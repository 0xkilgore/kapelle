import 'server-only';
import {validateTaskHostSources} from './taskSourcePacket';
import {createHash} from 'node:crypto';
import {readReportDocumentForBinding} from './reportRegistryUncached';
import {z} from 'zod';
import {nativeDraftSchema,rosterSchema,planSourceOf,planSourceSchema} from './nativeDelegationContract';
import {approvedReceiptSchema,canonicalProposal,proposalPlanSchema,validateProposal} from './taskProposalContract';
import {readyTaskHost,taskHostAdmissionSchema,taskHostWorkerSchema,validateTaskHostExecution,taskHostClaimSchema,taskHostDelegationsV2Schema,taskHostStatusV2Schema,taskHostPilotSchema,taskHostSnapshotSchema,type TaskHostContext,type TaskHostReadReason,type TaskHostDelegationsV2,type TaskHostStatusV2} from './taskHostContract';

export class TaskHostError extends Error{constructor(message:string,readonly status=503){super(message);}}
function configuration(){
 const token=process.env.KAPELLE_TASK_HOST_TOKEN,raw=process.env.KAPELLE_TASK_HOST_URL;
 if(process.env.KAPELLE_TASK_HOST_ENABLED!=='1'||!raw||!token||token.length<32)throw new TaskHostError('Task delegation is not connected yet.');
 const url=new URL(raw);
 if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!=='/'||url.search||url.hash||url.username||url.password)throw new TaskHostError('Task host configuration is unavailable.');
 return {origin:url.origin,token};
}
export function taskHostEnabled(){try{configuration();return true;}catch{return false;}}
const hash=async(s:string)=>createHash('sha256').update(s).digest('hex');
async function upstream(path:string,body?:unknown,signal?:AbortSignal){
 const {origin,token}=configuration();
 // The 20 s guard stays the outer ceiling; an Increment 2 read deadline (signal) cancels the downstream read sooner.
 const guard=signal?AbortSignal.any([AbortSignal.timeout(20000),signal]):AbortSignal.timeout(20000);
 const r=await fetch(origin+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',redirect:'error',signal:guard});
 if(!r.ok)throw new TaskHostError(r.status===409?'The task, recipient, or saved request changed. Check the saved plan before continuing.':r.status===404?'The task host or saved request is not available.':'The task host could not confirm this request.',[400,403,404,409].includes(r.status)?r.status:503);
 const reader=r.body?.getReader();if(!reader)throw new TaskHostError('Empty host response.');const chunks:Uint8Array[]=[];let size=0;
 for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>400000){await reader.cancel();throw new TaskHostError('Host response is too large.');}chunks.push(p.value);}
 return JSON.parse(Buffer.concat(chunks).toString());
}
/** AGENT-MODEL-V2: an owner kit call that keeps the host's typed refusal code (kit_*) and takes its own deadline (a chat turn
 *  runs up to the agent's binding timeout). Bounded response; never retried here. */
export async function taskHostKitCall(path:string,o:{body?:unknown;timeoutMs?:number;signal?:AbortSignal}={}):Promise<{status:number;json:Record<string,unknown>}>{
 const {origin,token}=configuration(),limit=AbortSignal.timeout(o.timeoutMs??20000),guard=o.signal?AbortSignal.any([limit,o.signal]):limit;
 const r=await fetch(origin+path,{method:o.body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:o.body===undefined?undefined:JSON.stringify(o.body),cache:'no-store',redirect:'error',signal:guard});
 const reader=r.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
 if(reader)for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>600000){await reader.cancel();throw new TaskHostError('Host response is too large.');}chunks.push(p.value);}
 let json:Record<string,unknown>={};try{json=JSON.parse(Buffer.concat(chunks).toString());}catch{json={};}
 return {status:r.status,json};
}
/** Agent kit (slice 5): the same configured, bounded host call, for the owner's Create-agent routes. */
export function taskHostCall(path:string,body?:unknown){return upstream(path,body);}
/** Raw native instance states in the host's owner/scope. Read-only; no availability is computed here. */
export async function readTaskHostInstances():Promise<unknown[]>{
 const r=await upstream('/instances');
 if(!r||r.ok!==true||!Array.isArray(r.items)||r.items.length>200)throw new TaskHostError('Agent instances could not be verified.');
 return r.items;
}
const dispatchPhaseSchema=z.enum(['OFFERED','ACCEPTED','CANCEL_REQUESTED','RESULT_RECORDED']);
export const dispatchListSchema=z.object({ok:z.literal(true),contract:z.literal('kapelle.dispatch-list/v1'),recipient:z.string().min(1),
 items:z.array(z.object({dispatchId:z.string().uuid(),revision:z.number().int().nonnegative(),phase:dispatchPhaseSchema,taskRef:z.string().min(1).max(200),authorityRef:z.string(),recipientInstanceId:z.string(),senderId:z.string(),offeredAt:z.string().nullable(),updatedAt:z.string().nullable(),expiresAt:z.string(),acceptedAt:z.string().nullable(),
  result:z.object({reportId:z.string().min(1),contentVersion:z.number().int().positive(),contentHash:z.string(),occurredAt:z.string()}).strict().nullable(),cancellationReason:z.string().nullable(),parentDispatchRef:z.string().nullable(),proposalOperationId:z.string().nullable()}).strict()).max(50),
 scanned:z.number().int().nonnegative(),nextCursor:z.string().nullable(),complete:z.boolean()}).strict();
export type DispatchList=z.infer<typeof dispatchListSchema>;
/** G1 read: native Dispatch records for one recipient. Dispatch phase is the record, not confirmed execution. */
export async function readTaskHostDispatches(instanceId:string,options:{phases?:string[];limit?:number;cursor?:string|null}={}):Promise<DispatchList>{
 const q=new URLSearchParams({recipient:instanceId});
 if(options.phases?.length)q.set('phase',options.phases.join(','));if(options.limit)q.set('limit',String(options.limit));if(options.cursor)q.set('cursor',options.cursor);
 const list=dispatchListSchema.parse(await upstream('/dispatches?'+q.toString()));
 if(list.recipient!==instanceId||list.items.some(i=>i.recipientInstanceId!==instanceId))throw new TaskHostError('Dispatch list belongs to another recipient.');
 return list;
}
/** Confirmed execution state for one Dispatch from the host's journal. `undefined` means the host is
 * bound to another instance (409) so execution cannot be inspected; `null` means no attempt exists. */
