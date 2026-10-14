/** Increment 2 browser-side orchestration for the Task delegation panel. Pure and injectable (no React, no globals):
 * - normalizeDiscovery: validates discovery v2 (every proposal/execution re-bound to this Task, its approval and Dispatch);
 * - selectAssignment / delegationFacts: the selected assignment and the three independent facts for deriveDelegationView;
 * - approveAndStart / continueApproved: ONE busy phase, a stable approval operation id, then exactly one run (respond:'claim');
 * - createStatusPoller: one finite polling controller (no overlap, background pause, 30-minute stop, reads only).
 * Browser storage keeps only the identity of an unsettled request. It never authorizes or resumes work. */
import {receiptMatches} from './nativeDelegationContract';
import {canonicalProposal,validateProposal,type TaskProposal} from './taskProposalContract';
import {readyTaskHost,taskHostClaimSchema,taskHostDelegationsV2Schema,taskHostStatusV2Schema,validateTaskHostExecution,type TaskHostContext,type TaskHostExecution,type TaskHostReadReason,type TaskHostStatusV2} from './taskHostContract';
import type {DelegationFacts} from './delegationState';

type Hash=(s:string)=>Promise<string>;
export type AssignmentItem={key:string;round:number|null;operationId:string|null;dispatchId:string|null;external:boolean;blocking:boolean;
 phase:string|null;proposal:TaskProposal|null;execution:TaskHostExecution|null;executionError:TaskHostReadReason|null};
export type Discovery={items:AssignmentItem[];complete:boolean;reason:TaskHostReadReason|null;nextCursor:string|null;next:{round:number;operationId:string}|null;instanceId:string|null;blockingDispatchIds:string[]};

/** The approved receipt must be exactly the saved approved version: proposal, version, hash, plan bytes and source. */
export function bindExecution(raw:unknown,p:TaskProposal,taskId:string){
 const v=p.versions.at(-1)!,e=validateTaskHostExecution(raw,taskId,v.draft.operationId),r=e.item;
 if(!p.approval||p.dispatchId!==r.dispatchId||r.approval.proposalId!==p.proposalId||r.approval.version!==v.version||r.approval.planHash!==v.planHash||r.approval.operationId!==p.approval.operationId||canonicalProposal(r.approvedPlan)!==canonicalProposal(v.plan)||!receiptMatches(r,v.draft,v.source.content,v.instructionHash,v.source.hash))throw Error('Assignment differs from the approved plan.');
 return e;
}
async function proposalFor(raw:unknown,taskId:string,operationId:string,hash:Hash){
 const p=await validateProposal(raw,hash);
 if(p.versions.some(v=>v.draft.taskId!==taskId||v.draft.operationId!==operationId))throw Error('Saved plan identity differs.');
 return p;
}
export async function normalizeDiscovery(raw:unknown,taskId:string,hash:Hash):Promise<Discovery>{
 const d=taskHostDelegationsV2Schema.parse(raw);
 if(d.taskId!==taskId)throw Error('Saved assignments belong to another task.');
 const blocking=new Set(d.blockingDispatchIds),items:AssignmentItem[]=[];
 for(const r of d.rounds){
  const proposal=await proposalFor(r.proposal,taskId,r.operationId,hash);
  items.push({key:proposal.dispatchId??r.operationId,round:r.round,operationId:r.operationId,dispatchId:proposal.dispatchId,external:false,blocking:!!proposal.dispatchId&&blocking.has(proposal.dispatchId),
   phase:null,proposal,execution:r.execution?bindExecution(r.execution,proposal,taskId):null,executionError:r.executionError});
 }
 for(const x of d.external){
  const proposal=x.proposal&&x.operationId?await proposalFor(x.proposal,taskId,x.operationId,hash):null;
  if(proposal&&proposal.dispatchId!==x.dispatchId)throw Error('Saved assignment binding differs.');
  items.push({key:x.dispatchId,round:null,operationId:x.operationId,dispatchId:x.dispatchId,external:true,blocking:blocking.has(x.dispatchId),phase:x.phase,proposal,
   execution:x.execution&&proposal?bindExecution(x.execution,proposal,taskId):null,executionError:x.execution&&!proposal?'execution_unavailable':x.executionError});
 }
 return {items,complete:d.discovery.complete,reason:d.discovery.reason,nextCursor:d.discovery.nextCursor,next:d.next,instanceId:d.instanceId,blockingDispatchIds:d.blockingDispatchIds};
}
/** "Load older assignments": merge a later page. The result stays incomplete unless every earlier gap was only the page limit. */
export function mergeDiscovery(a:Discovery,b:Discovery):Discovery{
 const keys=new Set(a.items.map(i=>i.key)),onlyPaging=a.complete||a.reason==='page_limit';
 return {...a,items:[...a.items,...b.items.filter(i=>!keys.has(i.key))],complete:onlyPaging&&b.complete,reason:onlyPaging?b.reason:a.reason,nextCursor:b.nextCursor,
  blockingDispatchIds:[...new Set([...a.blockingDispatchIds,...b.blockingDispatchIds])]};
}
/** Apply a status v2 read to its item. The durable facts replace the old ones; the readback is kept separately. */
export function applyStatus(d:Discovery,operationId:string,raw:unknown,taskId:string):{discovery:Discovery;status:TaskHostStatusV2}{
 const status=taskHostStatusV2Schema.parse(raw),i=d.items.findIndex(x=>x.operationId===operationId&&x.proposal);
 if(i<0)throw Error('Status belongs to another assignment.');
 const execution=bindExecution({ok:true,item:status.execution.item,worker:status.execution.worker},d.items[i].proposal!,taskId);
 const items=d.items.slice();items[i]={...items[i],execution,executionError:null};
 return {discovery:{...d,items},status};
}

