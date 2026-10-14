import { createHash } from 'node:crypto';
import {pilotAccess,currentPilot,pilotIdentity} from './pilot.js';
import {activeRecovery,recoveryFor,pilotControl,savedRead} from './recovery.js';
import type {AgentInstanceState} from '../../document-models/agent-instance/v1/index.js';
import type {DispatchState} from '../../document-models/dispatch/v1/index.js';
import { z } from 'zod';
import { digest, canonical } from '../content.js';
import { privateText } from '../worker/sources.js';
import { loadRestrictedClaudeAdapter } from '../worker/claude-host.js';
import { openFrameworkRuntime, type RuntimeOptions } from '../service/runtime.js';
import { openTaskExecutionHost } from './host.js';
import { TaskSourceClient } from './task-client.js';
import { taskWorkerBindingSchema, packetSchema, packetNotesSchema, reportResultFact, reportReceiptSchema,
  type TaskWorkerBinding, type TaskReportAdapter, type TaskReportReceipt, type TaskReportRead } from './worker-contract.js';
import { PrivateTaskReportAdapter, type PrivateTaskPublicationPort } from './private-report-adapter.js';
import type { ClaudeAdapter } from '../worker/execution.js';
import type { TaskWorkerPorts } from './worker.js';

const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskRuntimeProfileSchema = z.object({
  contract: z.literal('kapelle.task-runtime-profile/v1'),
  expiresAt: z.iso.datetime(), permissionRef: z.string().min(1),
  publisherBindingRef: z.string().min(1), binding: taskWorkerBindingSchema,
  packets: z.array(z.object({taskId:z.string().min(1), hash, path:z.string().min(1)}).strict()).min(1).max(32),
}).strict().superRefine((p,c) => {
  if(new Set(p.packets.map(v=>v.taskId)).size!==p.packets.length)
    c.addIssue({code:'custom',message:'duplicate_task_admission'});
  if(p.binding.pilot&&(p.packets.length!==1||p.packets[0].taskId!==p.binding.pilot.taskId||p.packets[0].hash!==p.binding.pilot.packetHash||p.permissionRef!==p.binding.pilot.permissionRef||p.expiresAt!==p.binding.pilot.recoveryExpiresAt))c.addIssue({code:'custom',message:'pilot_exact_packet_required'});
  const pins=p.binding.taskCapabilityHashes;
  if((p.packets.length>1&&!pins)||(pins&&canonical(Object.keys(pins).sort())!==canonical(p.packets.map(e=>e.taskId).sort())))
    c.addIssue({code:'custom',message:'exact_task_capability_pins_required'});
});
/** Immutable configuration for one host lifetime; edits revoke it until a reviewed restart. */
export class TaskRuntimeAdmission {
  private constructor(readonly path:string, readonly profile:z.infer<typeof taskRuntimeProfileSchema>, readonly now:()=>string) {}
  static async load(path:string, now=()=>new Date().toISOString()) {
    const result=new TaskRuntimeAdmission(path,taskRuntimeProfileSchema.parse(JSON.parse(await privateText(path))),now);
    await result.current(true); return result;
  }
  async current(metadataOnly=false) {
    const value=taskRuntimeProfileSchema.parse(JSON.parse(await privateText(this.path)));
    if(canonical(value)!==canonical(this.profile)||(value.expiresAt<=this.now()&&!(value.binding.pilot&&(metadataOnly||pilotControl(value.binding.pilot)||savedRead(value.binding.pilot))))) throw Error('task_host_profile_changed_or_expired');
    return value;
  }
  async packet(taskId:string, packetHash:string, binding:Readonly<TaskWorkerBinding>) {
    const p=await this.current();
    if(binding.pilot)pilotAccess(binding.pilot,{ownerId:binding.ownerId,scopeRef:binding.scopeRef,occurredAt:this.now()},binding.instanceId);
    if(canonical(binding)!==canonical(p.binding)) throw Error('task_host_binding_changed');
    const entry=p.packets.find(e=>e.taskId===taskId&&e.hash===packetHash);
    if(!entry) throw Error('task_packet_not_admitted');
    const packet=packetSchema.parse(JSON.parse(await privateText(entry.path,131072)));
    if(digest(packet)!==packetHash) throw Error('task_packet_changed');
    await this.current();
    if(binding.pilot)pilotAccess(binding.pilot,{ownerId:binding.ownerId,scopeRef:binding.scopeRef,occurredAt:this.now()},binding.instanceId);
    return packet;
  }
}
/** Receipt cache is only an index. Every facts/status read independently revalidates the native Report: either a full read,
 * or (bounded reuse) the bytes of a recent successful full read PLUS a current reader probe of exactly that document.
 * Worker journal rehydrates this index via reports.read after restart; no second result authority.
 * Observed live: each full read was a Registry lookup of ~80 s. Reuse is keyed by the exact canonical receipt; only successes are kept;
 * a failed/mismatching probe evicts and falls back to a full read (which alone decides); any failed full read evicts;
 * never used to confirm. No probe configured -> no reuse (full read every time). */
