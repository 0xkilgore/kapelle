import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {GET,POST} from '../app/api/ops/tasks/host-delegation/route';
import {findTaskHostDelegationsV2,readTaskHostStatusV2,commandTaskHost,TASK_HOST_READ_BUDGET_MS} from '../app/ops/_lib/taskHost';
import {delegationOperationId} from '../app/ops/_lib/taskDelegationIdentity';
import {taskId,agentId,context,receipt,worker,dispatchItem,proposal,hostDouble,hostEnv,reportDetail} from './fixtures/task-host-fixtures';

// Increment 2 console data path. Every read below is GET-only; tests assert zero POSTs except the explicit run.
const sha=async(v:string)=>createHash('sha256').update(v).digest('hex');
const slot=(round:number)=>delegationOperationId(taskId,agentId,round,sha);
const EXT='e0e0e0e0-e0e0-4e0e-8e0e-e0e0e0e0e0e0',D1='d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1',OLD='old-instance',REPORT='ffffffff-ffff-4fff-8fff-ffffffffffff';
type Routes={dispatchPages?:{items:unknown[];nextCursor:string|null}[];proposals?:Record<string,unknown>;receipts?:Record<string,unknown>;workers?:Record<string,unknown>;admissionDown?:boolean;report?:()=>Response;pilot?:unknown};
function host(r:Routes){
 let page=0;
 return hostDouble((path,method)=>{
  if(path.startsWith('/v2/reports/')&&r.report)return r.report();
  if(path.startsWith('/task-executions/pilot?'))return r.pilot===undefined?Response.json({ok:false},{status:404}):Response.json({ok:true,contract:'kapelle.task-host-pilot/v1',instanceId:agentId,taskId,pilot:r.pilot});
  if(path.startsWith('/task-delegations/agents?'))return r.admissionDown?new Response('{}',{status:503}):Response.json(context.roster);
  if(path.startsWith('/task-executions/admission?'))return r.admissionDown?new Response('{}',{status:503}):Response.json(context.admission);
  if(path.startsWith('/dispatches?')){const p=r.dispatchPages?.[page++]??{items:[],nextCursor:null};
   return Response.json({ok:true,contract:'kapelle.dispatch-list/v1',recipient:null,taskRef:taskId,items:p.items,scanned:p.items.length,nextCursor:p.nextCursor,complete:p.nextCursor===null});}
  const op=/^\/task-proposals\/operations\/(.+)$/.exec(path)?.[1];if(op)return r.proposals?.[op]?Response.json({ok:true,item:r.proposals[op]}):Response.json({ok:false},{status:404});
  const rc=/^\/task-delegations\/([0-9a-f-]{36})$/.exec(path)?.[1];if(rc&&r.receipts?.[rc])return Response.json({ok:true,item:r.receipts[rc]});
  const ex=/^\/task-executions\/([0-9a-f-]{36})$/.exec(path)?.[1];if(ex&&method==='GET'&&ex in (r.workers??{}))return Response.json({ok:true,item:r.workers![ex]});
  if(/\/task-executions\/[0-9a-f-]{36}\/run$/.test(path)&&method==='POST')return Response.json({ok:true,item:worker(D1,'EXECUTION_RUNNING')},{status:202});
  return Response.json({ok:false},{status:404});
 });
}
const w4={dispatchPages:[{items:[dispatchItem(D1,{recipient:OLD,phase:'RESULT_RECORDED',proposalOperationId:EXT})],nextCursor:null}],
 proposals:{[EXT]:proposal(EXT,{agent:OLD,dispatchId:D1})},receipts:{[EXT]:receipt(EXT,D1,{status:'RESULT_RECORDED',instanceId:OLD})},
 workers:{[D1]:worker(D1,'REPORT_PUBLISHED',{published:{reportId:REPORT}})}};