const at=(i:AssignmentItem)=>i.proposal?.approval?.occurredAt??i.proposal?.versions.at(-1)?.occurredAt??'';
const newest=(xs:AssignmentItem[])=>xs.slice().sort((a,b)=>at(b).localeCompare(at(a))||(b.round??0)-(a.round??0))[0]??null;
/** Selected assignment: the one an unsettled request names, else an unresolved one, else an unapproved saved plan, else the newest. */
export function selectAssignment(items:AssignmentItem[],pending:PendingRequest|null){
 const named=pending&&items.find(i=>i.operationId===pending.operationId);
 if(named)return named;
 return newest(items.filter(i=>i.blocking))??newest(items.filter(i=>i.proposal&&!i.proposal.dispatchId))??newest(items);
}

export type PendingRequest={kind:'create'|'approval'|'start';operationId:string;approvalOperationId?:string;proposalId?:string;version?:number};
/** A request is unsettled only while no authoritative read of its assignment has answered. An answer either shows its effect
 * or shows positive absence (unapproved plan, never-claimed worker), after which the owner may act again with the same ids. */
export function settles(pending:PendingRequest,d:Discovery,readFailed:boolean){
 if(readFailed||!d.complete&&pending.kind==='create')return false;
 const item=d.items.find(i=>i.operationId===pending.operationId);
 if(pending.kind==='create')return true;
 if(!item?.proposal)return false;
 if(pending.kind==='approval')return true;
 return !!item.execution&&item.executionError===null;
}

export type Verification={readback:'verified'|'unavailable'|'changed';verifiedAt:string|null};
export function delegationFacts(o:{discovery:Discovery|null;discoveryFailed:boolean;context:TaskHostContext|null;contextFailed:boolean;sourcesReady:boolean;
 selected:AssignmentItem|null;pending:PendingRequest|null;verification:Verification|null}):DelegationFacts{
 const {discovery:d,context,selected:s}=o;
 const history:DelegationFacts['history']=o.discoveryFailed?'failed':!d?'loading':d.complete?'complete':'incomplete';
 const admitted=!!context&&o.sourcesReady&&readyTaskHost(context);
 const v=s?.proposal?.versions.at(-1);
 const taskChanged=!!v&&!!context&&(v.draft.revision!==context.roster.task.revision||v.draft.sourceHash!==context.roster.task.sourceHash);
 const blockingAssignments=(d?.blockingDispatchIds??[]).filter(id=>id!==s?.dispatchId).length;
 // Pilot signals (absent = unknown → previous behaviour; the Framework still enforces the pilot either way).
 const pilot=context?.pilot??null,bound=!!pilot?.taskBound;
 const pilotExpired=bound&&pilot!.newWorkEnded&&!pilot!.invocationConsumed;
 const newWork:DelegationFacts['newWork']=bound&&pilot!.invocationConsumed?{admitted:false,reason:'pilot_invocation_used'}
  :pilot&&!bound?{admitted:false,reason:'host_not_admitted'}
  :admitted?{admitted:true}:{admitted:false,reason:o.contextFailed?'host_unavailable':'host_not_admitted'};
 const pin=bound?pilot!.pinnedPlan:null;
 const planPinned:DelegationFacts['planPinned']=!pin?'none':!v||s?.proposal?.dispatchId?'pinned'
  :v.draft.operationId===pin.operationId&&v.draft.sourceHash===pin.sourceHash&&v.planHash===pin.planHash?'matches':'differs';
 let assignment:DelegationFacts['assignment']=null;
 if(o.pending&&(!s||s.operationId===o.pending.operationId))assignment={kind:'request-unconfirmed',request:o.pending.kind};
 else if(s&&!s.proposal)assignment={kind:'approved',claim:'unknown'}; // external Dispatch whose plan could not be read
 else if(s&&!s.proposal!.dispatchId)assignment={kind:'saved-unapproved'};
 else if(s){
  const w=s.execution?.worker;
  if(!s.execution||s.executionError)assignment={kind:'approved',claim:'unknown'};
  // Explicit server evidence: the bound worker's durable journal has no attempt for this Dispatch (inspect → null).
  else if(!w)assignment={kind:'approved',claim:'never-claimed'};
  else if(w.status==='REPORT_PUBLISHED')assignment={kind:'result',readback:o.verification?.readback??'unavailable',verifiedAt:o.verification?.verifiedAt??null};
  else assignment={kind:'worker',status:w.status};
 }
 return {history,newWork,pilotExpired,taskChanged,blockingAssignments,assignment,planPinned};
}

