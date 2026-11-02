import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {syntheticTaskPlanProducer} from './fixtures/task-plan-producer.js';
import {taskDelegationFixture} from './task-delegation-fixture.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {TaskGenerations} from '../src/task-delegation/generations.js';
import {generationInput,type GenerationReceipt,type TaskProposalProducer} from '../src/task-delegation/generation-contract.js';
import {digest} from '../src/content.js';
const native=process.env.KAPELLE_SCOPED_REACTOR_ROOT&&process.env.KAPELLE_PLATFORM_MODELS_ROOT;
async function setup(){
 let calls=0,lookups=0,loss=false,admitted=true,bad=false,after:(()=>Promise<void>)|undefined,saved:GenerationReceipt|null=null;
 let f:Awaited<ReturnType<typeof taskDelegationFixture>>;
 const producer:TaskProposalProducer={identity:{id:'synthetic-plan-producer',version:'fixture-v1',configHash:digest({mode:'deterministic-fixture'})},timeoutMs:5000,
  admitted:async()=>admitted,
  async generate(input,invocationId,signal){calls++;expect(signal.aborted).toBe(false);const current=await new TaskProposals(f.authority).read(input.proposalId),g=current.generationRequests.find(r=>r.operationId===input.operationId)!;
   expect(g.status).toBe('RUNNING');expect(g.invocationId).toBe(invocationId);expect(g.inputHash).toBe(digest(input));
   saved={producer:input.producer,inputHash:bad?digest('wrong'):digest(input),resultId:'fixture-result:'+invocationId,plan:{...input.plan,recommendedAction:'Compare the supplied company evidence and list questions.',instructions:'Use the saved source context. '+input.comment,deliverable:'A short Report with source references and open questions.'}};
   await after?.();if(loss)throw Error('synthetic response loss');return saved;
  },
  async lookup(){lookups++;return saved;},
 };
 f=await taskDelegationFixture(producer);
 let api=new TaskProposals(f.authority),generations=new TaskGenerations(f.authority);
 const roster=await f.authority.taskDelegationAgents(f.platform.taskId),a=roster.agents.find(a=>a.available)!,operationId=randomUUID();
 const proposal=(await api.create({operationId,draft:{operationId,taskId:f.platform.taskId,revision:roster.task.revision,sourceHash:roster.task.sourceHash,agentId:a.id,recipient:a.recipient!,instructions:'Prepare a source-based research report.',includeNotes:true,includeComments:true,includeReferences:true}}))!;
 const request={operationId:randomUUID(),expectedRevision:proposal.revision,baseVersion:1,basePlanHash:proposal.versions[0].planHash,comment:'Focus on two questions and keep it concise.'};
 return {f,producer,proposal,request,get api(){return api;},get generations(){return generations;},counts:()=>({calls,lookups}),set(v:{loss?:boolean;bad?:boolean;admitted?:boolean}){if(v.loss!==undefined)loss=v.loss;if(v.bad!==undefined)bad=v.bad;if(v.admitted!==undefined)admitted=v.admitted;},after(fn:()=>Promise<void>){after=fn;},
  async restart(){await f.restart();api=new TaskProposals(f.authority);generations=new TaskGenerations(f.authority);},close:()=>f.close(),
 };
}
describe.skipIf(!native)('Native generated Task plan revision',()=>{
 it('retains comment and exact input before generation; atomically appends unapproved provenance and preserves original',async()=>{const x=await setup();try{
  const requested=await x.generations.request(x.proposal.proposalId,x.request),g=requested.generationRequests[0];expect(g.status).toBe('PENDING');expect(x.counts().calls).toBe(0);expect(g.actorId).toBe('owner');expect(g.inputHash).toBe(digest(generationInput(x.proposal.proposalId,x.proposal.versions[0],g)));
  await expect(x.api.approveAndSend(x.proposal.proposalId,{operationId:randomUUID(),expectedRevision:requested.revision,version:1,planHash:x.request.basePlanHash})).rejects.toThrow('generation must settle');
  const done=await x.generations.run(x.proposal.proposalId,x.request.operationId);expect(done.currentVersion).toBe(2);expect(done.approval).toBeNull();expect(done.dispatchId).toBeNull();expect(done.versions[0]).toEqual(x.proposal.versions[0]);expect(done.versions[1].comment).toBe(x.request.comment);expect(done.versions[1].provenance).toMatchObject({kind:'generated',requestOperationId:x.request.operationId,inputHash:g.inputHash});expect(done.generationRequests[0]).toMatchObject({status:'APPLIED',appliedVersion:2,errorCode:null});
  await x.restart();expect(await x.api.read(done.proposalId)).toEqual(done);expect(await x.generations.run(done.proposalId,x.request.operationId)).toEqual(done);expect(x.counts().calls).toBe(1);
  await expect(x.api.approveAndSend(done.proposalId,{operationId:randomUUID(),expectedRevision:done.revision,version:1,planHash:x.request.basePlanHash})).rejects.toThrow('Stale');
  const sent=await x.api.approveAndSend(done.proposalId,{operationId:randomUUID(),expectedRevision:done.revision,version:2,planHash:done.versions[1].planHash});const bundle=await x.f.authority.dispatchBundle(sent.item!.dispatchId,x.f.instance);expect(JSON.parse(bundle.instructions).approvedPlan).toEqual(done.versions[1].plan);
 }finally{await x.close();}},120000);
 it('duplicate requests and lost generator responses recover after restart without a new invocation',async()=>{const x=await setup();try{
  const first=await x.generations.request(x.proposal.proposalId,x.request);expect(await x.generations.request(x.proposal.proposalId,x.request)).toEqual(first);await expect(x.generations.request(x.proposal.proposalId,{...x.request,comment:'Different'})).rejects.toThrow('payload conflict');
  x.set({loss:true});const pending=await x.generations.run(x.proposal.proposalId,x.request.operationId);expect(pending.generationRequests[0].status).toBe('UNCERTAIN');expect(pending.currentVersion).toBe(1);
  await x.restart();expect((await x.generations.run(x.proposal.proposalId,x.request.operationId)).generationRequests[0].status).toBe('APPLIED');expect(x.counts()).toEqual({calls:1,lookups:1});
 }finally{await x.close();}},120000);
 it('unconfirmed recovery remains uncertain and cannot invoke again',async()=>{const x=await setup();try{
  await x.generations.request(x.proposal.proposalId,x.request);x.set({loss:true});await x.generations.run(x.proposal.proposalId,x.request.operationId);x.producer.lookup=async()=>null;
  await x.restart();expect((await x.generations.run(x.proposal.proposalId,x.request.operationId)).generationRequests[0].status).toBe('UNCERTAIN');expect(x.counts().calls).toBe(1);
 }finally{await x.close();}},120000);
 it('lost native claim response does not grant an inference on retry',async()=>{const x=await setup();try{
  await x.generations.request(x.proposal.proposalId,x.request);const commit=x.f.authority.backend.commit.bind(x.f.authority.backend);let first=true;x.f.authority.backend.commit=async(...args)=>{const r=await commit(...args);if(first){first=false;throw Error('claim response lost');}return r;};
  await expect(x.generations.run(x.proposal.proposalId,x.request.operationId)).rejects.toThrow('claim response lost');await x.restart();expect((await x.generations.run(x.proposal.proposalId,x.request.operationId)).generationRequests[0].status).toBe('UNCERTAIN');expect(x.counts().calls).toBe(0);
 }finally{await x.close();}},120000);
 it('lost native result response recovers one generated version without repeating producer',async()=>{const x=await setup();try{
  await x.generations.request(x.proposal.proposalId,x.request);const commit=x.f.authority.backend.commit.bind(x.f.authority.backend);let n=0;x.f.authority.backend.commit=async(...args)=>{const r=await commit(...args);if(++n===2)throw Error('result response lost');return r;};
  await expect(x.generations.run(x.proposal.proposalId,x.request.operationId)).rejects.toThrow('result response lost');await x.restart();const done=await x.generations.run(x.proposal.proposalId,x.request.operationId);expect(done.versions).toHaveLength(2);expect(done.generationRequests[0].status).toBe('APPLIED');expect(x.counts().calls).toBe(1);
 }finally{await x.close();}},120000);
 it('changed Task after generation preserves result as failed without applying or approving it',async()=>{const x=await setup();try{
  await x.generations.request(x.proposal.proposalId,x.request);x.after(async()=>{const task=await x.f.readTask(x.f.platform.taskId);await x.f.platform.act(task.id,'updateTitle',{expectedRevision:task.revision,title:'Changed Task'},'owner');});
  const failed=await x.generations.run(x.proposal.proposalId,x.request.operationId);expect(failed.generationRequests[0]).toMatchObject({status:'FAILED',errorCode:'SOURCE_CHANGED'});expect(failed.generationRequests[0].receipt).not.toBeNull();expect(failed.versions).toHaveLength(1);expect(failed.approval).toBeNull();
 }finally{await x.close();}},120000);
 it('manual revision supersedes a pending request without executing its producer',async()=>{const x=await setup();try{
  const pending=await x.generations.request(x.proposal.proposalId,x.request),v=pending.versions[0];const revised=(await x.api.revise(pending.proposalId,{operationId:randomUUID(),expectedRevision:pending.revision,baseVersion:v.version,basePlanHash:v.planHash,comment:'Manual alternative',plan:{...v.plan,instructions:'Owner edited plan.'},draft:v.draft}))!;
  expect(revised.generationRequests[0]).toMatchObject({status:'FAILED',errorCode:'SUPERSEDED'});expect(await x.generations.run(pending.proposalId,x.request.operationId)).toEqual(revised);expect(x.counts().calls).toBe(0);
 }finally{await x.close();}},120000);
 it('invalid producer receipt or revoked admission cannot append a generated plan',async()=>{const x=await setup();try{
  await x.generations.request(x.proposal.proposalId,x.request);x.set({bad:true});const rejected=await x.generations.run(x.proposal.proposalId,x.request.operationId);expect(rejected.generationRequests[0]).toMatchObject({status:'FAILED',errorCode:'PRODUCER_REJECTED'});expect(rejected.versions).toHaveLength(1);
  const request={...x.request,operationId:randomUUID(),expectedRevision:rejected.revision};await x.generations.request(x.proposal.proposalId,request);x.set({admitted:false});expect((await x.generations.run(x.proposal.proposalId,request.operationId)).generationRequests[1].status).toBe('FAILED');expect(x.counts().calls).toBe(1);
 }finally{await x.close();}},120000);
 it('HTTP recovery exposes native requests, refuses supplied output and blocks generic generated writes',async()=>{const x=await setup();try{
  const url=await x.f.serve(),headers={authorization:'Bearer '+x.f.token,'content-type':'application/json'},base='/task-proposals/'+x.proposal.proposalId;
  const post=(path:string,body:unknown)=>fetch(url+path,{method:'POST',headers,body:JSON.stringify(body)});
  expect((await post(base+'/generation-requests',{...x.request,plan:{}})).status).toBe(400);expect((await post(base+'/generation-requests',x.request)).status).toBe(200);
  const cold=await (await fetch(url+base,{headers})).json() as any;expect(cold.item.generationRequests[0].operationId).toBe(x.request.operationId);
  expect((await post(base+'/generation-requests/'+x.request.operationId+'/run',{output:'forged'})).status).toBe(400);
  expect((await post('/commands',{type:'RECORD_TASK_GENERATION'})).status).toBe(403);
  expect((await post(base+'/generation-requests/'+x.request.operationId+'/run',{})).status).toBe(200);
 }finally{await x.close();}},120000);
 it('late output after manual replacement and approval is retained without changing approved version or Dispatch',async()=>{const x=await setup();try{
  await x.generations.request(x.proposal.proposalId,x.request);
  let dispatchId='';x.after(async()=>{
   const p=await x.api.read(x.proposal.proposalId),v=p.versions.at(-1)!;
   const edited=(await x.api.revise(p.proposalId,{operationId:randomUUID(),expectedRevision:p.revision,baseVersion:v.version,basePlanHash:v.planHash,comment:'Owner chooses a different plan',plan:{...v.plan,instructions:'Owner alternative.'},draft:v.draft}))!;
   dispatchId=(await x.api.approveAndSend(p.proposalId,{operationId:randomUUID(),expectedRevision:edited.revision,version:2,planHash:edited.versions[1].planHash})).item!.dispatchId;
  });
  const result=await x.generations.run(x.proposal.proposalId,x.request.operationId);expect(result.dispatchId).toBe(dispatchId);expect(result.status).toBe('APPROVED');expect(result.approval?.version).toBe(2);expect(result.versions).toHaveLength(2);expect(result.versions[1].plan.instructions).toBe('Owner alternative.');expect(result.generationRequests[0]).toMatchObject({status:'FAILED',errorCode:'SUPERSEDED'});expect(result.generationRequests[0].receipt).not.toBeNull();
  expect((await x.f.authority.dispatchBundle(dispatchId,x.f.instance)).document.state.global).toBeDefined();
 }finally{await x.close();}},120000);

 it('concurrent runners share one native invocation claim',async()=>{const x=await setup();try{
  await x.generations.request(x.proposal.proposalId,x.request);let ready!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);x.after(async()=>{ready();await gate;});
  const first=x.generations.run(x.proposal.proposalId,x.request.operationId);await started;
  try{expect((await new TaskGenerations(x.f.authority).run(x.proposal.proposalId,x.request.operationId)).generationRequests[0].status).toBe('APPLIED');}finally{release();}
  expect((await first).versions).toHaveLength(2);expect(x.counts()).toEqual({calls:1,lookups:1});
 }finally{await x.close();}},120000);
 it('revoked recipient qualification before invocation preserves failed request with no producer call',async()=>{const x=await setup();try{
  await x.generations.request(x.proposal.proposalId,x.request);x.f.ctx.runtimeBindingContracts={...x.f.ctx.runtimeBindingContracts,'local-adapter':'revoked'};
  const failed=await x.generations.run(x.proposal.proposalId,x.request.operationId);expect(failed.generationRequests[0]).toMatchObject({status:'FAILED',errorCode:'SOURCE_CHANGED'});expect(x.counts().calls).toBe(0);
 }finally{await x.close();}},120000);
 it('Product fixture injection is explicitly deterministic and retains generated provenance',async()=>{const x=await setup();try{
  Object.assign(x.producer,syntheticTaskPlanProducer());await x.generations.request(x.proposal.proposalId,x.request);
  const done=await x.generations.run(x.proposal.proposalId,x.request.operationId);expect(done.versions[1].plan.instructions).toBe(x.request.comment);expect(done.versions[1].provenance).toMatchObject({kind:'generated',id:'synthetic-comment-plan-producer',producerVersion:'deterministic-v1'});
 }finally{await x.close();}},120000);

});
