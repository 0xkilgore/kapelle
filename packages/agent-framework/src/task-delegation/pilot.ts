import {recoveryFor} from './recovery.js';
import {z} from 'zod';
import {canonical,digest} from '../content.js';
import {assert} from '../validation.js';
import type {DefinitionProof,TrustedContext} from '../command-boundary.js';
import type {DispatchOffer} from '../../document-models/dispatch/v1/index.js';
const id=z.string().min(1).max(200),hash=z.string().regex(/^sha256:[a-f0-9]{64}$/),hex=z.string().regex(/^[a-f0-9]{64}$/);
/** Reviewed eligibility only. Never a production qualification or live success receipt. */
export const pilotSchema=z.object({
 mode:z.literal('single-task-pilot'),liveOutcome:z.literal('PENDING'),
 ownerId:id,scopeRef:id,instanceId:id,taskId:id,permissionRef:id,
 runtimeBindingRef:id,definitionHash:hash,modelPolicyHash:hash,
 planHash:hash,operationId:z.string().uuid(),sourceHash:hex,packetHash:hash,
 approvedAt:z.iso.datetime(),expiresAt:z.iso.datetime(),recoveryExpiresAt:z.iso.datetime(),
}).strict().refine(p=>Date.parse(p.expiresAt)-Date.parse(p.approvedAt)===7200000&&Date.parse(p.recoveryExpiresAt)-Date.parse(p.approvedAt)===86400000,'pilot_fixed_lifetimes');
export type TaskPilot=z.infer<typeof pilotSchema>;
export function pilotIdentity(raw:unknown,ctx:Pick<TrustedContext,'ownerId'|'scopeRef'>,instanceId:string){
 const p=pilotSchema.parse(raw);
 assert(p.ownerId===ctx.ownerId&&p.scopeRef===ctx.scopeRef&&p.instanceId===instanceId,'pilot_scope_or_expiry');return p;
}
export function currentPilot(raw:unknown,ctx:Pick<TrustedContext,'ownerId'|'scopeRef'|'occurredAt'>,instanceId:string){
 const p=pilotIdentity(raw,ctx,instanceId);
 assert(p.approvedAt<=ctx.occurredAt&&p.expiresAt>ctx.occurredAt,'pilot_scope_or_expiry');return p;
}
/** These commands only reduce authority. They never admit work or extend a grant. */
export const pilotConservativeControl=(type:string)=>['REQUEST_PAUSE','REVOKE_CAPABILITY','RETIRE_INSTANCE'].includes(type);
/** Expiry exception exists only inside a worker-validated completed-claim scope. */
export function pilotAccess(raw:unknown,ctx:Pick<TrustedContext,'ownerId'|'scopeRef'|'occurredAt'>,instanceId:string){
 const p=pilotIdentity(raw,ctx,instanceId);const recovery=recoveryFor(p);
 assert(p.approvedAt<=ctx.occurredAt&&(recovery?ctx.occurredAt<p.recoveryExpiresAt:p.expiresAt>ctx.occurredAt),'pilot_scope_or_expiry');return p;
}
export function pilotFor(proofs:readonly DefinitionProof[],instanceId:string){return proofs.find(d=>!d.qualified&&d.pilot?.instanceId===instanceId)?.pilot;}
export function pilotTask(p:TaskPilot,taskId:string,permissionRef:string){assert(p.taskId===taskId&&p.permissionRef===permissionRef,'pilot_task_or_permission');}
export function pilotPlan(p:TaskPilot,draft:{taskId:string;operationId:string;sourceHash:string;approval?:{planHash:string}},planHash=draft.approval?.planHash){
 assert(draft.taskId===p.taskId&&draft.operationId===p.operationId&&draft.sourceHash===p.sourceHash&&planHash===p.planHash,'pilot_exact_plan_required');
}
export function pilotOffer(p:TaskPilot,offer:DispatchOffer){
 pilotTask(p,offer.task.taskRef,offer.permissionRef);
 assert(offer.sources.length===1&&offer.sources[0].documentType==='task-authority/task'&&offer.sources[0].documentRef===p.taskId,'pilot_exact_task_source_required');
 assert(offer.task.authorityRef==='task-authority'&&!offer.senderAgent&&!offer.parentDispatchRef&&!offer.continuationOfRef&&offer.senderId===p.ownerId,'pilot_direct_owner_task_only');
 const e=JSON.parse(offer.instructions);
 assert(e.kind==='kapelle.task-delegation/v1'&&e.draft?.approval,'pilot_approval_required');pilotPlan(p,e.draft);
}
/** Called in addition to existing native lifecycle checks, never instead of them. */
export function pilotLifecycle(p:TaskPilot,type:string,input:any){
 assert(['CREATE_INSTANCE','GRANT_CAPABILITY','SET_MODEL_POLICY','SET_RUNTIME_BINDING','REQUEST_RESUME','REQUEST_PAUSE','RETIRE_INSTANCE','REVOKE_CAPABILITY'].includes(type),'pilot_lifecycle_only');
 if(type==='CREATE_INSTANCE'||type==='SET_MODEL_POLICY')assert(digest(input.modelPolicy)===p.modelPolicyHash&&!input.modelPolicy.paidFallback,'pilot_model_policy');
 if(type==='SET_RUNTIME_BINDING')assert(input.runtimeBindingRef===p.runtimeBindingRef,'pilot_runtime_binding');
 if(type==='GRANT_CAPABILITY'){
  const g=input.grant,actions=g.resourceRef===p.taskId?['read']:g.resourceRef===p.permissionRef?['receive']:[];
  assert(g.principalId===p.instanceId&&actions.length>0&&g.actions.length>0&&g.actions.every((a:string)=>actions.includes(a))&&g.expiresAt<=p.recoveryExpiresAt,'pilot_grant_scope');
 }
}
export function projectDefinition(release:DefinitionProof['release'],proofs:readonly DefinitionProof[]):DefinitionProof{
 const matches=proofs.filter(p=>canonical(p.release)===canonical(release));
 if(matches.some(p=>p.qualified))return {release,qualified:true};
 const pilots=matches.filter(p=>p.pilot);assert(pilots.length<=1,'pilot_ambiguous');
 return {release,qualified:false,...(pilots[0]?.pilot?{pilot:pilotSchema.parse(pilots[0].pilot)}:{})};
}