export async function readTaskHostWorkerStatus(dispatchId:string){
 try{return taskHostWorkerSchema.nullable().parse((await upstream('/task-executions/'+encodeURIComponent(dispatchId))).item);}
 catch(e){if(e instanceof TaskHostError&&e.status===409)return undefined;throw e;}
}
/** The host's per-Task admission receipt. Its instanceId names the single bound Task worker. */
export async function readTaskHostAdmission(taskId:string){
 return taskHostAdmissionSchema.parse(await upstream('/task-executions/admission?taskId='+encodeURIComponent(taskId)));
}
/** Pilot signals for this Task, or undefined when unknown (older Framework without the route, or the read failed). */
export async function readTaskHostPilot(taskId:string,signal?:AbortSignal){
 try{const v=taskHostPilotSchema.parse(await upstream('/task-executions/pilot?taskId='+encodeURIComponent(taskId),undefined,signal));
  return v.taskId===taskId?v:undefined;}catch{return undefined;}
}
/** Agent kit: the Task's kit agent admission (same strict contract), or null when the kit has no agent for this Task or is not
 * installed. Other failures propagate (a kit outage is not silently replaced by the pilot path). */
async function readKitAdmission(taskId:string,signal?:AbortSignal,chosen?:string){
 // Opt-in (Ops sets it when the kit runtime is installed): without it the console makes no kit call and the pilot path is unchanged.
 if(process.env.KAPELLE_TASK_HOST_KIT!=='1')return null;
 const {origin,token}=configuration();
 const guard=signal?AbortSignal.any([AbortSignal.timeout(20000),signal]):AbortSignal.timeout(20000);
 const r=await fetch(origin+'/task-executions/kit/admission?taskId='+encodeURIComponent(taskId)+(chosen?'&instanceId='+encodeURIComponent(chosen):''),{headers:{authorization:'Bearer '+token},cache:'no-store',redirect:'error',signal:guard});
 if(r.status===404)return null;
 if(!r.ok)throw new TaskHostError('The task host could not confirm the agent for this task.');
 return taskHostAdmissionSchema.parse(await r.json());
}
/** A kit plan's expiry: a 6-hour bucket + 30 h, so the roster read and the create see the same planned pin. */
export function kitPlanExpiry(now=Date.now()){return new Date(Math.floor(now/21600000)*21600000+30*3600000).toISOString();}
const rosterPath=(taskId:string,plan?:{operationId:string;expiresAt:string},source?:{instanceId:string;manifestHash:string})=>'/task-delegations/agents?taskId='+encodeURIComponent(taskId)
 +(plan?'&operationId='+plan.operationId+'&expiresAt='+encodeURIComponent(plan.expiresAt):'')+(plan&&source?'&instanceId='+encodeURIComponent(source.instanceId)+'&manifestHash='+source.manifestHash:'');
/** AGENT-MODEL-V2: the owner's choice for this Task: a task-selected agent and (once previewed) its frozen snapshot. Identity
 *  only; the host re-resolves the source from its own manifest store and re-derives every pin. */
export const taskChoiceSchema=z.object({agent:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),manifestHash:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()}).strict();
export type TaskChoice=z.infer<typeof taskChoiceSchema>;
async function readSnapshot(manifestHash:string,signal?:AbortSignal){
 const {ok:_ok,...v}=z.object({ok:z.literal(true)}).passthrough().parse(await upstream('/agents/snapshots/'+manifestHash,undefined,signal));
 const snap=taskHostSnapshotSchema.parse(v);
 if(snap.manifestHash!==manifestHash)throw new TaskHostError('The snapshot differs from the chosen one.',409);
 return snap;
}
const KIT_PROBE_OPERATION='00000000-0000-4000-8000-000000000000';
/** Kit mode, no kit agent for this Task's project (Framework 404): a NEUTRAL context, never an error. The Framework never
 *  issues this instance id; nothing can be admitted for it (ready=false), and discovery skips slot probing for it. */
export const NO_KIT_AGENT='kit:no-agent';
/** Context plus its mode. Kit mode: the admission is the Task's kit agent; the roster carries its PLANNED pin (nothing granted). */
async function contextFor(taskId:string,signal?:AbortSignal,choice?:TaskChoice){
 if(choice){
  // The owner chose a kit agent for this Task (and maybe its frozen snapshot): that agent's admission and planned pin only.
  if(process.env.KAPELLE_TASK_HOST_KIT!=='1')throw new TaskHostError('Choosing an agent needs the agent kit on this host.',409);
  const chosen=await readKitAdmission(taskId,signal,choice.agent);
  if(!chosen||chosen.instanceId!==choice.agent)throw new TaskHostError('This agent is not available for this Task.',409);
  const r=rosterSchema.parse(await upstream(rosterPath(taskId,{operationId:KIT_PROBE_OPERATION,expiresAt:kitPlanExpiry()},choice.manifestHash?{instanceId:choice.agent,manifestHash:choice.manifestHash}:undefined),undefined,signal));
  if(r.task.taskId!==taskId)throw new TaskHostError('Task identity differs.');
  const snapshot=choice.manifestHash?await readSnapshot(choice.manifestHash,signal):undefined;
  return {context:{ok:true as const,roster:r,admission:chosen,...(snapshot?{snapshot}:{})} as Awaited<ReturnType<typeof readPilotContext>>&{snapshot?:typeof snapshot},kit:true};
 }
 const kit=await readKitAdmission(taskId,signal);
 if(!kit&&process.env.KAPELLE_TASK_HOST_KIT==='1'){
  // The pilot admission routes do not exist on a kit host: "no kit agent" is a state of the Task, not a host failure.
  const r=rosterSchema.parse(await upstream(rosterPath(taskId),undefined,signal));
  if(r.task.taskId!==taskId)throw new TaskHostError('Task identity differs.');
  const admission=taskHostAdmissionSchema.parse({ok:true,contract:'kapelle.task-host/v1',instanceId:NO_KIT_AGENT,ready:false,reason:'host_not_admitted',packetRequired:true,taskRevision:r.task.revision,sourceHash:r.task.sourceHash,packetHash:null});
  return {context:{ok:true as const,roster:r,admission} as Awaited<ReturnType<typeof readPilotContext>>,kit:false};
 }
 if(kit){
  const r=rosterSchema.parse(await upstream(rosterPath(taskId,{operationId:KIT_PROBE_OPERATION,expiresAt:kitPlanExpiry()}),undefined,signal));
  const context:Awaited<ReturnType<typeof readPilotContext>>={ok:true as const,roster:r,admission:kit};
  if(context.roster.task.taskId!==taskId)throw new TaskHostError('Task identity differs.');return {context,kit:true};
 }
 return {context:await readPilotContext(taskId,signal),kit:false};
}
export async function readTaskHostContext(taskId:string,signal?:AbortSignal,choice?:TaskChoice):Promise<TaskHostContext>{return (await contextFor(taskId,signal,choice)).context;}
/** Executions are routed by the DISPATCH, not by the Task: a Dispatch to the Task's current kit agent is served under
 *  /task-executions/kit/ (one worker per approved run); any other (pilot-era) Dispatch by the Framework's legacy read route
 *  /task-executions/<id> (saved status, read-only on a kit host). Live 2026-10-15: W4 a9d2cb54 was sent to the kit route
 *  because Block Party now has a kit agent, and the kit refused it (409 kit_dispatch_not_kit). */