test('external assignment (random operation id, historical recipient) is found with its terminal Report, no round fabricated',async t=>{
 hostEnv(t);const h=host(w4);globalThis.fetch=h.fetch;
 const v=await findTaskHostDelegationsV2(taskId);
 assert.equal(v.contract,'kapelle.task-host-delegations/v2');assert.equal(v.instanceId,agentId);assert.deepEqual(v.rounds,[]);
 assert.equal(v.external.length,1);const x=v.external[0];
 assert.equal(x.dispatchId,D1);assert.equal(x.operationId,EXT);assert.equal(x.recipientInstanceId,OLD);assert.equal(x.phase,'RESULT_RECORDED');
 assert.equal(x.execution?.worker?.status,'REPORT_PUBLISHED');assert.equal(x.executionError,null);assert.equal('round' in x,false);
 assert.deepEqual(v.discovery,{complete:true,nextCursor:null,reason:null});assert.deepEqual(v.blockingOperationIds,[]);assert.deepEqual(v.blockingDispatchIds,[]);
 assert.deepEqual(v.next,{round:1,operationId:await slot(1)});
 assert.equal(h.posts().length,0);
 assert.equal(h.calls.filter(c=>c.path.startsWith('/task-proposals/operations/')).length,12+1,'all 12 slots probed + the external proposal');
});
test('slot holes do not stop the probe: later saved plans are found; next is the first hole',async t=>{
 hostEnv(t);const s1=await slot(1),s3=await slot(3);
 const h=host({proposals:{[s1]:proposal(s1),[s3]:proposal(s3)}});globalThis.fetch=h.fetch;
 const v=await findTaskHostDelegationsV2(taskId);
 assert.deepEqual(v.rounds.map(r=>r.round),[1,3]);assert.deepEqual(v.next,{round:2,operationId:await slot(2)});assert.equal(v.discovery.complete,true);
 assert.equal(h.posts().length,0);
});
test('a Dispatch whose saved plan belongs to another Task (wrong-Task binding) is refused, never shown',async t=>{
 hostEnv(t);const bad={...w4,proposals:{[EXT]:proposal(EXT,{agent:OLD,dispatchId:D1,task:'other-task'})}};
 globalThis.fetch=host(bad).fetch;
 await assert.rejects(findTaskHostDelegationsV2(taskId),/another task/);
 globalThis.fetch=host(bad).fetch;   // fresh double: the call above consumed its only Dispatch page
 const r=await GET(new Request('http://localhost/api/ops/tasks/host-delegation?taskId='+taskId+'&delegations=2',{headers:{host:'localhost',cookie:'KAPELLE_OPS_TOKEN=synthetic-host'}}));
 assert.notEqual(r.status,200);
});
test('pagination: at most 3 pages per interaction; more is reported incomplete with the cursor to load older',async t=>{
 hostEnv(t);const ids=['a1','a2','a3','a4'].map(s=>s+'a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1');
 const pages=ids.map((id,i)=>({items:[dispatchItem(id,{phase:'RESULT_RECORDED',proposalOperationId:null})],nextCursor:'c'+(i+1)}));
 const h=host({dispatchPages:pages});globalThis.fetch=h.fetch;
 const v=await findTaskHostDelegationsV2(taskId);
 assert.equal(h.calls.filter(c=>c.path.startsWith('/dispatches?')).length,3);assert.equal(v.external.length,3);
 assert.deepEqual(v.discovery,{complete:false,nextCursor:'c3',reason:'page_limit'});
 const h2=host({dispatchPages:[{items:[],nextCursor:null}]});globalThis.fetch=h2.fetch;
 await findTaskHostDelegationsV2(taskId,{cursor:'c3'});
 assert.match(h2.calls.find(c=>c.path.startsWith('/dispatches?'))!.path,/cursor=c3/);
});
test('current admission unavailable: history (external) still returned, slots not guessed, explicitly incomplete',async t=>{
 hostEnv(t);const h=host({...w4,admissionDown:true});globalThis.fetch=h.fetch;
 const v=await findTaskHostDelegationsV2(taskId);
 assert.equal(v.instanceId,null);assert.deepEqual(v.rounds,[]);assert.equal(v.external.length,1);assert.equal(v.next,null);
 assert.deepEqual(v.discovery,{complete:false,nextCursor:null,reason:'admission_unavailable'});
 assert.equal(h.calls.filter(c=>c.path.startsWith('/task-proposals/operations/')).length,1,'only the external proposal; no slot guessing');
});
test('a slow host cannot hold discovery past the read budget: bounded, incomplete, per-item deadline reason',async t=>{
 hostEnv(t);const inner=host(w4);
 globalThis.fetch=(async(url:RequestInfo|URL,o?:RequestInit)=>{
  if(/\/task-executions\/[0-9a-f-]{36}$/.test(new URL(String(url)).pathname))
   return new Promise<Response>((_,reject)=>{o?.signal?.addEventListener('abort',()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})));});
  return inner.fetch(url,o);}) as typeof fetch;
 // A real hanging fetch holds a socket open; this double does not, and AbortSignal.timeout timers are unref'd. Keep the loop alive.
 const alive=setInterval(()=>{},250);t.after(()=>clearInterval(alive));
 const t0=Date.now(),v=await findTaskHostDelegationsV2(taskId),ms=Date.now()-t0;
 assert.ok(ms<TASK_HOST_READ_BUDGET_MS+1500,'bounded: '+ms+' ms');
 assert.equal(v.external[0].execution,null);assert.equal(v.external[0].executionError,'deadline');assert.equal(v.external[0].phase,'RESULT_RECORDED','native phase kept');
 assert.equal(v.discovery.complete,false);assert.equal(v.discovery.reason,'deadline');
});
test('unresolved assignments are blocking; terminal ones are not',async t=>{
 hostEnv(t);const D2='d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2',EXT2='e2e2e2e2-e2e2-4e2e-8e2e-e2e2e2e2e2e2';
 const r={dispatchPages:[{items:[w4.dispatchPages[0].items[0],dispatchItem(D2,{recipient:OLD,phase:'ACCEPTED',proposalOperationId:EXT2})],nextCursor:null}],
  proposals:{...w4.proposals,[EXT2]:proposal(EXT2,{agent:OLD,dispatchId:D2})},receipts:{...w4.receipts,[EXT2]:receipt(EXT2,D2,{instanceId:OLD})},
  workers:{...w4.workers,[D2]:worker(D2,'EXECUTION_RUNNING')}};
 globalThis.fetch=host(r).fetch;
 const v=await findTaskHostDelegationsV2(taskId);assert.deepEqual(v.blockingOperationIds,[EXT2]);assert.deepEqual(v.blockingDispatchIds,[D2]);
});
test('an unresolved external Dispatch WITHOUT a proposal operation id is displayed and still blocks new work (by Dispatch id)',async t=>{
 hostEnv(t);const D3='d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
 globalThis.fetch=host({dispatchPages:[{items:[dispatchItem(D3,{recipient:OLD,phase:'ACCEPTED',proposalOperationId:null})],nextCursor:null}]}).fetch;
 const v=await findTaskHostDelegationsV2(taskId);
 assert.equal(v.external.length,1);assert.equal(v.external[0].operationId,null);assert.equal(v.external[0].executionError,'execution_unavailable');
 assert.deepEqual(v.blockingOperationIds,[]);assert.deepEqual(v.blockingDispatchIds,[D3]);
 // A terminal one does not block.
 globalThis.fetch=host({dispatchPages:[{items:[dispatchItem(D3,{recipient:OLD,phase:'RESULT_RECORDED',proposalOperationId:null})],nextCursor:null}]}).fetch;
 assert.deepEqual((await findTaskHostDelegationsV2(taskId)).blockingDispatchIds,[]);
});
test('run with respond:claim returns the Framework claim promptly: one POST and NO read after it (no Report readback)',async t=>{
 hostEnv(t);const S1=await slot(1);const h=host({receipts:{[S1]:receipt(S1,D1)}});globalThis.fetch=h.fetch;
 const claim:any=await commandTaskHost(taskId,{action:'run',operationId:S1,respond:'claim'});
 assert.equal(claim.contract,'kapelle.task-host-claim/v1');assert.equal(claim.dispatchId,D1);assert.equal(claim.worker.status,'EXECUTION_RUNNING');
 assert.equal(h.posts().length,1);const runAt=h.calls.findIndex(c=>c.method==='POST');assert.equal(h.calls.length,runAt+1,'nothing after the run');
});
test('status v2: pending work has no readback; a published result whose reader is unavailable is "unavailable", never verified',async t=>{
 hostEnv(t);delete process.env.KAPELLE_REPORT_DETAIL_URL;
 const P='c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
 globalThis.fetch=host({receipts:{[P]:receipt(P,D1)},workers:{[D1]:worker(D1,'REPORT_PENDING',{reason:'publication_uncertain'})}}).fetch;
 assert.deepEqual((await readTaskHostStatusV2(taskId,P)).readback,{state:'not_applicable',checkedAt:null,reason:null});
 const h=host(w4);globalThis.fetch=h.fetch;
 const v=await readTaskHostStatusV2(taskId,EXT);
 assert.equal(v.readback.state,'unavailable');assert.equal(v.readback.checkedAt,null);assert.ok(['reader_unavailable','deadline'].includes(v.readback.reason!));
 assert.equal(v.execution.worker?.status,'REPORT_PUBLISHED','durable fact preserved');assert.equal(h.posts().length,0);
});
test('route: delegations=2 and status=2 are GET-only and validate the cursor',async t=>{
 hostEnv(t);const h=host(w4);globalThis.fetch=h.fetch;
 const get=(q:string)=>GET(new Request('http://localhost/api/ops/tasks/host-delegation?taskId='+taskId+q,{headers:{host:'localhost',cookie:'KAPELLE_OPS_TOKEN=synthetic-host'}}));
 const r=await get('&delegations=2');assert.equal(r.status,200);assert.equal((await r.json()).contract,'kapelle.task-host-delegations/v2');
 assert.equal((await get('&delegations=2&cursor='+'x'.repeat(600))).status,400);
 assert.equal(h.posts().length,0);void POST;
});

