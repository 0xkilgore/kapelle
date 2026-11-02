/** Isolated demo composition only. Never import into a production host. */
import {randomUUID} from 'node:crypto';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {TaskWorker,type TaskWorkerPorts} from '../../src/task-delegation/worker.js';
import {packetTaskNotes,reportResultFact,type TaskSourcePacket,type TaskReportRequest,type TaskReportReceipt,type TaskWorkerBinding,type TaskExecutionReceipt} from '../../src/task-delegation/worker-contract.js';
import {parseEnvelope} from '../../src/task-delegation/contract.js';
import {digest} from '../../src/content.js';
import {sha} from '../../src/worker/contracts.js';
import {assert} from '../../src/validation.js';
import {policy} from '../fixtures.js';
import type {taskDelegationFixture} from '../task-delegation-fixture.js';
import type {DispatchState} from '../../document-models/dispatch/v1/index.js';
const controlsSchema=z.object({publisherAdmitted:z.boolean().optional(),providerMode:z.enum(['normal','uncertain']).optional(),loseRunResponse:z.boolean().optional(),losePublicationResponse:z.boolean().optional(),readerAvailable:z.boolean().optional()}).strict();
export async function taskWorkerComposition(f:Awaited<ReturnType<typeof taskDelegationFixture>>){
 const texts=[
  {title:'Example Company product',reference:'https://example.org/company/product',content:'Fictional fixture: Example Company provides scheduling software for small service businesses.'},
  {title:'Example Company customers',reference:'https://example.org/company/customers',content:'Fictional fixture: independent studios and local repair shops are described as customers. No competitor evidence is supplied.'},
 ];
 const packet:TaskSourcePacket={contract:'kapelle.task-source-packet/v1',sources:texts.map(t=>({document:{id:randomUUID(),version:1,hash:sha(t.content),title:t.title,project:null,mimeType:'text/markdown',content:t.content},reference:t.reference,capturedAt:'2026-09-28T12:00:00.000Z'}))};
 let task=await f.readTask(f.platform.taskId);
 await f.platform.act(task.id,'updateTitle',{expectedRevision:task.revision,title:'Research Example Company — supplied source fixture'},'owner');
 task=await f.readTask(task.id);
 // Hash is approved along with readable supplied text. No reference fetch is performed.
 await f.platform.act(task.id,'updateBody',{expectedRevision:task.revision,bodyMarkdown:packetTaskNotes(packet,'SYNTHETIC supplied packet; no pages fetched.\n'+texts.map(t=>t.reference+'\n'+t.content).join('\n\n'))},'owner');
 const roster=await f.authority.taskDelegationAgents(task.id),pin=roster.agents.find(a=>a.id===f.instance&&a.available)!.recipient!;
 const binding:TaskWorkerBinding={ownerId:'owner',scopeRef:f.ctx.scopeRef,instanceId:f.instance,runtimeBindingRef:pin.runtimeBindingRef,definitionHash:pin.definitionHash,capabilityHash:pin.capabilityHash,modelProfile:policy.preferredProfile,budgetPolicyRef:policy.budgetPolicyRef,inference:{model:'synthetic-task-worker',credentialTeamId:randomUUID(),credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'synthetic-sdk',cliVersion:'synthetic-cli',maxOutputTokens:1024,maxBudgetUsd:1,timeoutMs:5000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'}};
 const settings={publisherAdmitted:true,providerMode:'normal' as 'normal'|'uncertain',loseRunResponse:false,losePublicationResponse:false,readerAvailable:true};
 const counters={providerInvocations:0,executionLookups:0,publicationInvocations:0,publicationLookups:0,independentReads:0};
 const publications=new Map<string,{request:TaskReportRequest,receipt:TaskReportReceipt}>(),executions=new Map<string,TaskExecutionReceipt>();
 async function report(reportId:string){
  assert(settings.readerAvailable,'synthetic reader unavailable');
  const saved=[...publications.values()].find(p=>p.receipt.reportId===reportId);assert(saved,'synthetic report unavailable');
  const doc=await f.platform.coldRead(reportId),s=(doc.state as any).global,r=saved.receipt,request=saved.request;
  counters.independentReads++;
  assert(doc.header.id===r.reportId&&s.id===r.reportId&&s.lifecycle==='FINAL'&&s.sourceRef===request.sourceRef&&s.producer?.kind==='AGENT'&&s.producer.id===request.instanceId&&s.content?.contentHash===request.contentHash&&s.content.markdown===request.markdown&&s.content.byteSize===Buffer.byteLength(request.markdown),'synthetic native Report differs');
  // Fixture-v1 immutable content is its sole registration, separate from document revision.
  return {synthetic:true as const,id:doc.header.id,...s,contentVersion:1,publicationId:r.publicationId,dispatchId:r.dispatchId,inputHash:r.inputHash,verificationRef:r.verificationRef,ownerId:binding.ownerId,scopeRef:binding.scopeRef,producerId:s.producer.id};
 }
 const ports:TaskWorkerPorts={packet:async hash=>{assert(hash===digest(packet),'synthetic packet not admitted');return packet;},
  provider:{sdkVersion:'synthetic-sdk',cliVersion:'synthetic-cli',async run(input,sessionId,signal,capture){
   signal.throwIfAborted();counters.providerInvocations++;
   const context=JSON.parse(input.user);assert(digest(context.sources)===digest(packet.sources)&&context.approvedPlan.effectLimit==='PREPARE_ONLY','synthetic execution context differs');
   const runtime={provider:'anthropic' as const,runtime:'claude-agent-sdk' as const,model:input.model,sessionId,sdkVersion:'synthetic-sdk',cliVersion:'synthetic-cli',tools:[] as never[]};
   const text='# Synthetic research result\n\nDeterministic fixture; no real inference or browsing.\n\nApproved instructions: '+context.approvedPlan.instructions+'\n\n'+packet.sources.map(s=>'- '+s.document.content+' Source: '+s.reference).join('\n')+'\n\nNext step: owner reviews the supplied evidence. Competitor evidence is missing.';
   const output={text,contentHash:sha(text),byteSize:Buffer.byteLength(text),stopReason:'end_turn' as const,resultId:'synthetic:'+sessionId,costUsd:0};
   executions.set(sessionId,{sessionId,inputHash:digest(input),runtime,output});capture.runtime(runtime);capture.output(output);
   if(settings.providerMode==='uncertain')throw Error('synthetic provider response lost');
  }},
  recoverExecution:async(session,inputHash)=>{counters.executionLookups++;if(settings.providerMode==='uncertain')return null;const saved=executions.get(session);assert(!saved||saved.inputHash===inputHash,'synthetic execution identity differs');return saved??null;},
  reports:{bindingRef:'synthetic-native-report-composition-v1',admitted:async()=>settings.publisherAdmitted,
   async publish(request){
    assert(settings.publisherAdmitted,'synthetic publisher not admitted');counters.publicationInvocations++;
    assert(!publications.has(request.publicationId),'synthetic duplicate publish invocation');
    const reportId=await f.platform.report(request.markdown,request.sourceRef,request.instanceId);
    const receipt={publicationId:request.publicationId,dispatchId:request.dispatchId,inputHash:request.inputHash,reportId,contentVersion:1,contentHash:request.contentHash,verificationRef:'synthetic-native:'+reportId};
    publications.set(request.publicationId,{request,receipt});
    if(settings.losePublicationResponse){settings.losePublicationResponse=false;throw Error('synthetic publication response lost');}
    return receipt;
   },
   async lookup(request){counters.publicationLookups++;const saved=publications.get(request.publicationId);assert(!saved||digest(saved.request)===digest(request),'synthetic publication identity differs');return saved?.receipt??null;},
   async read(receipt){const r=await report(receipt.reportId);const verified={publicationId:r.publicationId,dispatchId:r.dispatchId,inputHash:r.inputHash,reportId:r.id,contentVersion:r.contentVersion,contentHash:r.content.contentHash,verificationRef:r.verificationRef};assert(digest(receipt)===digest(verified),'synthetic reader receipt differs');f.setResultFact(reportResultFact(verified));return {...r,bytes:Buffer.from(r.content.markdown)};},
  },
 };
 const root=join(realpathSync(f.root),'task-worker');let worker=TaskWorker.open(root,f.authority,binding,ports);
 async function item(dispatchId:string){const d=await f.authority.read(dispatchId,'kapelle/dispatch'),s=d.state.global as DispatchState;assert(s.offer,'synthetic Dispatch missing');return f.tasks.lookup(parseEnvelope(s.offer).draft.operationId);}
 async function run(dispatchId:string){
  const status=await worker.run(dispatchId),reply={ok:true as const,synthetic:true as const,worker:status,item:await item(dispatchId)};
  if(settings.loseRunResponse){settings.loseRunResponse=false;throw Error('synthetic worker response lost');}return reply;
 }
 f.setCompletion(async operationId=>{const receipt=await f.tasks.lookup(operationId);assert(receipt,'synthetic Dispatch missing');return (await run(receipt.dispatchId)).item;});
 const api={packet,binding,report,run,
  sourcePacket(hash:string){assert(hash===digest(packet),'synthetic packet unavailable');return {synthetic:true as const,packetHash:hash,packet};},
  async inspect(dispatchId:string){return {ok:true as const,synthetic:true as const,worker:await worker.inspect(dispatchId),item:await item(dispatchId)};},
  state(){return {synthetic:true,...settings,...counters,packetHash:digest(packet),sourceCount:packet.sources.length};},
  configure(raw:unknown){Object.assign(settings,controlsSchema.parse(raw));return this.state();},
  async reopen(){worker.close();await f.restart();worker=TaskWorker.open(root,f.authority,binding,ports);},
  async coldLookup(operationId:string){worker.close();try{return await f.coldLookup(operationId);}finally{worker=TaskWorker.open(root,f.authority,binding,ports);}},
  async close(){worker.close();await f.close();},
 };
 f.setDemoHandler(async(req,res)=>{
  const url=new URL(req.url??'/', 'http://localhost'),route=/^\/__fixture\/task-worker\/([^/]+)(\/run)?$/.exec(url.pathname);
  const source=/^\/__fixture\/source-packet\/(.+)$/.exec(url.pathname),reportRoute=/^\/__fixture\/report\/([^/]+)$/.exec(url.pathname);
  if(!route&&!source&&!reportRoute&&url.pathname!=='/__fixture/task-worker-state')return false;
  const reply=(value:unknown)=>{res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  const body=async()=>{let bytes=0;const parts:Buffer[]=[];for await(const part of req){bytes+=part.length;assert(bytes<=8192,'synthetic request too large');parts.push(Buffer.from(part));}return JSON.parse(Buffer.concat(parts).toString('utf8'));};
  if(req.method==='GET'&&source)reply(api.sourcePacket(decodeURIComponent(source[1])));
  else if(req.method==='GET'&&reportRoute)reply(await report(reportRoute[1]));
  else if(req.method==='GET'&&route&&!route[2])reply(await api.inspect(route[1]));
  else if(req.method==='POST'&&route&&route[2]){z.object({}).strict().parse(await body());reply(await run(route[1]));}
  else if(req.method==='GET'&&url.pathname==='/__fixture/task-worker-state')reply(api.state());
  else if(req.method==='POST'&&url.pathname==='/__fixture/task-worker-state')reply(api.configure(await body()));
  else {res.writeHead(405);res.end();}
  return true;
 });
 return api;
}
