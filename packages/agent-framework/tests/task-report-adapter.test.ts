import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../src/content.js';
import {bytesHash} from '../src/publication/manifest.js';
import {PrivateTaskReportAdapter,verifiedPrivateTaskResultFact,type PrivateTaskPublicationPort} from '../src/task-delegation/private-report-adapter.js';
import {TaskWorker,type TaskWorkerPorts} from '../src/task-delegation/worker.js';
import {packetTaskNotes,type TaskReportRequest,type TaskWorkerBinding,type TaskSourcePacket} from '../src/task-delegation/worker-contract.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {taskDelegationFixture} from './task-delegation-fixture.js';
import {privateTaskPublisherFixture} from './fixtures/private-task-publisher.js';
import {policy} from './fixtures.js';
const paired=process.env.KAPELLE_TASK_PUBLISHER_ROOT;
function request():TaskReportRequest{const dispatchId=randomUUID(),inputHash=digest('input'),markdown='# Native candidate Report\nSynthetic.';return {publicationId:'task-report:'+digest({dispatchId,inputHash}).slice(7),ownerId:'owner',scopeRef:'scope',instanceId:'instance',dispatchId,inputHash,taskId:'task',sourceRef:'dispatch:'+dispatchId,packetHash:digest('packet'),executionHash:digest('execution'),markdown,contentHash:bytesHash(Buffer.from(markdown))};}
function admission(r:TaskReportRequest){const author={id:r.instanceId,label:'Synthetic admitted author',instanceId:r.instanceId,definitionId:'definition',definitionVersion:'1',definitionHash:digest('definition')};return {bindingRef:'synthetic-paired-native',ownerId:r.ownerId,scopeRef:r.scopeRef,driveId:'drive',actorId:'publisher-actor',authorizationRef:'synthetic:authorization',libraryOrigin:'https://private.example',author,publisher:{...author,id:'publisher',instanceId:'publisher'}};}
describe.skipIf(!paired)('Paired private publisher bridge with actual candidate Report model',()=>{
 it('uses native publication metadata, immutable version and independently admitted scope; rejects forged evidence',async()=>{
  const f=await privateTaskPublisherFixture(),root=realpathSync(mkdtempSync(join(tmpdir(),'paired-report-')));try{
   const r=request(),a=admission(r),port:PrivateTaskPublicationPort=new f.PrivateTaskReportPublisher({bindingRef:a.bindingRef,receiptDir:join(root,'receipts'),lockDir:join(root,'locks'),mcp:f.mcp,...(f.modelAdmission?{modelAdmission:f.modelAdmission}:{}),reader:f.reader,authorize:async()=>a});
   const adapter=new PrivateTaskReportAdapter(port),receipt=await adapter.publish(r),native=f.docs.get(receipt.reportId).state.global;
   expect(native.publication.contentVersion).toBe(receipt.contentVersion);expect(native.publication.author.instanceId).toBe(r.instanceId);expect(native.publication.sourceRef).toBe(r.sourceRef);expect(native.ownerId).toBeUndefined();expect(native.scopeRef).toBeUndefined();
   const read=await adapter.read(receipt);expect(read.ownerId).toBe(a.ownerId);expect(read.scopeRef).toBe(a.scopeRef);expect(Buffer.from(read.bytes).toString()).toBe(r.markdown);
   const before=f.counts().writes,d=f.docs.get(receipt.reportId);f.docs.set(receipt.reportId,f.Report.reducer(d,f.Report.actions.requestReview({request:'READ',expectedRevision:1,occurredAt:'2026-09-28T13:00:00.000Z',actorId:'publisher-actor'})));
   expect((await adapter.read(receipt)).revision).toBe(2);expect(await adapter.lookup(r)).toEqual(receipt);expect(f.counts().writes).toBe(before);
   const e:any=await port.read(r.publicationId);
   for(const mutate of [(v:any)=>v.publication.contentVersion++, (v:any)=>v.scope.ownerId='other', (v:any)=>v.publication.author.instanceId='other', (v:any)=>v.publication.runRef=v.publication.runRef.replace(r.dispatchId,randomUUID()), (v:any)=>v.markdown='wrong', (v:any)=>v.verificationRef='forged', (v:any)=>v.publication.provenanceRef='kapelle-task://execution/'+'0'.repeat(64)+'?packet='+r.packetHash.slice(7)]){
    const bad=structuredClone(e);mutate(bad);const hostile=new PrivateTaskReportAdapter({bindingRef:a.bindingRef,admitted:async()=>true,publish:async()=>bad,lookup:async()=>bad,read:async()=>bad});await expect(hostile.lookup(r)).rejects.toThrow();
   }
   f.readerAvailable(false);await expect(verifiedPrivateTaskResultFact(adapter,receipt)).rejects.toThrow('reader unavailable');expect(f.counts().writes).toBe(before);
  }finally{f.close();rmSync(root,{recursive:true,force:true});}
 });
 it.skipIf(!process.env.KAPELLE_SCOPED_REACTOR_ROOT||!process.env.KAPELLE_PLATFORM_MODELS_ROOT)('approved native Dispatch → deterministic worker → actual publisher → native Report → independent result fact; lost reply recovers once',async()=>{
  const f=await taskDelegationFixture(),p=await privateTaskPublisherFixture();let worker:TaskWorker|undefined;
  try{
   const text='Synthetic supplied company evidence.',packet:TaskSourcePacket={contract:'kapelle.task-source-packet/v1',sources:[{document:{id:randomUUID(),version:1,hash:bytesHash(Buffer.from(text)).slice(7),title:'Company',project:null,mimeType:'text/markdown',content:text},reference:'fixture:company',capturedAt:'2026-09-10T10:00:00.000Z'}]};
   const task=await f.readTask(f.platform.taskId);await f.platform.act(task.id,'updateBody',{expectedRevision:task.revision,bodyMarkdown:packetTaskNotes(packet,'Research supplied evidence.')},'owner');
   const roster=await f.authority.taskDelegationAgents(task.id),agent=roster.agents.find(a=>a.available)!,pin=agent.recipient!,op=randomUUID(),api=new TaskProposals(f.authority);
   const proposal=(await api.create({operationId:op,draft:{operationId:op,taskId:task.id,revision:roster.task.revision,sourceHash:roster.task.sourceHash,agentId:agent.id,recipient:pin,includeNotes:true,includeComments:false,includeReferences:false,instructions:'Prepare findings from supplied evidence.'}}))!;
   const sent=(await api.approveAndSend(proposal.proposalId,{operationId:randomUUID(),expectedRevision:proposal.revision,version:1,planHash:proposal.versions[0].planHash})).item!;
   const binding:TaskWorkerBinding={ownerId:'owner',scopeRef:f.ctx.scopeRef,instanceId:f.instance,runtimeBindingRef:pin.runtimeBindingRef,definitionHash:pin.definitionHash,capabilityHash:pin.capabilityHash,modelProfile:policy.preferredProfile,budgetPolicyRef:policy.budgetPolicyRef,inference:{model:'synthetic-model',credentialTeamId:randomUUID(),credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'synthetic-sdk',cliVersion:'synthetic-cli',maxOutputTokens:1024,maxBudgetUsd:1,timeoutMs:5000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'}};
   const a=admission({...request(),ownerId:binding.ownerId,scopeRef:binding.scopeRef,instanceId:f.instance});a.author.definitionHash=pin.definitionHash;
   const opts={bindingRef:a.bindingRef,receiptDir:join(realpathSync(f.root),'receipts'),lockDir:join(realpathSync(f.root),'publisher-locks'),mcp:p.mcp,...(p.modelAdmission?{modelAdmission:p.modelAdmission}:{}),reader:p.reader,authorize:async()=>a};
   let port:PrivateTaskPublicationPort=new p.PrivateTaskReportPublisher(opts),adapter=new PrivateTaskReportAdapter(port),invocations=0,publishCalls=0,lookups=0;
   const ports:TaskWorkerPorts={packet:async()=>packet,provider:{sdkVersion:'synthetic-sdk',cliVersion:'synthetic-cli',async run(input,sessionId,_signal,capture){invocations++;const markdown='Synthetic worker finding: '+JSON.parse(input.user).sources[0].document.content;
    capture.runtime({provider:'anthropic',runtime:'claude-agent-sdk',model:input.model,sessionId,sdkVersion:'synthetic-sdk',cliVersion:'synthetic-cli',tools:[]});capture.output({text:markdown,contentHash:bytesHash(Buffer.from(markdown)).slice(7),byteSize:Buffer.byteLength(markdown),stopReason:'end_turn',resultId:'synthetic',costUsd:0});
   }},reports:{bindingRef:a.bindingRef,admitted:r=>adapter.admitted(r),publish:r=>{publishCalls++;return adapter.publish(r);},lookup:r=>{lookups++;return adapter.lookup(r);},read:async r=>{const value=await adapter.read(r);f.setResultFact(await verifiedPrivateTaskResultFact(adapter,r));return value;}}};
   const workerRoot=join(realpathSync(f.root),'worker');worker=TaskWorker.open(workerRoot,f.authority,binding,ports);p.loseReply();
   expect(await worker.run(sent.dispatchId)).toMatchObject({status:'REPORT_PENDING',result:null});expect((await f.tasks.lookup(sent.operationId))?.result).toBeNull();const writes=p.counts().writes;
   worker.close();await f.restart();port=new p.PrivateTaskReportPublisher({...opts,now:()=>{throw Error('timestamp regenerated');}});adapter=new PrivateTaskReportAdapter(port);worker=TaskWorker.open(workerRoot,f.authority,binding,ports);
   const done=await worker.run(sent.dispatchId);expect(done.status).toBe('REPORT_PUBLISHED');expect((await f.tasks.lookup(sent.operationId))?.result?.reportId).toBe(done.result?.reportId);expect(p.docs.get(done.result!.reportId).state.global.publication.publicationId).toBe(done.result!.publicationId);
   expect({invocations,publishCalls,lookups}).toEqual({invocations:1,publishCalls:1,lookups:1});expect(p.counts().writes).toBe(writes);expect((await f.platform.task()).status).toBe('OPEN');expect(done.taskCompleted).toBe(false);expect(done.effectsAuthorized).toBe(false);
   p.readerAvailable(false);expect(await worker.inspect(sent.dispatchId)).toMatchObject({status:'REPORT_PENDING',result:null});expect(p.counts().writes).toBe(writes);
  }finally{worker?.close();p.close();await f.close();}
 },120000);
});