export type Api={get:(query:string)=>Promise<unknown>;post:(body:unknown)=>Promise<unknown>};
export type PendingStore={read:()=>PendingRequest|null;write:(p:PendingRequest|null)=>void;approvalId:(proposalId:string,version:number)=>string};
/** A definite refusal committed nothing (stale version, changed context, invalid request). Timeouts and 5xx are unknown. */
const definite=(e:unknown)=>{const s=(e as {status?:number}).status;return s!==undefined&&s>=400&&s<500;};
export type MutationOutcome={outcome:'started'|'unconfirmed'|'refused';message:string|null};

/** One owner action: approve exactly this version (stable approval id), verify the returned approval and Dispatch, then send one
 * run for that same operation. No intermediate Start control; no automatic resend of either request. */
export async function approveAndStart(api:Api,store:PendingStore,p:TaskProposal):Promise<MutationOutcome>{
 const v=p.versions.at(-1)!,operationId=v.draft.operationId,approvalOperationId=store.approvalId(p.proposalId,v.version);
 store.write({kind:'approval',operationId,approvalOperationId,proposalId:p.proposalId,version:v.version});
 let r:{proposal?:TaskProposal;item?:{dispatchId:string;operationId:string}};
 try{r=await api.post({action:'approveProposal',proposalId:p.proposalId,payload:{operationId:approvalOperationId,expectedRevision:p.revision,version:v.version,planHash:v.planHash}}) as typeof r;}
 catch(e){if(definite(e)){store.write(null);return {outcome:'refused',message:e instanceof Error?e.message:null};}return {outcome:'unconfirmed',message:null};}
 const a=r.proposal?.approval;
 if(!r.proposal||!a||!r.item||a.version!==v.version||a.planHash!==v.planHash||r.proposal.dispatchId!==r.item.dispatchId||r.item.operationId!==operationId)return {outcome:'unconfirmed',message:null};
 return start(api,store,operationId,r.item.dispatchId);
}
/** Exceptional continuation of the SAME approved assignment, offered only on explicit never-claimed evidence. */
export async function continueApproved(api:Api,store:PendingStore,operationId:string,dispatchId:string){return start(api,store,operationId,dispatchId);}
async function start(api:Api,store:PendingStore,operationId:string,dispatchId:string):Promise<MutationOutcome>{
 store.write({kind:'start',operationId});
 try{
  const c=taskHostClaimSchema.parse(await api.post({action:'run',operationId,respond:'claim'}));
  if(c.operationId!==operationId||c.dispatchId!==dispatchId)return {outcome:'unconfirmed',message:null};
 }catch(e){if(definite(e)){store.write(null);return {outcome:'refused',message:e instanceof Error?e.message:null};}return {outcome:'unconfirmed',message:null};}
 store.write(null);return {outcome:'started',message:null};
}

/** Finite status polling: one controller, never overlapping, reads only. `read` returns the next interval (ms) or null to stop.
 * Automatic polling ends 30 minutes after the last owner action; a hidden page pauses it and resumes with one read. */
export const POLL_WINDOW_MS=30*60_000;
export function createStatusPoller(o:{read:()=>Promise<number|null>;timer:{set:(fn:()=>void,ms:number)=>unknown;clear:(h:unknown)=>void};now:()=>number;hidden:()=>boolean;onExpired:(expired:boolean)=>void}){
 let handle:unknown=null,inflight:Promise<void>|null=null,since=o.now(),next:number|null=null,stopped=false,expired=false;
 const clear=()=>{if(handle!==null){o.timer.clear(handle);handle=null;}};
 const setExpired=(x:boolean)=>{if(expired!==x){expired=x;o.onExpired(x);}};
 const schedule=()=>{clear();if(stopped||next===null||o.hidden())return;
  if(o.now()-since>=POLL_WINDOW_MS){setExpired(true);return;}
  handle=o.timer.set(()=>{handle=null;void run();},next);};
 const run=()=>inflight??=(async()=>{try{next=await o.read();}catch{/* keep the cadence; the caller shows the stale indicator */}finally{inflight=null;}schedule();})();
 return {
  /** Owner action (open, Check status, after a mutation): one read now and a fresh 30-minute window. */
  check(){since=o.now();setExpired(false);clear();return run();},
  /** The cadence for the current state, without an immediate read. */
  follow(ms:number|null){next=ms;if(!inflight)schedule();},
  visibility(){if(o.hidden())clear();else if(!stopped&&!expired&&next!==null&&!inflight){clear();void run();}},
  stop(){stopped=true;clear();},
  get busy(){return inflight!==null;},
 };
}