// Status v2 verified / changed fixtures: the selected-Report reader answers report-detail.v2.
test('status v2: verified only when the independent read matches the exact Report, Dispatch and bytes; otherwise changed or unavailable',async t=>{
 hostEnv(t);Object.assign(process.env,{KAPELLE_REPORT_DETAIL_URL:'http://127.0.0.1:14250/v2/reports',KAPELLE_REPORT_REGISTRY_MCP_TOKEN:'x'.repeat(40),KAPELLE_REPORT_REGISTRY_DRIVE_ID:'drive'});
 const md='# Task result\n\nSynthetic verified body.\n',H='sha256:'+createHash('sha256').update(md).digest('hex');
 const routes=(report:()=>Response)=>({receipts:{[EXT]:receipt(EXT,D1,{status:'RESULT_RECORDED',instanceId:OLD,contentHash:H})},
  workers:{[D1]:worker(D1,'REPORT_PUBLISHED',{published:{reportId:REPORT,contentHash:H}})},report});
 const ok=()=>Response.json(reportDetail(REPORT,{markdown:md,sourceRef:'dispatch:'+D1}));
 let h=host(routes(ok));globalThis.fetch=h.fetch;
 const v=await readTaskHostStatusV2(taskId,EXT);
 assert.equal(v.readback.state,'verified');assert.equal(v.readback.reason,null);assert.ok(Date.parse(v.readback.checkedAt!)>Date.now()-60000);
 assert.equal(h.posts().length,0);assert.equal(h.calls.filter(c=>c.path.startsWith('/v2/reports/')).length,1,'one independent read');
 // Same Report id, different (self-consistent) bytes: changed, never verified, no timestamp claimed.
 globalThis.fetch=host(routes(()=>Response.json(reportDetail(REPORT,{markdown:md+'edited',sourceRef:'dispatch:'+D1})))).fetch;
 assert.deepEqual((await readTaskHostStatusV2(taskId,EXT)).readback,{state:'changed',checkedAt:null,reason:'report_changed'});
 // Right bytes, but the Report now names another Dispatch: changed.
 globalThis.fetch=host(routes(()=>Response.json(reportDetail(REPORT,{markdown:md,sourceRef:'dispatch:'+'0'.repeat(8)+'-0000-4000-8000-000000000000'})))).fetch;
 assert.equal((await readTaskHostStatusV2(taskId,EXT)).readback.state,'changed');
 // Reader down: unavailable with a fixed reason; the durable published fact is preserved.
 globalThis.fetch=host(routes(()=>new Response('{}',{status:503}))).fetch;
 const u=await readTaskHostStatusV2(taskId,EXT);
 assert.deepEqual(u.readback,{state:'unavailable',checkedAt:null,reason:'reader_unavailable'});assert.equal(u.execution.worker?.status,'REPORT_PUBLISHED');
});

