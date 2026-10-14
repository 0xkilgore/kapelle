import 'server-only';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {DelegationClientClaims} from './delegationClientTokens';
import {TaskHostError,readBoundAssignment,readTaskHostContext,commandTaskHost,readTaskHostStatusV2,readTaskHostDispatch} from './taskHost';
import {bindExecution,delegationFacts,type AssignmentItem,type Discovery,type Verification} from './delegationClient';
import {deriveDelegationView} from './delegationState';
import {READ_REASONS,workReason} from './delegationText';
import {CANCELLATION_NOTE} from './taskHostContract';

/** Increment 2 step 6: the scoped chat surface (ported from the shared-chat candidate a6c98dec → 28eea41a), rebuilt on the
 * shared discovery/status v2 contracts and limited to WATCH AND CANCEL. Every read and the one command are checked against the
 * token's ONE deterministic assignment before any native record is returned or any effect is forwarded. The state title, the
 * worker reason text and the readback come from the same functions the Task page uses, so chat and page say the same thing.
 * Proposing, revising, approving and starting are not available here at all: they happen only in the signed-in console. */
export const DELEGATION_CLIENT_CONTEXT_CONTRACT='kapelle.delegation-client-context/v2';
export const WATCH_ONLY_NOTE='This connection can watch this assignment and request its cancellation. Plans are written, approved and started only in Kapelle.';
export const APPROVAL_BOUNDARY_NOTE='This connection cannot approve or start work. The owner reviews and approves the exact version in Kapelle; possession of this token or of a plan hash never approves.';
const hash=async(s:string)=>createHash('sha256').update(s).digest('hex');
function assertScope(ok:boolean,message:string,status=403){if(!ok)throw new TaskHostError(message,status);}

async function bound(claims:DelegationClientClaims){
 const b=await readBoundAssignment(claims.taskId,claims.instanceId,claims.round);
 assertScope(b.operationId===claims.operationId,'This connection is bound to another assignment.');
 if(claims.proposalId!==null)assertScope(!b.proposal||b.proposal.proposalId===claims.proposalId,'This connection is bound to a different saved plan.');
 return b;
}
const reportPath=(taskId:string,reportId:string,operationId:string)=>'/ops/library/'+encodeURIComponent(reportId)+'?taskId='+encodeURIComponent(taskId)+'&taskOperationId='+operationId;

