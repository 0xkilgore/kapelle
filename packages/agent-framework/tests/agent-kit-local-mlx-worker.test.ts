// local-mlx through the REAL TaskWorker (native approval, durable claim, journal, publication, readback): the vendored Pi path
// with a FAKE transport. No model server is started or contacted. Native-gated like the other worker tests.
import {describe, it, expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {realpathSync, mkdirSync} from 'node:fs';
import {taskDelegationFixture} from './task-delegation-fixture.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {TaskWorker} from '../src/task-delegation/worker.js';
import {packetTaskNotes, reportResultFact, type TaskSourcePacket, type TaskReportAdapter, type TaskReportReceipt, type TaskWorkerBinding} from '../src/task-delegation/worker-contract.js';
import {sha} from '../src/worker/contracts.js';
import {policy} from './fixtures.js';
import {localProfileSchema, localInferenceFor} from '../src/agent-kit/runtime-catalog.js';
import {openLocalMlxAdapter, vendoredPiDigest} from '../src/agent-kit/local-mlx/adapter.js';
import {RuntimeReservation} from '../src/agent-kit/local-mlx/reservation.js';
import type {MlxFetch} from '../src/agent-kit/local-mlx/transport.js';
import {OwnerPrivateReportStore, privateDocumentId} from '../src/agent-kit/private-store.js';
import {independentlyVerifiedReports} from '../src/task-delegation/runtime.js';
const native = process.env.KAPELLE_SCOPED_REACTOR_ROOT && process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const MODEL = 'mlx-community/Qwen3.6-27B-4bit';
const profile = localProfileSchema.parse({id: 'local-qwen', contract: 'kapelle.restricted-execution/v2', qualificationRef: 'synthetic:local-mlx',
  runtime: {kind: 'local-mlx', locality: 'local-only', model: MODEL, server: {implementation: 'mlx-lm', version: '0.31.3', service: 'com.kapelle.local-llm', endpoint: 'http://127.0.0.1:8080/v1'},
    modelManifestHash: 'sha256:' + 'a'.repeat(64), runnerManifestHash: 'sha256:' + 'b'.repeat(64), modelStorageRef: '~/Models/huggingface', contextTokens: 8192, sampling: {temperature: 0}, enableThinking: false, tools: [], concurrencyLimit: 1},
  harness: {kind: 'pi-agent-core', source: 'https://github.com/earendil-works/pi', commit: 'b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6', vendoredDigest: vendoredPiDigest(), adapterContract: 'kapelle.local-mlx-adapter/v1'},
  limits: {maxOutputTokens: 4096, maxBudgetUsd: 1, timeoutMs: 120000}});

async function fixture(reply: MlxFetch, opts: {private?: boolean} = {}){
 const f=await taskDelegationFixture();
 const packet:TaskSourcePacket={contract:'kapelle.task-source-packet/v1',sources:[{document:{id:randomUUID(),version:1,hash:sha('Synthetic company makes widgets.'),title:'Synthetic company profile',project:null,mimeType:'text/markdown',content:'Synthetic company makes widgets.'},reference:'fixture:company-profile',capturedAt:'2026-09-10T10:00:00.000Z'}]};
 const task=await f.readTask(f.platform.taskId);
 await f.platform.act(task.id,'updateBody',{expectedRevision:task.revision,bodyMarkdown:packetTaskNotes(packet,'Research this supplied fictional company. Return findings, source references and next steps.')},'owner');
 const roster=await f.authority.taskDelegationAgents(task.id),agent=roster.agents.find(a=>a.available)!,op=randomUUID(),api=new TaskProposals(f.authority);
 const proposal=(await api.create({operationId:op,draft:{operationId:op,taskId:task.id,revision:roster.task.revision,agentId:agent.id,recipient:agent.recipient!,sourceHash:roster.task.sourceHash,includeNotes:true,includeComments:false,includeReferences:false,instructions:'Prepare a research Report from the supplied source packet only.'}}))!;
 const sent=(await api.approveAndSend(proposal.proposalId,{operationId:randomUUID(),expectedRevision:proposal.revision,version:1,planHash:proposal.versions[0].planHash})).item!;
 const pin=agent.recipient!;
 const binding:TaskWorkerBinding={ownerId:'owner',scopeRef:f.ctx.scopeRef,instanceId:f.instance,runtimeBindingRef:pin.runtimeBindingRef,definitionHash:pin.definitionHash,capabilityHash:pin.capabilityHash,
  modelProfile:policy.preferredProfile,budgetPolicyRef:policy.budgetPolicyRef,inference:localInferenceFor(profile,{maxOutputTokens:1024,maxBudgetUsd:1,timeoutMs:5000}),
  ...(opts.private?{outputClassification:'owner-private' as const}:{})};
 let saved:{receipt:TaskReportReceipt,markdown:string}|null=null,publishCalls=0;
 const reports:TaskReportAdapter={bindingRef:'synthetic-native-registry',admitted:async()=>true,
  async publish(request){publishCalls++;const reportId=await f.platform.report(request.markdown,request.sourceRef,request.instanceId);const doc=await f.platform.coldRead(reportId),s=(doc.state as any).global;
   const receipt={publicationId:request.publicationId,dispatchId:request.dispatchId,inputHash:request.inputHash,reportId,contentVersion:1,contentHash:s.content.contentHash,verificationRef:'synthetic-independent:'+reportId};
   saved={receipt,markdown:request.markdown};f.setResultFact(reportResultFact(receipt));return receipt;},
  async lookup(){return saved?.receipt??null;},
  async read(receipt){const doc=await f.platform.coldRead(receipt.reportId),s=(doc.state as any).global;
   return {id:receipt.reportId,ownerId:binding.ownerId,scopeRef:binding.scopeRef,reportRef:s.reportRef,sourceRef:s.sourceRef,bytes:Buffer.from(s.content.markdown),revision:s.revision,contentVersion:1,publicationId:saved!.receipt.publicationId,dispatchId:saved!.receipt.dispatchId,inputHash:saved!.receipt.inputHash,producerId:s.producer.id,verificationRef:saved!.receipt.verificationRef};},
 };
 const privateStore=new OwnerPrivateReportStore(join(realpathSync(f.root),'private-reports'),{ownerId:'owner',scopeRef:f.ctx.scopeRef});
 const privateVerified=independentlyVerifiedReports(privateStore,'owner',f.ctx.scopeRef,f.instance);
 const privateReports:TaskReportAdapter={...privateVerified.reports,async publish(r){const rec=await privateVerified.reports.publish(r);f.setResultFact(reportResultFact(rec));return rec;}};
 const reservationDir=join(realpathSync(f.root),'local-runtime');mkdirSync(reservationDir,{recursive:true,mode:0o700});
 const ports=()=>({reports:opts.private?privateReports:reports,packet:async()=>packet,localProvider:openLocalMlxAdapter({profile,serviceGeneration:'gen-1',reservationDir,fetch:reply})});
 let worker=TaskWorker.open(join(realpathSync(f.root),'worker'),f.authority,binding,ports());
 return {f,binding,sent,reservationDir,privateStore,get worker(){return worker;},publishCalls:()=>publishCalls,
  async restart(){worker.close();await f.restart();worker=TaskWorker.open(join(realpathSync(f.root),'worker'),f.authority,binding,ports());},
  async close(){worker.close();await f.close();}};
}
const ok=(text:string)=>new Response(JSON.stringify({id:'chatcmpl-1',model:MODEL,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:text}}],usage:{prompt_tokens:900,completion_tokens:20,total_tokens:920}}),{status:200,headers:{'content-type':'application/json'}});

