import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {normalizeDiscovery,mergeDiscovery,applyStatus,selectAssignment,delegationFacts,settles,approveAndStart,continueApproved,createStatusPoller,POLL_WINDOW_MS,type Api,type PendingRequest,type PendingStore,type Discovery} from '../app/ops/_lib/delegationClient';
import {deriveDelegationView} from '../app/ops/_lib/delegationState';
import type {TaskProposal} from '../app/ops/_lib/taskProposalContract';
import {taskId,agentId,context,worker,proposal,receiptFor} from './fixtures/task-host-fixtures';

// Increment 2 step 4: the browser-side orchestration behind the Task panel (pure; fixtures only, no network).
const sha=async(v:string)=>createHash('sha256').update(v).digest('hex');
const OP1='01010101-0101-4101-8101-010101010101',OP2='02020202-0202-4202-8202-020202020202',EXT='e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0',NEXT='03030303-0303-4303-8303-030303030303';
const D1='d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1',D2='d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2',D3='d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
const approved=(op:string,d:string)=>proposal(op,{dispatchId:d});
const tp=(x:ReturnType<typeof proposal>)=>x as unknown as TaskProposal;
const exec=(p:ReturnType<typeof proposal>,status:string|null)=>({ok:true,item:receiptFor(p,{status:status==='REPORT_PUBLISHED'?'RESULT_RECORDED':'ACCEPTED'}),
 worker:status?worker(p.dispatchId!,status,status==='REPORT_PUBLISHED'?{published:{reportId:'ffffffff-ffff-4fff-8fff-ffffffffffff'}}:status==='EXECUTION_UNCERTAIN'?{reason:'provider_receipt_unconfirmed'}:status==='REPORT_PENDING'?{reason:'publisher_not_admitted'}:{}):null});
function raw(o:{rounds?:unknown[];external?:unknown[];complete?:boolean;reason?:string|null;cursor?:string|null;blocking?:string[];next?:boolean}={}){
 return {ok:true,contract:'kapelle.task-host-delegations/v2',taskId,instanceId:agentId,rounds:o.rounds??[],external:o.external??[],
  discovery:{complete:o.complete??true,nextCursor:o.cursor??null,reason:o.reason??null},blockingOperationIds:[],blockingDispatchIds:o.blocking??[],next:o.next===false?null:{round:3,operationId:NEXT}};
}
const view=(d:Discovery|null,extra:Partial<Parameters<typeof delegationFacts>[0]>={})=>{
 const selected=d?selectAssignment(d.items,extra.pending??null):null;
 return deriveDelegationView(delegationFacts({discovery:d,discoveryFailed:false,context:context as never,contextFailed:false,sourcesReady:true,selected,pending:null,verification:null,...extra}));
};

test('discovery v2 is re-bound in the browser: rounds and externals, blocking Dispatches, wrong Task or plan refused',async()=>{
 const p1=approved(OP1,D1),p2=proposal(OP2);
 const d=await normalizeDiscovery(raw({rounds:[{round:1,operationId:OP1,proposal:p1,execution:exec(p1,'REPORT_PUBLISHED'),executionError:null},{round:2,operationId:OP2,proposal:p2,execution:null,executionError:null}],
  external:[{dispatchId:D3,operationId:null,recipientInstanceId:'old',phase:'ACCEPTED',proposal:null,execution:null,executionError:'execution_unavailable'}],blocking:[D3]}),taskId,sha);
 assert.deepEqual(d.items.map(i=>[i.key,i.round,i.external,i.blocking]),[[D1,1,false,false],[OP2,2,false,false],[D3,null,true,true]]);
 // The unresolved external Dispatch (no proposal operation id) is selected and blocks new work.
 const v=view(d);assert.equal(selectAssignment(d.items,null)?.key,D3);assert.equal(v.state,'approval-saved');assert.equal(v.primary,'check-status');assert.deepEqual(v.mutations,{create:false,approveAndStart:false,continueApproved:false});
 await assert.rejects(normalizeDiscovery({...raw(),taskId:'other'},taskId,sha),/another task/);
 const forged={...exec(p1,null),item:{...receiptFor(p1),approvedPlan:{...p1.versions[0].plan,instructions:'Something else'}}};
 await assert.rejects(normalizeDiscovery(raw({rounds:[{round:1,operationId:OP1,proposal:p1,execution:forged,executionError:null}]}),taskId,sha),/differs from the approved plan/);
 await assert.rejects(normalizeDiscovery(raw({rounds:[{round:1,operationId:OP2,proposal:p1,execution:null,executionError:null}]}),taskId,sha),/identity differs/);
});