async function executionPath(taskId:string,dispatchId:string,recipientInstanceId:string,signal?:AbortSignal){
 const kit=await readKitAdmission(taskId,signal).catch(e=>{if(process.env.KAPELLE_TASK_HOST_KIT==='1')throw e;return null;});
 if(kit&&kit.instanceId===recipientInstanceId)return '/task-executions/kit/'+dispatchId;
 if(process.env.KAPELLE_TASK_HOST_KIT!=='1')return '/task-executions/'+dispatchId;
 // AGENT-MODEL-V2: a Dispatch to an owner-chosen kit agent (not the Task's default) is still a kit Dispatch. The kit route
 // answers it whatever the agent's state; only its explicit "not a kit Dispatch" refusal sends the read to the legacy route.
 const {origin,token}=configuration();
 const guard=signal?AbortSignal.any([AbortSignal.timeout(20000),signal]):AbortSignal.timeout(20000);
 const r=await fetch(origin+'/task-executions/kit/'+dispatchId,{headers:{authorization:'Bearer '+token},cache:'no-store',redirect:'error',signal:guard});
 if(r.ok){await r.body?.cancel();return '/task-executions/kit/'+dispatchId;}
 const v=await r.json().catch(()=>({})) as {error?:unknown};
 if(r.status===409&&v.error==='kit_dispatch_not_kit')return '/task-executions/'+dispatchId;
 throw new TaskHostError(r.status===404?'The task host or saved request is not available.':'The task host could not confirm this request.',[403,404,409].includes(r.status)?r.status:503);
}
async function readPilotContext(taskId:string,signal?:AbortSignal){
 const [r,a,p]=await Promise.all([upstream('/task-delegations/agents?taskId='+encodeURIComponent(taskId),undefined,signal),upstream('/task-executions/admission?taskId='+encodeURIComponent(taskId),undefined,signal),readTaskHostPilot(taskId,signal)]);
 const admission=taskHostAdmissionSchema.parse(a);
 const context={ok:true as const,roster:rosterSchema.parse(r),admission,...(p&&p.instanceId===admission.instanceId?{pilot:p.pilot}:{})};
 if(context.roster.task.taskId!==taskId)throw new TaskHostError('Task identity differs.');return context;
}
export async function readTaskHostSources(taskId:string,context?:Awaited<ReturnType<typeof readTaskHostContext>>){
 const mode=await contextFor(taskId),current=context??mode.context;
 return validateTaskHostSources(await upstream((mode.kit?'/task-executions/kit/sources':'/task-executions/sources')+'?taskId='+encodeURIComponent(taskId)),current,hash);
}
export async function readTaskHostProposal(taskId:string,proposalId:string,operation=false,signal?:AbortSignal){
 const response=await upstream('/task-proposals/'+(operation?'operations/':'')+encodeURIComponent(proposalId),undefined,signal);
 const item=await validateProposal(response.item,hash);
 if(!operation&&item.proposalId!==proposalId||operation&&item.versions[0].draft.operationId!==proposalId||item.versions.some(v=>v.draft.taskId!==taskId))throw new TaskHostError('Saved plan belongs to another task.');
 return {ok:true,item};
}
async function receipt(taskId:string,operationId:string,signal?:AbortSignal){
 const r=approvedReceiptSchema.parse((await upstream('/task-delegations/'+encodeURIComponent(operationId),undefined,signal)).item);
 if(r.taskId!==taskId||r.operationId!==operationId)throw new TaskHostError('Saved assignment belongs to another task.');return r;
}
export async function readTaskHostExecution(taskId:string,operationId:string,signal?:AbortSignal){
 const before=await receipt(taskId,operationId,signal);
 const path=await executionPath(taskId,before.dispatchId,before.recipient.instanceId,signal);
 const read=await upstream(path,undefined,signal),worker=taskHostWorkerSchema.nullable().parse(read.item);
 // Only the Framework's read-only legacy host marks a reply legacy (a pilot-era Dispatch it will never claim or run).
 const legacy=process.env.KAPELLE_TASK_HOST_KIT==='1'&&!path.startsWith('/task-executions/kit/')&&read.legacy===true;
 // Read the native result after the worker status so a just-published result is observable.
 return validateTaskHostExecution({ok:true,item:await receipt(taskId,operationId,signal),worker,...(legacy?{legacy:true as const}:{})},taskId,operationId);
}
/** Used by the Agents page's server-side v1 discovery only (no longer routed to the browser).
 * The executor's receipt does not establish this console reader's current access.
 * Reuse the installed Report reader before presenting a result link; never write or republish. */
