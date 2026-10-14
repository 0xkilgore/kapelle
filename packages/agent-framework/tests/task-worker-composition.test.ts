import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {taskDelegationFixture} from './task-delegation-fixture.js';
import {taskWorkerComposition} from './fixtures/task-worker-composition.js';
import {syntheticTaskPlanProducer} from './fixtures/task-plan-producer.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {TaskGenerations} from '../src/task-delegation/generations.js';
import {digest} from '../src/content.js';
const native=process.env.KAPELLE_SCOPED_REACTOR_ROOT&&process.env.KAPELLE_PLATFORM_MODELS_ROOT;
async function setup(){
 const f=await taskDelegationFixture(syntheticTaskPlanProducer()),c=await taskWorkerComposition(f),api=new TaskProposals(f.authority),g=new TaskGenerations(f.authority);
 const roster=await f.authority.taskDelegationAgents(f.platform.taskId),agent=roster.agents.find(a=>a.available)!,op=randomUUID();
 const original=(await api.create({operationId:op,draft:{operationId:op,taskId:f.platform.taskId,revision:roster.task.revision,sourceHash:roster.task.sourceHash,agentId:agent.id,recipient:agent.recipient!,includeNotes:true,includeComments:true,includeReferences:true,instructions:'Research this company from the supplied source packet.'}}))!;
 const selected=JSON.parse(original.versions[0].source.content),notes=JSON.parse(selected.notes),source=c.sourcePacket(notes.packetHash);expect(digest(source.packet)).toBe(notes.packetHash);expect(source.packet.sources).toHaveLength(2);
 const generation=await g.request(original.proposalId,{operationId:randomUUID(),expectedRevision:original.revision,baseVersion:1,basePlanHash:original.versions[0].planHash,comment:'Compare its audience and product. Identify evidence gaps.'});
 const revised=await g.run(original.proposalId,generation.generationRequests[0].operationId);
 const receipt=(await api.approveAndSend(revised.proposalId,{operationId:randomUUID(),expectedRevision:revised.revision,version:2,planHash:revised.versions[1].planHash})).item!;
 return {f,c,original,revised,receipt};
}
describe.skipIf(!native)('Complete generated-plan to new TaskWorker composition',()=>{
 it('uses approved generated plan and actual packet; native Report and read-only status survive reopen and lost acknowledgment',async()=>{const x=await setup();try{
  const id=x.receipt.dispatchId;expect((await x.c.inspect(id)).worker).toBeNull();expect(x.c.state().providerInvocations).toBe(0);
  x.c.configure({loseRunResponse:true});await expect(x.c.run(id)).rejects.toThrow('worker response lost');await x.c.reopen();
  const recovered=await x.c.inspect(id);expect(recovered.worker?.status).toBe('REPORT_PUBLISHED');expect(recovered.item?.status).toBe('RESULT_RECORDED');const r=await x.c.report(recovered.worker!.result!.reportId);
  expect(r.content.markdown).toContain(x.revised.versions[1].plan.instructions);expect(r.content.markdown).toContain(x.c.packet.sources[0].document.content);expect(r.inputHash).toBe(x.receipt.offerHash);expect(r.sourceRef).toBe('dispatch:'+id);expect(r.content.contentHash).toBe(recovered.item!.result!.contentHash);expect(r.contentVersion).toBe(recovered.item!.result!.contentVersion);expect(r.producerId).toBe(x.f.instance);
  expect((await x.f.platform.task()).status).toBe('OPEN');expect(x.c.state()).toMatchObject({providerInvocations:1,publicationInvocations:1,executionLookups:0,publicationLookups:0});
  expect((await x.f.complete(x.receipt.operationId))?.result).toEqual(recovered.item?.result);expect(x.c.state().providerInvocations).toBe(1);expect(x.c.state().publicationInvocations).toBe(1);
 }finally{await x.c.close();}},120000);
 it('HTTP pending is honest when publisher is unadmitted; GET cannot publish, recovery uses one retained output',async()=>{const x=await setup();try{
  const url=await x.f.serve(0,true),headers={authorization:'Bearer '+x.f.token,'content-type':'application/json'},path='/__fixture/task-worker/'+x.receipt.dispatchId;
  const post=(p:string,v:unknown)=>fetch(url+p,{method:'POST',headers,body:JSON.stringify(v)});
  expect((await fetch(url+path)).status).toBe(403);expect((await post(path+'/run',{provider:'forged'})).status).toBe(409);
  const source=await (await fetch(url+'/__fixture/source-packet/'+x.c.state().packetHash,{headers})).json() as any;expect(digest(source.packet)).toBe(x.c.state().packetHash);
  await post('/__fixture/task-worker-state',{publisherAdmitted:false});const pending=await (await post(path+'/run',{})).json() as any;
  expect(pending.worker).toMatchObject({status:'REPORT_PENDING',outputRetained:true,result:null});expect(pending.item.result).toBeNull();expect(x.c.state().publicationInvocations).toBe(0);
  await x.c.reopen();expect((await x.c.inspect(x.receipt.dispatchId)).worker?.status).toBe('REPORT_PENDING');x.c.configure({publisherAdmitted:true});
  expect((await x.c.inspect(x.receipt.dispatchId)).worker?.status).toBe('REPORT_PENDING');expect(x.c.state().publicationInvocations).toBe(0);
  const done=await x.c.run(x.receipt.dispatchId);expect(done.worker.status).toBe('REPORT_PUBLISHED');expect(x.c.state()).toMatchObject({providerInvocations:1,publicationInvocations:1});
 }finally{await x.c.close();}},120000);
 it('provider uncertainty and lost publication response recover by saved identities without repeated effects',async()=>{const x=await setup();try{
  x.c.configure({providerMode:'uncertain'});expect((await x.c.run(x.receipt.dispatchId)).worker.status).toBe('EXECUTION_UNCERTAIN');await x.c.reopen();
  expect((await x.c.inspect(x.receipt.dispatchId)).worker?.status).toBe('EXECUTION_UNCERTAIN');expect(x.c.state().executionLookups).toBe(0);
  expect((await x.c.run(x.receipt.dispatchId)).worker.status).toBe('EXECUTION_UNCERTAIN');expect(x.c.state().providerInvocations).toBe(1);
  x.c.configure({providerMode:'normal',losePublicationResponse:true});expect((await x.c.run(x.receipt.dispatchId)).worker.status).toBe('REPORT_PENDING');await x.c.reopen();
  expect((await x.c.inspect(x.receipt.dispatchId)).worker?.status).toBe('REPORT_PENDING');expect(x.c.state().publicationLookups).toBe(0);
  const done=await x.c.run(x.receipt.dispatchId);expect(done.worker.status).toBe('REPORT_PUBLISHED');expect(x.c.state()).toMatchObject({providerInvocations:1,publicationInvocations:1,publicationLookups:1});
  x.c.configure({readerAvailable:false});expect((await x.c.inspect(x.receipt.dispatchId)).worker).toMatchObject({status:'REPORT_PENDING',result:null});
 }finally{await x.c.close();}},120000);
});