test('state table from real discovery shapes: plan, running, pending, not completed, result readback, never-claimed continuation',async()=>{
 const one=async(p:ReturnType<typeof proposal>,status:string|null|'error',blocking=false)=>normalizeDiscovery(raw({rounds:[{round:1,operationId:p.versions[0].draft.operationId,proposal:p,
  execution:status==='error'?null:p.dispatchId?exec(p,status):null,executionError:status==='error'?'deadline':null}],blocking:blocking?[p.dispatchId!]:[]}),taskId,sha);
 assert.equal(view(await normalizeDiscovery(raw(),taskId,sha)).state,'no-plan');
 const plan=view(await one(proposal(OP1),null));assert.equal(plan.state,'approve-and-start');assert.equal(plan.mutations.approveAndStart,true);
 assert.equal(view(await one(approved(OP1,D1),'EXECUTION_RUNNING',true)).pollMs,5000);
 assert.equal(view(await one(approved(OP1,D1),'REPORT_PENDING',true)).pollMs,15000);
 const nc=view(await one(approved(OP1,D1),'EXECUTION_UNCERTAIN',true));assert.equal(nc.state,'work-not-completed');assert.equal(nc.newWork.reason,null,'only OTHER unresolved assignments block');assert.deepEqual(nc.mutations,{create:false,approveAndStart:false,continueApproved:false});
 // Worker read failed (deadline): unknown, never "not started".
 const unknown=view(await one(approved(OP1,D1),'error',true));assert.equal(unknown.state,'approval-saved');assert.equal(unknown.mutations.continueApproved,false);
 // The bound worker's journal answered "no attempt": the one deliberate continuation, only while admitted.
 const never=await one(approved(OP1,D1),null,true);assert.equal(view(never).state,'approved-not-started');assert.equal(view(never).mutations.continueApproved,true);
 assert.equal(view(never,{context:null,contextFailed:true}).state,'approval-saved');
 const done=await one(approved(OP1,D1),'REPORT_PUBLISHED');
 assert.equal(view(done,{verification:{readback:'verified',verifiedAt:'2026-10-14T12:00:00.000Z'}}).state,'report-ready');
 const unv=view(done,{verification:{readback:'unavailable',verifiedAt:'2026-10-13T12:00:00.000Z'}});assert.equal(unv.state,'saved-result-unverified');assert.equal(unv.stale,true);
 assert.equal(view(done,{verification:{readback:'changed',verifiedAt:null}}).state,'saved-result-changed');
 assert.equal(view(done).state,'saved-result-unverified','no readback yet is never shown as verified');
 // Partial discovery: the saved result is still shown, nothing new may be created.
 const partial=await normalizeDiscovery(raw({rounds:[{round:1,operationId:OP1,proposal:approved(OP1,D1),execution:exec(approved(OP1,D1),'REPORT_PUBLISHED'),executionError:null}],complete:false,reason:'deadline'}),taskId,sha);
 const pv=view(partial,{verification:{readback:'verified',verifiedAt:'x'}});assert.equal(pv.state,'report-ready');assert.equal(pv.stale,true);assert.equal(pv.newWork.reason,'history_incomplete');
 assert.equal(view(null).state,'checking');assert.equal(view(null,{discoveryFailed:true}).state,'checking');
});

test('selection: unsettled request, then unresolved, then unapproved plan, then newest; load-older merge stays incomplete on a real gap',async()=>{
 const p1=approved(OP1,D1),p2=proposal(OP2);
 const d=await normalizeDiscovery(raw({rounds:[{round:1,operationId:OP1,proposal:p1,execution:exec(p1,'REPORT_PUBLISHED'),executionError:null},{round:2,operationId:OP2,proposal:p2,execution:null,executionError:null}]}),taskId,sha);
 assert.equal(selectAssignment(d.items,null)?.operationId,OP2);
 assert.equal(selectAssignment(d.items,{kind:'start',operationId:OP1})?.operationId,OP1);
 const v=view(d,{pending:{kind:'start',operationId:OP1}});assert.equal(v.state,'request-unconfirmed');assert.equal(v.pollMs,5000);
 const older=await normalizeDiscovery(raw({external:[{dispatchId:D2,operationId:null,recipientInstanceId:'old',phase:'RESULT_RECORDED',proposal:null,execution:null,executionError:'execution_unavailable'}]}),taskId,sha);
 const paged=mergeDiscovery({...d,complete:false,reason:'page_limit',nextCursor:'b1.1.x'},older);
 assert.equal(paged.complete,true);assert.equal(paged.items.length,3);assert.equal(paged.nextCursor,null);
 assert.equal(mergeDiscovery({...d,complete:false,reason:'deadline'},older).complete,false);
});

