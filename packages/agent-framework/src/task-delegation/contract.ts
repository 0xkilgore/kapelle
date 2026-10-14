import {pilotAccess,pilotTask,type TaskPilot} from './pilot.js';
import {digest} from '../content.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonical } from '../content.js';
import type { TrustedContext } from '../command-boundary.js';
import type { DispatchOffer } from '../../document-models/dispatch/v1/index.js';
import type { AgentInstanceState } from '../../document-models/agent-instance/v1/index.js';
import { assert } from '../validation.js';
export const contract = 'kapelle.task-delegation/v1' as const;
export const sha = (s:string) => createHash('sha256').update(s).digest('hex');
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const pinSchema = z.object({instanceId:id,definitionId:id,definitionVersion:z.string().min(1),definitionHash:z.string().regex(/^sha256:[a-f0-9]{64}$/),runtimeBindingRef:id,capabilityHash:hex}).strict();
export const approvalSchema=z.object({proposalId:id,version:z.number().int().positive(),planHash:z.string().regex(/^sha256:[a-f0-9]{64}$/),operationId:z.string().uuid()}).strict();
export const draftSchema = z.object({approval:approvalSchema.optional(),operationId:z.string().uuid(),taskId:id,revision:z.number().int().nonnegative(),agentId:id,recipient:pinSchema,instructions:z.string().trim().min(1).max(4000),includeNotes:z.boolean(),includeComments:z.boolean(),includeReferences:z.boolean(),sourceHash:hex}).strict();
export type Draft = z.infer<typeof draftSchema>;
export const taskSchema = z.object({id,ownerId:id,revision:z.number().int().nonnegative(),title:z.string().min(1).max(500),status:z.enum(['OPEN','SNOOZED','BLOCKED','DONE','ARCHIVED']),projectId:z.string().nullable(),bodyMarkdown:z.string(),comments:z.array(z.object({bodyMarkdown:z.string()})).max(250),externalRefs:z.array(z.object({authority:z.string(),opaqueId:z.string()})).max(250)});
export type Task = z.infer<typeof taskSchema>;
export interface TaskDelegationOptions {
 /** Installed by the immutable pilot runtime, never accepted from a request. */
 pilot?:TaskPilot;
 readTask(id:string):Promise<Task>;
 /** Host-owned scoped receive resource, never supplied by the browser. */
 permissionRef:string;
}
export function taskSource(task:Task){
 const value={taskId:task.id,revision:task.revision,title:task.title,status:task.status,projectId:task.projectId,notes:task.bodyMarkdown,comments:task.comments.map(c=>c.bodyMarkdown),references:task.externalRefs.map(r=>`${r.authority}: ${r.opaqueId}`)};
 const content=JSON.stringify(value);assert(Buffer.byteLength(content)<=262144,'Task source too large');
 return {...value,sourceHash:sha(content)};
}
export function selectedSource(task:Task,draft:Draft){
 const p=taskSource(task);
 const content=JSON.stringify({taskId:p.taskId,revision:p.revision,title:p.title,...(draft.includeNotes?{notes:p.notes}:{}),...(draft.includeComments?{comments:p.comments}:{}),...(draft.includeReferences?{references:p.references}:{})});
 assert(Buffer.byteLength(content)<=24000,'Task selected context too large');
 return {authority:'task-authority' as const,content,hash:sha(content)};
}
export function acceptedEnvelope(task:Task,draft:Draft,approvedPlan?:unknown){
 assert(task.id===draft.taskId&&task.revision===draft.revision&&taskSource(task).sourceHash===draft.sourceHash&&!['DONE','ARCHIVED'].includes(task.status),'Task source changed');
 const e={kind:contract,draft,...(approvedPlan===undefined?{}:{approvedPlan}),instructionHash:sha(JSON.stringify(draft.instructions)),source:selectedSource(task,draft)};
 const text=JSON.stringify(e);assert(Buffer.byteLength(text)<=32000,'Task selected context too large');return e;
}
export function parseEnvelope(offer:DispatchOffer){
 const raw=JSON.parse(offer.instructions);
 assert(raw?.kind===contract,'Task delegation envelope unavailable');
 const draft=draftSchema.parse(raw.draft);
 assert(raw.instructionHash===sha(JSON.stringify(draft.instructions))&&raw.source?.authority==='task-authority'&&typeof raw.source.content==='string'&&raw.source.hash===sha(raw.source.content),'Task source envelope differs');
 return {kind:contract,draft,...(raw.approvedPlan===undefined?{}:{approvedPlan:raw.approvedPlan}),instructionHash:raw.instructionHash as string,source:raw.source as {authority:'task-authority';content:string;hash:string}};
}
export function qualifiedRecipient(state:AgentInstanceState,ctx:TrustedContext,taskId:string,permissionRef:string){
 const ref=state.definitionRef;
 const proof=ctx.definitions.find(d=>d.release.definitionId===ref?.id&&d.release.packageVersion===ref?.version&&d.release.contentHash===ref?.contentHash);
 if(proof&&!proof.qualified&&proof.pilot){const p=pilotAccess(proof.pilot,ctx,state.instanceId!);pilotTask(p,taskId,permissionRef);assert(p.definitionHash===ref?.contentHash&&p.runtimeBindingRef===state.runtimeBindingRef&&p.modelPolicyHash===digest(state.modelPolicy),'pilot_recipient_changed');}
 const definition=proof&&(proof.qualified||proof.pilot)?proof.release:undefined;
 const grant=(resource:string,action:string)=>state.grants.some(g=>g.principalId===state.instanceId&&g.resourceRef===resource&&g.actions.includes(action)&&!g.revokedAt&&g.expiresAt>ctx.occurredAt);
 assert(state.instanceId&&state.ownerId===ctx.ownerId&&state.scopeRef===ctx.scopeRef&&state.desiredState==='READY'&&definition&&state.runtimeBindingRef&&ctx.runtimeBindingRefs.includes(state.runtimeBindingRef)&&ctx.runtimeBindingContracts[state.runtimeBindingRef]===contract&&definition.runtimeContracts.includes(contract),'Task recipient unavailable');
 assert(definition.capabilities.some(c=>c.resourceType==='task'&&c.actions.includes('read'))&&definition.capabilities.some(c=>c.resourceType==='task-delegation'&&c.actions.includes('receive'))&&grant(taskId,'read')&&grant(permissionRef,'receive')&&ctx.resources.some(r=>r.id===permissionRef&&r.resourceType==='task-delegation'&&r.allowedActions.includes('receive')&&r.allowedActions.includes('dispatch')),'Task recipient capability unavailable');
 assert(state.modelPolicy&&!state.modelPolicy.paidFallback&&definition.modelProfiles.includes(state.modelPolicy.preferredProfile)&&ctx.budgetPolicyRefs.includes(state.modelPolicy.budgetPolicyRef),'Task recipient model policy unavailable');
 const capabilityHash=sha(canonical({ref,runtimeBindingRef:state.runtimeBindingRef,capabilities:definition.capabilities,grants:state.grants.filter(g=>[taskId,permissionRef].includes(g.resourceRef)),modelPolicy:state.modelPolicy}));
 return {instanceId:state.instanceId,definitionId:ref!.id,definitionVersion:ref!.version,definitionHash:ref!.contentHash,runtimeBindingRef:state.runtimeBindingRef,capabilityHash};
}
/** Called inside the existing native command lock, from current Task authority reads. */
export async function bindTaskFacts(ctx:TrustedContext,offer:DispatchOffer,options:TaskDelegationOptions){
 const e=parseEnvelope(offer);
 // Native recipient authority (READY, grants unrevoked/unexpired, pilot, runtime, model policy, pin) is checked BEFORE the
 // Task HTTP read, so a Task transport failure can never mask a revoked/expired grant or a changed recipient.
 const state=ctx.dispatch?.agents.find(a=>a.instanceId===e.draft.agentId);
 assert(state,'Task recipient unavailable');
 const pin=qualifiedRecipient(state,ctx,e.draft.taskId,options.permissionRef);
 assert(canonical(pin)===canonical(e.draft.recipient)&&e.draft.agentId===pin.instanceId,'Task recipient capability changed');
 const task=taskSchema.parse(await options.readTask(e.draft.taskId));
 assert(task.id===e.draft.taskId&&task.ownerId===ctx.ownerId,'Task owner differs');
 assert(canonical(acceptedEnvelope(task,e.draft,e.approvedPlan))===canonical(e),'Task source changed');
 const expectedRecipient={instanceId:pin.instanceId,definitionId:pin.definitionId,definitionVersion:pin.definitionVersion,definitionHash:pin.definitionHash};
 assert(canonical(offer.recipient)===canonical(expectedRecipient)&&offer.permissionRef===options.permissionRef&&offer.task.authorityRef==='task-authority'&&offer.task.taskRef===task.id&&offer.task.commitmentHash==='sha256:'+e.draft.sourceHash&&offer.sources.length===1&&canonical(offer.sources[0])===canonical({documentRef:task.id,documentType:'task-authority/task',contentVersion:task.revision+1,contentHash:'sha256:'+e.source.hash}),'Task Dispatch binding differs');
 const resource={id:task.id,resourceType:'task',revision:task.revision,contentHash:'sha256:'+e.source.hash,allowedActions:['read']};
 ctx.resources=[...ctx.resources.filter(r=>r.id!==task.id),resource];
 ctx.dispatch={...ctx.dispatch!,tasks:[{authorityRef:'task-authority',taskRef:task.id,ownerId:ctx.ownerId,scopeRef:ctx.scopeRef,commitmentHash:'sha256:'+e.draft.sourceHash,status:task.status}],sources:[{...offer.sources[0],ownerId:ctx.ownerId,scopeRef:ctx.scopeRef}]};
}