export async function readTaskHostVisibleExecution(taskId:string,operationId:string){
 const execution=await readTaskHostExecution(taskId,operationId),worker=execution.worker;
 if(worker?.status!=='REPORT_PUBLISHED'||!worker.result)return execution;
 const result=worker.result;
 let verified=false;
 try{
  const {read}=await readResultReport(result.reportId);
  if(read.availability==='authoritative'){
   const report=read.report,content=report.content.markdown;
   verified=report.documentId===result.reportId&&report.lifecycle==='FINAL'
    &&report.sourceRef==='dispatch:'+execution.item.dispatchId
    &&report.content.storage==='INLINE_MARKDOWN'&&content!==null
    &&report.content.contentHash.replace(/^sha256:/,'')===result.contentHash.slice(7)
    &&createHash('sha256').update(content).digest('hex')===result.contentHash.slice(7)
    &&Buffer.byteLength(content,'utf8')===report.content.byteSize;
  }
 }catch{/* Reader failures retain the saved execution, but expose no result link. */}
 return verified?execution:validateTaskHostExecution({...execution,worker:{...worker,status:'REPORT_PENDING',reason:'readback_unconfirmed',result:null}},taskId,operationId);
}
const uuid=z.string().uuid(),digest=z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const taskHostCommandSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('createProposal'),payload:z.object({operationId:uuid,draft:nativeDraftSchema.partial({instructions:true})}).strict()}).strict(),
 z.object({action:z.literal('reviseProposal'),proposalId:uuid,payload:z.object({operationId:uuid,expectedRevision:z.number().int().nonnegative(),baseVersion:z.number().int().positive(),basePlanHash:digest,comment:z.string().max(4000),plan:proposalPlanSchema,draft:nativeDraftSchema}).strict()}).strict(),
 z.object({action:z.literal('approveProposal'),proposalId:uuid,payload:z.object({operationId:uuid,expectedRevision:z.number().int().nonnegative(),version:z.number().int().positive(),planHash:digest}).strict()}).strict(),
 // respond:'claim' (Increment 2 §3): return the Framework's claim/settled answer promptly; no synchronous post-run read.
 // Required: an older client that expects a post-run Report read fails closed (400) instead of misreading the claim.
 z.object({action:z.literal('run'),operationId:uuid,respond:z.literal('claim')}).strict(),
 /** Cancellation REQUEST on the saved assignment's Dispatch (ported from the chat candidate). It records CANCEL_REQUESTED
  * natively; it never asserts that the worker or its child process has exited. */
 z.object({action:z.literal('cancel'),operationId:uuid,reason:z.string().trim().min(1).max(500)}).strict(),
]);
const dispatchRecordSchema=z.object({ok:z.literal(true),document:z.object({header:z.object({id:z.string().min(1)}).loose(),state:z.object({global:z.object({
 revision:z.number().int().nonnegative(),dispatchId:z.string().min(1),ownerId:z.string().min(1),scopeRef:z.string().min(1),phase:dispatchPhaseSchema,
 cancellationReason:z.string().nullable().optional(),result:z.object({reportId:z.string().min(1)}).loose().nullable().optional(),
 offer:z.object({task:z.object({authorityRef:z.literal('task-authority'),taskRef:z.string().min(1).max(200)}).loose(),recipient:z.object({instanceId:z.string().min(1)}).loose(),expiresAt:z.string(),permissionRef:z.string().min(1).max(200).optional()}).loose(),
}).loose()}).loose()}).loose()}).loose();
export type TaskHostDispatchRecord={dispatchId:string;revision:number;phase:z.infer<typeof dispatchPhaseSchema>;cancellationReason:string|null;hasResult:boolean;taskRef:string;recipientInstanceId:string};
/** Current native Dispatch record (phase, revision, cancellation). Read-only. */
export async function readTaskHostDispatch(dispatchId:string,signal?:AbortSignal):Promise<TaskHostDispatchRecord>{
 if(!/^[a-f0-9-]{36}$/.test(dispatchId))throw new TaskHostError('Invalid assignment identity.',400);
 const g=dispatchRecordSchema.parse(await upstream('/documents/'+dispatchId+'?type=kapelle%2Fdispatch',undefined,signal)).document.state.global;
 if(g.dispatchId!==dispatchId)throw new TaskHostError('Dispatch identity differs.');
 return {dispatchId,revision:g.revision,phase:g.phase,cancellationReason:g.cancellationReason??null,hasResult:!!g.result,taskRef:g.offer.task.taskRef,recipientInstanceId:g.offer.recipient.instanceId};
}
export async function commandTaskHost(taskId:string,raw:unknown,requested?:TaskChoice){
 const body=taskHostCommandSchema.parse(raw);
 if(body.action==='run'){
  const saved=await receipt(taskId,body.operationId);
  // The host rechecks the exact installed binding and saved Dispatch on every run/recovery.
  const claimed=await upstream(await executionPath(taskId,saved.dispatchId,saved.recipient.instanceId)+'/run',{});
  const w=taskHostWorkerSchema.parse(claimed?.item);
  if(w.dispatchId!==saved.dispatchId)throw new TaskHostError('The claim belongs to another assignment.');
  return taskHostClaimSchema.parse({ok:true,contract:'kapelle.task-host-claim/v1',operationId:body.operationId,dispatchId:saved.dispatchId,worker:w});
 }
 if(body.action==='cancel'){
  const saved=await receipt(taskId,body.operationId);
  const d=await readTaskHostDispatch(saved.dispatchId);
  if(d.taskRef!==taskId||d.recipientInstanceId!==saved.agentId)throw new TaskHostError('Saved assignment belongs to another task or recipient.');
  if(d.phase==='RESULT_RECORDED'||d.hasResult)throw new TaskHostError('A result is already recorded for this assignment, so it cannot be cancelled.',409);
  // Idempotent by native operation id (Dispatch + revision). An already requested cancellation is reported from the record,
  // never re-sent; a changed revision surfaces as a 409 to re-read. The answer is the same status v2 the page reads.
  if(d.phase!=='CANCEL_REQUESTED')await upstream('/commands',{operationId:'task-delegation-cancel:'+saved.dispatchId+':'+d.revision,documentId:saved.dispatchId,documentType:'kapelle/dispatch',expectedRevision:d.revision,type:'REQUEST_DISPATCH_CANCEL',input:{reason:body.reason}});
  return readTaskHostStatusV2(taskId,body.operationId);
 }
 if(body.action==='approveProposal'){
  const saved=(await readTaskHostProposal(taskId,body.proposalId)).item;
  if(saved.approval){
   if(saved.approval.operationId!==body.payload.operationId||saved.approval.version!==body.payload.version||saved.approval.planHash!==body.payload.planHash)throw new TaskHostError('This plan has a different approval.',409);
   return {ok:true,proposal:saved,item:await receipt(taskId,saved.versions.at(-1)!.draft.operationId)};
  }
 }
 let savedDraft:z.infer<typeof nativeDraftSchema>|null=null;
 if(body.action==='reviseProposal'||body.action==='approveProposal')savedDraft=(await readTaskHostProposal(taskId,body.proposalId)).item.versions.at(-1)!.draft as z.infer<typeof nativeDraftSchema>;
 // The choice for approve/revise comes from the SAVED draft (its agent and frozen source), never from the request.
 const savedSource=planSourceOf(savedDraft?.grantPlan);
 const choice:TaskChoice|undefined=savedDraft?(savedSource?{agent:savedDraft.agentId,manifestHash:savedSource.manifestHash}:undefined):requested;
 const {context,kit}=await contextFor(taskId,undefined,choice);
 if(!readyTaskHost(context))throw new TaskHostError('No admitted task worker is available for this task.',409);
 // Agent kit: the console SERVER completes the draft's recipient pin + grantPlan from the kit roster for the draft's OWN operation
 // id and plan expiry (create/revise), and verifies them on approve; the Framework re-derives and re-checks both.
 const kitRecipient=async(operationId:string,expiresAt:string)=>{
  const r=rosterSchema.parse(await upstream(rosterPath(taskId,{operationId,expiresAt},choice?.manifestHash?{instanceId:choice.agent,manifestHash:choice.manifestHash}:undefined)));
  const ag=r.agents.find(a=>a.id===context.admission.instanceId);
  if(!ag?.available||!ag.recipient||!ag.grantPlan)throw new TaskHostError('The agent cannot be planned for this task right now.',409);
  return {recipient:ag.recipient,grantPlan:ag.grantPlan};
 };
 if(kit&&(body.action==='createProposal'||body.action==='reviseProposal')){
  const d=body.payload.draft,planned=await kitRecipient(d.operationId,d.grantPlan?.expiresAt??kitPlanExpiry());
  body.payload.draft={...d,...planned};
 }
 const current=body.action==='createProposal'||body.action==='reviseProposal'?body.payload.draft:(await readTaskHostProposal(taskId,body.proposalId)).item.versions.at(-1)!.draft;
 if(current.taskId!==taskId||current.revision!==context.admission.taskRevision||current.sourceHash!==context.admission.sourceHash||current.agentId!==context.admission.instanceId||canonicalProposal(current.recipient)!==canonicalProposal(kit?(current.grantPlan?(await kitRecipient(current.operationId,current.grantPlan.expiresAt)).recipient:null):context.roster.agents.find(a=>a.id===context.admission.instanceId)?.recipient)||(kit&&!current.grantPlan)||!current.includeNotes)throw new TaskHostError('Task context or worker admission changed. Refresh before approval.',409);
 if(choice?.manifestHash){if(planSourceOf(current.grantPlan)?.manifestHash!==choice.manifestHash)throw new TaskHostError('The plan names other files than the chosen snapshot. Refresh before approval.',409);}
 else await readTaskHostSources(taskId,context);
 const path=body.action==='createProposal'?'/task-proposals':'/task-proposals/'+body.proposalId+(body.action==='reviseProposal'?'/revisions':'/approve-and-send');
 const response=await upstream(path,body.payload);
 const proposal=await validateProposal(response.proposal??response.item,hash);
 if(body.action!=='createProposal'&&proposal.proposalId!==body.proposalId||proposal.versions.some(v=>v.draft.taskId!==taskId))throw new TaskHostError('Returned proposal belongs to another task.');
 return body.action==='approveProposal'?{ok:true,proposal,item:approvedReceiptSchema.parse(response.item)}:{ok:true,item:proposal};
}