/** The bound projection: what the Task page shows for this one assignment, without owner controls. */
export async function scopedContext(claims:DelegationClientClaims){
 const b=await bound(claims),p=b.proposal,v=p?.versions.at(-1)??null;
 let execution=null;
 if(b.status&&p){try{execution=bindExecution({ok:true,item:b.status.execution.item,worker:b.status.execution.worker},p,claims.taskId);}catch{throw new TaskHostError('Saved work belongs to another assignment.',403);}}
 const context=await readTaskHostContext(claims.taskId).catch(()=>null);
 // The native Dispatch record is the authority for its phase (cancellation requested, result recorded); unknown if unreadable.
 const dispatch=p?.dispatchId?await readTaskHostDispatch(p.dispatchId).then(d=>d.taskRef===claims.taskId&&d.recipientInstanceId===claims.instanceId?d:null,()=>null):null;
 const item:AssignmentItem|null=p?{key:p.dispatchId??b.operationId,round:b.round,operationId:b.operationId,dispatchId:p.dispatchId,external:false,blocking:false,phase:null,proposal:p,execution,executionError:b.statusError}:null;
 const discovery:Discovery={items:item?[item]:[],complete:true,reason:null,nextCursor:null,next:null,instanceId:claims.instanceId,blockingDispatchIds:[]};
 const rb=b.status?.readback??null;
 const verification:Verification|null=!rb||rb.state==='not_applicable'?null:rb.state==='verified'?{readback:'verified',verifiedAt:rb.checkedAt}:{readback:rb.state,verifiedAt:null};
 // sourcesReady:false: the chat surface never offers owner mutations, so its title never invites approval or continuation.
 const view=deriveDelegationView(delegationFacts({discovery,discoveryFailed:false,context,contextFailed:!context,sourcesReady:false,selected:item,pending:null,verification}));
 const w=execution?.worker??null,phase=dispatch?.phase??null,result=w?.status==='REPORT_PUBLISHED'?w.result:null;
 const cancellable=claims.actions.includes('cancel')&&!!dispatch&&phase!=='RESULT_RECORDED'&&phase!=='CANCEL_REQUESTED'&&!dispatch.hasResult&&w?.status!=='REPORT_PUBLISHED';
 const pilot=context?.pilot&&context.pilot.taskBound?context.pilot:null;
 return {ok:true as const,contract:DELEGATION_CLIENT_CONTEXT_CONTRACT,
  connection:{clientId:claims.clientId,actions:claims.actions,expiresAt:new Date(claims.exp*1000).toISOString(),note:WATCH_ONLY_NOTE},
  assignment:{taskId:claims.taskId,instanceId:claims.instanceId,round:claims.round,operationId:claims.operationId,proposalId:p?.proposalId??claims.proposalId,dispatchId:p?.dispatchId??null,exists:!!p},
  task:context?{title:context.roster.task.title,status:context.roster.task.status,revision:context.roster.task.revision}:null,
  recipient:context?{id:claims.instanceId,name:context.roster.agents.find(a=>a.id===claims.instanceId)?.name??null}:null,
  plan:v?{version:v.version,planHash:v.planHash,recommendedAction:v.plan.recommendedAction,instructions:v.plan.instructions,deliverable:v.plan.deliverable,effectLimit:v.plan.effectLimit}:null,
  approval:p?.approval?{version:p.approval.version,planHash:p.approval.planHash,occurredAt:p.approval.occurredAt}:null,
  state:{id:view.state,title:view.title,stale:view.stale,detail:w?workReason(w.reason)||null:b.statusError?READ_REASONS[b.statusError]:null},
  execution:execution?{phase,worker:w?{status:w.status,reason:w.reason,reasonText:workReason(w.reason)||null}:null}:null,
  readback:rb,
  report:result&&verification?.readback==='verified'?{reportId:result.reportId,path:reportPath(claims.taskId,result.reportId,b.operationId)}:null,
  pilot:pilot?{newWorkEnded:pilot.newWorkEnded,newWorkEndsAt:pilot.newWorkEndsAt,invocationConsumed:pilot.invocationConsumed,planPinned:!!pilot.pinnedPlan}:null,
  cancellation:{available:cancellable,requested:phase==='CANCEL_REQUESTED',note:CANCELLATION_NOTE},
  review:{availableHere:false,path:'/ops/native-tasks/'+encodeURIComponent(claims.taskId),note:APPROVAL_BOUNDARY_NOTE},
 };
}

/** GET for a scoped client: the bound context, or status v2 of the bound operation. Nothing else; the Task is the token's own. */
export async function scopedDelegationRead(claims:DelegationClientClaims,query:URLSearchParams){
 assertScope(query.getAll('taskId').length===1&&query.get('taskId')===claims.taskId,'This connection is bound to another Task.');
 const flags=[...query.keys()].filter(k=>k!=='taskId').sort().join(',');
 if(flags==='')return scopedContext(claims);
 if(flags==='operationId,status'&&query.get('status')==='2'){
  assertScope(query.get('operationId')===claims.operationId,'This connection is bound to another assignment.');
  const b=await bound(claims);assertScope(!!b.proposal?.dispatchId,'Nothing has been approved for this connection yet.',404);
  return readTaskHostStatusV2(claims.taskId,claims.operationId);
 }
 throw new TaskHostError('Invalid delegation request.',400);
}

const scopedCommandSchema=z.object({action:z.literal('cancel'),operationId:z.string().uuid(),reason:z.string().trim().min(1).max(500)}).strict();
/** POST for a scoped client: only the cancellation request, only on the bound, approved assignment. */
export async function scopedDelegationCommand(claims:DelegationClientClaims,raw:unknown){
 const action=(raw as {action?:unknown}|null)?.action;
 assertScope(action==='cancel',action==='approveProposal'?'Scoped connections cannot approve. Review and approve the exact version in Kapelle.':WATCH_ONLY_NOTE);
 const body=scopedCommandSchema.parse(raw);
 assertScope(claims.actions.includes('cancel'),'This connection was not granted the "cancel" action.');
 assertScope(body.operationId===claims.operationId,'This connection is bound to another assignment.');
 const b=await bound(claims);
 assertScope(!!b.proposal?.dispatchId,'Nothing has been sent for this connection, so there is nothing to cancel.',409);
 return commandTaskHost(claims.taskId,body);
}