test('a request settles only on an authoritative answer; positive absence lets the owner act again with the same ids',async()=>{
 const p=approved(OP1,D1),un=proposal(OP1);
 const d=(x:ReturnType<typeof proposal>,e:unknown,err:string|null=null)=>normalizeDiscovery(raw({rounds:[{round:1,operationId:OP1,proposal:x,execution:e,executionError:err}]}),taskId,sha);
 const approval:PendingRequest={kind:'approval',operationId:OP1},start:PendingRequest={kind:'start',operationId:OP1};
 assert.equal(settles(approval,await d(un,null),true),false,'a failed read never settles');
 assert.equal(settles(approval,await d(un,null),false),true,'unapproved plan read back: approve again reuses the stable id');
 assert.equal(settles(start,await d(p,null,'deadline'),false),false,'worker unknown keeps it unconfirmed');
 assert.equal(settles(start,await d(p,exec(p,null)),false),true,'never-claimed evidence settles it (continuation is a separate tap)');
 assert.equal(settles({kind:'create',operationId:NEXT},await normalizeDiscovery(raw({complete:false,reason:'deadline'}),taskId,sha),false),false);
});

function store(){
 let pending:PendingRequest|null=null;const ids=new Map<string,string>();const writes:(PendingRequest|null)[]=[];
 const s:PendingStore={read:()=>pending,write:p=>{pending=p;writes.push(p);},approvalId:(id,v)=>{const k=id+':'+v;if(!ids.has(k))ids.set(k,crypto.randomUUID());return ids.get(k)!;}};
 return {s,writes,get pending(){return pending;}};
}
const err=(status?:number)=>Object.assign(Error(status?'refused':'timeout'),{status});
function api(answer:(body:{action:string;payload?:{operationId:string}})=>unknown){
 const posts:{action:string;payload?:{operationId:string};respond?:string}[]=[];
 const a:Api={get:async()=>{throw Error('no GET expected');},post:async(b)=>{posts.push(b as never);const r=answer(b as never);if(r instanceof Error)throw r;return r;}};
 return {a,posts};
}
const claim=(op:string,d:string)=>({ok:true,contract:'kapelle.task-host-claim/v1',operationId:op,dispatchId:d,worker:worker(d,'EXECUTION_RUNNING')});

test('Approve and start: one approval of the exact version, verified Dispatch, then exactly one claim run; nothing resent',async()=>{
 const p=proposal(OP1),done=approved(OP1,D1),st=store();
 const ok=api(b=>b.action==='approveProposal'?{ok:true,proposal:done,item:receiptFor(done)}:claim(OP1,D1));
 assert.deepEqual(await approveAndStart(ok.a,st.s,tp(p)),{outcome:'started',message:null});
 assert.deepEqual(ok.posts.map(x=>x.action),['approveProposal','run']);
 const ap=ok.posts[0] as unknown as {payload:{operationId:string;version:number;planHash:string;expectedRevision:number}};
 assert.equal(ap.payload.version,1);assert.equal(ap.payload.planHash,p.versions[0].planHash);assert.equal(ap.payload.expectedRevision,p.revision);
 assert.deepEqual(ok.posts[1],{action:'run',operationId:OP1,respond:'claim'});assert.equal(st.pending,null);
 // Lost approval response: no run, request kept; a later tap reuses the SAME approval operation id (server-idempotent).
 const st2=store(),lost=api(()=>err());
 assert.equal((await approveAndStart(lost.a,st2.s,tp(p))).outcome,'unconfirmed');assert.deepEqual(lost.posts.map(x=>x.action),['approveProposal']);assert.equal(st2.pending?.kind,'approval');
 await approveAndStart(lost.a,st2.s,tp(p));assert.equal(lost.posts[0].payload!.operationId,lost.posts[1].payload!.operationId);
 // Definite refusal (stale version): nothing committed, request cleared, no run.
 const st3=store(),refused=api(()=>err(409));
 assert.deepEqual(await approveAndStart(refused.a,st3.s,tp(p)),{outcome:'refused',message:'refused'});assert.equal(refused.posts.length,1);assert.equal(st3.pending,null);
 // Approval answered but not for this exact version: unconfirmed, no run.
 const st4=store(),other=api(()=>({ok:true,proposal:{...done,approval:{...done.approval!,version:2}},item:receiptFor(done)}));
 assert.equal((await approveAndStart(other.a,st4.s,tp(p))).outcome,'unconfirmed');assert.equal(other.posts.length,1);
 // Lost run response: unconfirmed start, not resent; a 503 is unknown, not a refusal.
 for(const e of [err(),err(503)]){const st5=store(),runLost=api(b=>b.action==='approveProposal'?{ok:true,proposal:done,item:receiptFor(done)}:e);
  assert.equal((await approveAndStart(runLost.a,st5.s,tp(p))).outcome,'unconfirmed');assert.equal(runLost.posts.length,2);assert.equal(st5.pending?.kind,'start');}
 // A claim for another Dispatch is not confirmation.
 const st6=store(),wrong=api(b=>b.action==='approveProposal'?{ok:true,proposal:done,item:receiptFor(done)}:claim(OP1,D2));
 assert.equal((await approveAndStart(wrong.a,st6.s,tp(p))).outcome,'unconfirmed');
 // Continuation of the same approved assignment: run only, same operation.
 const st7=store(),cont=api(()=>claim(OP1,D1));
 assert.equal((await continueApproved(cont.a,st7.s,OP1,D1)).outcome,'started');assert.deepEqual(cont.posts,[{action:'run',operationId:OP1,respond:'claim'}]);
});

