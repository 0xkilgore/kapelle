import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveDelegationView,DELEGATION_REASONS,type DelegationFacts} from '../app/ops/_lib/delegationState';
import {taskHostDelegationsV2Schema,taskHostStatusV2Schema,taskHostClaimSchema} from '../app/ops/_lib/taskHostContract';
import {GET,POST} from '../app/api/ops/tasks/host-delegation/route';

// Increment 2 state table, one test per row: three independent facts, never derived from one another.
const base:DelegationFacts={history:'complete',newWork:{admitted:true},pilotExpired:false,taskChanged:false,blockingAssignments:0,assignment:null};
const view=(p:Partial<DelegationFacts>)=>deriveDelegationView({...base,...p});
const noMutation={create:false,approveAndStart:false,continueApproved:false};

test('history loading/incomplete/failed: checking, no prepare/start from incomplete discovery',()=>{
 for(const history of ['loading','incomplete','failed'] as const){
  const v=view({history});assert.equal(v.state,'checking');assert.equal(v.primary,'check-status');assert.deepEqual(v.mutations,noMutation);
  assert.equal(v.newWork.reason,'history_incomplete');
  assert.equal(v.title,history==='failed'?'Saved assignments could not be read':'Checking saved assignments','a failed read never claims to be still checking');
 }
});
test('no saved plan + admitted: editable instructions, one create, no execution',()=>{
 const v=view({});assert.equal(v.state,'no-plan');assert.equal(v.primary,'save-plan');assert.deepEqual(v.mutations,{create:true,approveAndStart:false,continueApproved:false});
});
test('no saved plan + not admitted: new work unavailable with the typed reason; no mutation',()=>{
 const v=view({newWork:{admitted:false,reason:'publisher_model_not_admitted'}});
 assert.equal(v.state,'new-work-unavailable');assert.deepEqual(v.mutations,noMutation);assert.equal(v.newWork.message,DELEGATION_REASONS.publisher_model_not_admitted);
 assert.equal(view({newWork:{admitted:false,reason:null}}).newWork.reason,'host_not_admitted');
});
test('saved, unapproved, admitted: full plan / Approve and start; not admitted or expired: plan without the control',()=>{
 const ok=view({assignment:{kind:'saved-unapproved'}});assert.equal(ok.state,'approve-and-start');assert.deepEqual(ok.mutations,{create:false,approveAndStart:true,continueApproved:false});
 for(const p of [{newWork:{admitted:false as const,reason:null}},{pilotExpired:true},{blockingAssignments:1}]){
  const v=view({...p,assignment:{kind:'saved-unapproved'}});assert.equal(v.state,'saved-plan');assert.deepEqual(v.mutations,noMutation);
 }
});
test('approval or start response ambiguous: Request not confirmed / Check status; read only, no resend',()=>{
 for(const request of ['approval','start'] as const){
  const v=view({assignment:{kind:'request-unconfirmed',request}});
  assert.equal(v.state,'request-unconfirmed');assert.equal(v.primary,'check-status');assert.deepEqual(v.mutations,noMutation);assert.equal(v.pollMs,5000);
 }
});
test('approval confirmed, execution not confirmed: Approval saved; absence of a worker response is not proof of no start',()=>{
 const v=view({assignment:{kind:'approved',claim:'unknown'}});assert.equal(v.state,'approval-saved');assert.deepEqual(v.mutations,noMutation);
});
test('approved and NEVER claimed (explicit server evidence) + admitted: one deliberate Continue; otherwise status only',()=>{
 const v=view({assignment:{kind:'approved',claim:'never-claimed'}});assert.equal(v.state,'approved-not-started');assert.deepEqual(v.mutations,{create:false,approveAndStart:false,continueApproved:true});
 for(const p of [{pilotExpired:true},{newWork:{admitted:false as const,reason:null}},{taskChanged:true},{history:'incomplete' as const}])
  assert.equal(view({...p,assignment:{kind:'approved',claim:'never-claimed'}}).mutations.continueApproved,false);
});
test('running: Agent working / poll only, no second start; rejected/uncertain: Work not completed, no Try again',()=>{
 const r=view({assignment:{kind:'worker',status:'EXECUTION_RUNNING'}});assert.equal(r.state,'agent-working');assert.equal(r.pollMs,5000);assert.deepEqual(r.mutations,noMutation);
 for(const status of ['EXECUTION_REJECTED','EXECUTION_UNCERTAIN'] as const){const v=view({assignment:{kind:'worker',status}});assert.equal(v.state,'work-not-completed');assert.equal(v.pollMs,null);assert.deepEqual(v.mutations,noMutation);}
});
test('Report pending: output retained, 15 s polling, no provider run',()=>{
 const v=view({assignment:{kind:'worker',status:'REPORT_PENDING'}});assert.equal(v.state,'report-pending');assert.equal(v.pollMs,15000);assert.deepEqual(v.mutations,noMutation);
});
test('verified result: Report ready / Open Report; current read unavailable: saved result kept, not asserted fresh; changed: not shown as verified',()=>{
 assert.equal(view({assignment:{kind:'result',readback:'verified',verifiedAt:'2026-10-14T01:00:00.000Z'}}).primary,'open-report');
 const u=view({assignment:{kind:'result',readback:'unavailable',verifiedAt:'2026-10-14T01:00:00.000Z'}});assert.equal(u.state,'saved-result-unverified');assert.equal(u.primary,'check-status');assert.equal(u.stale,true);
 const c=view({assignment:{kind:'result',readback:'changed',verifiedAt:null}});assert.equal(c.state,'saved-result-changed');assert.notEqual(c.primary,'open-report');
});
test('expired pilot with a readable saved assignment: same history/result controls, all execution disabled, window message',()=>{
 const v=view({pilotExpired:true,assignment:{kind:'result',readback:'verified',verifiedAt:'2026-10-14T01:00:00.000Z'}});
 assert.equal(v.state,'report-ready');assert.equal(v.primary,'open-report');assert.deepEqual(v.mutations,noMutation);assert.equal(v.newWork.reason,'pilot_window_ended');
});
test('Task changed after approval: old instructions never relabelled current; new work needs its own approval',()=>{
 const v=view({taskChanged:true,assignment:{kind:'saved-unapproved'}});assert.equal(v.state,'saved-plan');assert.match(v.title,/Task has changed/);assert.deepEqual(v.mutations,noMutation);
});
test('a saved assignment stays visible while discovery is incomplete, marked stale, with no mutation',()=>{
 const v=view({history:'incomplete',assignment:{kind:'worker',status:'REPORT_PENDING'}});assert.equal(v.state,'report-pending');assert.equal(v.stale,true);assert.deepEqual(v.mutations,noMutation);
});