export const pilotEligibilitySchema=z.object({
 contract:z.literal('kapelle.single-task-pilot-eligibility/v1'),status:z.literal('ELIGIBLE'),liveOutcome:z.literal('PENDING'),
 bindingHash:hash,publisherSourceHash:hash,approvedAt:z.iso.datetime(),admissionExpiresAt:z.iso.datetime(),expiresAt:z.iso.datetime(),
 sourcePins:z.array(z.object({path:z.string().startsWith('/'),sha256:hex}).strict()).min(1).max(4096),
 dependencyPins:z.array(z.object({path:z.string().startsWith('/'),sha256:hex}).strict()).min(1).max(65536),
}).strict();

/** Increment 2: read-only pilot signals for the console (GET /task-executions/pilot). Additive and separate from the strict
 * admission contract, so older consoles never see it. It grants nothing: the claim singleton, pilotPlan and admission checks
 * remain the execution boundary. Signals:
 * - newWorkEnded: outside [approvedAt, expiresAt), or the single pilot invocation is already consumed;
 * - pinnedPlan: for the pilot's own Task, the only plan the authority admits (draft operation id, source hash, plan hash);
 *   plan edits from the console cannot be admitted, so the console shows it read-only. Null for any other Task. */
export const pilotSignalsSchema=z.object({mode:z.literal('single-task-pilot'),taskBound:z.boolean(),newWorkEndsAt:z.iso.datetime(),
 newWorkEnded:z.boolean(),invocationConsumed:z.boolean(),
 pinnedPlan:z.object({operationId:z.string().uuid(),sourceHash:hex,planHash:hash}).strict().nullable()}).strict();
export type PilotSignals=z.infer<typeof pilotSignalsSchema>;
export function pilotSignals(p:TaskPilot,taskId:string,occurredAt:string,invocationConsumed:boolean):PilotSignals{
 const taskBound=p.taskId===taskId;
 return pilotSignalsSchema.parse({mode:'single-task-pilot',taskBound,newWorkEndsAt:p.expiresAt,
  newWorkEnded:!(p.approvedAt<=occurredAt&&occurredAt<p.expiresAt)||invocationConsumed||!taskBound,invocationConsumed,
  pinnedPlan:taskBound?{operationId:p.operationId,sourceHash:p.sourceHash,planHash:p.planHash}:null});
}