test('status v2 updates only its own assignment and keeps the readback separate',async()=>{
 const p=approved(OP1,D1),d=await normalizeDiscovery(raw({rounds:[{round:1,operationId:OP1,proposal:p,execution:exec(p,'EXECUTION_RUNNING'),executionError:null}]}),taskId,sha);
 const s=applyStatus(d,OP1,{ok:true,contract:'kapelle.task-host-status/v2',execution:exec(p,'REPORT_PUBLISHED'),readback:{state:'verified',checkedAt:'2026-10-14T12:00:00.000Z',reason:null}},taskId);
 assert.equal(s.discovery.items[0].execution?.worker?.status,'REPORT_PUBLISHED');assert.equal(s.status.readback.state,'verified');
 assert.throws(()=>applyStatus(d,OP2,{ok:true,contract:'kapelle.task-host-status/v2',execution:exec(p,null),readback:{state:'not_applicable',checkedAt:null,reason:null}},taskId),/another assignment/);
});

function clock(){
 let now=0,seq=0;const timers=new Map<number,{at:number;fn:()=>void}>();
 return {now:()=>now,timer:{set:(fn:()=>void,ms:number)=>{const id=++seq;timers.set(id,{at:now+ms,fn});return id;},clear:(h:unknown)=>{timers.delete(h as number);}},
  pending:()=>timers.size,
  async advance(ms:number){const end=now+ms;for(;;){const due=[...timers.entries()].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;now=due[1].at;timers.delete(due[0]);due[1].fn();await new Promise(r=>setImmediate(r));}now=end;}};
}

test('finite polling: cadence from the state, never overlapping, paused in background, stops after 30 minutes until Check status',async()=>{
 const c=clock();let reads=0,hidden=false,cadence:number|null=5000,expired=false,release:(()=>void)|null=null,hold=false;
 const p=createStatusPoller({read:async()=>{reads++;if(hold)await new Promise<void>(r=>{release=r;});return cadence;},timer:c.timer,now:c.now,hidden:()=>hidden,onExpired:x=>{expired=x;}});
 await p.check();assert.equal(reads,1);
 await c.advance(5000);assert.equal(reads,2);await c.advance(15000);assert.equal(reads,5);
 // No overlap: a slow read in flight absorbs both the timer and an owner check.
 hold=true;await c.advance(5000);assert.equal(reads,6);const again=p.check();assert.equal(reads,6);assert.equal(p.busy,true);
 hold=false;release!();await again;assert.equal(reads,6);
 // Report pending: 15 s cadence.
 cadence=15000;await c.advance(5000);assert.equal(reads,7);await c.advance(14999);assert.equal(reads,7);await c.advance(1);assert.equal(reads,8);
 // Background: no reads; foreground: exactly one read, then the cadence resumes.
 hidden=true;p.visibility();await c.advance(60000);assert.equal(reads,8);
 hidden=false;p.visibility();await new Promise(r=>setImmediate(r));assert.equal(reads,9);
 // Terminal state: polling stops.
 cadence=null;await c.advance(15000);assert.equal(reads,10);await c.advance(600000);assert.equal(reads,10);assert.equal(c.pending(),0);
 // 30-minute window from the last owner action, then Check status only.
 cadence=5000;await p.check();const start=reads;await c.advance(POLL_WINDOW_MS+60000);
 assert.equal(expired,true);assert.equal(c.pending(),0);assert.ok(reads-start<=POLL_WINDOW_MS/5000+1);const frozen=reads;
 await c.advance(600000);assert.equal(reads,frozen);
 hidden=true;p.visibility();hidden=false;p.visibility();await new Promise(r=>setImmediate(r));assert.equal(reads,frozen,'an expired poller does not restart on focus');
 await p.check();assert.equal(expired,false);assert.equal(reads,frozen+1);await c.advance(5000);assert.equal(reads,frozen+2);
 p.stop();await c.advance(60000);assert.equal(reads,frozen+2);
});