// v2 contract invariants.
const op='11111111-1111-4111-8111-111111111111',dispatch='22222222-2222-4222-8222-222222222222';
test('discovery v2: incomplete needs a fixed reason; complete has no cursor; external items carry no round',()=>{
 const ok={ok:true,contract:'kapelle.task-host-delegations/v2',taskId:'t',instanceId:null,rounds:[],external:[{dispatchId:dispatch,operationId:null,recipientInstanceId:'i',phase:'RESULT_RECORDED',proposal:null,execution:null,executionError:'execution_unavailable'}],discovery:{complete:false,nextCursor:'c',reason:'page_limit'},blockingOperationIds:[],blockingDispatchIds:[],next:null};
 assert.equal(taskHostDelegationsV2Schema.safeParse(ok).success,true);
 assert.equal(taskHostDelegationsV2Schema.safeParse({...ok,discovery:{complete:false,nextCursor:null,reason:null}}).success,false);
 assert.equal(taskHostDelegationsV2Schema.safeParse({...ok,discovery:{complete:true,nextCursor:'c',reason:null}}).success,false);
 assert.equal(taskHostDelegationsV2Schema.safeParse({...ok,external:[{...ok.external[0],round:1}]}).success,false);
 assert.equal(taskHostDelegationsV2Schema.safeParse({...ok,external:[{...ok.external[0],executionError:'ECONNREFUSED 127.0.0.1'}]}).success,false,'raw error text is not a public reason');
});
test('status v2: readback applies exactly to published results; unverified needs a fixed reason; verified needs a time',async()=>{
 const {receipt,worker}=await import('./fixtures/task-host-fixtures');
 const published={ok:true,item:receipt(op,dispatch,{status:'RESULT_RECORDED'}),worker:worker(dispatch,'REPORT_PUBLISHED',{published:{reportId:'ffffffff-ffff-4fff-8fff-ffffffffffff'}})};
 const pending={ok:true,item:receipt(op,dispatch),worker:worker(dispatch,'REPORT_PENDING',{reason:'publication_uncertain'})};
 const s=(execution:unknown,readback:unknown)=>taskHostStatusV2Schema.safeParse({ok:true,contract:'kapelle.task-host-status/v2',execution,readback}).success;
 assert.equal(s(published,{state:'verified',checkedAt:'2026-10-14T01:00:00.000Z',reason:null}),true);
 assert.equal(s(published,{state:'unavailable',checkedAt:'2026-10-14T01:00:00.000Z',reason:'reader_unavailable'}),true,'previously verified time kept');
 assert.equal(s(published,{state:'changed',checkedAt:null,reason:'report_changed'}),true);
 assert.equal(s(pending,{state:'not_applicable',checkedAt:null,reason:null}),true);
 assert.equal(s(published,{state:'not_applicable',checkedAt:null,reason:null}),false,'a published result always has a readback state');
 assert.equal(s(pending,{state:'verified',checkedAt:'2026-10-14T01:00:00.000Z',reason:null}),false,'pending work is never verified');
 assert.equal(s(published,{state:'verified',checkedAt:null,reason:null}),false);
 assert.equal(s(published,{state:'unavailable',checkedAt:null,reason:null}),false,'unverified needs a fixed reason');
 assert.equal(s(published,{state:'unavailable',checkedAt:null,reason:'Error: socket hang up'}),false,'raw text is not a reason');
});
test('claim v1 carries the Framework worker status only (no Report read)',()=>{
 const worker={contract:'kapelle.task-delegation/v1',dispatchId:dispatch,status:'EXECUTION_RUNNING',outputRetained:false,reason:null,result:null,taskCompleted:false,effectsAuthorized:false};
 assert.equal(taskHostClaimSchema.safeParse({ok:true,contract:'kapelle.task-host-claim/v1',operationId:op,dispatchId:dispatch,worker}).success,true);
 assert.equal(taskHostClaimSchema.safeParse({ok:true,contract:'kapelle.task-host-claim/v1',operationId:op,dispatchId:dispatch,worker,report:{}}).success,false);
});