test('status v2 result read: one transient Registry 503 is retried once and verifies; a persistent one stays unavailable after two reads',async t=>{
 hostEnv(t);Object.assign(process.env,{KAPELLE_REPORT_DETAIL_URL:'http://127.0.0.1:14250/v2/reports',KAPELLE_REPORT_REGISTRY_MCP_TOKEN:'x'.repeat(40),KAPELLE_REPORT_REGISTRY_DRIVE_ID:'drive'});
 const md='# Task result\n\nSynthetic verified body.\n',H='sha256:'+createHash('sha256').update(md).digest('hex');
 const routes=(report:()=>Response)=>({receipts:{[EXT]:receipt(EXT,D1,{status:'RESULT_RECORDED',instanceId:OLD,contentHash:H})},
  workers:{[D1]:worker(D1,'REPORT_PUBLISHED',{published:{reportId:REPORT,contentHash:H}})},report});
 const busy=()=>Response.json({error:'report_projection_unavailable'},{status:503});
 let n=0;let h=host(routes(()=>n++===0?busy():Response.json(reportDetail(REPORT,{markdown:md,sourceRef:'dispatch:'+D1}))));globalThis.fetch=h.fetch;
 assert.equal((await readTaskHostStatusV2(taskId,EXT)).readback.state,'verified');
 assert.equal(h.calls.filter(c=>c.path.startsWith('/v2/reports/')).length,2);assert.equal(h.posts().length,0);
 h=host(routes(busy));globalThis.fetch=h.fetch;
 assert.deepEqual((await readTaskHostStatusV2(taskId,EXT)).readback,{state:'unavailable',checkedAt:null,reason:'reader_unavailable'});
 assert.equal(h.calls.filter(c=>c.path.startsWith('/v2/reports/')).length,2,'exactly one retry');assert.equal(h.posts().length,0);
});