test('pilot signals: window ended, run used, pinned plan locks writing/editing and only the exact pinned plan is approvable',async()=>{
 const p=proposal(OP1),v=p.versions[0];
 const pilot=(o:Record<string,unknown>={})=>({mode:'single-task-pilot',taskBound:true,newWorkEndsAt:'2026-10-14T12:00:00.000Z',newWorkEnded:false,invocationConsumed:false,
  pinnedPlan:{operationId:OP1,sourceHash:v.draft.sourceHash,planHash:v.planHash},...o});
 const withPilot=(x:unknown)=>({...context,pilot:x}) as never;
 const plan=await normalizeDiscovery(raw({rounds:[{round:1,operationId:OP1,proposal:p,execution:null,executionError:null}]}),taskId,sha);
 const none=await normalizeDiscovery(raw(),taskId,sha);
 // Unknown (older Framework): unchanged behaviour.
 assert.equal(view(plan).editable,true);assert.equal(view(none).state,'no-plan');
 // Pinned exact plan: approvable, not editable.
 const ok=view(plan,{context:withPilot(pilot())});assert.equal(ok.state,'approve-and-start');assert.equal(ok.mutations.approveAndStart,true);assert.equal(ok.editable,false);
 // A different saved plan on the pilot Task: shown, not approvable.
 const other=view(plan,{context:withPilot(pilot({pinnedPlan:{operationId:OP1,sourceHash:v.draft.sourceHash,planHash:'sha256:'+'9'.repeat(64)}}))});
 assert.equal(other.state,'saved-plan');assert.equal(other.newWork.reason,'pilot_plan_differs');assert.equal(other.mutations.approveAndStart,false);assert.equal(other.editable,false);
 // No plan yet: nothing can be written here; wait for the operator's fixed plan.
 const wait=view(none,{context:withPilot(pilot())});assert.equal(wait.state,'new-work-unavailable');assert.equal(wait.newWork.reason,'pilot_plan_pinned');assert.equal(wait.mutations.create,false);
 // Window ended: the separate message, history intact, no mutation.
 const ended=view(plan,{context:withPilot(pilot({newWorkEnded:true}))});assert.equal(ended.state,'saved-plan');assert.equal(ended.newWork.reason,'pilot_window_ended');assert.equal(ended.mutations.approveAndStart,false);
 // The one run is used: its own reason (the Framework refuses a second claim anyway).
 const used=view(plan,{context:withPilot(pilot({newWorkEnded:true,invocationConsumed:true}))});assert.equal(used.newWork.reason,'pilot_invocation_used');assert.equal(used.mutations.approveAndStart,false);
 // A pilot host asked about another Task: not admitted, no pinned plan.
 const elsewhere=view(none,{context:withPilot(pilot({taskBound:false,newWorkEnded:true,pinnedPlan:null}))});assert.equal(elsewhere.newWork.reason,'host_not_admitted');assert.equal(elsewhere.mutations.create,false);
 // Never-claimed continuation is not offered after the window ends.
 const ap=approved(OP1,D1),never=await normalizeDiscovery(raw({rounds:[{round:1,operationId:OP1,proposal:ap,execution:exec(ap,null),executionError:null}],blocking:[D1]}),taskId,sha);
 assert.equal(view(never,{context:withPilot(pilot())}).state,'approved-not-started');assert.equal(view(never,{context:withPilot(pilot({newWorkEnded:true}))}).state,'approval-saved');
});