// Ambiguous-request fixtures: a timed-out approval/start is "not confirmed" (503), never retried, never read as refusal.
const taskId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function env(t:any){const e={...process.env},f=globalThis.fetch;t.after(()=>{process.env=e;globalThis.fetch=f;});
 Object.assign(process.env,{KAPELLE_OPS_ENABLED:'1',KAPELLE_OPS_TOKEN:'synthetic-host',KAPELLE_TASK_HOST_ENABLED:'1',KAPELLE_TASK_HOST_URL:'http://127.0.0.1:4494',KAPELLE_TASK_HOST_TOKEN:'s'.repeat(40)});}
const post=(body:unknown)=>POST(new Request('http://localhost/api/ops/tasks/host-delegation?taskId='+taskId,{method:'POST',headers:{cookie:'KAPELLE_OPS_TOKEN=synthetic-host',origin:'http://localhost',host:'localhost','x-kapelle-csrf':'task-host','content-type':'application/json'},body:JSON.stringify(body)}));
test('fixture: the run POST times out after a valid saved receipt -> 503 "not confirmed", exactly one run POST, no follow-up write',async t=>{
 env(t);const {receipt}=await import('./fixtures/task-host-fixtures');let runs=0,posts=0;
 globalThis.fetch=async(url,o)=>{const p=String(url);if(o?.method==='POST'){posts++;if(p.endsWith('/run')){runs++;throw Object.assign(new Error('The operation was aborted due to timeout'),{name:'TimeoutError'});}}
  if(p.includes('/task-delegations/'+op))return Response.json({ok:true,item:receipt(op,dispatch)});return Response.json({ok:false},{status:404});};
 const r=await post({action:'run',operationId:op,respond:'claim'});
 assert.equal(r.status,503);assert.equal(runs,1,'the run was sent exactly once');assert.equal(posts,1,'no follow-up write');
 const body=await r.json();assert.equal(body.ok,false);assert.match(body.error,/could not be confirmed/i);assert.doesNotMatch(String(body.error),/aborted|timeout|ECONN/i,'no raw transport text');
});
test('fixture: a 503 from the host on approve is unknown (not a refusal): generic not-confirmed message, single POST',async t=>{
 env(t);let posts=0;
 globalThis.fetch=async(_url,o)=>{if(o?.method==='POST'){posts++;return new Response('{}',{status:503});}return new Response('{}',{status:503});};
 const r=await post({action:'approveProposal',proposalId:op,payload:{operationId:op,expectedRevision:1,version:1,planHash:'sha256:'+'a'.repeat(64)}});
 assert.equal(r.status,503);assert.equal(posts,0,'a failed precondition read never turns into a write');
 assert.match((await r.json()).error,/could not confirm|could not be confirmed/i);
});
test('fixture: GET status never POSTs (refresh after an ambiguous request is read only)',async t=>{
 env(t);let posts=0;globalThis.fetch=async(_u,o)=>{if(o?.method==='POST')posts++;return new Response('{}',{status:503});};
 const r=await GET(new Request('http://localhost/api/ops/tasks/host-delegation?taskId='+taskId+'&operationId='+op+'&status=2',{headers:{host:'localhost',cookie:'KAPELLE_OPS_TOKEN=synthetic-host'}}));
 assert.equal(r.status,503,'reached the handler: the host could not confirm (unknown), not an access refusal');
 assert.equal(posts,0);
});