export const VERIFIED_READ_REUSE_MS=10*60*1000;
export type ReportProbe=(documentId:string)=>Promise<unknown>;
function probeMatches(value:unknown,v:TaskReportRead){
  const doc=(value as any)?.document??value,header=doc?.header,g=doc?.state?.global,c=g?.content;
  if(!header||header.id!==v.id||header.documentType!=='kilgore/report'||g?.lifecycle!=='FINAL'||g.sourceRef!==v.sourceRef)return false;
  if(c?.storage!=='INLINE_MARKDOWN'||typeof c.markdown!=='string')return false;
  const bytes=Buffer.from(c.markdown,'utf8'),hash=createHash('sha256').update(bytes).digest('hex');
  return bytes.equals(v.bytes)&&bytes.length===c.byteSize&&String(c.contentHash).replace(/^sha256:/,'')===hash;
}
export function independentlyVerifiedReports(port:PrivateTaskPublicationPort, ownerId:string, scopeRef:string, instanceId:string, options:{reuseMs?:number;clock?:()=>number;probe?:ReportProbe}={}) {
  const adapter=new PrivateTaskReportAdapter(port), receipts=new Map<string,TaskReportReceipt>();
  const reuseMs=options.reuseMs??VERIFIED_READ_REUSE_MS, clock=options.clock??Date.now;
  const verified=new Map<string,{key:string;at:number;read:TaskReportRead}>();
  const copy=(v:TaskReportRead):TaskReportRead=>({...v,bytes:Buffer.from(v.bytes)});
  async function verify(r:TaskReportReceipt) {
    const key=canonical(reportReceiptSchema.parse(r));
    try{
      const v=await adapter.read(r);
      if(v.ownerId!==ownerId||v.scopeRef!==scopeRef||v.producerId!==instanceId)throw Error('task_report_scope_changed');
      verified.set(r.publicationId,{key,at:clock(),read:copy(v)});return v;
    }catch(e){verified.delete(r.publicationId);throw e;}
  }
  async function reuse(r:TaskReportReceipt) {
    const hit=verified.get(r.publicationId),key=canonical(reportReceiptSchema.parse(r)),age=hit?clock()-hit.at:Infinity;
    if(options.probe&&hit&&hit.key===key&&age>=0&&age<reuseMs){
      let ok=false;try{ok=probeMatches(await options.probe(hit.read.id),hit.read);}catch{ok=false;}
      if(ok)return copy(hit.read);
      verified.delete(r.publicationId); // probe failed or differs: never reuse; the authoritative full read decides
    }
    return verify(r);
  }
  const reports:TaskReportAdapter={bindingRef:adapter.bindingRef,publicationStartBoundary:adapter.publicationStartBoundary,
    admitted:r=>adapter.admitted(r),publish:r=>adapter.publish(r),lookup:r=>adapter.lookup(r),
    // The new-execution publish-readiness check must survive this wrapper (dropping it silently disables the pre-claim publish-readiness refusal).
    ...(adapter.publishReady?{publishReady:()=>adapter.publishReady!()}:{}),
    async read(r){const v=await verify(r);receipts.set(r.publicationId,structuredClone(r));return v;},
    async readVerified(r){const v=await reuse(r);receipts.set(r.publicationId,structuredClone(r));return v;}};
  return {reports,async facts(){
    const results=[];
    for(const r of receipts.values()) {try{await reuse(r);results.push(reportResultFact(r));}catch{/* unavailable Reports grant no result fact */}}
    return results;
  }};
}
export type TaskRuntimeOptions={
  runtime:Omit<RuntimeOptions,'taskDelegation'>;
  profilePath:string; workerRoot:string; token:()=>string;
  taskSource:TaskSourceClient; publisher:PrivateTaskPublicationPort;
  claudeHost:Parameters<typeof loadRestrictedClaudeAdapter>[0];
  /** Qualification seam. Production omits this and loads the installed restricted adapter. */
  provider?:ClaudeAdapter;
  recoverExecution?:TaskWorkerPorts['recoverExecution'];
  /** Reader-role point read of one Report by id (launcher's independent reader client); enables fail-closed status reuse. */
  reportProbe?:ReportProbe;
};
/** Compose native Task host on the caller's existing Framework listener. Never provisions,
 * dispatches, opens another listener, writes Task notes, or activates a schedule on startup. */
