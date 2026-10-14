import 'server-only';
import {validateTaskHostSources} from './taskSourcePacket';
import {createHash} from 'node:crypto';
import {readReportDocumentForBinding} from './reportRegistryUncached';
import {z} from 'zod';
import {nativeDraftSchema,rosterSchema} from './nativeDelegationContract';
import {approvedReceiptSchema,canonicalProposal,proposalPlanSchema,validateProposal} from './taskProposalContract';
import {readyTaskHost,taskHostAdmissionSchema,taskHostWorkerSchema,validateTaskHostExecution,taskHostClaimSchema,taskHostDelegationsV2Schema,taskHostStatusV2Schema,taskHostPilotSchema,type TaskHostReadReason,type TaskHostDelegationsV2,type TaskHostStatusV2} from './taskHostContract';

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
export async function readTaskHostContext(taskId:string,signal?:AbortSignal){
 const [r,a,p]=await Promise.all([upstream('/task-delegations/agents?taskId='+encodeURIComponent(taskId),undefined,signal),upstream('/task-executions/admission?taskId='+encodeURIComponent(taskId),undefined,signal),readTaskHostPilot(taskId,signal)]);
 const admission=taskHostAdmissionSchema.parse(a);
 const context={ok:true as const,roster:rosterSchema.parse(r),admission,...(p&&p.instanceId===admission.instanceId?{pilot:p.pilot}:{})};
 if(context.roster.task.taskId!==taskId)throw new TaskHostError('Task identity differs.');return context;
}
export async function readTaskHostSources(taskId:string,context?:Awaited<ReturnType<typeof readTaskHostContext>>){
 const current=context??await readTaskHostContext(taskId);
 return validateTaskHostSources(await upstream('/task-executions/sources?taskId='+encodeURIComponent(taskId)),current,hash);
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
 const worker=taskHostWorkerSchema.nullable().parse((await upstream('/task-executions/'+before.dispatchId,undefined,signal)).item);
 // Read the native result after the worker status so a just-published result is observable.
 return validateTaskHostExecution({ok:true,item:await receipt(taskId,operationId,signal),worker},taskId,operationId);
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
  const read=await readReportDocumentForBinding(result.reportId);
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
 // respond:'claim' (Increment 2): return the Framework's claim/settled answer promptly; no synchronous post-run read.
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
export async function commandTaskHost(taskId:string,raw:unknown){
 const body=taskHostCommandSchema.parse(raw);
 if(body.action==='run'){
  const saved=await receipt(taskId,body.operationId);
  // The host rechecks the exact installed binding and saved Dispatch on every run/recovery.
  const claimed=await upstream('/task-executions/'+saved.dispatchId+'/run',{});
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
 if(body.action==='reviseProposal')await readTaskHostProposal(taskId,body.proposalId);
 const context=await readTaskHostContext(taskId);
 if(!readyTaskHost(context))throw new TaskHostError('No admitted task worker is available for this task.',409);
 const current=body.action==='createProposal'||body.action==='reviseProposal'?body.payload.draft:(await readTaskHostProposal(taskId,body.proposalId)).item.versions.at(-1)!.draft;
 if(current.taskId!==taskId||current.revision!==context.admission.taskRevision||current.sourceHash!==context.admission.sourceHash||current.agentId!==context.admission.instanceId||canonicalProposal(current.recipient)!==canonicalProposal(context.roster.agents.find(a=>a.id===context.admission.instanceId)?.recipient)||!current.includeNotes)throw new TaskHostError('Task context or worker admission changed. Refresh before approval.',409);
 await readTaskHostSources(taskId,context);
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

// ---- Increment 2 console data path (v2; additive) ----
/** Total read budget of one discovery/status interaction (hard 5 s; bounded partial results). */
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

/** Increment 2 discovery (v2). Read only (GET verbs only). Finds:
 * - deterministic page slots of the CURRENTLY admitted instance: all 12 are probed (a hole does not stop the probe);
 * - every Task-filtered Dispatch across historical recipients (50/page, at most 3 pages; `nextCursor` to load older);
 *   Dispatches that are not a current slot are `external` (no fabricated round).
 * Current admission is read separately: its failure never aborts history. Any page/slot/item left unresolved within the
 * budget makes the result explicitly incomplete with a fixed reason; an incomplete result cannot enable prepare/start. */
export async function findTaskHostDelegationsV2(taskId:string,options:{cursor?:string|null}={}):Promise<TaskHostDelegationsV2>{
 const deadline=AbortSignal.timeout(TASK_HOST_READ_BUDGET_MS);
 let reason:TaskHostReadReason|null=null;const mark=(r:TaskHostReadReason)=>{reason??=r;};
 const contextP=readTaskHostContext(taskId,deadline).then(c=>c,()=>null);
 const dispatches:DispatchList['items']=[];let cursor:string|null=options.cursor??null,pages=0;
 try{do{const page=await readTaskHostTaskDispatches(taskId,cursor,deadline);dispatches.push(...page.items);cursor=page.nextCursor;pages++;}while(cursor&&pages<DISCOVERY_MAX_PAGES);}
 catch(e){if(e instanceof TaskHostError&&e.message.includes('another task'))throw e;mark(deadline.aborted?'deadline':'host_unavailable');}
 if(cursor)mark('page_limit');
 const context=await contextP,instanceId=context?.admission.instanceId??null;
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
 const terminal=(phase:string|undefined,ex:{worker:{status:string}|null}|null)=>phase==='RESULT_RECORDED'||ex?.worker?.status==='EXECUTION_REJECTED';
 const blockingDispatchIds=[...rounds.filter(r=>r.proposal.dispatchId&&!terminal(byDispatch.get(r.proposal.dispatchId)?.phase,r.execution)).map(r=>r.proposal.dispatchId as string),
  ...external.filter(x=>!terminal(x.phase,x.execution)).map(x=>x.dispatchId)];
 const blocking=[...rounds.filter(r=>r.proposal.dispatchId&&!terminal(byDispatch.get(r.proposal.dispatchId)?.phase,r.execution)).map(r=>r.operationId),
  ...external.filter(x=>x.operationId&&!terminal(x.phase,x.execution)).map(x=>x.operationId as string)];
 return taskHostDelegationsV2Schema.parse({ok:true,contract:'kapelle.task-host-delegations/v2',taskId,instanceId,rounds,external,
  discovery:{complete:reason===null,nextCursor:cursor,reason},blockingOperationIds:[...new Set(blocking)],blockingDispatchIds:[...new Set(blockingDispatchIds)],next,
  ...(context&&context.pilot!==undefined?{pilot:context.pilot}:{})});
}

/** Increment 2 status (v2): durable execution facts + a separate, bounded independent readback of the published Report.
 * 'unavailable' never claims fresh verification; the caller keeps its last confirmed state. GET only; no side effects. */
export async function readTaskHostStatusV2(taskId:string,operationId:string):Promise<TaskHostStatusV2>{
 const deadline=AbortSignal.timeout(TASK_HOST_READ_BUDGET_MS);
 const execution=await readTaskHostExecution(taskId,operationId,deadline),worker=execution.worker;
 const out=(readback:TaskHostStatusV2['readback'])=>taskHostStatusV2Schema.parse({ok:true,contract:'kapelle.task-host-status/v2',execution,readback});
 if(worker?.status!=='REPORT_PUBLISHED'||!worker.result)return out({state:'not_applicable',checkedAt:null,reason:null});
 const result=worker.result;
 try{
  const read=await readReportDocumentForBinding(result.reportId,deadline);
  if(read.availability!=='authoritative')return out(read.availability==='not-found'?{state:'changed',checkedAt:null,reason:'report_changed'}:{state:'unavailable',checkedAt:null,reason:deadline.aborted?'deadline':'reader_unavailable'});
  const ok=reportMatchesResult(read.report,result,execution.item.dispatchId);
  return out(ok?{state:'verified',checkedAt:new Date().toISOString(),reason:null}:{state:'changed',checkedAt:null,reason:'report_changed'});
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
 let read;try{read=await readReportDocumentForBinding(w.result.reportId,deadline);}catch{throw new TaskHostError('The previous Report could not be read right now.',503);}
 if(read.availability!=='authoritative')throw new TaskHostError('The previous Report could not be read right now.',503);
 if(!reportMatchesResult(read.report,w.result,execution.item.dispatchId))throw new TaskHostError('The previous Report no longer matches its saved result.',409);
 // Only bytes covered by the verified content hash are returned (the Report title is not, so it is omitted).
 const markdown=read.report.content.markdown!;
 return {ok:true as const,contract:'kapelle.task-host-prior-result/v1' as const,operationId,dispatchId:execution.item.dispatchId,reportId:w.result.reportId,
  excerpt:markdown.slice(0,PRIOR_RESULT_EXCERPT_CHARS),truncated:markdown.length>PRIOR_RESULT_EXCERPT_CHARS};
}