test('removed v1 reads fail closed: plain operationId and delegations=1 make no upstream call; run without respond:claim is refused',async t=>{
 hostEnv(t);const h=host({});globalThis.fetch=h.fetch;
 const get=(q:string)=>GET(new Request('http://localhost/api/ops/tasks/host-delegation?taskId='+taskId+q,{headers:{host:'localhost',cookie:'KAPELLE_OPS_TOKEN=synthetic-host'}}));
 assert.equal((await get('&operationId='+EXT)).status,400);assert.equal(h.calls.length,0,'no read for the removed execution path');
 const r=await get('&delegations=1');assert.notEqual((await r.json()).contract,'kapelle.task-host-delegations/v1');
 await assert.rejects(commandTaskHost(taskId,{action:'run',operationId:EXT}));assert.equal(h.posts().length,0);
});

test('pilot signals reach context and discovery v2; an older Framework (404) leaves them absent, never invented',async t=>{
 hostEnv(t);const {readTaskHostContext}=await import('../app/ops/_lib/taskHost');
 const signals={mode:'single-task-pilot',taskBound:true,newWorkEndsAt:'2026-10-14T12:00:00.000Z',newWorkEnded:true,invocationConsumed:false,pinnedPlan:null};
 let h=host({pilot:signals});globalThis.fetch=h.fetch;
 assert.deepEqual((await readTaskHostContext(taskId)).pilot,signals);
 assert.deepEqual((await findTaskHostDelegationsV2(taskId)).pilot,signals);assert.equal(h.posts().length,0);
 h=host({pilot:null});globalThis.fetch=h.fetch;assert.equal((await readTaskHostContext(taskId)).pilot,null);
 h=host({});globalThis.fetch=h.fetch;const old=await readTaskHostContext(taskId);assert.equal('pilot' in old,false);assert.equal('pilot' in (await findTaskHostDelegationsV2(taskId)),false);
 // A malformed signal is unknown, not a pilot claim.
 h=host({pilot:{...signals,newWorkEnded:'yes'}});globalThis.fetch=h.fetch;assert.equal('pilot' in (await readTaskHostContext(taskId)),false);
});