// ---- Task-bound assignment discovery and Report→Task origin (read-only) ----
import {delegationOperationId,MAX_DELEGATION_ROUNDS} from './taskDelegationIdentity';
import type {TaskHostExecution} from './taskHostContract';
import type {TaskProposal} from './taskProposalContract';

export type TaskHostDelegationRound={round:number;operationId:string;proposal:TaskProposal;execution:TaskHostExecution|null;executionError:string|null};
export type TaskHostDelegations={ok:true;contract:'kapelle.task-host-delegations/v1';instanceId:string;rounds:TaskHostDelegationRound[];next:{round:number;operationId:string}|null};

/** Recover every saved assignment for this Task and the admitted recipient without browser state.
 * Identities are derived, so a lost pointer, another device, or a duplicate submission all resolve
 * to the same native proposal. Probing stops at the first round the authority has never recorded. */
export async function findTaskHostDelegations(taskId:string,context?:Awaited<ReturnType<typeof readTaskHostContext>>):Promise<TaskHostDelegations>{
 const current=context??await readTaskHostContext(taskId),instanceId=current.admission.instanceId;
 const rounds:TaskHostDelegationRound[]=[];let next:TaskHostDelegations['next']=null;
 for(let round=1;round<=MAX_DELEGATION_ROUNDS;round++){
  const operationId=await delegationOperationId(taskId,instanceId,round,hash);
  let proposal:TaskProposal;
  try{proposal=(await readTaskHostProposal(taskId,operationId,true)).item;}
  catch(e){if(e instanceof TaskHostError&&e.status===404){next={round,operationId};break;}throw e;}
  if(proposal.versions.some(v=>v.draft.agentId!==instanceId))throw new TaskHostError('Saved plan belongs to another recipient.');
  let execution:TaskHostExecution|null=null,executionError:string|null=null;
  if(proposal.dispatchId){try{execution=await readTaskHostVisibleExecution(taskId,operationId);}catch(e){executionError=e instanceof Error?e.message:'Saved work status is unavailable.';}}
  rounds.push({round,operationId,proposal,execution,executionError});
 }
 return {ok:true,contract:'kapelle.task-host-delegations/v1',instanceId,rounds,next};
}

const dispatchDocumentSchema=z.object({document:z.object({state:z.object({global:z.object({
 ownerId:z.string().min(1),scopeRef:z.string().min(1),phase:z.string().min(1),
 offer:z.object({task:z.object({authorityRef:z.literal('task-authority'),taskRef:z.string().min(1).max(200)}),recipient:z.object({instanceId:z.string().min(1)}),instructions:z.string().min(1)}).loose(),
}).loose()}).loose()}).loose()}).loose();

export type TaskHostReportOrigin={taskId:string;operationId:string;dispatchId:string;taskTitle:string;recommendedAction:string;version:number};

/** Resolve a published Report back to its original Task through the native Dispatch it names.
 * Read-only: the Report's sourceRef names the Dispatch, the Dispatch names the Task, and the saved
 * execution must independently confirm that exactly this Report was its verified result. */
export async function readTaskHostReportOrigin(reportId:string,sourceRef:string|null):Promise<TaskHostReportOrigin|null>{
 const match=/^dispatch:([a-f0-9-]{36})$/.exec(sourceRef??'');
 if(!match||!/^[a-f0-9-]{36}$/.test(reportId))return null;
 const dispatchId=match[1];
 const global=dispatchDocumentSchema.parse(await upstream('/documents/'+dispatchId+'?type=kapelle%2Fdispatch')).document.state.global;
 const envelope=JSON.parse(global.offer.instructions);
 const draft=nativeDraftSchema.pick({operationId:true,taskId:true,agentId:true}).loose().parse(envelope?.draft);
 if(draft.taskId!==global.offer.task.taskRef||draft.agentId!==global.offer.recipient.instanceId)throw new TaskHostError('Dispatch task binding differs.');
 const execution=await readTaskHostExecution(draft.taskId,draft.operationId);
 const worker=execution.worker;
 if(execution.item.dispatchId!==dispatchId||worker?.status!=='REPORT_PUBLISHED'||worker.result?.reportId!==reportId||execution.item.result?.reportId!==reportId)throw new TaskHostError('This Report is not the verified result of that task.');
 let taskTitle='';try{taskTitle=String(JSON.parse(execution.item.source.content).title??'');}catch{}
 return {taskId:draft.taskId,operationId:draft.operationId,dispatchId,taskTitle,recommendedAction:execution.item.approvedPlan.recommendedAction,version:execution.item.approval.version};
}