describe.skipIf(!native)('local-mlx through the real TaskWorker', () => {
  it('approved Dispatch -> one local request -> local receipt -> published, verified Report; nothing replays', async () => {
    const bodies:unknown[]=[];
    const x=await fixture(async(_u,init)=>{bodies.push(JSON.parse(init.body));return ok('# Widgets\n\nSynthetic finding from the supplied packet. Source: fixture:company-profile.');});
    try{
      expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'REPORT_PUBLISHED',outputRetained:true});
      expect(bodies).toHaveLength(1);
      const body=bodies[0] as any;
      expect(body).toMatchObject({model:MODEL,stream:false,max_tokens:1024,temperature:0,chat_template_kwargs:{enable_thinking:false}});
      expect(JSON.parse(body.messages[1].content).sources[0].reference).toBe('fixture:company-profile');
      expect(x.publishCalls()).toBe(1);
      await x.restart();
      expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'REPORT_PUBLISHED'});
      expect(bodies).toHaveLength(1); // no second request after restart
      expect(new RuntimeReservation(x.reservationDir,'com.kapelle.local-llm').read()).toBeNull();
    }finally{await x.close();}
  },120000);

  it('crash after send: the claim stays consumed and the runtime reservation stays uncertain; nothing is re-invoked or published', async () => {
    let calls=0;
    const x=await fixture(async(_u,init)=>{calls++;return new Promise<Response>((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted'))));});
    try{
      await x.worker.begin(x.sent.dispatchId,true,0);
      await new Promise(r=>setTimeout(r,300));
      expect(calls).toBe(1);
      x.worker.stop();await x.worker.drain();
      await x.restart();
      expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_UNCERTAIN',outputRetained:false});
      expect(calls).toBe(1);expect(x.publishCalls()).toBe(0);
      expect(new RuntimeReservation(x.reservationDir,'com.kapelle.local-llm').read()).toMatchObject({state:'uncertain'});
    }finally{await x.close();}
  },120000);

  it('owner-private agent: the Report is published ONLY to the owner-private store (zero Registry publications), verified, and readable through the gateway view', async () => {
    const x=await fixture(async()=>ok('# September (synthetic)\n\nCategorized 3 rows; flagged 1. No money moved.'),{private:true});
    try{
      const s=await x.worker.run(x.sent.dispatchId);
      expect(s).toMatchObject({status:'REPORT_PUBLISHED'});
      expect(x.publishCalls()).toBe(0); // the shared Registry double was never called
      const doc=x.privateStore.readDocument(s.result!.reportId)!;
      expect(doc).toMatchObject({classification:'owner-private',dispatchId:x.sent.dispatchId,lifecycle:'FINAL'});
      expect(doc.documentId).toBe(privateDocumentId('task-report:'+doc.reportRef.slice('report:task:'.length)));
      await x.restart();
      expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'REPORT_PUBLISHED'});
    }finally{await x.close();}
  },120000);

  it('F-L1: a complete but refused answer (truncated at the output ceiling) settles as a definite rejection: consumed, never re-invoked, reservation released', async () => {
    let calls=0;
    const x=await fixture(async()=>{calls++;return new Response(JSON.stringify({id:'chatcmpl-1',model:MODEL,choices:[{index:0,finish_reason:'length',message:{role:'assistant',content:'Partial...'}}],
      usage:{prompt_tokens:900,completion_tokens:1024,total_tokens:1924}}),{status:200,headers:{'content-type':'application/json'}});});
    try{
      expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_REJECTED',reason:'mlx_output_truncated',outputRetained:false});
      expect(calls).toBe(1);expect(x.publishCalls()).toBe(0);
      expect(new RuntimeReservation(x.reservationDir,'com.kapelle.local-llm').read()).toBeNull(); // the server settled
      expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_REJECTED',reason:'mlx_output_truncated'});
      await x.restart();
      expect(await x.worker.run(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_REJECTED',reason:'mlx_output_truncated'});
      expect(await x.worker.inspect(x.sent.dispatchId)).toMatchObject({status:'EXECUTION_REJECTED',reason:'mlx_output_truncated'});
      expect(calls).toBe(1); // never re-invoked
    }finally{await x.close();}
  },120000);
});
