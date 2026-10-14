import {createServer} from 'node:http';
import {openTaskExecutionHost} from '../src/task-delegation/host.js';
import { describe,it,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recoverDeadWriterLock } from '../src/worker/writer-lock.js';
import { taskDelegationFixture } from './task-delegation-fixture.js';
import { TaskProposals } from '../src/task-delegation/proposals.js';
import { TaskWorker, type TaskWorkerPorts } from '../src/task-delegation/worker.js';
import { packetTaskNotes, reportResultFact, type TaskSourcePacket, type TaskReportAdapter, type TaskReportReceipt, type TaskWorkerBinding, type TaskExecutionReceipt } from '../src/task-delegation/worker-contract.js';
import { digest } from '../src/content.js';
import { sha } from '../src/worker/contracts.js';
import { policy } from './fixtures.js';
const native=process.env.KAPELLE_SCOPED_REACTOR_ROOT&&process.env.KAPELLE_PLATFORM_MODELS_ROOT;
async function fixture(){
 const f=await taskDelegationFixture();
 const packet:TaskSourcePacket={contract:'kapelle.task-source-packet/v1',sources:[{document:{id:randomUUID(),version:1,hash:sha('Synthetic company makes widgets.'),title:'Synthetic company profile',project:null,mimeType:'text/markdown',content:'Synthetic company makes widgets.'},reference:'fixture:company-profile',capturedAt:'2026-09-10T10:00:00.000Z'}]};
 const task=await f.readTask(f.platform.taskId);
 await f.platform.act(task.id,'updateBody',{expectedRevision:task.revision,bodyMarkdown:packetTaskNotes(packet,'Research this supplied fictional company. Return findings, source references and next steps.')},'owner');
 const roster=await f.authority.taskDelegationAgents(task.id),agent=roster.agents.find(a=>a.available)!,op=randomUUID(),api=new TaskProposals(f.authority);
 const proposal=(await api.create({operationId:op,draft:{operationId:op,taskId:task.id,revision:roster.task.revision,agentId:agent.id,recipient:agent.recipient!,sourceHash:roster.task.sourceHash,includeNotes:true,includeComments:false,includeReferences:false,instructions:'Prepare a research Report from the supplied source packet only.'}}))!;
 const sent=(await api.approveAndSend(proposal.proposalId,{operationId:randomUUID(),expectedRevision:proposal.revision,version:1,planHash:proposal.versions[0].planHash})).item!;
 const pin=agent.recipient!;
 const binding:TaskWorkerBinding={ownerId:'owner',scopeRef:f.ctx.scopeRef,instanceId:f.instance,runtimeBindingRef:pin.runtimeBindingRef,definitionHash:pin.definitionHash,capabilityHash:pin.capabilityHash,modelProfile:policy.preferredProfile,budgetPolicyRef:policy.budgetPolicyRef,inference:{model:'synthetic-model',credentialTeamId:randomUUID(),credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'synthetic-sdk',cliVersion:'synthetic-cli',maxOutputTokens:1024,maxBudgetUsd:1,timeoutMs:5000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'}};
 let providerCalls=0,publishCalls=0,readerCalls=0,lookupCalls=0,providerLoss=false,publishLoss=false,readUnavailable=false,admitted=true,packetAdmitted=true;
 let afterProvider:(()=>Promise<void>)|undefined,execution:TaskExecutionReceipt|null=null;
 let saved:{receipt:TaskReportReceipt,markdown:string}|null=null;
 const reports:TaskReportAdapter={bindingRef:'synthetic-native-registry',admitted:async()=>admitted,
  async publish(request){publishCalls++;const reportId=await f.platform.report(request.markdown,request.sourceRef,request.instanceId);const doc=await f.platform.coldRead(reportId),s=(doc.state as any).global;
   const receipt={publicationId:request.publicationId,dispatchId:request.dispatchId,inputHash:request.inputHash,reportId,contentVersion:1,contentHash:s.content.contentHash,verificationRef:'synthetic-independent:'+reportId};
   saved={receipt,markdown:request.markdown};f.setResultFact(reportResultFact(receipt));if(publishLoss)throw Error('synthetic publication reply lost');return receipt;},
  async lookup(){lookupCalls++;return saved?.receipt??null;},
  async read(receipt){readerCalls++;if(readUnavailable)throw Error('synthetic reader not admitted');const doc=await f.platform.coldRead(receipt.reportId),s=(doc.state as any).global;
   return {id:receipt.reportId,ownerId:binding.ownerId,scopeRef:binding.scopeRef,reportRef:s.reportRef,sourceRef:s.sourceRef,bytes:Buffer.from(s.content.markdown),revision:s.revision,contentVersion:1,publicationId:saved!.receipt.publicationId,dispatchId:saved!.receipt.dispatchId,inputHash:saved!.receipt.inputHash,producerId:s.producer.id,verificationRef:receipt.verificationRef};},
 };
 const ports:TaskWorkerPorts={reports,packet:async()=>{if(!packetAdmitted)throw Error('packet_not_admitted');return packet;},provider:{sdkVersion:'synthetic-sdk',cliVersion:'synthetic-cli',async run(input,sessionId,signal,capture){
  providerCalls++;expect(input.tools).toEqual([]);expect(JSON.parse(input.user).sources).toEqual(packet.sources);expect(signal.aborted).toBe(false);
  const runtime={provider:'anthropic' as const,runtime:'claude-agent-sdk' as const,model:input.model,sessionId,sdkVersion:'synthetic-sdk',cliVersion:'synthetic-cli',tools:[] as never[]};
  const text='Synthetic finding: this company makes widgets. Source: fixture:company-profile. Next: owner reviews the supplied evidence.';
  const output={text,contentHash:sha(text),byteSize:Buffer.byteLength(text),stopReason:'end_turn' as const,resultId:'synthetic-result',costUsd:0};execution={sessionId,inputHash:digest(input),runtime,output};capture.runtime(runtime);capture.output(output);
  await afterProvider?.();if(providerLoss)throw Error('synthetic provider reply lost');
 }}};
 let worker=TaskWorker.open(join(realpathSync(f.root),'worker'),f.authority,binding,ports);
 return {f,packet,binding,ports,reports,sent,get worker(){return worker;},get execution(){return execution;},get saved(){return saved;},counts:()=>({providerCalls,publishCalls,readerCalls,lookupCalls}),
  set(flags:{providerLoss?:boolean;publishLoss?:boolean;readUnavailable?:boolean;admitted?:boolean;packetAdmitted?:boolean}){if(flags.providerLoss!==undefined)providerLoss=flags.providerLoss;if(flags.publishLoss!==undefined)publishLoss=flags.publishLoss;if(flags.readUnavailable!==undefined)readUnavailable=flags.readUnavailable;if(flags.admitted!==undefined)admitted=flags.admitted;if(flags.packetAdmitted!==undefined)packetAdmitted=flags.packetAdmitted;},
  afterProvider(fn:()=>Promise<void>){afterProvider=fn;},
  async restart(){worker.close();await f.restart();worker=TaskWorker.open(join(realpathSync(f.root),'worker'),f.authority,binding,ports);},
  async close(){worker.close();await f.close();},
 };
}
describe.skipIf(!native)('Task worker: native approval, restricted execution and explicit Report adapter',()=>{
 it('retains uncertain ownership while provider cleanup is pending and rejects late output',async()=>{
  const x=await fixture();let release!:()=>void,entered!:()=>void,calls=0;
  const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
  x.ports.provider.run=async(_input,_session,signal,capture)=>{
   calls++;entered();await new Promise<void>(r=>signal.addEventListener('abort',()=>r(),{once:true}));
   capture.uncertain?.();await gate;
   expect(()=>capture.output({text:'late',contentHash:sha('late'),byteSize:4,stopReason:'end_turn',resultId:'late',costUsd:0})).toThrow('worker_late_callback');
   throw Error('synthetic terminated');
  };
  try{
   await x.worker.begin(x.sent.dispatchId,true,0);await started;x.worker.stop();
   await new Promise(r=>setTimeout(r,20));
   expect(await x.worker.inspect(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_UNCERTAIN',reason:'provider_termination_unconfirmed',outputRetained:false});
   expect(()=>x.worker.close()).toThrow('worker_busy');
   expect(()=>TaskWorker.open(join(realpathSync(x.f.root),'worker'),x.f.authority,x.binding,x.ports)).toThrow('worker_lock_held');
   release();await x.worker.drain();await x.restart();
   expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_UNCERTAIN'});expect(calls).toBe(1);expect(x.counts().publishCalls).toBe(0);
  }finally{release();await x.worker.drain();await x.close();}
 },120000);

 it('existing HTTP host admits exact packet, runs only explicit approved Dispatch, and reads/restarts without replay',async()=>{
  const x=await fixture();x.worker.close();let hostAdmitted=true;
  const open=()=>openTaskExecutionHost({root:join(realpathSync(x.f.root),'worker'),authority:x.f.authority,binding:x.binding,ports:x.ports,token:()=>x.f.token,admitted:async()=>hostAdmitted});
  let host=open(),server=createServer(host.handler);
  const listen=async()=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as any).port}`;};
  const stop=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));host.close();};
  let origin=await listen();const headers={authorization:'Bearer '+x.f.token,'content-type':'application/json'};
  const status=()=>fetch(origin+'/task-executions/'+x.sent.dispatchId,{headers});
  const run=(body={})=>fetch(origin+'/task-executions/'+x.sent.dispatchId+'/run',{method:'POST',headers,body:JSON.stringify(body)});
  try{
   expect((await fetch(origin+'/task-executions/'+x.sent.dispatchId)).status).toBe(403);
   // Increment 2 pilot signals: a non-pilot binding answers pilot:null; strict query; token required.
   expect(await (await fetch(origin+'/task-executions/pilot?taskId='+x.f.platform.taskId,{headers})).json()).toEqual({ok:true,contract:'kapelle.task-host-pilot/v1',instanceId:x.binding.instanceId,taskId:x.f.platform.taskId,pilot:null});
   expect((await fetch(origin+'/task-executions/pilot?taskId='+x.f.platform.taskId)).status).toBe(403);
   expect((await fetch(origin+'/task-executions/pilot?taskId=a&taskId=b',{headers})).status).toBe(400);
   let r=await fetch(origin+'/task-executions/admission?taskId='+x.f.platform.taskId,{headers});expect(await r.json()).toMatchObject({ready:true,instanceId:x.binding.instanceId,packetHash:digest(x.packet)});
   const sources=(query='taskId='+x.f.platform.taskId,auth=headers)=>fetch(origin+'/task-executions/sources?'+query,{headers:auth});
   const beforeRead=x.counts(),taskBefore=await x.f.readTask(x.f.platform.taskId);
   const sourceResponse=await sources();expect(sourceResponse.headers.get('cache-control')).toBe('private, no-store');
   const sourceBody=await sourceResponse.json();expect(sourceBody).toMatchObject({ok:true,contract:'kapelle.task-host-sources/v1',ready:true,instanceId:x.binding.instanceId,packetHash:digest(x.packet),packet:x.packet,task:{taskId:taskBefore.id,revision:taskBefore.revision}});
   expect(sourceBody.task.sourceHash).toBe(sourceBody.sourceHash);expect(digest(sourceBody.packet)).toBe(sourceBody.packetHash);
   expect(x.counts()).toEqual(beforeRead);expect(await x.f.readTask(x.f.platform.taskId)).toEqual(taskBefore);
   expect((await sources('taskId='+taskBefore.id,{authorization:'Bearer wrong','content-type':'application/json'})).status).toBe(403);
   for(const query of ['taskId='+taskBefore.id+'&url=https://example.com','taskId='+taskBefore.id+'&packetHash='+digest(x.packet),'taskId='+taskBefore.id+'&taskId='+taskBefore.id,''])expect((await sources(query)).status).toBe(400);
   hostAdmitted=false;expect(await (await sources()).json()).toEqual({ok:false,error:'host_not_admitted'});hostAdmitted=true;
   x.set({packetAdmitted:false});expect((await sources()).status).toBe(503);x.set({packetAdmitted:true});
   x.f.setReadOverride(t=>({...t,ownerId:'another-owner'}));expect(await (await sources()).json()).toEqual({ok:false,error:'task_execution_unavailable'});x.f.setReadOverride();
   let sourceReads=0;x.f.setReadOverride(t=>++sourceReads>=3?{...t,title:'Changed during admission'}:t);expect(await (await sources()).json()).toEqual({ok:false,error:'host_not_admitted'});x.f.setReadOverride();
   expect(await (await sources('taskId=unrelated-task')).json()).toEqual({ok:false,error:'task_execution_unavailable'});
   x.packet.sources[0].reference='changed';expect(await (await sources()).json()).toEqual({ok:false,error:'host_not_admitted'});x.packet.sources[0].reference='fixture:company-profile';
   expect(await (await status()).json()).toEqual({ok:true,item:null});expect(x.counts().providerCalls).toBe(0);
   expect((await run({instructions:'injected'})).status).toBe(400);expect(x.counts().providerCalls).toBe(0);
   x.packet.sources[0].reference='changed';r=await fetch(origin+'/task-executions/admission?taskId='+x.f.platform.taskId,{headers});expect(await r.json()).toMatchObject({ready:false,packetHash:null});expect((await run()).status).toBe(503);x.packet.sources[0].reference='fixture:company-profile';
   const done=await (await run()).json();expect(done.item.status).toBe('REPORT_PUBLISHED');expect(done.item.taskCompleted).toBe(false);expect((await x.f.platform.task()).status).toBe('OPEN');
   const before=x.counts();expect(await (await status()).json()).toEqual(done);expect(x.counts().providerCalls).toBe(before.providerCalls);expect(x.counts().publishCalls).toBe(before.publishCalls);expect(x.counts().lookupCalls).toBe(before.lookupCalls);
   await stop();await x.f.restart();host=open();server=createServer(host.handler);origin=await listen();expect(await (await status()).json()).toEqual(done);expect(await (await run()).json()).toEqual(done);expect(x.counts().providerCalls).toBe(1);expect(x.counts().publishCalls).toBe(1);
   hostAdmitted=false;expect((await status()).status).toBe(503);expect((await run()).status).toBe(503);expect(x.counts().providerCalls).toBe(1);
  }finally{await stop();await x.close();}
 },120000);
 it('a NEW execution whose publish readiness fails is refused before the claim and any inference (fixed label)',async()=>{const x=await fixture();try{
  let ready=false;(x.reports as any).publishReady=async()=>{if(!ready)throw Error('PRIVATE_PUBLICATION_MODEL_DEPLOYMENT_MISMATCH');};
  await expect(x.worker.run(x.sent.dispatchId)).rejects.toThrow(/^publisher_model_not_admitted$/);
  expect(x.counts().providerCalls).toBe(0);expect(x.counts().publishCalls).toBe(0);
  expect(((await x.f.authority.read(x.sent.dispatchId,'kapelle/dispatch')).state.global as any).phase).toBe('OFFERED');   // never accepted
  // Admission restored: the same Dispatch runs normally, exactly once.
  ready=true;expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PUBLISHED');expect(x.counts().providerCalls).toBe(1);
  // An existing attempt (status read / replay) never takes the readiness path, even if readiness fails again.
  ready=false;expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PUBLISHED');expect(x.counts().providerCalls).toBe(1);
 }finally{await x.close();}});
 it('a publish-time model refusal is named publisher_model_not_admitted on the run and on later status reads',async()=>{const x=await fixture();try{
  let refuse=false;(x.reports as any).publishReady=async()=>{if(refuse)throw Error('PRIVATE_PUBLICATION_MODEL_DEPLOYMENT_MISMATCH');};
  const publish=x.reports.publish;let thrown='PRIVATE_PUBLICATION_MODEL_DEPLOYMENT_MISMATCH';x.reports.publish=async()=>{throw Error(thrown);};
  x.afterProvider(async()=>{refuse=true;});   // the Registry changes during inference
  const first=await x.worker.run(x.sent.dispatchId);
  expect(first.status).toBe('REPORT_PENDING');expect(first.reason).toBe('publisher_model_not_admitted');expect(x.counts().providerCalls).toBe(1);
  // Non-pilot workers persist their start marker before publish, so later reads stay conservative (publication_uncertain);
  // pilot workers mark only at the first transport write, so their reads take the fresh readiness label instead.
  expect((await x.worker.inspect(x.sent.dispatchId))?.reason).toBe('publication_uncertain');
  // The fence class (a possible write already happened) is never labelled as a model refusal.
  refuse=false;thrown='PRIVATE_PUBLICATION_MODEL_DEPLOYMENT_CHANGED';
  expect((await x.worker.run(x.sent.dispatchId)).reason).toBe('publication_uncertain');
  x.reports.publish=publish;
 }finally{await x.close();}});
 it('executes approved context, independently reads one native Report and never repeats after restart',async()=>{const x=await fixture();try{
  const done=await x.worker.run(x.sent.dispatchId);expect(done.status).toBe('REPORT_PUBLISHED');expect(done.taskCompleted).toBe(false);expect(done.effectsAuthorized).toBe(false);
  expect((await x.f.tasks.lookup(x.sent.operationId))?.result?.reportId).toBe(done.result?.reportId);expect((await x.f.platform.task()).status).toBe('OPEN');
  await x.restart();expect(await x.worker.run(x.sent.dispatchId)).toEqual(done);expect(x.counts()).toEqual({providerCalls:1,publishCalls:1,readerCalls:2,lookupCalls:0});
 }finally{await x.close();}},120000);
 it('retains output pending publisher admission then resumes without reinference',async()=>{const x=await fixture();try{
  x.set({admitted:false});expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'REPORT_PENDING',outputRetained:true,reason:'publisher_not_admitted',result:null});
  expect((await x.f.tasks.lookup(x.sent.operationId))?.status).toBe('ACCEPTED');expect(x.counts().publishCalls).toBe(0);
  await x.restart();x.set({admitted:true});expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PUBLISHED');expect(x.counts().providerCalls).toBe(1);
 }finally{await x.close();}},120000);
 it('lost provider response stays uncertain across restart; read-only session recovery never reinvokes',async()=>{const x=await fixture();try{
  x.set({providerLoss:true});expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_UNCERTAIN',outputRetained:true});await x.restart();
  expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');expect(x.counts().publishCalls).toBe(0);
  x.ports.recoverExecution=async(sessionId,inputHash)=>{expect(sessionId).toBe(x.execution!.sessionId);expect(inputHash).toBe(x.execution!.inputHash);return x.execution;};
  expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PUBLISHED');expect(x.counts().providerCalls).toBe(1);
 }finally{await x.close();}},120000);
 it('lost publication response reconciles same identity after restart without republishing',async()=>{const x=await fixture();try{
  x.set({publishLoss:true});expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'REPORT_PENDING',reason:'publication_uncertain'});await x.restart();
  const done=await x.worker.run(x.sent.dispatchId);expect(done.status).toBe('REPORT_PUBLISHED');expect(done.result?.reportId).toBe(x.saved?.receipt.reportId);expect(x.counts()).toEqual({providerCalls:1,publishCalls:1,readerCalls:1,lookupCalls:1});
 }finally{await x.close();}},120000);
 it('unavailable readback never creates a native result; receipt survives restart',async()=>{const x=await fixture();try{
  x.set({readUnavailable:true});expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'REPORT_PENDING',reason:'readback_unconfirmed'});expect((await x.f.tasks.lookup(x.sent.operationId))?.result).toBeNull();
  await x.restart();x.set({readUnavailable:false});expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PUBLISHED');expect(x.counts().publishCalls).toBe(1);
 }finally{await x.close();}},120000);
 it('rejects changed packet, revoked qualification, changed Task and wrong owner before inference',async()=>{const x=await fixture();try{
  x.packet.sources[0].reference='changed';await expect(x.worker.run(x.sent.dispatchId)).rejects.toThrow('packet_changed');x.packet.sources[0].reference='fixture:company-profile';
  x.set({packetAdmitted:false});await expect(x.worker.run(x.sent.dispatchId)).rejects.toThrow('packet_not_admitted');x.set({packetAdmitted:true});
  const original=x.f.ctx.runtimeBindingContracts;x.f.ctx.runtimeBindingContracts={...original,'local-adapter':'revoked'};await expect(x.worker.run(x.sent.dispatchId)).rejects.toThrow('recipient unavailable');x.f.ctx.runtimeBindingContracts=original;
  expect(()=>TaskWorker.open(join(realpathSync(x.f.root),'wrong'),x.f.authority,{...x.binding,ownerId:'other'},x.ports)).toThrow('authority_scope_changed');
  const task=await x.f.readTask(x.f.platform.taskId);await x.f.platform.act(task.id,'updateTitle',{expectedRevision:task.revision,title:'Changed after approval'},'owner');await expect(x.worker.run(x.sent.dispatchId)).rejects.toThrow('source changed');expect(x.counts().providerCalls).toBe(0);
 }finally{await x.close();}},120000);
 it('revocation during execution retains evidence and refuses publication',async()=>{const x=await fixture();try{
  x.afterProvider(async()=>{x.f.ctx.runtimeBindingContracts={...x.f.ctx.runtimeBindingContracts,'local-adapter':'revoked'};});
  await expect(x.worker.run(x.sent.dispatchId)).rejects.toThrow('recipient unavailable');expect(x.counts()).toMatchObject({providerCalls:1,publishCalls:0});await x.restart();await expect(x.worker.run(x.sent.dispatchId)).rejects.toThrow('recipient unavailable');expect(x.counts().providerCalls).toBe(1);
 }finally{await x.close();}},120000);
 it('refuses another Dispatch result and changed bytes despite publication success',async()=>{const x=await fixture();try{
  const read=x.reports.read;x.reports.read=async r=>({...await read(r),dispatchId:randomUUID()});expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PENDING');expect((await x.f.tasks.lookup(x.sent.operationId))?.result).toBeNull();
  x.reports.read=async r=>({...await read(r),bytes:Buffer.from('wrong bytes')});expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PENDING');x.reports.read=read;expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PUBLISHED');expect(x.counts().publishCalls).toBe(1);
 }finally{await x.close();}},120000);
 it('native result acknowledgement loss reconciles on restart without replay',async()=>{const x=await fixture();try{
  const commit=x.f.authority.backend.commit.bind(x.f.authority.backend);let n=0;x.f.authority.backend.commit=async(...args)=>{const r=await commit(...args);if(++n===2)throw Error('synthetic lost result acknowledgement');return r;};
  await expect(x.worker.run(x.sent.dispatchId)).rejects.toThrow('lost result acknowledgement');await x.restart();expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PUBLISHED');expect(x.counts()).toMatchObject({providerCalls:1,publishCalls:1});
 }finally{await x.close();}},120000);
 it('a different empty journal cannot re-execute an already accepted Dispatch',async()=>{const x=await fixture();try{
  x.set({admitted:false});await x.worker.run(x.sent.dispatchId);
  const second=TaskWorker.open(join(realpathSync(x.f.root),'second-worker'),x.f.authority,x.binding,x.ports);
  try{await expect(second.run(x.sent.dispatchId)).rejects.toThrow('execution_history_required');}finally{second.close();}
  expect(x.counts().providerCalls).toBe(1);
 }finally{await x.close();}},120000);
 it('an uncertain publication with no receipt never gains another publication invocation',async()=>{const x=await fixture();try{
  let calls=0;x.reports.publish=async()=>{calls++;throw Error('unknown result');};x.reports.lookup=async()=>null;
  expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PENDING');await x.restart();
  expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PENDING');expect(calls).toBe(1);expect(x.counts().providerCalls).toBe(1);
 }finally{await x.close();}},120000);
 it('lost native acceptance response recovers before the only provider invocation',async()=>{const x=await fixture();try{
  const commit=x.f.authority.backend.commit.bind(x.f.authority.backend);let first=true;x.f.authority.backend.commit=async(...args)=>{const r=await commit(...args);if(first){first=false;throw Error('lost acceptance');}return r;};
  await expect(x.worker.run(x.sent.dispatchId)).rejects.toThrow('lost acceptance');expect(x.counts().providerCalls).toBe(0);
  await x.restart();expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PUBLISHED');expect(x.counts().providerCalls).toBe(1);
 }finally{await x.close();}},120000);

 it('a separate process crash after durable invocation claim cannot trigger another provider call',async()=>{const x=await fixture();try{
  x.worker.close();const root=join(realpathSync(x.f.root),'worker'),configPath=join(x.f.root,'crash-worker.json');
  await x.f.offline(async config=>{
   writeFileSync(configPath,JSON.stringify({...(config as object),workerRoot:root,binding:x.binding,packet:x.packet,dispatchId:x.sent.dispatchId}));
   const child=spawn(process.execPath,['--import',process.env.KAPELLE_WORKER_HOST_TSX!,fileURLToPath(new URL('./fixtures/task-worker-crash.ts',import.meta.url)),configPath],{env:process.env,stdio:['ignore','pipe','pipe']});
   let log='';child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
   const code=await new Promise<number|null>((ok,bad)=>{child.on('error',bad);child.on('close',ok);});expect(code,log).toBe(73);
   expect(readFileSync(join(root,'synthetic-invocation'),'utf8')).toBe('1');recoverDeadWriterLock(root,child.pid!);
  });
  await x.restart();expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');expect(x.counts().providerCalls).toBe(0);expect(x.counts().publishCalls).toBe(0);
 }finally{await x.close();}},120000);

});

// Saved-work projection tests share the native fixture above, without adding a store.
import {createTaskSavedWorkLoader,type SavedWorkAccess} from '../src/task-delegation/saved-work.js';
import {readdirSync,lstatSync} from 'node:fs';
function readAccess(x:Awaited<ReturnType<typeof fixture>>):SavedWorkAccess {
 return {subject:{subjectId:'authenticated-reader',ownerId:'owner',scopeRef:x.binding.scopeRef},
  authorizeDispatchRead:async selection=>selection.dispatchId===x.sent.dispatchId?{...selection,authorizationRef:'synthetic-dispatch-read-grant'}:null};
}
function retainedFiles(root:string):unknown{return readdirSync(root).filter(name=>!name.endsWith('-shm')).sort().map(name=>{const path=join(root,name),s=lstatSync(path);return {name,mode:s.mode,mtime:s.mtimeMs,ctime:s.ctimeMs,links:s.nlink,value:s.isDirectory()?retainedFiles(path):digest(readFileSync(path).toString('base64'))};});}
describe.skipIf(!native)('Saved work: existing native authority projection',()=>{
 it('returns immutable saved request and native recorded result with no execution, Report access or mutation',async()=>{const x=await fixture();try{
  await x.worker.run(x.sent.dispatchId);
  const workerRoot=join(realpathSync(x.f.root),'worker'),before=retainedFiles(workerRoot),counts=x.counts();
  const backend=x.f.authority.backend,snapshot=()=>backend.store.readOwnedOperationSnapshot({collectionId:backend.collectionId,documentId:x.sent.dispatchId,documentType:'kapelle/dispatch'});
  const nativeBefore=await snapshot(),journalBefore=x.f.authority.journal.db.prepare('SELECT * FROM commands ORDER BY id').all();
  const taskBefore=((await x.f.platform.task()).document.state as any).global;
  const denied=async()=>{throw Error('read attempted an effect');};
  x.ports.provider.run=denied;x.ports.recoverExecution=denied;
  x.reports.publish=denied;x.reports.lookup=denied;x.reports.read=denied;x.reports.admitted=denied;
  x.f.authority.backend.commit=denied;x.f.authority.command=denied;x.f.authority.dispatchCommand=denied;
  backend.store.reserveAllocation=denied;backend.store.finishAllocation=denied;backend.store.reconcile=denied;backend.client.executeScopedAuthority=denied;
  x.f.authority.journal.save=()=>{throw Error('journal mutation');};
  const db=(x.worker as any).db,prepare=db.prepare.bind(db);db.prepare=(sql:string)=>{expect(sql).toMatch(/^SELECT /);return prepare(sql);};
  const access=readAccess(x);let acl=0;const check=access.authorizeDispatchRead;access.authorizeDispatchRead=async s=>{acl++;return check(s);};
  const loader=createTaskSavedWorkLoader(x.worker,access),work=(await loader.loadSavedWork(x.sent.dispatchId))!;
  expect(work.request).toMatchObject({dispatchId:x.sent.dispatchId,taskId:x.f.platform.taskId,inputHash:x.sent.offerHash,markdown:x.saved!.markdown});
  const native=(await x.f.authority.read(x.sent.dispatchId,'kapelle/dispatch')).state.global as any;
  expect(work.nativeResult).toEqual({dispatchId:native.dispatchId,inputHash:native.offer.contentHash,reportId:native.result.reportId,contentVersion:native.result.contentVersion,contentHash:native.result.contentHash,verificationRef:native.result.verificationRef});
  expect(Object.isFrozen(work)&&Object.isFrozen(work.request)&&Object.isFrozen(work.nativeResult)).toBe(true);
  expect(await loader.loadSavedWork(x.sent.dispatchId)).toEqual(work);expect(acl).toBe(4);expect(x.counts()).toEqual(counts);expect(retainedFiles(workerRoot)).toEqual(before);
  expect(await snapshot()).toEqual(nativeBefore);expect(x.f.authority.journal.db.prepare('SELECT * FROM commands ORDER BY id').all()).toEqual(journalBefore);expect(((await x.f.platform.task()).document.state as any).global).toEqual(taskBefore);
 }finally{await x.close();}},120000);
 it('returns null for absent/unconfirmed history and null nativeResult for completed unpublished work',async()=>{const x=await fixture();try{
  const loader=createTaskSavedWorkLoader(x.worker,readAccess(x));expect(await loader.loadSavedWork(x.sent.dispatchId)).toBeNull();
  x.set({providerLoss:true});await x.worker.run(x.sent.dispatchId);expect(await loader.loadSavedWork(x.sent.dispatchId)).toBeNull();
  x.ports.recoverExecution=async()=>x.execution;x.set({admitted:false});await x.worker.run(x.sent.dispatchId);
  // A forged external fact must not become a saved native result.
  x.f.setResultFact({dispatchId:x.sent.dispatchId,inputHash:x.sent.offerHash,reportId:'invented',contentVersion:1,contentHash:'sha256:'+'0'.repeat(64),verificationRef:'invented'});
  const counts=x.counts(),work=(await loader.loadSavedWork(x.sent.dispatchId))!;expect(work.nativeResult).toBeNull();expect(work.request.markdown).toBe(x.execution!.output.text);expect(x.counts()).toEqual(counts);
 }finally{await x.close();}},120000);
 it('denies wrong owner/scope/subject/Dispatch before native or journal reads',async()=>{const x=await fixture();try{
  let reads=0;const read=x.f.authority.read.bind(x.f.authority);x.f.authority.read=async(...args)=>{reads++;return read(...args);};
  for(const change of [{ownerId:'other'},{scopeRef:'other'}]){const a=readAccess(x);Object.assign(a.subject,change);await expect(createTaskSavedWorkLoader(x.worker,a).loadSavedWork(x.sent.dispatchId)).rejects.toThrow();}
  const a=readAccess(x);a.authorizeDispatchRead=async selection=>({...selection,subjectId:'other-subject',authorizationRef:'wrong'});
  await expect(createTaskSavedWorkLoader(x.worker,a).loadSavedWork(x.sent.dispatchId)).rejects.toThrow('read_denied');
  await expect(createTaskSavedWorkLoader(x.worker,readAccess(x)).loadSavedWork(randomUUID())).rejects.toThrow();expect(reads).toBe(0);expect(x.counts().providerCalls).toBe(0);
  for(const change of ['identity','owner','scope']){
   x.f.authority.read=async(...args)=>{const doc=structuredClone(await read(...args));if(change==='identity')doc.header.id=randomUUID();else (doc.state.global as any)[change==='owner'?'ownerId':'scopeRef']='other';return doc;};
   await expect(createTaskSavedWorkLoader(x.worker,readAccess(x)).loadSavedWork(x.sent.dispatchId)).rejects.toThrow('dispatch_changed');
  }
 }finally{await x.close();}},120000);
 it('refuses changed Task or packet and stale/cross-Dispatch execution history',async()=>{const x=await fixture();try{
  await x.worker.run(x.sent.dispatchId);const loader=createTaskSavedWorkLoader(x.worker,readAccess(x)),worker=x.worker as any,db=worker.db;
  const original=db.prepare('SELECT body FROM attempts WHERE id=?').get(x.sent.dispatchId).body;
  for(const mutate of [(a:any)=>a.dispatchId=randomUUID(),(a:any)=>a.offerHash='sha256:'+'0'.repeat(64),(a:any)=>a.requestHash='changed',(a:any)=>a.input.user='{}']){
   const changed=JSON.parse(original);mutate(changed);db.prepare('UPDATE attempts SET body=? WHERE id=?').run(JSON.stringify(changed),x.sent.dispatchId);
   await expect(loader.loadSavedWork(x.sent.dispatchId)).rejects.toThrow();db.prepare('UPDATE attempts SET body=? WHERE id=?').run(original,x.sent.dispatchId);
  }
  const read=x.f.authority.read.bind(x.f.authority);x.f.authority.read=async(...args)=>{const doc=structuredClone(await read(...args));if(args[1]==='kapelle/dispatch')(doc.state.global as any).result.reportId='changed';return doc;};
  await expect(loader.loadSavedWork(x.sent.dispatchId)).rejects.toThrow('native_result_changed');x.f.authority.read=read;
  x.packet.sources[0].reference='changed';await expect(loader.loadSavedWork(x.sent.dispatchId)).rejects.toThrow('packet_changed');x.packet.sources[0].reference='fixture:company-profile';
  const t=await x.f.readTask(x.f.platform.taskId);await x.f.platform.act(t.id,'updateTitle',{expectedRevision:t.revision,title:'Changed Task'},'owner');await expect(loader.loadSavedWork(x.sent.dispatchId)).rejects.toThrow('Task source changed');
 }finally{await x.close();}},120000);
 it('refuses revoked admission or source changes during awaited readback',async()=>{const x=await fixture();try{
  await x.worker.run(x.sent.dispatchId);const a=readAccess(x);let calls=0;const authorize=a.authorizeDispatchRead;
  a.authorizeDispatchRead=async selection=>++calls===2?null:authorize(selection);
  await expect(createTaskSavedWorkLoader(x.worker,a).loadSavedWork(x.sent.dispatchId)).rejects.toThrow();
  const b=readAccess(x);calls=0;b.authorizeDispatchRead=async selection=>{if(++calls===2){const t=await x.f.readTask(x.f.platform.taskId);await x.f.platform.act(t.id,'updateTitle',{expectedRevision:t.revision,title:'Concurrent change'},'owner');}return authorize(selection);};
  await expect(createTaskSavedWorkLoader(x.worker,b).loadSavedWork(x.sent.dispatchId)).rejects.toThrow('changed_during_read');
 }finally{await x.close();}},120000);
});

describe.skipIf(!native)('Task worker shutdown',()=>{
 it('abort retains uncertain execution; close while busy refuses and restart does not reinvoke',async()=>{
  const x=await fixture();let entered!:()=>void,finish!:()=>void;
  const arrived=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{finish=r;});
  x.afterProvider(async()=>{entered();await gate;});
  try{
   const run=x.worker.run(x.sent.dispatchId);await arrived;x.worker.stop();
   expect(()=>x.worker.close()).toThrow('worker_busy');finish();
   expect(await run).toMatchObject({status:'EXECUTION_UNCERTAIN'});
   expect(x.counts().publishCalls).toBe(0);
   await expect(x.worker.run(x.sent.dispatchId)).rejects.toThrow('worker_unavailable');
   await x.restart();expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_UNCERTAIN'});
   expect(x.counts().providerCalls).toBe(1);expect(x.counts().publishCalls).toBe(0);
  }finally{finish();await x.close();}
 },120000);
});

// Pre-inference rejection (decision 2026-10-07) and claim-then-detach execution.
import {ProviderRejectedBeforeInference} from '../src/worker/execution.js';
import {MAX_PRE_INFERENCE_ATTEMPTS} from '../src/task-delegation/worker.js';
describe.skipIf(!native)('Task worker: pre-inference rejection and detached execution',()=>{
 it.each(['claude_oauth_not_available','claude_provider_binding_mismatch','claude_provider_context_invalid'])('local refusal %s is retained across restart and preserves the invocation right',async(reason)=>{const x=await fixture();try{
  const run=x.ports.provider.run;let refusals=0;
  x.ports.provider.run=async()=>{refusals++;throw new ProviderRejectedBeforeInference(reason);};
  const first=await x.worker.run(x.sent.dispatchId);
  expect(first).toMatchObject({status:'EXECUTION_REJECTED',reason,outputRetained:false,result:null,taskCompleted:false});
  const retained=JSON.parse((x.worker as any).db.prepare('SELECT body FROM attempts WHERE id=?').get(x.sent.dispatchId).body);
  expect(retained).toMatchObject({phase:'rejected',runtime:null,output:null,publication:null});expect(retained.rejections).toHaveLength(1);expect(retained.rejections[0].reason).toBe(reason);
  expect(x.counts().providerCalls).toBe(0);
  expect(refusals).toBe(1);expect(x.counts().publishCalls).toBe(0);
  expect((await x.f.tasks.lookup(x.sent.operationId))?.status).toBe('ACCEPTED');expect((await x.f.platform.task()).status).toBe('OPEN');
  await x.restart();expect(await x.worker.inspect(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_REJECTED',reason});
  x.ports.provider.run=run;const done=await x.worker.run(x.sent.dispatchId);
  expect(done.status).toBe('REPORT_PUBLISHED');expect(x.counts()).toMatchObject({providerCalls:1,publishCalls:1});
  await x.restart();expect(await x.worker.run(x.sent.dispatchId)).toEqual(done);expect(x.counts().providerCalls).toBe(1);
 }finally{await x.close();}},120000);
 it.each(['claude_provider_account_mismatch','claude_provider_account_unavailable','claude_provider_account_interrupted'])('post-query account failure %s remains uncertain without replay',async(reason)=>{
  const x=await fixture();let submissions=0;try{
   // Even a wrongly typed exception must not expand the pre-query allowlist.
   x.ports.provider.run=async()=>{submissions++;throw new ProviderRejectedBeforeInference(reason);};
   expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');
   const retained=JSON.parse((x.worker as any).db.prepare('SELECT body FROM attempts WHERE id=?').get(x.sent.dispatchId).body);
   expect(retained.rejections).toEqual([]);
   await x.restart();expect((await x.worker.inspect(x.sent.dispatchId))?.status).toBe('EXECUTION_UNCERTAIN');
   expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');expect(submissions).toBe(1);
  }finally{await x.close();}
 },120000);
 it('a locally named refusal cannot erase already captured query uncertainty',async()=>{
  const x=await fixture();let submissions=0;try{
   x.ports.provider.run=async(_input,_session,_signal,capture)=>{submissions++;capture.uncertain?.();throw new ProviderRejectedBeforeInference('claude_provider_context_invalid');};
   expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');
   await x.restart();expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');expect(submissions).toBe(1);
  }finally{await x.close();}
 },120000);
 it('refusals are bounded: after the limit the Dispatch stays rejected and no further provider call is made',async()=>{const x=await fixture();try{
  let refusals=0;x.ports.provider.run=async()=>{refusals++;throw new ProviderRejectedBeforeInference('claude_oauth_not_available');};
  for(let i=1;i<MAX_PRE_INFERENCE_ATTEMPTS;i++)expect((await x.worker.run(x.sent.dispatchId))).toMatchObject({status:'EXECUTION_REJECTED',reason:'claude_oauth_not_available'});
  // The last permitted refusal is reported as the limit, so the owner sees the boundary immediately.
  expect(refusals).toBe(MAX_PRE_INFERENCE_ATTEMPTS-1);
  expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_REJECTED',reason:'rejection_limit',outputRetained:false});
  expect(refusals).toBe(MAX_PRE_INFERENCE_ATTEMPTS);await x.restart();
  expect((await x.worker.inspect(x.sent.dispatchId))?.reason).toBe('rejection_limit');expect(x.counts().publishCalls).toBe(0);
 }finally{await x.close();}},120000);
 it('an aborted attempt is never reclassified as a rejection',async()=>{const x=await fixture();try{
  x.ports.provider.run=async(_input,_session,signal)=>{x.worker.stop();expect(signal.aborted).toBe(true);throw new ProviderRejectedBeforeInference('claude_oauth_not_available');};
  expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_UNCERTAIN',reason:'provider_receipt_unconfirmed'});
  await x.restart();expect((await x.worker.inspect(x.sent.dispatchId))?.status).toBe('EXECUTION_UNCERTAIN');
 }finally{await x.close();}},120000);
 it('a refusal after a model turn began stays uncertain even if it carries the rejection class',async()=>{const x=await fixture();try{
  const run=x.ports.provider.run;
  x.ports.provider.run=async(input,sessionId,signal,capture)=>{await run(input,sessionId,signal,{runtime:capture.runtime,output:()=>{}});throw new ProviderRejectedBeforeInference('claude_oauth_not_available');};
  expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');
  x.ports.provider.run=run;expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');expect(x.counts().providerCalls).toBe(1);
 }finally{await x.close();}},120000);
 it('begin() answers with the durable claim while the provider works; reads see RUNNING; a second start is refused; HTTP 202 then 200',async()=>{
  const x=await fixture();x.worker.close();
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let entered!:()=>void;const arrived=new Promise<void>(r=>{entered=r;});
  x.afterProvider(async()=>{entered();await gate;});
  const host=openTaskExecutionHost({root:join(realpathSync(x.f.root),'worker'),authority:x.f.authority,binding:x.binding,ports:x.ports,token:()=>x.f.token,admitted:async()=>true});
  const server=createServer(host.handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${(server.address() as any).port}`,headers={authorization:'Bearer '+x.f.token,'content-type':'application/json'};
  const status=async()=>(await (await fetch(origin+'/task-executions/'+x.sent.dispatchId,{headers})).json()).item;
  const run=()=>fetch(origin+'/task-executions/'+x.sent.dispatchId+'/run',{method:'POST',headers,body:'{}'});
  try{
   const started=await run();expect(started.status).toBe(202);
   const {DatabaseSync}=await import('node:sqlite');const persisted=new DatabaseSync(join(realpathSync(x.f.root),'worker','task-executions.sqlite'),{readOnly:true});
   try{expect(JSON.parse((persisted.prepare('SELECT body FROM attempts WHERE id=?').get(x.sent.dispatchId) as any).body).phase).toBe('started');}finally{persisted.close();}
   expect((await started.json()).item).toMatchObject({status:'EXECUTION_RUNNING',reason:null,result:null});
   await arrived;expect(await status()).toMatchObject({status:'EXECUTION_RUNNING'});
   expect((await run()).status).toBe(409);expect(x.counts().providerCalls).toBe(1);
   release();for(let i=0;i<200&&(await status()).status==='EXECUTION_RUNNING';i++)await new Promise(r=>setTimeout(r,25));
   expect(await status()).toMatchObject({status:'REPORT_PUBLISHED'});
   const again=await run();expect(again.status).toBe(200);expect((await again.json()).item.status).toBe('REPORT_PUBLISHED');
   expect(x.counts()).toMatchObject({providerCalls:1,publishCalls:1});
  }finally{release();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await host.stop();host.close();await x.close();}
 },120000);
 it('stop() during a detached run aborts it, drain() waits, and the journal reads uncertain afterwards',async()=>{
  const x=await fixture();let entered!:()=>void;const arrived=new Promise<void>(r=>{entered=r;});let finish!:()=>void;const gate=new Promise<void>(r=>{finish=r;});
  x.afterProvider(async()=>{entered();await gate;});
  try{
   const claim=await x.worker.begin(x.sent.dispatchId,true,0);expect(claim.status).toBe('EXECUTION_RUNNING');
   await arrived;x.worker.stop();finish();await x.worker.drain();
   expect((await x.worker.inspect(x.sent.dispatchId))?.status).toBe('EXECUTION_UNCERTAIN');expect(x.counts().publishCalls).toBe(0);
   await x.restart();expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');expect(x.counts().providerCalls).toBe(1);
  }finally{finish();await x.close();}
 },120000);
});

describe.skipIf(!native)('post-submission failures retain the invocation claim',()=>{
 for(const legacyClass of [false,true])it('init mismatch with zero captures stays uncertain; legacy class='+legacyClass,async()=>{
  const x=await fixture();let submissions=0;
  try{
   x.ports.provider.run=async()=>{submissions++;throw legacyClass?new ProviderRejectedBeforeInference('claude_runtime_mismatch:fields=agents.nonempty'):Error('claude_runtime_mismatch:fields=agents.nonempty');};
   expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');
   expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');
   await x.restart();expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');
   expect(submissions).toBe(1);expect(x.counts().publishCalls).toBe(0);
  }finally{await x.close();}
 },120000);
});

describe.skipIf(!native)('historical unsafe rejection compatibility',()=>{
 it('old init-rejection journal never gains a fresh invocation right',async()=>{
  const x=await fixture();try{
   x.ports.provider.run=async()=>{throw new ProviderRejectedBeforeInference('claude_oauth_not_available');};
   await x.worker.run(x.sent.dispatchId);const db=(x.worker as any).db;
   const old=JSON.parse(db.prepare('SELECT body FROM attempts WHERE id=?').get(x.sent.dispatchId).body);
   old.rejections[0].reason='claude_runtime_mismatch:fields=agents.nonempty';db.prepare('UPDATE attempts SET body=? WHERE id=?').run(JSON.stringify(old),x.sent.dispatchId);
   await x.restart();let submissions=0;x.ports.provider.run=async()=>{submissions++;};
   expect((await x.worker.inspect(x.sent.dispatchId))?.status).toBe('EXECUTION_UNCERTAIN');
   expect((await x.worker.run(x.sent.dispatchId)).status).toBe('EXECUTION_UNCERTAIN');expect(submissions).toBe(0);
  }finally{await x.close();}
 },120000);
});
it.skipIf(!native)('status reads of a published result use readVerified; confirmation always reads fresh',async()=>{
 const x=await fixture();let fresh=0,reused=0;const read=x.reports.read;
 x.reports.read=async r=>{fresh++;return read(r);};x.reports.readVerified=async r=>{reused++;return read(r);};
 expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PUBLISHED');
 const confirmFresh=fresh;expect(confirmFresh).toBeGreaterThan(0);expect(reused).toBe(0);
 expect((await x.worker.inspect(x.sent.dispatchId))?.status).toBe('REPORT_PUBLISHED');expect(reused).toBe(1);expect(fresh).toBe(confirmFresh);
 expect((await x.worker.run(x.sent.dispatchId)).status).toBe('REPORT_PUBLISHED');expect(reused).toBe(2);expect(fresh).toBe(confirmFresh);
});