// ---- Increment 2 §3 console data path (v2; additive) ----
/** Total read budget of one discovery/status interaction (§2: hard 5 s; bounded partial results). */
export const TASK_HOST_READ_BUDGET_MS=5000;
const DISCOVERY_PAGE=50,DISCOVERY_MAX_PAGES=3,RESOLVE_CONCURRENCY=4;
const taskDispatchListSchema=dispatchListSchema.extend({recipient:z.null(),taskRef:z.string().min(1).max(200)});
/** Task-filtered Dispatch page across ALL recipients of this owner/scope (historical instances included). */
async function readTaskHostTaskDispatches(taskId:string,cursor:string|null,signal?:AbortSignal){
 const q=new URLSearchParams({taskRef:taskId,limit:String(DISCOVERY_PAGE)});if(cursor)q.set('cursor',cursor);
 const list=taskDispatchListSchema.parse(await upstream('/dispatches?'+q.toString(),undefined,signal));
 if(list.taskRef!==taskId||list.items.some(i=>i.taskRef!==taskId))throw new TaskHostError('Dispatch list belongs to another task.');
 return list;
}
async function mapBounded<T,R>(items:T[],limit:number,fn:(item:T)=>Promise<R>):Promise<R[]>{
 const out:R[]=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(next<items.length){const i=next++;out[i]=await fn(items[i]);}}));
 return out;
}
function readReason(e:unknown,signal:AbortSignal):TaskHostReadReason{
 if(signal.aborted)return 'deadline';
 if(e instanceof TaskHostError&&e.status===409)return 'worker_bound_elsewhere';
 return 'execution_unavailable';
}

/** Increment 2 §3 discovery (v2). Read only (GET verbs only). Finds:
 * - deterministic page slots of the CURRENTLY admitted instance: all 12 are probed (a hole does not stop the probe);
 * - every Task-filtered Dispatch across historical recipients (50/page, at most 3 pages; `nextCursor` to load older);
 *   Dispatches that are not a current slot are `external` (no fabricated round).
 * Current admission is read separately: its failure never aborts history. Any page/slot/item left unresolved within the
 * budget makes the result explicitly incomplete with a fixed reason; an incomplete result cannot enable prepare/start. */
export async function findTaskHostDelegationsV2(taskId:string,options:{cursor?:string|null;choice?:TaskChoice}={}):Promise<TaskHostDelegationsV2>{
 const deadline=AbortSignal.timeout(TASK_HOST_READ_BUDGET_MS);
 let reason:TaskHostReadReason|null=null;const mark=(r:TaskHostReadReason)=>{reason??=r;};
 const contextP=readTaskHostContext(taskId,deadline,options.choice?{agent:options.choice.agent}:undefined).then(c=>c,()=>null);
 const dispatches:DispatchList['items']=[];let cursor:string|null=options.cursor??null,pages=0;
 try{do{const page=await readTaskHostTaskDispatches(taskId,cursor,deadline);dispatches.push(...page.items);cursor=page.nextCursor;pages++;}while(cursor&&pages<DISCOVERY_MAX_PAGES);}
 catch(e){if(e instanceof TaskHostError&&e.message.includes('another task'))throw e;mark(deadline.aborted?'deadline':'host_unavailable');}
 if(cursor)mark('page_limit');
 const context=await contextP,instanceId=context&&context.admission.instanceId!==NO_KIT_AGENT?context.admission.instanceId:null;
 if(!context)mark('admission_unavailable');
 // Deterministic slots of the current instance (page-created proposals, including unapproved ones without a Dispatch).
 const slots=instanceId?await Promise.all(Array.from({length:MAX_DELEGATION_ROUNDS},async(_,i)=>({round:i+1,operationId:await delegationOperationId(taskId,instanceId,i+1,hash)}))):[];
 const probed=await mapBounded(slots,RESOLVE_CONCURRENCY,async slot=>{
  try{return {...slot,proposal:(await readTaskHostProposal(taskId,slot.operationId,true,deadline)).item as TaskProposal|null};}
  catch(e){if(e instanceof TaskHostError&&e.status===404&&!deadline.aborted)return {...slot,proposal:null};
   if(e instanceof TaskHostError&&e.message.includes('another task'))throw e;mark(deadline.aborted?'deadline':'host_unavailable');return {...slot,proposal:undefined};}
 });
 for(const p of probed)if(p.proposal&&p.proposal.versions.some(v=>v.draft.agentId!==instanceId))throw new TaskHostError('Saved plan belongs to another recipient.');
 const firstHole=probed.find(p=>p.proposal===null),unresolvedBefore=firstHole?probed.some(p=>p.round<firstHole.round&&p.proposal===undefined):true;
 const next=firstHole&&!unresolvedBefore?{round:firstHole.round,operationId:firstHole.operationId}:null;
 const found=probed.filter(p=>p.proposal) as {round:number;operationId:string;proposal:TaskProposal}[];
 const byDispatch=new Map(dispatches.map(d=>[d.dispatchId,d]));
 const slotDispatchIds=new Set(found.map(p=>p.proposal.dispatchId).filter((d):d is string=>!!d));
 const externalsRaw=dispatches.filter(d=>!slotDispatchIds.has(d.dispatchId)).slice(0,150);
 // Resolve executions/proposals for displayed items only, bounded concurrency, same deadline.
 const rounds=await mapBounded(found,RESOLVE_CONCURRENCY,async p=>{
  if(!p.proposal.dispatchId)return {round:p.round,operationId:p.operationId,proposal:p.proposal,execution:null,executionError:null};
  try{const execution=await readTaskHostExecution(taskId,p.operationId,deadline);return {round:p.round,operationId:p.operationId,proposal:p.proposal,execution,executionError:null};}
  catch(e){const r=readReason(e,deadline);if(r==='deadline')mark('deadline');return {round:p.round,operationId:p.operationId,proposal:p.proposal,execution:null,executionError:r};}
 });
 const external=await mapBounded(externalsRaw,RESOLVE_CONCURRENCY,async d=>{
  const base={dispatchId:d.dispatchId,operationId:d.proposalOperationId,recipientInstanceId:d.recipientInstanceId,phase:d.phase};
  if(!d.proposalOperationId)return {...base,proposal:null,execution:null,executionError:'execution_unavailable' as TaskHostReadReason};
  let proposal:TaskProposal|null=null,execution=null,executionError:TaskHostReadReason|null=null;
  try{
   proposal=(await readTaskHostProposal(taskId,d.proposalOperationId,true,deadline)).item;
   // Task binding is checked by readTaskHostProposal; recipient and Dispatch binding are checked here.
   if(proposal.versions.some(v=>v.draft.agentId!==d.recipientInstanceId)||proposal.dispatchId!==d.dispatchId)throw new TaskHostError('Saved assignment binding differs.',409);
  }catch(e){if(e instanceof TaskHostError&&/another task|binding differs/.test(e.message))throw e;executionError=readReason(e,deadline);if(executionError==='deadline')mark('deadline');return {...base,proposal:null,execution:null,executionError};}
  try{execution=await readTaskHostExecution(taskId,d.proposalOperationId,deadline);if(execution.item.dispatchId!==d.dispatchId)throw new TaskHostError('Saved assignment binding differs.',409);}
  catch(e){if(e instanceof TaskHostError&&/binding differs/.test(e.message))throw e;executionError=readReason(e,deadline);if(executionError==='deadline')mark('deadline');execution=null;}
  return {...base,proposal,execution,executionError};
 });
 // Unresolved = a Dispatch that is not RESULT_RECORDED and whose worker is not known to have finished without effect.
 // A pilot-era approval read on a kit host (read-only legacy route) with no execution attempt can never start: terminal.
 const terminal=(phase:string|undefined,ex:{worker:{status:string}|null;legacy?:true}|null)=>phase==='RESULT_RECORDED'||ex?.worker?.status==='EXECUTION_REJECTED'||(!!ex?.legacy&&ex.worker===null);
 const blockingDispatchIds=[...rounds.filter(r=>r.proposal.dispatchId&&!terminal(byDispatch.get(r.proposal.dispatchId)?.phase,r.execution)).map(r=>r.proposal.dispatchId as string),
  ...external.filter(x=>!terminal(x.phase,x.execution)).map(x=>x.dispatchId)];
 const blocking=[...rounds.filter(r=>r.proposal.dispatchId&&!terminal(byDispatch.get(r.proposal.dispatchId)?.phase,r.execution)).map(r=>r.operationId),
  ...external.filter(x=>x.operationId&&!terminal(x.phase,x.execution)).map(x=>x.operationId as string)];
 return taskHostDelegationsV2Schema.parse({ok:true,contract:'kapelle.task-host-delegations/v2',taskId,instanceId,rounds,external,
  discovery:{complete:reason===null,nextCursor:cursor,reason},blockingOperationIds:[...new Set(blocking)],blockingDispatchIds:[...new Set(blockingDispatchIds)],next,
  ...(context&&context.pilot!==undefined?{pilot:context.pilot}:{})});
}

