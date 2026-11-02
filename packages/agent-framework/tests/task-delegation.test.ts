import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {taskDelegationFixture} from './task-delegation-fixture.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {taskSource} from '../src/task-delegation/contract.js';
const native=process.env.KAPELLE_SCOPED_REACTOR_ROOT&&process.env.KAPELLE_PLATFORM_MODELS_ROOT;
async function proposal(f:Awaited<ReturnType<typeof taskDelegationFixture>>){const r=await f.authority.taskDelegationAgents(f.platform.taskId),a=r.agents.find(a=>a.available)!,operationId=randomUUID(),api=new TaskProposals(f.authority);const request={operationId,draft:{operationId,taskId:f.platform.taskId,revision:r.task.revision,agentId:a.id,recipient:a.recipient!,instructions:'Prepare the requested work.',sourceHash:r.task.sourceHash,includeNotes:true,includeComments:true,includeReferences:true}};const p=(await api.create(request))!,v=p.versions[0],approval={operationId:randomUUID(),expectedRevision:p.revision,version:1,planHash:v.planHash};return {api,p,v,request,approval};}
describe.skipIf(!native)('Native general Task delegation with exact owner proposal approval',()=>{
 it('retains full context, recovers duplicates/separate process and links native Report without completing Task',async()=>{const f=await taskDelegationFixture();try{
  const x=await proposal(f),sent=await x.api.approveAndSend(x.p.proposalId,x.approval),first=sent.item!,draft={...x.v.draft,approval:first.approval};
  expect(JSON.parse(first.source.content).comments).toEqual(['Synthetic activity context.']);expect(JSON.parse(first.source.content).references).toEqual(['fixture: reference-123']);
  const both=await Promise.all([f.tasks.submit(draft),f.tasks.submit(draft)]);expect(both).toEqual([first,first]);expect(await f.coldLookup(draft.operationId)).toEqual(first);
  await expect(f.tasks.submit({...draft,instructions:'Changed intent'})).rejects.toThrow('payload conflict');const done=await f.complete(draft.operationId);expect(done?.status).toBe('RESULT_RECORDED');expect(done?.taskCompleted).toBe(false);expect(done?.effectsAuthorized).toBe(false);expect((await f.platform.task()).status).toBe('OPEN');await f.restart();expect(await f.tasks.lookup(draft.operationId)).toEqual(done);expect(await f.authority.backend.list('kapelle/dispatch')).toHaveLength(1);
 }finally{await f.close();}},120000);
 it('rejects identity/source drift and oversize context while recovering the accepted record after Task changes',async()=>{const f=await taskDelegationFixture();try{
  const x=await proposal(f);f.setReadOverride(t=>({...t,ownerId:'other'}));await expect(x.api.approveAndSend(x.p.proposalId,x.approval)).rejects.toThrow('source changed');f.setReadOverride();const sent=await x.api.approveAndSend(x.p.proposalId,x.approval),receipt=sent.item!;
  const t=await f.readTask(f.platform.taskId);await f.platform.act(t.id,'updateTitle',{expectedRevision:t.revision,title:'Changed native Task'},'owner');expect(await f.tasks.lookup(x.request.operationId)).toEqual(receipt);await expect(f.authority.dispatchBundle(receipt.dispatchId,f.instance)).rejects.toThrow('source changed');
  const op=randomUUID();await expect(x.api.create({operationId:op,draft:{...x.request.draft,operationId:op}})).rejects.toThrow('source changed');
  f.setReadOverride(t=>({...t,bodyMarkdown:'x'.repeat(25000)}));const big=await f.readTask(t.id),op2=randomUUID();await expect(x.api.create({operationId:op2,draft:{...x.request.draft,operationId:op2,revision:big.revision,sourceHash:taskSource(big).sourceHash}})).rejects.toThrow('too large');
 }finally{await f.close();}},120000);
 it('revoked runtime qualification blocks native recipient acceptance and keeps the offered receipt',async()=>{const f=await taskDelegationFixture();try{
  const x=await proposal(f),receipt=(await x.api.approveAndSend(x.p.proposalId,x.approval)).item!;f.ctx.runtimeBindingContracts={...f.ctx.runtimeBindingContracts,'local-adapter':'kapelle.document-review/v1'};
  expect((await f.authority.taskDelegationAgents(f.platform.taskId)).agents[0].available).toBe(false);await expect(f.authority.dispatchBundle(receipt.dispatchId,f.instance)).rejects.toThrow('recipient unavailable');await expect(f.command(receipt.dispatchId,'kapelle/dispatch','ACCEPT_DISPATCH',{inputHash:receipt.offerHash},f.instance)).rejects.toThrow('recipient unavailable');expect((await f.tasks.lookup(x.request.operationId))?.status).toBe('OFFERED');
 }finally{await f.close();}},120000);
 it('reconciles Dispatch committed after native approval but before its acknowledgement returns',async()=>{const f=await taskDelegationFixture();try{
  const x=await proposal(f),commit=f.authority.backend.commit.bind(f.authority.backend);let n=0;f.authority.backend.commit=async(...args)=>{const r=await commit(...args);if(++n===2)throw Error('synthetic lost dispatch acknowledgement');return r;};
  await expect(x.api.approveAndSend(x.p.proposalId,x.approval)).rejects.toThrow('lost dispatch acknowledgement');await f.restart();const result=await new TaskProposals(f.authority).approveAndSend(x.p.proposalId,x.approval);expect(result.item?.accepted).toBe(true);expect(await f.authority.backend.list('kapelle/dispatch')).toHaveLength(1);
 }finally{await f.close();}},120000);
 it('owner HTTP exposes durable proposal, exact approval, lookup and conflicting retry',async()=>{const f=await taskDelegationFixture();try{
  const x=await proposal(f),url=await f.serve(),headers={authorization:'Bearer '+f.token,'content-type':'application/json'};
  const call=(path:string,body?:unknown)=>fetch(url+path,{method:body===undefined?'GET':'POST',headers,...(body===undefined?{}:{body:JSON.stringify(body)})});
  expect((await fetch(url+'/task-proposals/'+x.p.proposalId)).status).toBe(403);expect((await call('/task-delegations/'+x.request.operationId)).status).toBe(404);expect((await call('/task-delegations',x.v.draft)).status).toBe(409);
  const response=await call('/task-proposals/'+x.p.proposalId+'/approve-and-send',x.approval);expect(response.status).toBe(200);const saved=await response.json() as any;expect((await (await call('/task-delegations/'+x.request.operationId)).json() as any).item).toEqual(saved.item);
  expect((await call('/task-proposals/'+x.p.proposalId+'/approve-and-send',{...x.approval,planHash:'sha256:'+'a'.repeat(64)})).status).toBe(409);expect((await call('/task-proposals',{...x.request,effectsAuthorized:true})).status).toBe(400);expect(await f.authority.backend.list('kapelle/dispatch')).toHaveLength(1);
 }finally{await f.close();}},120000);
});