export async function openTaskRuntime(options:TaskRuntimeOptions) {
  const admission=await TaskRuntimeAdmission.load(options.profilePath,options.runtime.now);
  const p=admission.profile,b=p.binding;
  if(b.ownerId!==options.runtime.ownerId||b.scopeRef!==options.runtime.scopeRef||
    options.taskSource.ownerId!==b.ownerId||options.taskSource.sourceOwnerId!==(b.taskSourceOwnerId??b.ownerId)||options.publisher.bindingRef!==p.publisherBindingRef)
    throw Error('task_runtime_scope_changed');
  if(options.token().length<32)throw Error('task_runtime_token_unavailable');
  // Pilot recovery-only startup must not import SDK/auth. Load provider lazily only on run.
  const provider=options.provider??(b.pilot?{
    sdkVersion:b.inference.sdkVersion,cliVersion:b.inference.cliVersion,
    async run(...args:Parameters<ClaudeAdapter['run']>){
      const admitted=()=>currentPilot(b.pilot,{ownerId:b.ownerId,scopeRef:b.scopeRef,occurredAt:options.runtime.now?.()??new Date().toISOString()},b.instanceId);
      admitted();const loaded=await loadRestrictedClaudeAdapter(options.claudeHost);
      if(loaded.sdkVersion!==b.inference.sdkVersion||loaded.cliVersion!==b.inference.cliVersion)throw Error('worker_runtime_version_changed');
      admitted();return loaded.run(...args);
    },
  }:await loadRestrictedClaudeAdapter(options.claudeHost));
  const verified=independentlyVerifiedReports(options.publisher,b.ownerId,b.scopeRef,b.instanceId,options.reportProbe?{probe:options.reportProbe}:{});
  async function readTask(id:string){
    await admission.current();
    // A saved read after the recovery window checks the pilot's identity only (no time-based access); it never admits work.
    if(b.pilot){if(savedRead(b.pilot))pilotIdentity(b.pilot,{ownerId:b.ownerId,scopeRef:b.scopeRef},b.instanceId);else pilotAccess(b.pilot,{ownerId:b.ownerId,scopeRef:b.scopeRef,occurredAt:options.runtime.now?.()??new Date().toISOString()},b.instanceId);}
    if(!p.packets.some(e=>e.taskId===id))throw Error('Task not admitted');
    return options.taskSource.readTask(id);
  }
  const runtime=await openFrameworkRuntime({...options.runtime,
    taskDelegation:{permissionRef:p.permissionRef,readTask,...(b.pilot?{pilot:b.pilot}:{})},
    facts:async()=>{
      await admission.current();
      const base=await options.runtime.facts();
      // Native READY/grants/definition/runtime qualification remains authoritative.
      // This Task composition accepts result facts only from its independent reader.
      const results=await verified.facts();
      return {...base,dispatch:{parents:base.dispatch?.parents??[],agents:base.dispatch?.agents??[],
        tasks:base.dispatch?.tasks??[],sources:base.dispatch?.sources??[],
        results}};
    }});
  try {
    const host=openTaskExecutionHost({root:options.workerRoot,authority:runtime.authority,binding:b,token:options.token,
      readable:async(taskId,dispatchId,_binding,saved=false)=>{
        try{
          // Authenticate current Task access through the existing authority GET. Do not read packet bytes.
          if(activeRecovery())recoveryFor(b.pilot!,dispatchId);
          const task=await readTask(taskId);
          const dispatch=(await runtime.authority.read(dispatchId,'kapelle/dispatch')).state.global as DispatchState;
          const instance=(await runtime.authority.read(b.instanceId,'kapelle/agent-instance')).state.global as AgentInstanceState;
          const now=options.runtime.now?.()??new Date().toISOString();
          return task.id===taskId&&task.ownerId===b.ownerId&&dispatch.dispatchId===dispatchId&&
            dispatch.ownerId===b.ownerId&&dispatch.scopeRef===b.scopeRef&&
            dispatch.offer?.task.authorityRef==='task-authority'&&dispatch.offer.task.taskRef===taskId&&
            dispatch.offer.recipient.instanceId===b.instanceId&&instance.instanceId===b.instanceId&&
            instance.ownerId===b.ownerId&&instance.scopeRef===b.scopeRef&&
            // After the recovery window every pilot grant has expired by construction (pilotLifecycle caps it at recoveryExpiresAt),
            // so a saved read requires a matching read grant that was never REVOKED and was still live when the pilot was approved
            // (a stale pre-pilot grant cannot satisfy it); revocation still denies. Otherwise unchanged.
            instance.grants.some(g=>g.principalId===b.instanceId&&g.resourceRef===taskId&&g.actions.includes('read')&&!g.revokedAt&&(g.expiresAt>now||saved&&!!b.pilot&&savedRead(b.pilot)&&g.expiresAt>b.pilot.approvedAt&&g.expiresAt<=b.pilot.recoveryExpiresAt));
        }catch{return false;}
      },
      admitted:async taskId=>{
        if(b.pilot)currentPilot(b.pilot,{ownerId:b.ownerId,scopeRef:b.scopeRef,occurredAt:options.runtime.now?.()??new Date().toISOString()},b.instanceId);
        const t=await readTask(taskId),n=packetNotesSchema.parse(JSON.parse(t.bodyMarkdown));
        await admission.packet(taskId,n.packetHash,b);return true;
      },ports:{provider,reports:verified.reports,recoverExecution:options.recoverExecution,
        packet:async(hash,binding)=>{
          // Only one exact owner-admitted Task may identify this packet; no ambient file access.
          const entries=p.packets.filter(e=>e.hash===hash);
          if(entries.length!==1)throw Error('task_packet_identity_ambiguous');
          return admission.packet(entries[0].taskId,hash,binding);
        }}});
    return {authority:runtime.authority,handler:host.handler,stop:host.stop,
      async close(){await host.stop();host.close();await runtime.close();}};
  }catch(error){await runtime.close();throw error;}
}