/** Increment 2 §3 status (v2): durable execution facts + a separate, bounded independent readback of the published Report.
 * 'unavailable' never claims fresh verification; the caller keeps its last confirmed state. GET only; no side effects. */
export async function readTaskHostStatusV2(taskId:string,operationId:string):Promise<TaskHostStatusV2>{
 const deadline=AbortSignal.timeout(TASK_HOST_READ_BUDGET_MS);
 const execution=await readTaskHostExecution(taskId,operationId,deadline),worker=execution.worker;
 const out=(readback:TaskHostStatusV2['readback'])=>taskHostStatusV2Schema.parse({ok:true,contract:'kapelle.task-host-status/v2',execution,readback});
 if(worker?.status!=='REPORT_PUBLISHED'||!worker.result)return out({state:'not_applicable',checkedAt:null,reason:null});
 const result=worker.result;
 try{
  const {location,read}=await readResultReport(result.reportId,deadline);
  if(read.availability!=='authoritative')return out(read.availability==='not-found'?{state:'changed',checkedAt:null,reason:'report_changed'}:{state:'unavailable',checkedAt:null,reason:deadline.aborted?'deadline':'reader_unavailable'});
  const ok=reportMatchesResult(read.report,result,execution.item.dispatchId);
  return out(ok?{state:'verified',checkedAt:new Date().toISOString(),reason:null,...(location==='private'?{location}:{})}:{state:'changed',checkedAt:null,reason:'report_changed'});
 }catch{return out({state:'unavailable',checkedAt:null,reason:deadline.aborted?'deadline':'reader_unavailable'});}
}

/** One deterministic assignment (Task, recipient, round) read directly from native records, for the scoped chat surface.
 * No discovery scan: the proposal by its derived operation id (every version must name this Task, operation and recipient),
 * then status v2 when it was approved. Never another assignment, never a write. */
export async function readBoundAssignment(taskId:string,instanceId:string,round:number){
 const operationId=await delegationOperationId(taskId,instanceId,round,hash);
 let proposal:TaskProposal|null=null;
 try{proposal=(await readTaskHostProposal(taskId,operationId,true)).item;}
 catch(e){if(!(e instanceof TaskHostError&&e.status===404))throw e;}
 if(proposal&&proposal.versions.some(v=>v.draft.agentId!==instanceId||v.draft.operationId!==operationId||v.draft.taskId!==taskId))throw new TaskHostError('Saved plan belongs to another assignment.',403);
 let status:TaskHostStatusV2|null=null,statusError:TaskHostReadReason|null=null;
 if(proposal?.dispatchId){try{status=await readTaskHostStatusV2(taskId,operationId);}catch(e){statusError=e instanceof TaskHostError&&e.status===409?'worker_bound_elsewhere':'execution_unavailable';}}
 if(status&&(status.execution.item.agentId!==instanceId||status.execution.item.dispatchId!==proposal!.dispatchId))throw new TaskHostError('Saved work belongs to another assignment.',403);
 return {round,operationId,proposal,status,statusError};
}

/** Owner-private Reports never enter the shared Registry; the Framework serves them only on its owner-token gateway.
 *  null = not a private Report (404). Read-only. */
const privateReportSchema=z.object({ok:z.literal(true),contract:z.literal('kapelle.private-report/v1'),report:z.object({
 documentId:z.string().uuid(),reportRef:z.string(),sourceRef:z.string(),producerId:z.string(),dispatchId:z.string().uuid(),taskId:z.string(),lifecycle:z.literal('FINAL'),
 contentVersion:z.number().int().positive(),contentHash:z.string().regex(/^sha256:[a-f0-9]{64}$/),byteSize:z.number().int().nonnegative(),markdown:z.string().max(32000),
 publishedAt:z.string(),classification:z.literal('owner-private')}).strict()}).strict();