// Owner decision (Oct 14): "Revise or run again" after a VERIFIED Report — new work under every existing safety rule.
test('verified Report allows a NEW plan only under the new-work rules; pilots stay single-run with the reason shown',()=>{
 const done={kind:'result' as const,readback:'verified' as const,verifiedAt:'2026-10-14T01:00:00.000Z'};
 const ok=view({assignment:done});assert.equal(ok.state,'report-ready');assert.equal(ok.primary,'open-report');
 assert.deepEqual(ok.mutations,{create:true,approveAndStart:false,continueApproved:false},'a new plan only; this assignment is never run again');
 const blocked=view({assignment:done,blockingAssignments:1});assert.equal(blocked.mutations.create,false);assert.equal(blocked.newWork.reason,'unresolved_assignment');
 assert.equal(view({assignment:done,history:'incomplete'}).mutations.create,false);
 assert.equal(view({assignment:done,newWork:{admitted:false,reason:'pilot_invocation_used'}}).newWork.message,DELEGATION_REASONS.pilot_invocation_used);
 assert.equal(view({assignment:done,newWork:{admitted:false,reason:'pilot_invocation_used'}}).mutations.create,false);
 assert.equal(view({assignment:done,pilotExpired:true}).mutations.create,false);
 const pinned=view({assignment:done,planPinned:'pinned'});assert.equal(pinned.mutations.create,false);assert.equal(pinned.newWork.reason,'pilot_plan_pinned');
 for(const readback of ['unavailable','changed'] as const)assert.equal(view({assignment:{kind:'result',readback,verifiedAt:null}}).mutations.create,false,'only after a verified Report');
});