test('prior result (Revise or run again): only an independently verified Report, bounded excerpt, GET only',async t=>{
 hostEnv(t);Object.assign(process.env,{KAPELLE_REPORT_DETAIL_URL:'http://127.0.0.1:14250/v2/reports',KAPELLE_REPORT_REGISTRY_MCP_TOKEN:'x'.repeat(40),KAPELLE_REPORT_REGISTRY_DRIVE_ID:'drive'});
 const {readTaskHostPriorResult,PRIOR_RESULT_EXCERPT_CHARS}=await import('../app/ops/_lib/taskHost');
 const md='# Task result\n\n'+'Finding. '.repeat(400),H='sha256:'+createHash('sha256').update(md).digest('hex');
 const routes=(report:()=>Response,published=true)=>({receipts:{[EXT]:receipt(EXT,D1,{status:published?'RESULT_RECORDED':'ACCEPTED',instanceId:OLD,contentHash:H})},
  workers:{[D1]:published?worker(D1,'REPORT_PUBLISHED',{published:{reportId:REPORT,contentHash:H}}):worker(D1,'EXECUTION_RUNNING')},report});
 let h=host(routes(()=>Response.json(reportDetail(REPORT,{markdown:md,sourceRef:'dispatch:'+D1}))));globalThis.fetch=h.fetch;
 const r=await readTaskHostPriorResult(taskId,EXT);
 assert.equal(r.contract,'kapelle.task-host-prior-result/v1');assert.equal(r.reportId,REPORT);assert.equal('title' in r,false,'only hash-covered bytes are returned');assert.equal(r.excerpt.length,PRIOR_RESULT_EXCERPT_CHARS);assert.equal(r.truncated,true);assert.ok(md.startsWith(r.excerpt));
 assert.equal(h.posts().length,0);
 const get=(q:string)=>GET(new Request('http://localhost/api/ops/tasks/host-delegation?taskId='+taskId+q,{headers:{host:'localhost',cookie:'KAPELLE_OPS_TOKEN=synthetic-host'}}));
 assert.equal((await get('&priorResult='+EXT)).status,200);
 h=host(routes(()=>Response.json(reportDetail(REPORT,{markdown:md+'edited',sourceRef:'dispatch:'+D1}))));globalThis.fetch=h.fetch;
 await assert.rejects(readTaskHostPriorResult(taskId,EXT),/no longer matches/);
 h=host(routes(()=>new Response('{}',{status:503})));globalThis.fetch=h.fetch;await assert.rejects(readTaskHostPriorResult(taskId,EXT),/could not be read/);
 h=host(routes(()=>Response.json({}),false));globalThis.fetch=h.fetch;await assert.rejects(readTaskHostPriorResult(taskId,EXT),/no published Report/);
 assert.equal(h.posts().length,0);
});