export type PrivateReport=z.infer<typeof privateReportSchema>['report'];
export async function readPrivateReport(documentId:string,signal?:AbortSignal):Promise<PrivateReport|null>{
 const id=z.string().uuid().parse(documentId);
 try{const r=privateReportSchema.parse(await upstream('/private-reports/'+id,undefined,signal)).report;
  if(r.documentId!==id||createHash('sha256').update(r.markdown).digest('hex')!==r.contentHash.slice(7)||Buffer.byteLength(r.markdown)!==r.byteSize)throw new TaskHostError('The private Report could not be verified.',503);
  return r;}
 catch(e){if(e instanceof TaskHostError&&e.status===404)return null;throw e;}
}
/** A saved result's Report from where it lives: the owner-private gateway first (a 404 there means "not private"), else the
 *  Registry point read. The private view is shaped like a Registry read so the same exact-match check applies. */
async function readResultReport(reportId:string,signal?:AbortSignal):Promise<{location:'registry'|'private';read:Awaited<ReturnType<typeof readReportDocumentForBinding>>}>{
 if(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(reportId)&&taskHostEnabled()){
  const p=await readPrivateReport(reportId,signal);
  if(p)return {location:'private',read:{availability:'authoritative',error:null,report:{documentId:p.documentId,reportRef:p.reportRef,title:'Private Report',projectRef:null,sourceRef:p.sourceRef,revision:1,
   producer:{kind:'AGENT',id:p.producerId,label:null},lifecycle:'FINAL',attention:{request:'NONE',reason:null,reviewBy:null,requestedAt:null,resolvedAt:null,resolution:null},review:{openedAt:null,readAt:null,feedback:[]},
   content:{storage:'INLINE_MARKDOWN',mimeType:'text/markdown',filename:null,contentHash:p.contentHash.slice(7),byteSize:p.byteSize,markdown:p.markdown,blobRef:null},createdAt:p.publishedAt,updatedAt:p.publishedAt}}};
 }
 return {location:'registry',read:await readReportDocumentForBinding(reportId,signal)};
}
/** The exact published Report: same document, FINAL, this Dispatch, inline bytes whose declared and recomputed hash and size
 * equal the saved result. Shared by status v2 and the prior-result read. */
type BindingReport=Extract<Awaited<ReturnType<typeof readReportDocumentForBinding>>,{availability:'authoritative'}>['report'];
function reportMatchesResult(report:BindingReport,result:{reportId:string;contentHash:string},dispatchId:string){
 const content=report.content.markdown;
 return report.documentId===result.reportId&&report.lifecycle==='FINAL'&&report.sourceRef==='dispatch:'+dispatchId
  &&report.content.storage==='INLINE_MARKDOWN'&&content!==null&&report.content.contentHash.replace(/^sha256:/,'')===result.contentHash.slice(7)
  &&createHash('sha256').update(content).digest('hex')===result.contentHash.slice(7)&&Buffer.byteLength(content,'utf8')===report.content.byteSize;
}

/** Owner decision (Oct 14), "Revise or run again": a bounded excerpt of an assignment's VERIFIED Report, so the owner can carry it
 * into the next plan's instructions (visible and editable before saving). GET only; refuses anything not independently verified. */
export const PRIOR_RESULT_EXCERPT_CHARS=1500;
export async function readTaskHostPriorResult(taskId:string,operationId:string){
 const deadline=AbortSignal.timeout(TASK_HOST_READ_BUDGET_MS);
 const execution=await readTaskHostExecution(taskId,operationId,deadline),w=execution.worker;
 if(w?.status!=='REPORT_PUBLISHED'||!w.result)throw new TaskHostError('This assignment has no published Report.',409);
 let read;try{const r=await readResultReport(w.result.reportId,deadline);
  // Owner-private Report text is never copied into plan text (plans are not private-classified).
  if(r.location==='private')throw new TaskHostError('Private Reports are not copied into a new plan. Open it from the private view.',409);
  read=r.read;}catch(e){if(e instanceof TaskHostError&&e.status===409)throw e;throw new TaskHostError('The previous Report could not be read right now.',503);}
 if(read.availability!=='authoritative')throw new TaskHostError('The previous Report could not be read right now.',503);
 if(!reportMatchesResult(read.report,w.result,execution.item.dispatchId))throw new TaskHostError('The previous Report no longer matches its saved result.',409);
 // Only bytes covered by the verified content hash are returned (the Report title is not, so it is omitted).
 const markdown=read.report.content.markdown!;
 return {ok:true as const,contract:'kapelle.task-host-prior-result/v1' as const,operationId,dispatchId:execution.item.dispatchId,reportId:w.result.reportId,
  excerpt:markdown.slice(0,PRIOR_RESULT_EXCERPT_CHARS),truncated:markdown.length>PRIOR_RESULT_EXCERPT_CHARS};
}

/** AGENT-MODEL-V2: the kit agents the owner may choose for this Task: available task-selected agents (with their suggested
 *  scopes) plus the Task's fixed-project kit agent, if any. Read-only; at most 20 agents are described. */
const agentScopeSchema=z.object({kinds:z.array(z.enum(['project','folder'])),defaults:z.array(planSourceSchema.shape.scope)}).strict();
export async function readTaskHostAgentChoices(taskId:string){
 if(process.env.KAPELLE_TASK_HOST_KIT!=='1')return {ok:true as const,defaultAgentId:null,agents:[]};
 const [def,roster]=await Promise.all([readKitAdmission(taskId),upstream(rosterPath(taskId)).then(r=>rosterSchema.parse(r))]);
 if(roster.task.taskId!==taskId)throw new TaskHostError('Task identity differs.');
 const agents=(await mapBounded(roster.agents.slice(0,20),RESOLVE_CONCURRENCY,async a=>{
  try{
   const d=z.object({ok:z.literal(true),availability:z.string(),kitDefinition:z.boolean().optional(),scope:agentScopeSchema.nullable().optional()}).passthrough().parse(await upstream('/agents/'+encodeURIComponent(a.id)+'/availability'));
   if(!d.kitDefinition||d.availability!=='available')return null;
   if(d.scope)return {id:a.id,name:a.name,scope:d.scope};
   return def&&def.instanceId===a.id?{id:a.id,name:a.name,scope:null}:null;
  }catch{return null;}
 })).filter((x):x is NonNullable<typeof x>=>!!x);
 return {ok:true as const,defaultAgentId:def?.instanceId??null,agents};
}
