import {DatabaseSync} from 'node:sqlite';
import {it,expect} from 'vitest';
import {mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync,unlinkSync,readdirSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {context,installed,apply,policy,R,proposal} from './fixtures.js';
import {digest,releaseHash,proposalHash,type TrustedContext} from '../src/command-boundary.js';
import {pilotSchema,currentPilot,pilotPlan,pilotLifecycle,projectDefinition,pilotSignals,pilotSignalsSchema,type TaskPilot} from '../src/task-delegation/pilot.js';
import {taskSource,qualifiedRecipient,acceptedEnvelope,bindTaskFacts,type Draft} from '../src/task-delegation/contract.js';
import {taskReadTransient} from '../src/task-delegation/task-client.js';
import {failureLabel} from '../src/task-delegation/failure-labels.js';
import {dispatchOfferHash,instructionsHash,authorizeDispatchLineage,type DispatchContext} from '../src/dispatch/contracts.js';
import {packetTaskNotes,type TaskWorkerBinding} from '../src/task-delegation/worker-contract.js';
import {TaskWorker,type TaskWorkerPorts} from '../src/task-delegation/worker.js';
import {ProviderRejectedBeforeInference} from '../src/worker/execution.js';
import {sha} from '../src/worker/contracts.js';
import {FrameworkAuthority} from '../src/service/authority.js';
import type {DispatchOffer} from '../document-models/dispatch/v1/index.js';
function fixture(){
 const ctx=context(),release=ctx.definitions[0].release;
 release.runtimeContracts=['kapelle.task-delegation/v1'];
 release.capabilities=[{id:'task',resourceType:'task',actions:['read'],requirement:'REQUIRED',outputTypes:[]},{id:'receive',resourceType:'task-delegation',actions:['receive'],requirement:'REQUIRED',outputTypes:[]}];
 release.contentHash=releaseHash(release);ctx.runtimeBindingContracts={'local-adapter':'kapelle.task-delegation/v1'};
 const packet={contract:'kapelle.task-source-packet/v1' as const,sources:[{document:{id:randomUUID(),version:1,hash:sha('fixture'),title:'Fixture',project:null,mimeType:'text/markdown' as const,content:'fixture'},reference:'fixture:source',capturedAt:ctx.occurredAt}]};
 const task={id:'existing-task',ownerId:ctx.ownerId,revision:1,title:'Fixture',status:'OPEN' as const,projectId:null,bodyMarkdown:packetTaskNotes(packet,''),comments:[],externalRefs:[]};
 const pilot:TaskPilot={mode:'single-task-pilot',liveOutcome:'PENDING',ownerId:ctx.ownerId,scopeRef:ctx.scopeRef,instanceId:'commissioner-1',taskId:task.id,permissionRef:'task-permission',runtimeBindingRef:'local-adapter',definitionHash:release.contentHash,modelPolicyHash:digest(policy),planHash:digest('exact-plan'),operationId:randomUUID(),sourceHash:taskSource(task).sourceHash,packetHash:digest(packet),approvedAt:ctx.occurredAt,expiresAt:'2026-09-10T14:00:00.000Z',recoveryExpiresAt:'2026-09-11T12:00:00.000Z'};
 ctx.definitions=[{release,qualified:false,pilot}];ctx.resources=[{id:task.id,resourceType:'task',revision:1,contentHash:digest('task'),allowedActions:['read']},{id:pilot.permissionRef,resourceType:'task-delegation',revision:1,contentHash:digest('permission'),allowedActions:['receive','dispatch']}];
 let doc=installed(ctx);doc=apply(doc,'SET_RUNTIME_BINDING',{runtimeBindingRef:pilot.runtimeBindingRef},ctx);
 for(const [resourceRef,actions] of [[task.id,['read']],[pilot.permissionRef,['receive']]] as const)doc=apply(doc,'GRANT_CAPABILITY',{grant:{id:'grant:'+resourceRef,principalId:pilot.instanceId,resourceRef,actions:[...actions],expiresAt:pilot.recoveryExpiresAt,reviewPolicy:'ALWAYS'}},ctx);
 doc=apply(doc,'REQUEST_RESUME',{},ctx);
 const pin=qualifiedRecipient(doc.state.global,ctx,task.id,pilot.permissionRef);
 const draft:Draft={operationId:pilot.operationId,taskId:task.id,revision:task.revision,agentId:pilot.instanceId,recipient:pin,instructions:'Prepare fixture Report.',includeNotes:true,includeComments:false,includeReferences:false,sourceHash:pilot.sourceHash,approval:{proposalId:'proposal',version:1,planHash:pilot.planHash,operationId:randomUUID()}};
 const plan={recommendedAction:'Prepare',instructions:draft.instructions,deliverable:'Report',effectLimit:'PREPARE_ONLY'};
 const instructions=JSON.stringify(acceptedEnvelope(task,draft,plan));
 const offer:DispatchOffer={contentHash:'',scopeRef:ctx.scopeRef,task:{authorityRef:'task-authority',taskRef:task.id,commitmentHash:'sha256:'+pilot.sourceHash},originalRequesterId:ctx.ownerId,senderId:ctx.ownerId,senderAgent:null,recipient:{instanceId:pin.instanceId,definitionId:pin.definitionId,definitionVersion:pin.definitionVersion,definitionHash:pin.definitionHash},parentDispatchRef:null,parentContentHash:null,continuationOfRef:null,instructions,instructionsHash:instructionsHash(instructions),sources:[{documentRef:task.id,documentType:'task-authority/task',contentVersion:task.revision+1,contentHash:'sha256:'+JSON.parse(instructions).source.hash}],permissionRef:pilot.permissionRef,expiresAt:pilot.expiresAt};offer.contentHash=dispatchOfferHash(offer);
 const dctx:DispatchContext={...ctx,dispatch:{parents:[],agents:[doc.state.global],tasks:[{...offer.task,ownerId:ctx.ownerId,scopeRef:ctx.scopeRef,status:'OPEN'}],sources:offer.sources.map(source=>({...source,ownerId:ctx.ownerId,scopeRef:ctx.scopeRef})),results:[]}};
 return {ctx,pilot,doc,task,packet,pin,draft,offer,dctx};
}
it('projects pilot eligibility without production promotion; production proof remains unchanged',()=>{
 const f=fixture(),release=f.ctx.definitions[0].release;
 expect(projectDefinition(release,f.ctx.definitions)).toEqual({release,qualified:false,pilot:f.pilot});
 expect(projectDefinition(release,[{release,qualified:true}])).toEqual({release,qualified:true});
 expect(projectDefinition({...release,contentHash:digest('drift')},f.ctx.definitions).pilot).toBeUndefined();
 expect(()=>projectDefinition(release,[...f.ctx.definitions,...f.ctx.definitions])).toThrow('pilot_ambiguous');
 expect(()=>pilotSchema.parse({...f.pilot,liveOutcome:'PASS'})).toThrow();
});
it.each(['owner','scope','instance','expiry','task','permission','model','runtime','definition'] as const)('rejects %s drift at Task consumer',kind=>{
 const f=fixture(),ctx=structuredClone(f.ctx),state=structuredClone(f.doc.state.global),p=ctx.definitions[0].pilot!;
 if(kind==='owner')p.ownerId='other';if(kind==='scope')p.scopeRef='other';if(kind==='instance')p.instanceId='other';if(kind==='expiry')p.expiresAt=ctx.occurredAt;if(kind==='task')p.taskId='other';if(kind==='permission')p.permissionRef='other';if(kind==='model')p.modelPolicyHash=digest('other');if(kind==='runtime')p.runtimeBindingRef='other';if(kind==='definition')p.definitionHash=digest('other');
 expect(()=>qualifiedRecipient(state,ctx,f.task.id,f.pilot.permissionRef)).toThrow();
});
it('admits only exact lifecycle and refuses generic effects and second instance',()=>{
 const f=fixture();expect(f.doc.state.global.desiredState).toBe('READY');
 const other=structuredClone(f.ctx);other.definitions[0].pilot={...f.pilot,instanceId:'different-instance'};expect(()=>installed(other)).toThrow('pilot_scope_or_expiry');
 for(const type of ['BIND_CONNECTION','BIND_SCHEDULE','PIN_DEFINITION_VERSION','LINK_DOCUMENT'])expect(()=>pilotLifecycle(f.pilot,type,{})).toThrow('pilot_lifecycle_only');
 expect(()=>pilotLifecycle(f.pilot,'SET_MODEL_POLICY',{modelPolicy:{...policy,paidFallback:true}})).toThrow('pilot_model_policy');
 expect(()=>pilotLifecycle(f.pilot,'SET_RUNTIME_BINDING',{runtimeBindingRef:'other'})).toThrow('pilot_runtime_binding');
 for(const [resourceRef,actions] of [['other',['read']],[f.task.id,['update']],[f.pilot.permissionRef,['dispatch']]] as const)expect(()=>apply(f.doc,'GRANT_CAPABILITY',{grant:{id:'bad',principalId:f.pilot.instanceId,resourceRef,actions:[...actions],expiresAt:f.pilot.expiresAt,reviewPolicy:'ALWAYS'}},f.ctx)).toThrow('pilot_grant_scope');
 const review=R.utils.createDocument();review.header.id='review';
 expect(()=>apply(review,'CREATE_REVIEW',{reviewId:'review',instanceId:f.pilot.instanceId,scopeRef:f.ctx.scopeRef,proposal:proposal()},{...f.ctx,instance:f.doc.state.global})).toThrow('pilot_generic_effect_forbidden');
});
it.each(['valid','plan','source','operation','approval','task','parent','sender','instance','missing-source','extra-source','wrong-source'] as const)('Dispatch consumer validates %s',kind=>{
 const f=fixture(),o=structuredClone(f.offer),ctx=structuredClone(f.dctx),e=JSON.parse(o.instructions);
 if(kind==='plan')e.draft.approval.planHash=digest('other');if(kind==='source')e.draft.sourceHash=sha('other');if(kind==='operation')e.draft.operationId=randomUUID();if(kind==='approval')delete e.draft.approval;
 if(kind==='task')ctx.definitions[0].pilot!.taskId='other';if(kind==='parent')o.parentDispatchRef='other';if(kind==='sender')o.senderAgent=o.recipient;if(kind==='instance')ctx.definitions[0].pilot!.instanceId='other';
 if(kind==='missing-source')o.sources=[];if(kind==='extra-source')o.sources.push({...o.sources[0]});if(kind==='wrong-source')o.sources[0].documentType='other';
 o.instructions=JSON.stringify(e);o.instructionsHash=instructionsHash(o.instructions);o.contentHash=dispatchOfferHash(o);
 if(kind==='valid')expect(()=>authorizeDispatchLineage('dispatch',o,ctx)).not.toThrow();else expect(()=>authorizeDispatchLineage('dispatch',o,ctx)).toThrow();
});
function workerFixture(mode:'success'|'prechild'|'uncertain'){
 const f=fixture(),root=realpathSync(mkdtempSync(join(tmpdir(),'kapelle-pilot-injected-'))),id=randomUUID();let calls=0,now=f.ctx.occurredAt,fault:(()=>void)|undefined;
 const states=new Map<string,any>([[id,{dispatchId:id,ownerId:f.ctx.ownerId,scopeRef:f.ctx.scopeRef,offer:f.offer,phase:'OFFERED',acceptance:null}]]);
 const authority={options:{ownerId:f.ctx.ownerId,scopeRef:f.ctx.scopeRef,now:()=>now},journal:{get:()=>null},
  read:async(key:string,type:string)=>({state:{global:type==='kapelle/agent-instance'?f.doc.state.global:states.get(key)}}),
  dispatchBundle:async(key:string)=>{fault?.();return {document:{state:{global:states.get(key)}}};},
  dispatchCommand:async(c:any)=>{states.get(c.documentId).acceptance={inputHash:c.input.inputHash};return {result:{disposition:'ACCEPTED'}};},
 } as unknown as FrameworkAuthority;
 const binding:TaskWorkerBinding={ownerId:f.ctx.ownerId,scopeRef:f.ctx.scopeRef,instanceId:f.pilot.instanceId,runtimeBindingRef:f.pilot.runtimeBindingRef,definitionHash:f.pilot.definitionHash,capabilityHash:f.pin.capabilityHash,modelProfile:policy.preferredProfile,budgetPolicyRef:policy.budgetPolicyRef,pilot:f.pilot,inference:{model:'injected',credentialTeamId:randomUUID(),credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'injected',cliVersion:'injected',maxOutputTokens:100,maxBudgetUsd:1,timeoutMs:5000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'}};
 const ports:TaskWorkerPorts={packet:async()=>f.packet,provider:{sdkVersion:'injected',cliVersion:'injected',run:async(input,sessionId,_signal,capture)=>{calls++;if(mode==='prechild')throw new ProviderRejectedBeforeInference('claude_provider_binding_mismatch');if(mode==='uncertain'){capture.uncertain?.();throw Error('lost');}const text='Fixture';capture.runtime({provider:'anthropic',runtime:'claude-agent-sdk',model:input.model,sessionId,sdkVersion:'injected',cliVersion:'injected',tools:[]});capture.output({text,contentHash:sha(text),byteSize:text.length,stopReason:'end_turn',resultId:'fixture',costUsd:0});}}};
 let worker=TaskWorker.open(root,authority,binding,ports);
 return {f,id,states,binding,ports,root,get worker(){return worker;},calls:()=>calls,setFault(v:(()=>void)|undefined){fault=v;},expire(){now=f.pilot.expiresAt;},restart(){worker.close();worker=TaskWorker.open(root,authority,structuredClone(binding),ports);},close(){worker.close();rmSync(root,{recursive:true,force:true});}};
}
it.each(['success','prechild','uncertain'] as const)('durable single claim: %s cannot replay, regenerate receipt or substitute Dispatch',async mode=>{
 const x=workerFixture(mode);try{
  expect(x.worker.pilotConsumed()).toBe(false);
  const status=mode==='success'?'REPORT_PENDING':'EXECUTION_UNCERTAIN';expect((await x.worker.run(x.id)).status).toBe(status);expect(x.calls()).toBe(1);
  expect(x.worker.pilotConsumed()).toBe(true);
  x.restart();expect(x.worker.pilotConsumed()).toBe(true);expect((await x.worker.run(x.id)).status).toBe(status);expect(x.calls()).toBe(1);
  const substitute=randomUUID();x.states.set(substitute,{...x.states.get(x.id),dispatchId:substitute,acceptance:null});await expect(x.worker.run(substitute)).rejects.toThrow('pilot_invocation_consumed');expect(x.calls()).toBe(1);
 }finally{x.close();}
});
it('an uncertain attempt keeps a fixed failure label (an earlier build stored none); an unknown provider error is unlabeled',async()=>{
 const x=workerFixture('uncertain');try{
  expect((await x.worker.run(x.id)).status).toBe('EXECUTION_UNCERTAIN');
  const db=new DatabaseSync(join(x.root,'task-executions.sqlite'));
  try{expect(JSON.parse((db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string}).body)).toMatchObject({phase:'uncertain',uncertainReason:'unlabeled'});}finally{db.close();}
 }finally{x.close();}
});
// Observed live: the 1 s freshness recheck aborted inference on a Task read that timed out (2 s budget consumed by the pin re-hash).
// A slow provider (~4.5 s) whose rechecks fail with the given sequence after the claim; null = success.
async function recheckTimeline(faults:(Error|null)[]){
 const x=workerFixture('success'),run=x.ports.provider.run;let seen=0;
 x.ports.provider.run=async(input,sessionId,signal,capture)=>{
  x.setFault(()=>{const e=faults[seen++];if(e)throw e;});
  await new Promise<void>((resolve,reject)=>{const t=setTimeout(resolve,4500);signal.addEventListener('abort',()=>{clearTimeout(t);reject(Error('claude_interrupted'));},{once:true});});
  x.setFault(undefined);return run(input,sessionId,signal,capture);
 };
 try{
  const started=Date.now(),status=(await x.worker.run(x.id)).status,elapsed=Date.now()-started;
  const db=new DatabaseSync(join(x.root,'task-executions.sqlite'));
  try{return {status,elapsed,seen,attempt:JSON.parse((db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string}).body)};}finally{db.close();}
 }finally{x.close();}
}
const timeoutError=()=>Object.assign(Error('The operation was aborted due to timeout'),{name:'TimeoutError'});
it('timeline: two consecutive transient Task-read failures during inference do not abort it',async()=>{
 const r=await recheckTimeline([timeoutError(),Error('Task authority unavailable'),null,timeoutError(),new TypeError('fetch failed'),null]);
 expect(r.status).toBe('REPORT_PENDING');expect(r.attempt.phase).toBe('completed');expect(r.attempt.uncertainReason).toBeUndefined();expect(r.seen).toBeGreaterThanOrEqual(3);
},15000);
it('a third consecutive transient Task-read failure aborts with a fixed reason',async()=>{
 const r=await recheckTimeline([timeoutError(),timeoutError(),timeoutError(),timeoutError()]);
 expect(r.status).toBe('EXECUTION_UNCERTAIN');expect(r.attempt).toMatchObject({phase:'uncertain',uncertainReason:'recheck:task_read_transient'});expect(r.seen).toBe(3);
},15000);
it.each([
 ['Task source changed','recheck:task_source_changed'],
 ['Task recipient capability changed','recheck:task_recipient_capability_changed'],
 ['Task authority refused','recheck:task_authority_refused'],
 ['worker_request_changed','recheck:worker_request_changed'],
 ['Expected string, received "secret value"','recheck:unlabeled'],
 ['secret:synthetic-token-abc','recheck:unlabeled'],
 ['Private client Acme acquisition','recheck:unlabeled'],
])('a semantic recheck failure (%s) aborts at the first tick',async(message,reason)=>{
 const r=await recheckTimeline([Error(message)]);
 expect(r.status).toBe('EXECUTION_UNCERTAIN');expect(r.attempt).toMatchObject({phase:'uncertain',uncertainReason:reason});expect(r.seen).toBe(1);expect(r.elapsed).toBeLessThan(3000);
},15000);
// The REAL native recipient checks (bindTaskFacts) on the fixture's native context, with a Task reader that fails
// transiently. Grant state must be judged before (and independently of) the Task HTTP read.
async function nativeRecheck(grant:'valid'|'revoked'|'expired',reader:'unavailable'|'timeout'|'changed'|'ok'){
 const f=fixture(),ctx=structuredClone(f.dctx) as any,state=ctx.dispatch.agents[0];
 const g=state.grants.find((x:any)=>x.resourceRef===f.task.id);
 if(grant==='revoked')g.revokedAt=ctx.occurredAt;if(grant==='expired')g.expiresAt=ctx.occurredAt;
 let reads=0;
 const readTask=async()=>{reads++;
  if(reader==='unavailable')throw Error('Task authority unavailable');
  if(reader==='timeout')throw Object.assign(Error('The operation was aborted due to timeout'),{name:'TimeoutError'});
  return reader==='changed'?{...f.task,title:'Changed while unreadable'}:f.task;};
 const error=await bindTaskFacts(ctx,f.offer,{permissionRef:f.pilot.permissionRef,readTask} as any).then(()=>null,(e:unknown)=>e as Error);
 return {error,reads,transient:error?taskReadTransient(error):false};
}
it.each(['revoked','expired'] as const)('a %s Task grant is refused before the Task read, even when the Task Authority is failing',async grant=>{
 for(const reader of ['unavailable','timeout'] as const){
  const r=await nativeRecheck(grant,reader);
  expect(r.error?.message).toBe('Task recipient capability unavailable');expect(r.transient).toBe(false);expect(r.reads).toBe(0);
  expect(failureLabel(r.error)).toBe('task_recipient_capability_unavailable');
 }
});
it('valid native state + failing Task read is the only tolerated (transient) case; a changed Task aborts on its first successful read',async()=>{
 expect((await nativeRecheck('valid','unavailable')).transient).toBe(true);
 expect((await nativeRecheck('valid','timeout')).transient).toBe(true);
 const changed=await nativeRecheck('valid','changed');expect(changed.error?.message).toBe('Task source changed');expect(changed.transient).toBe(false);
 expect((await nativeRecheck('valid','ok')).error).toBeNull();
});
it.each(['revoked','expired'] as const)('worker aborts on the FIRST recheck when native state says %s and the Task read fails',async grant=>{
 const native=(await nativeRecheck(grant,'unavailable')).error!;
 const r=await recheckTimeline([native,timeoutError(),timeoutError()]);
 expect(r.status).toBe('EXECUTION_UNCERTAIN');expect(r.attempt).toMatchObject({phase:'uncertain',uncertainReason:'recheck:task_recipient_capability_unavailable'});expect(r.seen).toBe(1);expect(r.elapsed).toBeLessThan(3000);
},15000);
it('the first observed recheck failure is retained (latched)',async()=>{
 const r=await recheckTimeline([Error('Task source changed'),Error('worker_request_changed'),Error('Task owner differs')]);
 expect(r.attempt.uncertainReason).toBe('recheck:task_source_changed');
},15000);
it('only the explicit vocabulary is persisted; unknown codes, prose and secret-shaped text are unlabeled',()=>{
 for(const [input,label] of [
  ['claude_unexpected_message','claude_unexpected_message'],['worker_request_changed','worker_request_changed'],['pilot_scope_or_expiry','pilot_scope_or_expiry'],
  ['Task source changed','task_source_changed'],['Task authority refused','task_authority_refused'],
  ['claude_runtime_mismatch:fields=model,plugins.nonempty:count=2','claude_runtime_mismatch:fields=model,plugins.nonempty:count=2'],
  ['claude_runtime_mismatch:fields=plugins.nonempty:cc-plugin-sec-default+cc-plugin-diff','claude_runtime_mismatch:fields=plugins.nonempty:cc-plugin-sec-default+cc-plugin-diff'],
  ['claude_runtime_mismatch:fields=model,secret_value','claude_runtime_mismatch'],
  ['claude_runtime_mismatch:fields=plugins.nonempty:cc-plugin-acme-private','claude_runtime_mismatch'],
  ['claude_runtime_mismatch:fields=plugins.nonempty:count=1000','claude_runtime_mismatch'],
  ['secret_token_value','unlabeled'],['some_unknown_snake_case_code','unlabeled'],['secret:synthetic-token-abc','unlabeled'],
  ['Private client Acme acquisition','unlabeled'],['claude_unexpected_message:extra','unlabeled'],['','unlabeled'],
 ] as const)expect(failureLabel(Error(input))).toBe(label);
 expect(failureLabel('claude_interrupted')).toBe('unlabeled');expect(failureLabel(undefined)).toBe('unlabeled');
});
// Every allowlisted reason must survive the journal schema (real worker round trip, SQLite readback).
const longMismatch='claude_runtime_mismatch:fields='+Array(16).fill('plugins.nonempty:cc-plugin-sec-default').join(',');
async function providerFailure(message:string){
 const x=workerFixture('success');
 x.ports.provider.run=async(_i,_s,_signal,capture)=>{capture.uncertain?.();throw Error(message);};
 try{
  const status=(await x.worker.run(x.id)).status;
  const db=new DatabaseSync(join(x.root,'task-executions.sqlite'));
  try{return {status,attempt:JSON.parse((db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string}).body)};}finally{db.close();}
 }finally{x.close();}
}
it.each([
 ['claude_runtime_mismatch:fields=permissionMode','claude_runtime_mismatch:fields=permission_mode'],
 ['claude_runtime_mismatch:fields=model,permissionMode,plugins.nonempty:count=3','claude_runtime_mismatch:fields=model,permission_mode,plugins.nonempty:count=3'],
 [longMismatch,'claude_runtime_mismatch'],
])('persistence: %s is saved as a schema-valid reason through the real worker (no ZodError, reloads)',async(message,stored)=>{
 const r=await providerFailure(message);
 expect(r.status).toBe('EXECUTION_UNCERTAIN');expect(r.attempt).toMatchObject({phase:'uncertain',uncertainReason:stored});
});
it.each([
 ['claude_runtime_mismatch:fields=permissionMode','recheck:claude_runtime_mismatch:fields=permission_mode'],
 [longMismatch,'recheck:claude_runtime_mismatch'],
])('persistence under the recheck: prefix: %s',async(message,stored)=>{
 const r=await recheckTimeline([Error(message)]);
 expect(r.status).toBe('EXECUTION_UNCERTAIN');expect(r.attempt).toMatchObject({phase:'uncertain',uncertainReason:stored});
},15000);
it.each(['approval','plan','packet','expiry'] as const)('worker refuses %s before provider/claim',async kind=>{
 const x=workerFixture('success');try{
  if(kind==='packet')x.ports.packet=async()=>({...x.f.packet,sources:[]});
  else if(kind==='expiry')x.expire();
  else{const o=x.states.get(x.id).offer,e=JSON.parse(o.instructions);if(kind==='approval')delete e.draft.approval;else e.draft.approval.planHash=digest('other');o.instructions=JSON.stringify(e);}
  await expect(x.worker.run(x.id)).rejects.toThrow();expect(x.calls()).toBe(0);
 }finally{x.close();}
});

import {prepareTaskLauncher,publisherSourceHash} from '../src/task-delegation/launcher.js';
import {canonical} from '../src/content.js';
it('launcher requires explicit pilot opt-in, immutable proof/source/dependencies and never emits qualified=true',async()=>{
 const f=fixture(),root=realpathSync(mkdtempSync(join(tmpdir(),'kapelle-pilot-launcher-')));
 const write=(name:string,value:unknown)=>{const path=join(root,name);writeFileSync(path,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});return path;};
 try{
  const pubRoot=join(root,'publisher');mkdirSync(pubRoot);mkdirSync(join(pubRoot,'src'));
  write('publisher/src/mcp-client.ts','export class HttpReportRegistryMcp {call(){throw Error("no transport permitted");}}');
  write('publisher/src/task-publication.ts','export class PrivateTaskReportPublisher { constructor(options){this.bindingRef=options.bindingRef;} }');
  const sourcePath=write('source-pin','injected source'),depPath=write('dependency-pin','injected dependency'),release=f.ctx.definitions[0].release;
  const assets=[release.instructions,...release.skills,...release.qualificationFixtures].map((ref,i)=>({ref,path:write('asset-'+i,canonical({id:ref.id,version:ref.version}))}));
  const b:TaskWorkerBinding={ownerId:f.ctx.ownerId,scopeRef:f.ctx.scopeRef,instanceId:f.pilot.instanceId,runtimeBindingRef:f.pilot.runtimeBindingRef,definitionHash:f.pilot.definitionHash,capabilityHash:f.pin.capabilityHash,modelProfile:policy.preferredProfile,budgetPolicyRef:policy.budgetPolicyRef,pilot:f.pilot,inference:{model:'injected',credentialTeamId:randomUUID(),credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'injected',cliVersion:'injected',maxOutputTokens:100,maxBudgetUsd:1,timeoutMs:1000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'}};
  const profile={contract:'kapelle.task-runtime-profile/v1',expiresAt:f.pilot.recoveryExpiresAt,permissionRef:f.pilot.permissionRef,publisherBindingRef:'publisher',binding:b,packets:[{taskId:f.task.id,hash:f.pilot.packetHash,path:write('packet',f.packet)}]},profilePath=write('profile',profile);
  const publisherHash=await publisherSourceHash(pubRoot);
  const proof={contract:'kapelle.single-task-pilot-eligibility/v1',status:'ELIGIBLE',liveOutcome:'PENDING',bindingHash:digest(b),publisherSourceHash:publisherHash,approvedAt:f.pilot.approvedAt,admissionExpiresAt:f.pilot.expiresAt,expiresAt:f.pilot.recoveryExpiresAt,sourcePins:[{path:sourcePath,sha256:sha('injected source')}],dependencyPins:[{path:depPath,sha256:sha('injected dependency')}]};
  const evidencePath=write('proof',proof);
  const c={contract:'kapelle.task-launcher/v1',enabled:true,pilotMode:'single-task-pilot',expiresAt:f.pilot.recoveryExpiresAt,profilePath,taskAuthorityUrl:'http://127.0.0.1:1',taskTokenFile:write('task.token','t'.repeat(40)),publisherRoot:pubRoot,publisherSourceHash:publisherHash,receiptDir:join(root,'receipts'),lockDir:join(root,'locks'),publisherUrl:'http://127.0.0.1:1/mcp',publisherTokenFile:write('writer.token','w'.repeat(40)),readerUrl:'http://127.0.0.1:1/mcp',readerTokenFile:write('reader.token','r'.repeat(40)),admission:{bindingRef:'publisher',ownerId:b.ownerId,scopeRef:b.scopeRef,driveId:'drive',actorId:'writer',authorizationRef:'fixture',libraryOrigin:'https://fixture.invalid',author:{id:b.instanceId,label:'Pilot',instanceId:b.instanceId,definitionId:release.definitionId,definitionVersion:release.packageVersion,definitionHash:release.contentHash},publisher:{id:'service:publisher',label:'Publisher',instanceId:null,definitionId:null,definitionVersion:null,definitionHash:null}},qualification:{release,assets,evidencePath,evidenceHash:'sha256:'+sha(JSON.stringify(proof))}};
  const configPath=write('config',c),base={runtime:{stateRoot:join(root,'native'),reactorRoot:'/unused',ownerId:b.ownerId,scopeRef:b.scopeRef,now:()=>f.ctx.occurredAt,facts:async()=>f.ctx},workerRoot:join(root,'worker'),token:()=> 't'.repeat(40),claudeHost:{managerRoot:'/unused',cliPath:'/unused',runtimeRoot:join(root,'runtime')}};
  const options=await prepareTaskLauncher(configPath,base);const facts=await options.runtime.facts();expect(facts.definitions.find(d=>d.release.contentHash===release.contentHash)).toMatchObject({qualified:false,pilot:f.pilot});
  for(const [path,original] of [[sourcePath,'injected source'],[depPath,'injected dependency']] as const){writeFileSync(path,'drift');await expect(options.runtime.facts()).rejects.toThrow('pilot_file_pin_changed');writeFileSync(path,original);}
  writeFileSync(join(pubRoot,'src/mcp-client.ts'),'publisher drift');await expect(options.runtime.facts()).rejects.toThrow('publisher_code_changed');writeFileSync(join(pubRoot,'src/mcp-client.ts'),'export class HttpReportRegistryMcp {call(){throw Error("no transport permitted");}}');
  for(const field of ['bindingHash','publisherSourceHash'] as const){const bad={...proof,[field]:digest('drift')};write('proof',bad);write('config',{...c,qualification:{...c.qualification,evidenceHash:'sha256:'+sha(JSON.stringify(bad))}});await expect(prepareTaskLauncher(configPath,base)).rejects.toThrow('qualification_invalid');}
  write('proof',proof);write('config',{...c,pilotMode:undefined});await expect(prepareTaskLauncher(configPath,base)).rejects.toThrow('pilot_explicit_opt_in_required');
  write('config',c);write('profile',{...profile,packets:[...profile.packets,{...profile.packets[0],taskId:'other'}]});await expect(prepareTaskLauncher(configPath,base)).rejects.toThrow();
  write('profile',profile);const expired=await prepareTaskLauncher(configPath,{...base,runtime:{...base.runtime,now:()=>f.pilot.recoveryExpiresAt}});await expect(expired.runtime.facts()).rejects.toThrow();
  // Existing production receipt and omitted pilot retain the original PASS branch.
  const {pilot:_,...production}=b;write('profile',{...profile,binding:production});
  const pass={contract:'kapelle.task-runtime-qualification/v1',status:'PASS',bindingHash:digest(production),publisherSourceHash:publisherHash,expiresAt:f.pilot.expiresAt};write('proof',pass);write('config',{...c,pilotMode:undefined,qualification:{...c.qualification,evidenceHash:'sha256:'+sha(JSON.stringify(pass))}});
  expect((await (await prepareTaskLauncher(configPath,base)).runtime.facts()).definitions.find(d=>d.release.contentHash===release.contentHash)).toEqual({release,qualified:true});
 }finally{rmSync(root,{recursive:true,force:true});}
});
it('authority preserves pilot scope and requires native exact approval and Dispatch identity',async()=>{
 const f=fixture(),dispatchId=randomUUID(),approval=f.draft.approval!,{approval:_,...plain}=f.draft;
 const history={versions:[{version:approval.version,planHash:approval.planHash,draft:plain}],approval:{version:approval.version,planHash:approval.planHash,operationId:approval.operationId},dispatchId};
 const saved={header:{id:'proposal',documentType:'kapelle/review-intent'},state:{document:{version:3},global:{ownerId:f.ctx.ownerId,scopeRef:f.ctx.scopeRef,status:'APPROVED',taskPlanJson:JSON.stringify(history)}}};
 const backend={list:async()=>['definition'],read:async(id:string)=>({document:id==='definition'?{state:{global:{release:f.ctx.definitions[0].release}}}:saved})};
 const a=new FrameworkAuthority(backend as any,{} as any,{ownerId:f.ctx.ownerId,scopeRef:f.ctx.scopeRef,now:()=>f.ctx.occurredAt,facts:async()=>f.ctx});
 const projected=await (a as any).context({header:{documentType:'other'},state:{global:{revision:0}}});expect(projected.definitions).toEqual(f.ctx.definitions);
 expect(await a.taskProposalDispatch(f.draft,dispatchId)).toBe(dispatchId);
 await expect(a.taskProposalDispatch({...plain})).rejects.toThrow('approval required');
 await expect(a.taskProposalDispatch(f.draft,randomUUID())).rejects.toThrow('approval differs');
 for(const change of [{planHash:digest('wrong')},{operationId:randomUUID()},{version:2}])await expect(a.taskProposalDispatch({...f.draft,approval:{...approval,...change}},dispatchId)).rejects.toThrow('approval differs');
 saved.state.global.status='PROPOSED';await expect(a.taskProposalDispatch(f.draft,dispatchId)).rejects.toThrow('approval differs');
});
it('regenerating eligibility cannot change the persisted worker binding or recover a consumed invocation',async()=>{
 const x=workerFixture('uncertain');try{
  await x.worker.run(x.id);x.worker.close();
  const changed={...x.binding,pilot:{...x.binding.pilot!,planHash:digest('new-plan'),operationId:randomUUID()}};
  // Opening against the same durable root rejects a freshly issued, different plan.
  const authority={options:{ownerId:x.binding.ownerId,scopeRef:x.binding.scopeRef}} as FrameworkAuthority;
  expect(()=>TaskWorker.open(x.root,authority,changed,x.ports)).toThrow('worker_binding_changed');expect(x.calls()).toBe(1);
 }finally{x.close();}
});
it.each(['REQUEST_PAUSE','REVOKE_CAPABILITY','RETIRE_INSTANCE'])('permits conservative %s after expiry only for exact owner/instance',type=>{
 const f=fixture(),expired={...f.ctx,occurredAt:f.pilot.expiresAt},input=type==='REVOKE_CAPABILITY'?{grantId:'grant:'+f.task.id}:{};
 const result=apply(f.doc,type,input,expired);
 if(type==='REQUEST_PAUSE')expect(result.state.global.desiredState).toBe('PAUSED');
 if(type==='RETIRE_INSTANCE')expect(result.state.global.desiredState).toBe('RETIRED');
 if(type==='REVOKE_CAPABILITY')expect(result.state.global.grants.find(g=>g.id==='grant:'+f.task.id)?.revokedAt).toBe(expired.occurredAt);
 expect(()=>apply(f.doc,type,input,{...expired,principalId:'attacker'})).toThrow();
 const other=structuredClone(expired);other.definitions[0].pilot!.instanceId='other';expect(()=>apply(f.doc,type,input,other)).toThrow('pilot_scope_or_expiry');
 expect(()=>apply(f.doc,'REQUEST_RESUME',{},expired)).toThrow('pilot_scope_or_expiry');
 expect(()=>apply(f.doc,'GRANT_CAPABILITY',{grant:{id:'late',principalId:f.pilot.instanceId,resourceRef:f.task.id,actions:['read'],expiresAt:f.pilot.expiresAt,reviewPolicy:'ALWAYS'}},expired)).toThrow('pilot_scope_or_expiry');
});
it('authority CREATE/accept path actually reads native approval before authorizing a pilot Dispatch',async()=>{
 const f=fixture(),id=randomUUID(),approval=f.draft.approval!,{approval:_,...plain}=f.draft,e=JSON.parse(f.offer.instructions);
 const history={versions:[{version:approval.version,planHash:approval.planHash,draft:plain,plan:e.approvedPlan}],approval:{version:approval.version,planHash:approval.planHash,operationId:approval.operationId},dispatchId:id};
 const proposal={header:{id:'proposal',documentType:'kapelle/review-intent'},state:{document:{version:3},global:{ownerId:f.ctx.ownerId,scopeRef:f.ctx.scopeRef,status:'APPROVED',taskPlanJson:JSON.stringify(history)}}};
 const dispatch={header:{id,documentType:'kapelle/dispatch'},state:{document:{version:1},global:{revision:1,dispatchId:id,ownerId:f.ctx.ownerId,scopeRef:f.ctx.scopeRef,offer:f.offer,phase:'OFFERED'}}};
 let approvalReads=0;
 const backend={list:async()=>['definition'],read:async(key:string)=>{if(key==='proposal')approvalReads++;return {document:key==='definition'?{state:{global:{release:f.ctx.definitions[0].release}}}:key===f.pilot.instanceId?f.doc:key===id?dispatch:proposal};}};
 const a=new FrameworkAuthority(backend as any,{} as any,{ownerId:f.ctx.ownerId,scopeRef:f.ctx.scopeRef,now:()=>f.ctx.occurredAt,facts:async()=>f.ctx,taskDelegation:{permissionRef:f.pilot.permissionRef,readTask:async()=>f.task}});
 await expect(a.dispatchBundle(id,f.pilot.instanceId)).resolves.toBeDefined();expect(approvalReads).toBeGreaterThan(0);
 proposal.state.global.status='PROPOSED';approvalReads=0;
 await expect((a as any).currentContext(dispatch,{documentId:id,documentType:'kapelle/dispatch',type:'CREATE_DISPATCH',input:{offer:f.offer}})).rejects.toThrow('approval differs');expect(approvalReads).toBeGreaterThan(0);
 await expect(a.dispatchBundle(id,f.pilot.instanceId)).rejects.toThrow('approval differs');
});
it('completed output survives expiry/restart while ordinary admission remains expired',async()=>{
 const x=workerFixture('success');try{
  expect((await x.worker.run(x.id)).status).toBe('REPORT_PENDING');x.expire();x.restart();
  await expect(x.worker.run(x.id)).rejects.toThrow('pilot_scope_or_expiry');expect(x.calls()).toBe(1);
  const db=new DatabaseSync(join(x.root,'task-executions.sqlite'),{readOnly:true});try{
   const row=db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string};expect(JSON.parse(row.body)).toMatchObject({phase:'completed',output:{text:'Fixture'}});expect(db.prepare('SELECT count(*) AS n FROM pilot_claim').get()).toMatchObject({n:1});
  }finally{db.close();}
  // Expiry still blocks ordinary admission, including retained output.
  const f=fixture(),ctx={...f.dctx,occurredAt:f.pilot.expiresAt};
  expect(()=>qualifiedRecipient(f.doc.state.global,ctx,f.task.id,f.pilot.permissionRef)).toThrow('pilot_scope_or_expiry');
  expect(()=>authorizeDispatchLineage('dispatch',f.offer,ctx)).toThrow();
 }finally{x.close();}
});
it('commits pilot claim and started evidence together before provider entry',async()=>{
 const x=workerFixture('success'),run=x.ports.provider.run;let observed=false;
 x.ports.provider.run=async(...args)=>{
  const db=new DatabaseSync(join(x.root,'task-executions.sqlite'),{readOnly:true});try{
   const claim=db.prepare('SELECT dispatchId,requestHash FROM pilot_claim').get() as {dispatchId:string;requestHash:string};
   const row=db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string};const attempt=JSON.parse(row.body);
   expect(claim).toMatchObject({dispatchId:x.id,requestHash:attempt.requestHash});expect(attempt.phase).toBe('started');observed=true;
  }finally{db.close();}await run(...args);
 };
 try{await x.worker.run(x.id);expect(observed).toBe(true);}finally{x.close();}
});
it('rolls back both claim and started write on injected SQLite write rejection without invoking',async()=>{
 const x=workerFixture('success'),db=new DatabaseSync(join(x.root,'task-executions.sqlite'));
 try{
  db.exec("CREATE TRIGGER reject_started BEFORE INSERT ON attempts WHEN json_extract(NEW.body,'$.phase')='started' BEGIN SELECT RAISE(ABORT,'injected_started_write_failure'); END");
  await expect(x.worker.run(x.id)).rejects.toThrow('injected_started_write_failure');expect(x.calls()).toBe(0);
  expect(db.prepare('SELECT count(*) AS n FROM pilot_claim').get()).toMatchObject({n:0});
  const row=db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string};expect(JSON.parse(row.body).phase).toBe('prepared');
 }finally{db.close();x.close();}
});

// Fully composed source-policy tests. Only transport/storage/provider seams are injected;
// launcher pins, runtime admission, HTTP handler, native authority/reducers and Report adapter run.
import {vi} from 'vitest';
import {Readable} from 'node:stream';
import {applyNative} from '../src/command-boundary.js';
import * as Dispatch from '../document-models/dispatch/v1/index.js';
import {openTaskRuntime} from '../src/task-delegation/runtime.js';
import {openFrameworkRuntime} from '../src/service/runtime.js';
import {loadRestrictedClaudeAdapter} from '../src/worker/claude-host.js';
vi.mock('../src/service/runtime.js',()=>({openFrameworkRuntime:vi.fn()}));
vi.mock('../src/worker/claude-host.js',()=>({loadRestrictedClaudeAdapter:vi.fn(()=>{throw Error('SDK must not load in recovery');})}));
async function recoveryFixture(actualPublisher?:string,opts:{deployLock?:string}={}){
 const x=workerFixture('success');x.worker.close();const {f,id,binding,root}=x;
 let now=f.ctx.occurredAt,enabled=false,publishes=0,lookups=0,reads=0,commits=0,transportCalls=0,unknown:'before'|'after'|null=null,nativeUnknown=false;
 let onPublish:()=>void|Promise<void>=()=>{},onRead:()=>void|Promise<void>=()=>{},onPrepare:()=>void|Promise<void>=()=>{},onLookup:()=>void|Promise<void>=()=>{},onPreSend:()=>void|Promise<void>=()=>{},onTransport:()=>void=()=>{};
 const write=(name:string,value:unknown)=>{const path=join(root,name);writeFileSync(path,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});return path;};
 const documents=new Map<string,any>();let dispatch=Dispatch.utils.createDocument();dispatch.header.id=id;
 dispatch=apply(dispatch,'CREATE_DISPATCH',{dispatchId:id,ownerId:f.ctx.ownerId,offer:f.offer},f.dctx);
 const approval=f.draft.approval!,{approval:_,...plain}=f.draft;
 const proposal={header:{id:'proposal',documentType:'kapelle/review-intent'},state:{document:{version:3},global:{ownerId:f.ctx.ownerId,scopeRef:f.ctx.scopeRef,status:'APPROVED',taskPlanJson:JSON.stringify({versions:[{version:approval.version,planHash:approval.planHash,draft:plain,plan:JSON.parse(f.offer.instructions).approvedPlan}],approval:{version:approval.version,planHash:approval.planHash,operationId:approval.operationId},dispatchId:id})}}};
 documents.set(id,dispatch);documents.set('proposal',proposal);documents.set(f.pilot.instanceId,f.doc);documents.set('definition',{state:{global:{release:f.ctx.definitions[0].release}}});
 const entries=new Map<string,any>();
 const journal={get:(key:string)=>entries.get(key),save:(e:any)=>entries.set(e.command.operationId,structuredClone(e)),pending:()=>[...entries.values()].filter(e=>!e.result)};
 const backend={list:async(type:string)=>type==='kapelle/agent-definition'?['definition']:[f.pilot.instanceId],read:async(key:string)=>{const document=documents.get(key);if(!document)throw Error('missing synthetic document');return {document,nativeRevision:document.state.global.revision??0};},
  prepare:async(_id:string,_type:string,_op:string,_revision:number,action:any)=>{await onPrepare();return {action,nativeRevision:_revision};},
  commit:async(key:string,prepared:any)=>{commits++;if(nativeUnknown)return {disposition:'UNRESOLVED'};if(prepared.nativeRevision!==documents.get(key).state.global.revision)return {disposition:'REVISION_CONFLICT'};documents.set(key,applyNative(documents.get(key),prepared.action));return {disposition:'ACCEPTED'};},reconcile:async()=>({disposition:'UNRESOLVED'})};
 vi.mocked(openFrameworkRuntime).mockImplementation(async(options:any)=>({authority:new FrameworkAuthority(backend as any,journal as any,options),close:async()=>{}}) as any);
 const pubRoot=actualPublisher??join(root,'publisher');if(!actualPublisher){mkdirSync(pubRoot);mkdirSync(join(pubRoot,'src'));}
 const key='__kapellePilotFixture';
 const records=new Map<string,{request:any;evidence:any}>();
 const author={id:binding.instanceId,label:'Pilot',instanceId:binding.instanceId,definitionId:f.ctx.definitions[0].release.definitionId,definitionVersion:'1.0.0',definitionHash:binding.definitionHash};
 const publisher={id:'service:publisher',label:'Publisher',instanceId:null,definitionId:null,definitionVersion:null,definitionHash:null};
 (globalThis as any)[key]={transport:()=>{transportCalls++;onTransport();return {};},preSend:async()=>{await onPreSend();},async admitted(){return enabled;},async publish(r:any){publishes++;await onPublish();if(unknown==='before')throw Error('lost publication response');const documentId='report-fixture',planDigest=sha('plan');const evidence={documentId,driveId:'drive',reportRef:'report:task:'+r.publicationId.slice(12),sourceRef:r.sourceRef,producerId:r.instanceId,revision:1,publication:{publicationId:r.publicationId,author:{...author,definitionHash:author.definitionHash.slice(7)},publisher,runRef:'kapelle-task://dispatch/'+r.dispatchId+'?input='+r.inputHash.slice(7),sourceRef:r.sourceRef,provenanceRef:'kapelle-task://execution/'+r.executionHash.slice(7)+'?packet='+r.packetHash.slice(7),contentHash:r.contentHash.slice(7),contentVersion:1,authorizationRef:'fixture',publishedAt:now},markdown:r.markdown,planDigest,verificationRef:'private-report:'+sha(JSON.stringify({driveId:'drive',documentId,planDigest})),scope:{ownerId:r.ownerId,scopeRef:r.scopeRef,driveId:'drive',admissionRef:'publisher'}};records.set(r.publicationId,{request:r,evidence});if(unknown==='after')throw Error('lost publication response');return evidence;},async lookup(r:any){lookups++;await onLookup();return records.get(r.publicationId)?.evidence??null;},async read(pid:string){reads++;await onRead();return records.get(pid)?.evidence;},request:(pid:string)=>records.get(pid)?.request};
 if(!actualPublisher){write('publisher/src/mcp-client.ts',`export class HttpReportRegistryMcp {async call(){return globalThis.${key}.transport();} async callWithStart(name,args,start){start();return this.call();}}`);
 write('publisher/src/task-publication.ts',`export class PrivateTaskReportPublisher {constructor(options){this.o=options;this.bindingRef=options.bindingRef;} async admitted(r){await this.o.authorize(r);return globalThis.${key}.admitted(r);} async publish(r){await globalThis.${key}.preSend();await this.o.authorize(r);await this.o.mcp.call('publishReport',{});return globalThis.${key}.publish(r);} async lookup(r){await this.o.authorize(r);return globalThis.${key}.lookup(r);} async read(id){await this.o.authorize(globalThis.${key}.request(id));return globalThis.${key}.read(id);}}`);
 }
 const release=f.ctx.definitions[0].release,assets=[release.instructions,...release.skills,...release.qualificationFixtures].map((ref,i)=>({ref,path:write('asset-'+i,canonical({id:ref.id,version:ref.version}))}));
 const sourcePath=write('source','source'),dependencyPath=write('dependency','dependency'),publisherHash=await publisherSourceHash(pubRoot);
 const profile={contract:'kapelle.task-runtime-profile/v1',expiresAt:f.pilot.recoveryExpiresAt,permissionRef:f.pilot.permissionRef,publisherBindingRef:'publisher',binding,packets:[{taskId:f.task.id,hash:f.pilot.packetHash,path:write('packet',f.packet)}]};
 const profilePath=write('profile',profile),proof={contract:'kapelle.single-task-pilot-eligibility/v1',status:'ELIGIBLE',liveOutcome:'PENDING',bindingHash:digest(binding),publisherSourceHash:publisherHash,approvedAt:f.pilot.approvedAt,admissionExpiresAt:f.pilot.expiresAt,expiresAt:f.pilot.recoveryExpiresAt,sourcePins:[{path:sourcePath,sha256:sha('source')}],dependencyPins:[{path:dependencyPath,sha256:sha('dependency')}]};
 const config={contract:'kapelle.task-launcher/v1',enabled:true,pilotMode:'single-task-pilot',expiresAt:f.pilot.recoveryExpiresAt,profilePath,taskAuthorityUrl:'http://127.0.0.1:1',taskTokenFile:write('task.token','t'.repeat(40)),publisherRoot:pubRoot,publisherSourceHash:publisherHash,receiptDir:join(root,'receipts'),lockDir:join(root,'locks'),publisherUrl:'http://127.0.0.1:1/mcp',publisherTokenFile:write('writer.token','w'.repeat(40)),readerUrl:'http://127.0.0.1:1/mcp',readerTokenFile:write('reader.token','r'.repeat(40)),admission:{bindingRef:'publisher',ownerId:binding.ownerId,scopeRef:binding.scopeRef,driveId:'drive',actorId:'writer',authorizationRef:'fixture',libraryOrigin:'https://fixture.invalid',author,publisher},qualification:{release,assets,evidencePath:write('proof',proof),evidenceHash:'sha256:'+sha(JSON.stringify(proof))}};
 if(actualPublisher&&readFileSync(join(pubRoot,'src/task-publication.ts'),'utf8').includes('TASK_PUBLICATION_MODEL_NOT_ADMITTED')){
  // Publisher e693b964+: a QUALIFIED_LIVE 49-file model admission is required to publish (pinned in the launcher config).
  const {qualifiedAdmission}=await import('./fixtures/model-admission.js');
  const text=JSON.stringify(qualifiedAdmission(pubRoot,(config as any).publisherUrl,(config as any).admission.driveId));
  (config as any).modelAdmission={path:write('model-admission.json',text),sha256:'sha256:'+sha(text)};
 }
 if(opts.deployLock)(config as any).registryDeployLock={path:opts.deployLock,timeoutMs:300};
 const configPath=write('config',config),base={runtime:{stateRoot:join(root,'native'),reactorRoot:'/not-used',ownerId:binding.ownerId,scopeRef:binding.scopeRef,now:()=>now,facts:async()=>f.ctx},workerRoot:root,token:()=> 't'.repeat(40),claudeHost:{managerRoot:'/not-used',cliPath:'/not-used',runtimeRoot:join(root,'runtime')}};
 // Worker root cannot contain the publisher or native roots; reuse its records under a sibling.
 const workerRoot=join(root,'worker');base.workerRoot=workerRoot;
 let nativeReport:any;
 let onRegistryRead:(name:string)=>void|Promise<void>=()=>{};
 if(actualPublisher){const module=await import(/* @vite-ignore */ actualPublisher+'/tests/fixtures/private-publication.ts');nativeReport=new module.Fake();}
 vi.stubGlobal('fetch',vi.fn(async(url:any,init:any)=>{
  if(!String(url).endsWith('/mcp'))return new Response(JSON.stringify(f.task),{status:200});
  if(!nativeReport)throw Error('unexpected real transport');
  // The outage these tests model starts AFTER the new-execution publish-readiness check: that read still answers.
  if(!enabled&&JSON.parse(init.body).params?.name!=='getRegistryDeploymentV1')throw Error('injected offline publisher unavailable');
  const {params:{name,arguments:args}}=JSON.parse(init.body);
  if(['getDocuments','getReportIdentities','getDocument','lookupReportPublicationV1','getReportDocumentV1','getRegistryDeploymentV1'].includes(name)){await onRegistryRead(name);}
  else {transportCalls++;onTransport();}
  const result=await nativeReport.call(name,args);
  return new Response(JSON.stringify({jsonrpc:'2.0',result:{structuredContent:result}}),{status:200});
 }));
 let host:Awaited<ReturnType<typeof openTaskRuntime>>;
 async function start(provider=true){const options=await prepareTaskLauncher(configPath,base);host=await openTaskRuntime({...options,...(provider?{provider:x.ports.provider}:{})});}
 await start();
 async function call(suffix='',method='POST',body:unknown={},token='t'.repeat(40)){
  let status=0,value:any;const req=Readable.from(method==='POST'?[Buffer.from(JSON.stringify(body))]:[]) as any;req.url='/task-executions/'+id+suffix;req.method=method;req.headers={authorization:'Bearer '+token,'content-type':'application/json'};
  await host.handler(req,{writeHead:(s:number)=>{status=s;},end:(s:string)=>{value=JSON.parse(s);}} as any);return {status,...value};
 }
 return {nativeReport,onRegistryRead:(fn:(name:string)=>void|Promise<void>)=>{onRegistryRead=fn;},f,id,root,workerRoot,documents,entries,sourcePath,dependencyPath,profilePath,configPath,proofPath:config.qualification.evidencePath,records,call,counts:()=>({provider:x.calls(),publishes,lookups,reads,commits,transportCalls}),enable:()=>{enabled=true;},now:(value:string)=>{now=value;},expire:()=>{now=f.pilot.expiresAt;},deadline:()=>{now=f.pilot.recoveryExpiresAt;},unknown:(afterWrite=false)=>{unknown=afterWrite?'after':'before';},nativeUnknown:(value=true)=>{nativeUnknown=value;},onTransport:(fn:()=>void)=>{onTransport=fn;},onPreSend:(fn:()=>void)=>{onPreSend=fn;},onPublish:(fn:()=>void)=>{onPublish=fn;},onRead:(fn:()=>void|Promise<void>)=>{onRead=fn;},onPrepare:(fn:()=>void)=>{onPrepare=fn;},onLookup:(fn:()=>void)=>{onLookup=fn;},host:()=>host,restart:async()=>{await host.close();await start(false);},close:async()=>{await host.close();vi.unstubAllGlobals();delete (globalThis as any)[key];rmSync(root,{recursive:true,force:true});}};
}
it('composed recovery: completed claim, expired admission, cold restart, first Report once, readback/native result and no provider initialization',async()=>{
 const x=await recoveryFixture();try{
  expect((await x.call('/run')).item.status).toBe('REPORT_PENDING');expect(x.counts().provider).toBe(1);
  x.expire();await x.restart();x.enable();
  const before=x.counts();expect((await x.call('','GET')).item.status).toBe('REPORT_PENDING');expect(x.counts().publishes).toBe(before.publishes);
  expect((await x.call('/run')).status).not.toBe(200);
  const result=await x.call('/reconcile');expect(result).toMatchObject({status:200,item:{status:'REPORT_PUBLISHED',taskCompleted:false,effectsAuthorized:false}});
  expect((await x.call('/reconcile')).item.result).toEqual(result.item.result);
  await x.restart();expect((await x.call('','GET')).item.result).toEqual(result.item.result);
  expect(x.counts()).toMatchObject({provider:1,publishes:1,commits:2});expect(loadRestrictedClaudeAdapter).not.toHaveBeenCalled();
 }finally{await x.close();}
});
it('composed recovery: unknown first publication stays lookup-only across restart and repeated explicit reconcile',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();x.unknown();
  expect((await x.call('/reconcile')).item.reason).toBe('publication_uncertain');await x.restart();
  for(let i=0;i<2;i++)expect((await x.call('/reconcile')).item.reason).toBe('publication_uncertain');
  expect(x.counts()).toMatchObject({provider:1,publishes:1,lookups:2,commits:1});
 }finally{await x.close();}
});
it.each(['approval','grant-revoked','grant-expired','cancel','recipient','acceptance','model','source','owner','plan','packet','source-pin','dependency-pin','profile','proof','missing-time','late-settlement','partial','claim','fence','deadline'] as const)('recovery refuses %s without inference/publication',async kind=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();
  if(kind==='approval')x.documents.get('proposal').state.global.status='PROPOSED';
  if(kind==='grant-revoked')x.f.doc.state.global.grants[0].revokedAt=x.f.pilot.expiresAt;
  if(kind==='grant-expired')x.f.doc.state.global.grants[0].expiresAt=x.f.pilot.expiresAt;
  if(kind==='cancel')x.documents.get(x.id).state.global.cancellationReason='cancelled';
  if(kind==='recipient')x.documents.get(x.id).state.global.offer.recipient.instanceId='other';
  if(kind==='acceptance')x.documents.get(x.id).state.global.acceptance.actorId='other';
  if(kind==='model')x.f.doc.state.global.modelPolicy!.preferredProfile='other';
  if(kind==='source')x.f.task.revision++;
  if(kind==='owner')x.f.task.ownerId='other';
  if(kind==='plan'){const s=x.documents.get('proposal').state.global,h=JSON.parse(s.taskPlanJson);h.approval.planHash=digest('different');s.taskPlanJson=JSON.stringify(h);}
  if(kind==='packet')writeFileSync(join(x.root,'packet'),JSON.stringify({...x.f.packet,sources:[]}));
  if(kind==='source-pin')writeFileSync(x.sourcePath,'drift');if(kind==='dependency-pin')writeFileSync(x.dependencyPath,'drift');
  if(kind==='profile')writeFileSync(x.profilePath,'{}');if(kind==='proof')writeFileSync(x.proofPath,'{}');
  if(['missing-time','late-settlement','partial','claim'].includes(kind)){
   const db=new DatabaseSync(join(x.workerRoot,'task-executions.sqlite'));try{const row=db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string},a=JSON.parse(row.body);if(kind==='missing-time')delete a.completedAt;if(kind==='late-settlement')a.settledAt=x.f.pilot.expiresAt;if(kind==='partial')a.phase='uncertain';if(kind==='claim')db.exec('DELETE FROM pilot_claim');db.prepare('UPDATE attempts SET body=? WHERE id=?').run(JSON.stringify(a),x.id);}finally{db.close();}
  }
  if(kind==='fence')writeFileSync(join(x.workerRoot,'provider-invocation.json'),'{}');if(kind==='deadline')x.deadline();
  expect((await x.call('/reconcile')).status).not.toBe(200);expect(x.counts()).toMatchObject({provider:1,publishes:0,commits:1});
  if(kind==='fence')unlinkSync(join(x.workerRoot,'provider-invocation.json')); // remove only our fabricated marker; no child was created
 }finally{await x.close();}
});
it.each(['publication','readback','native-prepare'] as const)('recovery deadline crossing at %s retains evidence and starts no later write',async boundary=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();
  if(boundary==='publication')x.onPublish(x.deadline);if(boundary==='readback')x.onRead(x.deadline);if(boundary==='native-prepare')x.onPrepare(x.deadline);
  const result=await x.call('/reconcile');expect(result.item?.status).not.toBe('REPORT_PUBLISHED');expect(x.counts()).toMatchObject({provider:1,publishes:1,commits:1});
  const db=new DatabaseSync(join(x.workerRoot,'task-executions.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string};expect(JSON.parse(row.body).publication.phase).toBe('started');}finally{db.close();}
 }finally{await x.close();}
});
it('reconcile requires existing completed claim, authentication and exact empty body; never accepts caller recovery authority',async()=>{
 const x=await recoveryFixture();try{
  expect((await x.call('/reconcile')).status).not.toBe(200);expect((await x.call('/reconcile','POST',{},'wrong')).status).toBe(403);
  expect((await x.call('/reconcile','POST',{recovery:true})).status).toBe(400);expect(x.counts()).toMatchObject({provider:0,publishes:0,commits:0});
 }finally{await x.close();}
});
it.each(['approvedAt','expiresAt','recoveryExpiresAt'] as const)('fixed lifetime schema refuses moved %s',key=>{
 const f=fixture();expect(()=>pilotSchema.parse({...f.pilot,[key]:'2026-09-12T12:00:00.000Z'})).toThrow('pilot_fixed_lifetimes');
});
it('provider completing at admission expiry remains uncertain and cannot reconcile',async()=>{
 const x=workerFixture('success'),original=x.ports.provider.run;
 x.ports.provider.run=async(...args)=>{await original(...args);x.expire();};
 try{expect((await x.worker.run(x.id)).status).toBe('EXECUTION_UNCERTAIN');await expect(x.worker.reconcile(x.id)).rejects.toThrow('completed_claim_required');expect(x.calls()).toBe(1);}finally{x.close();}
});
it('recovery GET cannot use its internal scope to issue native commands',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();expect((await x.call('/reconcile')).item.status).toBe('REPORT_PUBLISHED');
  let denied=0;x.onRead(async()=>{expect(()=>x.host().authority.command({operationId:'hostile',documentId:x.id,documentType:'kapelle/dispatch',expectedRevision:2,type:'RECORD_DISPATCH_RESULT',input:{}})).toThrow('pilot_recovery_command_forbidden');
   const a=x.host().authority;for(const forbidden of [()=>a.taskGenerationCommand({}),()=>a.claimPublicationInvocation('other','other'),()=>a.effectAdmission('other','other'),()=>a.allocate('other','kapelle/agent-instance','Other'),()=>a.receipt('other'),()=>a.claimTaskGeneration('other','other'),()=>a.admission({} as any)])expect(forbidden).toThrow('pilot_recovery_');
   await expect(a.grantInboxReview({} as any)).rejects.toThrow('pilot_recovery_other_effect_forbidden');denied++;});
  const count=x.counts().commits;expect((await x.call('','GET')).item.status).toBe('REPORT_PUBLISHED');expect(denied).toBeGreaterThan(0);expect(x.counts().commits).toBe(count);
 }finally{await x.close();}
});
it('expired-admission authority retains only exact conservative owner controls; no grants or resume',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();
  const s=x.f.doc.state.global;
  const cmd=(type:string,input:Record<string,unknown>)=>({operationId:randomUUID(),documentId:x.f.pilot.instanceId,documentType:'kapelle/agent-instance',expectedRevision:s.revision,type,input});
  await expect(x.host().authority.command(cmd('GRANT_CAPABILITY',{grant:{id:'late',principalId:x.f.pilot.instanceId,resourceRef:x.f.task.id,actions:['read'],expiresAt:x.f.pilot.recoveryExpiresAt,reviewPolicy:'ALWAYS'}}))).rejects.toThrow('pilot_scope_or_expiry');
  await expect(x.host().authority.command(cmd('REQUEST_RESUME',{}))).rejects.toThrow('pilot_scope_or_expiry');
  await expect(x.host().authority.command(cmd('REQUEST_PAUSE',{}))).resolves.toMatchObject({result:{disposition:'ACCEPTED'}});
  x.enable();expect((await x.call('/reconcile')).status).not.toBe(200);expect(x.counts().publishes).toBe(0);
 }finally{await x.close();}
});
it('lost publication reply recovers same Report by lookup, without republishing',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();x.unknown(true);
  expect((await x.call('/reconcile')).item.reason).toBe('publication_uncertain');await x.restart();
  expect((await x.call('/reconcile')).item.status).toBe('REPORT_PUBLISHED');expect(x.counts()).toMatchObject({provider:1,publishes:1,lookups:1,commits:2});
 }finally{await x.close();}
});
it('uncertain native result is reconciled under the same operation without resubmission',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();x.nativeUnknown();
  expect((await x.call('/reconcile')).status).not.toBe(200);await x.restart();
  const pending=[...x.entries.values()].find(e=>e.command.type==='RECORD_DISPATCH_RESULT');
  await expect(x.host().authority.receipt(pending.command.operationId)).rejects.toThrow('pilot_explicit_reconciliation_required');
  // Allocation operation names do not establish target identity. Model a replay
  // resolving to the protected Dispatch; ordinary fresh allocations are separate cases.
  x.host().authority.backend.allocate=async(_op,_type,_name,_version,beforeNative)=>{await beforeNative!(x.id);throw Error('unexpected allocation write');};
  await expect(x.host().authority.allocate('other','kapelle/agent-instance','Other')).rejects.toThrow('pilot_explicit_reconciliation_required');
  expect((await x.call('/reconcile')).status).not.toBe(200);expect(x.counts()).toMatchObject({provider:1,publishes:1,commits:2});
  expect([...x.entries.values()].filter(e=>e.command.type==='RECORD_DISPATCH_RESULT')).toHaveLength(1);
 }finally{await x.close();}
});
it('lookup crossing recovery deadline preserves its receipt but starts no native write',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();x.unknown(true);await x.call('/reconcile');
  x.onLookup(x.deadline);expect((await x.call('/reconcile')).item?.status).not.toBe('REPORT_PUBLISHED');expect(x.counts()).toMatchObject({provider:1,publishes:1,lookups:1,commits:1});
 }finally{await x.close();}
});
it('recovery does not settle an unrelated native journal entry',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();x.entries.set('unrelated',{command:{operationId:'unrelated'}});
  expect((await x.call('/reconcile')).status).not.toBe(200);expect(x.counts()).toMatchObject({provider:1,publishes:1,commits:1});expect(x.entries.get('unrelated')).toEqual({command:{operationId:'unrelated'}});
 }finally{await x.close();}
});
it('retained publication with changed bytes cannot become a native verified result',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();x.unknown(true);await x.call('/reconcile');
  [...x.records.values()][0].evidence.markdown='changed';await x.restart();
  expect((await x.call('/reconcile')).item.reason).toBe('publication_uncertain');expect(x.counts()).toMatchObject({provider:1,publishes:1,commits:1});
 }finally{await x.close();}
});
it.each(['local-failure','admission-deadline'] as const)('presend %s retains the first publication right without resetting a started record',async kind=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.enable();
  x.onPreSend(()=>{if(kind==='local-failure')throw Error('injected local preflight failure');x.expire();});
  await x.call('/run');
  const db=new DatabaseSync(join(x.workerRoot,'task-executions.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string};expect(JSON.parse(row.body).publication).toBeNull();}finally{db.close();}
  expect(x.counts().publishes).toBe(0);x.onPreSend(()=>{});x.expire();
  expect((await x.call('/reconcile')).item.status).toBe('REPORT_PUBLISHED');expect(x.counts()).toMatchObject({provider:1,publishes:1});
 }finally{await x.close();}
});
it.each(['REQUEST_PAUSE','REVOKE_CAPABILITY','RETIRE_INSTANCE','REQUEST_DISPATCH_CANCEL'])('pending result does not block exact owner %s after recovery expiry',async type=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();x.nativeUnknown();await x.call('/reconcile');x.nativeUnknown(false);x.deadline();await x.restart();
  const pending=[...x.entries.values()].find(e=>e.command.type==='RECORD_DISPATCH_RESULT'),before=JSON.stringify(pending);
  const documentId=type==='REQUEST_DISPATCH_CANCEL'?x.id:x.f.pilot.instanceId,documentType=type==='REQUEST_DISPATCH_CANCEL'?'kapelle/dispatch':'kapelle/agent-instance';
  const state=x.documents.get(documentId).state.global,input=type==='REVOKE_CAPABILITY'?{grantId:'grant:'+x.f.task.id}:type==='REQUEST_DISPATCH_CANCEL'?{reason:'Owner cancelled'}:{};
  const result=await x.host().authority.command({operationId:randomUUID(),documentId,documentType,expectedRevision:state.revision,type,input});
  expect(result.result.disposition).toBe('ACCEPTED');expect(JSON.stringify(x.entries.get(pending.command.operationId))).toBe(before);expect(x.counts().publishes).toBe(1);
 }finally{await x.close();}
});
import {CommandJournal} from '../src/service/journal.js';
it('protected native result remains protected in a reopened durable journal without pilot runtime options',async()=>{
 const x=await recoveryFixture();let journal:CommandJournal|undefined;try{
  await x.call('/run');x.expire();x.enable();x.nativeUnknown();await x.call('/reconcile');
  const pending=[...x.entries.values()].find(e=>e.command.type==='RECORD_DISPATCH_RESULT');expect(pending.pilot).toEqual(x.f.pilot);
  const path=join(x.root,'durable-native.sqlite');journal=new CommandJournal(path,'fixture');journal.save(pending);journal.close();journal=new CommandJournal(path,'fixture');
  const original=x.host().authority,{pilot:_,...taskDelegation}=original.options.taskDelegation!;
  const reopened=new FrameworkAuthority(original.backend,journal,{...original.options,taskDelegation});
  await expect(reopened.receipt(pending.command.operationId)).rejects.toThrow('pilot_explicit_reconciliation_required');expect(journal.get(pending.command.operationId)).toEqual(pending);
 }finally{journal?.close();await x.close();}
});
it('same-Dispatch cancel reports native revision conflict and preserves the unresolved result',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();x.nativeUnknown();await x.call('/reconcile');x.nativeUnknown(false);x.deadline();
  const pending=[...x.entries.values()].find(e=>e.command.type==='RECORD_DISPATCH_RESULT'),before=JSON.stringify(pending),state=x.documents.get(x.id).state.global;
  x.onPrepare(()=>{state.revision++;}); // competing native revision wins after control preparation
  const result=await x.host().authority.command({operationId:randomUUID(),documentId:x.id,documentType:'kapelle/dispatch',expectedRevision:state.revision,type:'REQUEST_DISPATCH_CANCEL',input:{reason:'Owner cancelled'}});
  expect(result.result.disposition).toBe('REVISION_CONFLICT');expect(state.cancellationReason).toBeNull();expect(JSON.stringify(x.entries.get(pending.command.operationId))).toBe(before);
 }finally{await x.close();}
});
it.each(['wrong-instance','wrong-owner','wrong-principal','changed-source-pin'] as const)('pending result grants no owner-control bypass for %s',async kind=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();x.nativeUnknown();await x.call('/reconcile');x.nativeUnknown(false);x.deadline();
  let documentId=x.f.pilot.instanceId;const type='REQUEST_PAUSE';
  if(kind==='wrong-instance'){documentId='other';x.documents.set(documentId,structuredClone(x.f.doc));}
  if(kind==='wrong-owner')x.f.doc.state.global.ownerId='other';
  if(kind==='changed-source-pin')writeFileSync(x.sourcePath,'changed');
  const command={operationId:randomUUID(),documentId,documentType:'kapelle/agent-instance',expectedRevision:x.f.doc.state.global.revision,type,input:{}};
  if(kind==='wrong-principal')await expect(x.host().authority.dispatchCommand(command,'other')).rejects.toThrow();
  else await expect(x.host().authority.command(command)).rejects.toThrow();
  expect(x.counts().commits).toBe(2);
 }finally{await x.close();}
});
it.each(['credentials','permission','recovery-deadline'] as const)('latest %s refusal is before durable publication-start and before send',async kind=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();x.onPreSend(()=>{
   if(kind==='credentials')writeFileSync(join(x.root,'writer.token'),'invalid');
   if(kind==='permission')x.f.doc.state.global.grants[0].revokedAt=x.f.pilot.expiresAt;
   if(kind==='recovery-deadline')x.deadline();
  });
  await x.call('/reconcile');expect(x.counts()).toMatchObject({provider:1,publishes:0});
  const db=new DatabaseSync(join(x.workerRoot,'task-executions.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string};expect(JSON.parse(row.body).publication).toBeNull();}finally{db.close();}
 }finally{await x.close();}
});
it('durable marker precedes irreducible transport call; a thrown send remains lookup-only',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();x.enable();x.onTransport(()=>{
   const db=new DatabaseSync(join(x.workerRoot,'task-executions.sqlite'),{readOnly:true});try{const row=db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string};expect(JSON.parse(row.body).publication).toMatchObject({phase:'started',receipt:null});}finally{db.close();}
   throw Error('possibly sent');
  });
  expect((await x.call('/reconcile')).item.reason).toBe('publication_uncertain');await x.restart();
  expect((await x.call('/reconcile')).item.reason).toBe('publication_uncertain');expect(x.counts()).toMatchObject({provider:1,transportCalls:1,lookups:1});
 }finally{await x.close();}
});

// Explicit cross-repository qualification input: the actual reviewed publisher source,
// never an installed live service. No network escapes the injected fetch above.
const publisherQualificationRoot=process.env.KAPELLE_PILOT_PUBLISHER_SOURCE;
function savedPublication(x:Awaited<ReturnType<typeof recoveryFixture>>){
 const db=new DatabaseSync(join(x.workerRoot,'task-executions.sqlite'),{readOnly:true});
 try{return JSON.parse((db.prepare('SELECT body FROM attempts WHERE id=?').get(x.id) as {body:string}).body).publication;}finally{db.close();}
}
function createIntents(root:string){const dir=join(root,'receipts');return existsSync(dir)?readdirSync(dir).filter(n=>n.startsWith('.private-create-')).map(n=>readFileSync(join(dir,n),'utf8')):[];}
it.skipIf(!publisherQualificationRoot).each(['membership-refusal','credentials','permission','admission-deadline','recovery-deadline'] as const)('actual publisher composed boundary: %s occurs before BOTH durable markers',async kind=>{
 const x=await recoveryFixture(publisherQualificationRoot);try{
  expect((await x.call('/run')).item.status).toBe('REPORT_PENDING');x.enable();
  if(kind!=='admission-deadline')x.expire();
  // The last read before the create: the 2nd producer listing (listing publishers), or the 2nd native identity lookup (the
  // pre-create recheck) for the scale-bridge publisher, which makes no listing at all.
  const pointPublisher=readFileSync(join(publisherQualificationRoot!,'src/private-publication.ts'),'utf8').includes('class PointPrivateReportMcp');
  const preCreateRead=pointPublisher?'lookupReportPublicationV1':'getDocuments';
  let lists=0;x.onRegistryRead(name=>{if(name===preCreateRead&&++lists===2){
   // Private identity scan checks the independent reader, then final create membership.
   if(kind==='membership-refusal')throw Error('injected membership read failure');
   if(kind==='credentials')writeFileSync(join(x.root,'writer.token'),'invalid');
   if(kind==='permission')x.f.doc.state.global.grants[0].revokedAt=x.f.pilot.expiresAt;
   if(kind==='admission-deadline')x.expire();
   if(kind==='recovery-deadline')x.deadline();
  }});
  await x.call(kind==='admission-deadline'?'/run':'/reconcile');
  expect(lists).toBe(2);expect(savedPublication(x)).toBeNull();expect(createIntents(x.root)).toEqual([]);
  expect(x.nativeReport.writes).toBe(0);expect(x.counts()).toMatchObject({provider:1,transportCalls:0});
  if(kind==='membership-refusal'||kind==='admission-deadline'){
   x.onRegistryRead(()=>{});await x.restart();
   expect((await x.call('/reconcile')).item.status).toBe('REPORT_PUBLISHED');
   expect(x.nativeReport.writes).toBe(2);expect(createIntents(x.root)).toHaveLength(1);expect(x.counts().provider).toBe(1);
  }
 }finally{await x.close();}
});
it.skipIf(!publisherQualificationRoot).each(['create','register'])('actual publisher lost %s response: durable markers precede send and restart permits lookup only',async fault=>{
 const x=await recoveryFixture(publisherQualificationRoot);try{
  await x.call('/run');x.enable();x.expire();x.nativeReport.fault=fault;
  x.onTransport(()=>{expect(savedPublication(x)).toMatchObject({phase:'started',receipt:null});expect(createIntents(x.root)).toHaveLength(1);expect(JSON.parse(createIntents(x.root)[0]).phase).toBe('CREATE_ATTEMPTED');});
  expect((await x.call('/reconcile')).item.reason).toBe('publication_uncertain');
  const writes=x.nativeReport.writes,marker=createIntents(x.root);await x.restart();
  const result=await x.call('/reconcile');
  expect(result.item.status).toBe(fault==='register'?'REPORT_PUBLISHED':'REPORT_PENDING');
  if(fault==='create')expect(result.item.reason).toBe('publication_uncertain');
  await x.call('/reconcile');expect(x.nativeReport.writes).toBe(writes);expect(createIntents(x.root)).toEqual(marker);expect(x.counts().provider).toBe(1);
 }finally{await x.close();}
});

// Shared-store regression: ordinary native authority keeps its own facts/qualification.
// It does not borrow the expired Task launcher's metadata exception.
async function sharedPilotStore(configured:boolean){
 const x=await recoveryFixture();
 await x.call('/run');x.expire();x.enable();x.nativeUnknown();await x.call('/reconcile');x.nativeUnknown(false);x.deadline();
 const pending=[...x.entries.values()].find(e=>e.command.type==='RECORD_DISPATCH_RESULT');
 const ctx=context();ctx.definitions[0].release.definitionId='ordinary-definition';ctx.definitions[0].release.contentHash=releaseHash(ctx.definitions[0].release);
 let ordinary=installed(ctx);ordinary.header.id='ordinary-agent';ordinary.state.global.instanceId='ordinary-agent';
 ordinary=apply(ordinary,'GRANT_CAPABILITY',{grant:{id:'ordinary-grant',principalId:'ordinary-agent',resourceRef:'contracts',actions:['read'],expiresAt:'2026-09-12T12:00:00.000Z',reviewPolicy:'ALWAYS'}},ctx);
 ordinary=apply(ordinary,'SET_RUNTIME_BINDING',{runtimeBindingRef:'local-adapter'},ctx);ordinary=apply(ordinary,'REQUEST_RESUME',{},ctx);
 x.documents.set(ordinary.header.id,ordinary);
 const definitionId='ordinary-definition-document';x.documents.set(definitionId,{state:{global:{release:ctx.definitions[0].release}}});
 const original=x.host().authority,backend={...original.backend,list:async(type:string)=>type==='kapelle/agent-definition'?['definition',definitionId]:[x.f.pilot.instanceId,ordinary.header.id]};
 const path=join(x.root,'shared-native.sqlite');let journal=new CommandJournal(path,'shared');journal.save(pending);journal.close();journal=new CommandJournal(path,'shared');
 let sourceValid=true;const facts=async()=>{if(!sourceValid)throw Error('ordinary_source_changed');return {...ctx,definitions:[...ctx.definitions,...x.f.ctx.definitions]};};
 const {pilot:_,...delegation}=original.options.taskDelegation!;
 const authority=new FrameworkAuthority(backend as any,journal,{...original.options,facts,taskDelegation:{...delegation,...(configured?{pilot:x.f.pilot}:{})}});
 const pendingBytes=()=>String((journal.db.prepare('SELECT body FROM commands WHERE id=?').get(pending.command.operationId) as {body:string}).body);
 const before=pendingBytes();
 const command=(type:string,input:Record<string,unknown>={},id=ordinary.header.id)=>({operationId:randomUUID(),documentId:id,documentType:'kapelle/agent-instance',expectedRevision:x.documents.get(id).state.global.revision,type,input});
 return {x,ctx,ordinary,journal,authority,pending,before,pendingBytes,command,invalidateSource:()=>{sourceValid=false;},close:async()=>{journal.close();await x.close();}};
}
it.each([true,false])('shared store configured pilot=%s: ordinary controls skip protected pending result after expiry/reopen',async configured=>{
 const s=await sharedPilotStore(configured);try{
  for(const [type,input] of [['SET_MODEL_POLICY',{modelPolicy:policy}],['REQUEST_PAUSE',{}],['REVOKE_CAPABILITY',{grantId:'ordinary-grant'}],['RETIRE_INSTANCE',{}]] as const){
   expect((await s.authority.command(s.command(type,input))).result.disposition).toBe('ACCEPTED');expect(s.pendingBytes()).toBe(s.before);
  }
  const other=structuredClone(s.x.documents.get(s.x.id)),otherId=randomUUID();other.header.id=otherId;other.state.global.dispatchId=otherId;
  const offer=other.state.global.offer;offer.recipient.instanceId='ordinary-agent';offer.task.taskRef='ordinary-task';offer.permissionRef='ordinary-permission';offer.contentHash=dispatchOfferHash(offer);other.state.global.acceptance.inputHash=offer.contentHash;
  s.x.documents.set(otherId,other);
  expect((await s.authority.command({operationId:randomUUID(),documentId:otherId,documentType:'kapelle/dispatch',expectedRevision:other.state.global.revision,type:'REQUEST_DISPATCH_CANCEL',input:{reason:'Ordinary owner cancel'}})).result.disposition).toBe('ACCEPTED');
  await expect(s.authority.receipt(s.pending.command.operationId)).rejects.toThrow('pilot_explicit_reconciliation_required');expect(s.pendingBytes()).toBe(s.before);
 }finally{await s.close();}
});
it.each([true,false])('shared store configured pilot=%s: normal wrong-owner/source/revision/qualification checks remain',async configured=>{
 for(const failure of ['owner','source','revision','qualification'] as const){const s=await sharedPilotStore(configured);try{
  const c=s.command('SET_MODEL_POLICY',{modelPolicy:policy});
  if(failure==='owner')s.ordinary.state.global.ownerId='someone-else';
  if(failure==='source')s.invalidateSource();
  if(failure==='revision')c.expectedRevision--;
  if(failure==='qualification')s.ctx.definitions[0].qualified=false;
  await expect(s.authority.command(c)).rejects.toThrow();expect(s.pendingBytes()).toBe(s.before);
  expect(s.x.documents.get('ordinary-agent').state.global.revision).toBe(s.ordinary.state.global.revision);
 }finally{await s.close();}}
});
it.each([true,false])('shared store configured pilot=%s: pilot resource and same-Dispatch ordering never bypassed',async configured=>{
 const s=await sharedPilotStore(configured);try{
  await expect(s.authority.command(s.command('SET_MODEL_POLICY',{modelPolicy:policy},s.x.f.pilot.instanceId))).rejects.toThrow('pilot_explicit_reconciliation_required');
  await expect(s.authority.command({...s.command('ACCEPT_DISPATCH'),documentId:s.x.id,documentType:'kapelle/dispatch',expectedRevision:s.x.documents.get(s.x.id).state.global.revision})).rejects.toThrow('pilot_explicit_reconciliation_required');
  await expect(s.authority.command(s.command('GRANT_CAPABILITY',{grant:{id:'cannot-reorder',principalId:'ordinary-agent',resourceRef:s.x.f.pilot.taskId,actions:['read'],expiresAt:'2026-09-12T12:00:00.000Z',reviewPolicy:'ALWAYS'}}))).rejects.toThrow('pilot_explicit_reconciliation_required');
  expect(s.pendingBytes()).toBe(s.before);
 }finally{await s.close();}
});

import * as ReviewV2 from '../document-models/review-intent/v2/index.js';
import * as ReviewV3 from '../document-models/review-intent/v3/index.js';
import {NativeBackend} from '../src/service/native-backend.js';
import {makeVersion} from '../src/task-delegation/proposal-contract.js';
import {generationInput} from '../src/task-delegation/generation-contract.js';
const settlementCallers=['allocate','claimTaskGeneration','claimPublicationInvocation','effectAdmission','admission'] as const;
async function settlementFixture(configured:boolean,caller?:typeof settlementCallers[number]){
 const s=await sharedPilotStore(configured),{ctx,ordinary,authority,x}=s;
 const r=ctx.definitions[0].release;r.runtimeContracts.push('kapelle.task-delegation/v1');r.capabilities.push({id:'task',resourceType:'task',actions:['read'],requirement:'OPTIONAL',outputTypes:[]},{id:'receive',resourceType:'task-delegation',actions:['receive'],requirement:'OPTIONAL',outputTypes:[]});r.capabilities.push({id:'website',resourceType:'website',actions:['read','update','publish'],requirement:'OPTIONAL',outputTypes:[]});r.documentModels=[{documentType:'kapelle/review-intent',version:2}];r.contentHash=releaseHash(r);
 ctx.resources[0].resourceType='website';ctx.resources=[{...ctx.resources[0],resourceType:'website',allowedActions:[...ctx.resources[0].allowedActions,'publish']},...ctx.resources.slice(1)];
 const pubProposal={...proposal(),effectKind:'WEBSITE_PUBLICATION' as const,action:'publish',expiresAt:'2026-09-12T12:00:00.000Z'};pubProposal.contentHash=proposalHash(pubProposal);
 ordinary.state.global.definitionRef!.contentHash=r.contentHash;
 ctx.runtimeBindingContracts={...ctx.runtimeBindingContracts,'local-adapter':'kapelle.task-delegation/v1'};
 const task={...structuredClone(x.f.task),id:'ordinary-task'},permission='ordinary-permission';
 ctx.resources=[...ctx.resources,{id:task.id,resourceType:'task',revision:1,contentHash:digest('ordinary-task'),allowedActions:['read']},{id:permission,resourceType:'task-delegation',revision:1,contentHash:digest('ordinary-permission'),allowedActions:['receive','dispatch']}];
 let instance=ordinary;
 for(const [id,resourceRef,actions] of [['ordinary-update','contracts',['read','update','publish']],['ordinary-task-read',task.id,['read']],['ordinary-receive',permission,['receive']]] as const)instance=apply(instance,'GRANT_CAPABILITY',{grant:{id,principalId:ordinary.header.id,resourceRef,actions:[...actions],expiresAt:'2026-09-12T12:00:00.000Z',reviewPolicy:'ALWAYS'}},ctx);
 x.documents.set(instance.header.id,instance);ctx.instance=instance.state.global;
 ctx.effects=ctx.effects.map(e=>({...e,instanceId:instance.header.id,proposalHash:pubProposal.contentHash}));
 let review=ReviewV2.utils.createDocument();review.header.id='ordinary-review';
 review=apply(review,'CREATE_REVIEW',{reviewId:review.header.id,instanceId:instance.header.id,scopeRef:ctx.scopeRef,proposal:pubProposal},ctx);
 review=apply(review,'RECORD_DECISION',{proposalHash:pubProposal.contentHash,proposalVersion:1,approved:true,reason:null},ctx);
 review=apply(review,'RESERVE_EFFECT',{operationId:'effect-1',dispatchRef:'dispatch-existing-1',outboxRef:'outbox-existing-1',proposalHash:pubProposal.contentHash,proposalVersion:1},ctx);
 x.documents.set(review.header.id,review);authority.options.effectPolicy=()=>{};
 const recipient=qualifiedRecipient(instance.state.global,ctx,task.id,permission),draft={...x.f.draft,approval:undefined,taskId:task.id,agentId:instance.header.id,recipient,sourceHash:taskSource(task).sourceHash};delete draft.approval;
 const plan=JSON.parse(x.f.offer.instructions).approvedPlan,v=makeVersion(task,draft,plan,1,'',{kind:'owner-authored',id:'owner'});
 let gen=ReviewV3.utils.createDocument();gen.header.id='ordinary-generation';
 const producer={identity:{id:'injected',version:'1',configHash:digest('injected')},timeoutMs:1000,admitted:async()=>true,generate:async()=>{throw Error('no generation allowed');},lookup:async()=>null};
 const request:any={operationId:randomUUID(),expectedRevision:1,baseVersion:1,basePlanHash:v.planHash,comment:'Review context',proposalId:gen.header.id,producer:producer.identity,inputHash:'',status:'PENDING',invocationId:null,receipt:null,outputHash:null,appliedVersion:null,errorCode:null,actorId:'owner',requestedAt:ctx.occurredAt};request.inputHash=digest(generationInput(gen.header.id,v,request));
 Object.assign(gen.state.global,{ownerId:ctx.ownerId,scopeRef:ctx.scopeRef,revision:1,status:'PROPOSED',taskPlanJson:JSON.stringify({versions:[v],approval:null,dispatchId:null,generationRequests:[request]})});x.documents.set(gen.header.id,gen);
 authority.options.taskProposalProducer=producer;authority.options.taskDelegation={...authority.options.taskDelegation!,permissionRef:permission,readTask:async()=>task};
 let allocated='ordinary-allocation',adds=0,finishes=0;const reservation=ReviewV2.utils.createDocument();
 const allocationBackend=new NativeBackend('test','test','test',{
  reserveAllocation:async()=>{reservation.header.id=allocated;return {kind:'RESERVED',document:reservation};},
  inspectOwned:async()=>({disposition:adds?'OWNED':'ABSENT'}),finishAllocation:async()=>{finishes++;},
 } as any,{drives:{addFile:async()=>{adds++;}}} as any,()=> 'unused');
 authority.backend.allocate=allocationBackend.allocate.bind(allocationBackend);
 const input={instanceId:instance.header.id,documentId:'contracts',revision:7,contentHash:digest('contracts-v7')};
 if(caller==='effectAdmission'){review=apply(review,'CLAIM_EXECUTION',{operationId:'effect-1',attemptId:'existing-attempt',executorId:instance.header.id,dispatchRef:'dispatch-existing-1',outboxRef:'outbox-existing-1',proposalHash:pubProposal.contentHash,proposalVersion:1},ctx);x.documents.set(review.header.id,review);}
 async function call(kind:typeof settlementCallers[number]){
  if(kind==='allocate')return authority.allocate('ordinary-allocate','kapelle/review-intent','Ordinary',2);
  if(kind==='claimTaskGeneration')return authority.claimTaskGeneration(gen.header.id,request.operationId);
  if(kind==='claimPublicationInvocation')return authority.claimPublicationInvocation(review.header.id,'effect-1');
  if(kind==='effectAdmission'){
   return authority.effectAdmission(review.header.id,'effect-1');
  }
  return authority.admission(input);
 }
 return {...s,instance,review:()=>x.documents.get(review.header.id),gen,task,input,request,call,allocation:(id:string)=>{allocated=id;},allocationCounts:()=>({adds,finishes})};
}
it.each(settlementCallers.flatMap(caller=>[true,false].map(configured=>({caller,configured}))))('settlement $caller configured=$configured: ordinary target succeeds, protected bytes and single claim survive',async({caller,configured})=>{
 const s=await settlementFixture(configured,caller);try{
  const result=await s.call(caller);expect(s.pendingBytes()).toBe(s.before);
  if(caller==='claimTaskGeneration'){expect(result).toMatchObject({invoke:true});expect(await s.call(caller)).toMatchObject({invoke:false});}
  if(caller==='claimPublicationInvocation'){expect(result).toBe(true);expect(await s.call(caller)).toBe(false);}
  if(caller==='allocate')expect(s.allocationCounts()).toEqual({adds:1,finishes:1});
  expect(s.pendingBytes()).toBe(s.before);await expect(s.authority.receipt(s.pending.command.operationId)).rejects.toThrow('pilot_explicit_reconciliation_required');
 }finally{await s.close();}
});
it.each(settlementCallers.flatMap(caller=>[true,false].flatMap(configured=>['related','unknown'].map(scope=>({caller,configured,scope})))))('settlement $caller configured=$configured refuses $scope scope unchanged',async({caller,configured,scope})=>{
 const s=await settlementFixture(configured,caller);try{
  const id=scope==='related'?s.x.f.pilot.instanceId:'';
  if(caller==='allocate')s.allocation(id);
  if(caller==='claimTaskGeneration'){const h=JSON.parse(s.gen.state.global.taskPlanJson!);h.versions[0].draft.agentId=id;s.gen.state.global.taskPlanJson=JSON.stringify(h);}
  if(caller==='claimPublicationInvocation'||caller==='effectAdmission')s.review().state.global.instanceId=id;
  if(caller==='admission')s.input.documentId=scope==='related'?s.x.f.pilot.taskId:'';
  await expect(s.call(caller)).rejects.toThrow();expect(s.pendingBytes()).toBe(s.before);expect(s.allocationCounts()).toEqual({adds:0,finishes:0});
 }finally{await s.close();}
});
it.each(settlementCallers.filter(c=>c!=='allocate').flatMap(caller=>[true,false].flatMap(configured=>['owner','source','qualification'].map(failure=>({caller,configured,failure})))))('settlement $caller configured=$configured retains normal $failure refusal',async({caller,configured,failure})=>{
 const s=await settlementFixture(configured,caller);try{
  if(failure==='owner'){
   if(caller==='claimTaskGeneration')s.gen.state.global.ownerId='another-owner';
   else if(caller==='admission')s.instance.state.global.ownerId='another-owner';
   else s.review().state.global.ownerId='another-owner';
  }
  if(failure==='source')s.invalidateSource();
  if(failure==='qualification')s.ctx.definitions[0].qualified=false;
  await expect(s.call(caller)).rejects.toThrow();expect(s.pendingBytes()).toBe(s.before);
 }finally{await s.close();}
});
it.each([true,false])('settlement allocate configured=%s retains model validation and same-reservation replay',async configured=>{
 const s=await settlementFixture(configured,'allocate');try{
  await expect(s.authority.allocate('bad-model','kapelle/review-intent','Ordinary',99)).rejects.toThrow();expect(s.allocationCounts()).toEqual({adds:0,finishes:0});
  const first=await s.call('allocate');expect(await s.call('allocate')).toEqual(first);expect(s.allocationCounts()).toEqual({adds:1,finishes:2});
  s.allocation(s.x.id);await expect(s.call('allocate')).rejects.toThrow('pilot_explicit_reconciliation_required');expect(s.allocationCounts()).toEqual({adds:1,finishes:2});expect(s.pendingBytes()).toBe(s.before);
 }finally{await s.close();}
});

// End to end through the REAL launcher + actual fenced publisher (0be4dd4+): a Registry deployment that no longer matches
// the admission refuses the new execution BEFORE any inference, with the fixed label; nothing is published or claimed.
it.skipIf(!publisherQualificationRoot)('end to end: deployment mismatch refuses /run before inference (409 publisher_model_not_admitted)',async()=>{
 const fenced=readFileSync(join(publisherQualificationRoot!,'src/private-publication.ts'),'utf8').includes('report-publication-model-admission.v2');
 if(!fenced)return;
 const x=await recoveryFixture(publisherQualificationRoot);try{
  x.enable();x.nativeReport.deployment={...x.nativeReport.deployment,modelDigest:'0'.repeat(64)};
  const refused=await x.call('/run');
  expect(refused).toMatchObject({status:409,ok:false,error:'publisher_model_not_admitted'});
  expect(x.counts()).toMatchObject({provider:0,publishes:0});expect(x.nativeReport.writes).toBe(0);
  // The Registry is back on the admitted model: the same Dispatch now runs (exactly one inference).
  x.nativeReport.deployment={...x.nativeReport.deployment,modelDigest:(await import('./fixtures/model-admission.js')).modelDigest((await import('./fixtures/model-admission.js')).packageInventory(publisherQualificationRoot!))};
  expect((await x.call('/run')).item.status).not.toBe(undefined);expect(x.counts().provider).toBe(1);
 }finally{await x.close();}
});

// Mechanical deploy fence end to end through the REAL launcher + actual publisher: while the Registry deploy/restart tooling holds
// the EXCLUSIVE deploy lock, the publication waits and then refuses before any Registry write; once released, the same
// execution publishes exactly once with no second inference.
it.skipIf(!publisherQualificationRoot)('deploy lock end to end: a deploy in progress blocks publication before any write; afterwards it publishes once',async()=>{
 const lockModule=join(publisherQualificationRoot!,'src/deploy-lock.ts');
 if(!existsSync(lockModule))return;
 const {acquireDeployLock}=await import(/* @vite-ignore */ lockModule);
 const dir=mkdtempSync(join(tmpdir(),'deploy-lock-pilot-')),lock=join(realpathSync(dir),'REGISTRY-DEPLOY.lock');
 const x=await recoveryFixture(publisherQualificationRoot,{deployLock:lock});try{
  x.enable();const deploy=await acquireDeployLock(lock,'exclusive',1000);
  let first;try{first=await x.call('/run');}finally{await deploy.release();}
  expect(first.item.status).toBe('REPORT_PENDING');expect(x.nativeReport.writes).toBe(0);expect(x.counts().provider).toBe(1);
  expect((await x.call('/reconcile')).item.status).toBe('REPORT_PUBLISHED');
  expect(x.nativeReport.writes).toBe(2);expect(x.counts().provider).toBe(1);
 }finally{await x.close();rmSync(dir,{recursive:true,force:true});}
});

it('pilot signals (Increment 2): window, consumed claim and the pinned plan, read-only and Task-bound',()=>{
 const {pilot}=fixture(),at=(ms:number)=>new Date(Date.parse(pilot.approvedAt)+ms).toISOString();
 const open=pilotSignals(pilot,pilot.taskId,at(60000),false);
 expect(open).toEqual({mode:'single-task-pilot',taskBound:true,newWorkEndsAt:pilot.expiresAt,newWorkEnded:false,invocationConsumed:false,
  pinnedPlan:{operationId:pilot.operationId,sourceHash:pilot.sourceHash,planHash:pilot.planHash}});
 expect(pilotSignals(pilot,pilot.taskId,at(-1),false).newWorkEnded).toBe(true);
 expect(pilotSignals(pilot,pilot.taskId,pilot.expiresAt,false).newWorkEnded).toBe(true);
 expect(pilotSignals(pilot,pilot.taskId,at(7199999),false).newWorkEnded).toBe(false);
 expect(pilotSignals(pilot,pilot.taskId,at(60000),true)).toMatchObject({newWorkEnded:true,invocationConsumed:true,pinnedPlan:{planHash:pilot.planHash}});
 // Another Task on a pilot host: no new work and no pinned plan to disclose.
 expect(pilotSignals(pilot,'other-task',at(60000),false)).toMatchObject({taskBound:false,newWorkEnded:true,pinnedPlan:null});
 expect(()=>pilotSignalsSchema.parse({...open,extra:1})).toThrow();
});

// ---- Increment 2 B-1: saved reads after the pilot's recovery window (read-only projection of the worker's saved record) ----
import {withSavedRead,savedRead,savedReadCommand} from '../src/task-delegation/recovery.js';
it('after the recovery window, GET serves the saved published receipt read-only: no Registry, publisher, provider or command; run/reconcile stay refused',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();await x.restart();x.enable();
  const published=await x.call('/reconcile');expect(published.item.status).toBe('REPORT_PUBLISHED');
  x.deadline();
  const before=x.counts();
  const saved=await x.call('','GET');
  expect(saved).toMatchObject({status:200,item:{status:'REPORT_PUBLISHED',reason:null,outputRetained:true,taskCompleted:false,effectsAuthorized:false}});
  expect(saved.item.result).toEqual(published.item.result);
  expect(saved.item.result).toMatchObject({reportId:expect.any(String),contentHash:expect.stringMatching(/^sha256:/),verificationRef:expect.any(String)});
  expect(x.counts()).toEqual(before);
  // Cold restart after the window (the release swap) serves the same projection.
  await x.restart();expect((await x.call('','GET')).item.result).toEqual(published.item.result);
  expect((await x.call('/run')).status).not.toBe(200);expect((await x.call('/reconcile')).status).not.toBe(200);
  expect(x.counts()).toEqual(before);
 }finally{await x.close();}
});
it.each(['grant-revoked','grant-pre-pilot','task-owner','native-result','dispatch-recipient'] as const)('after the recovery window a saved read refuses %s',async kind=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.expire();await x.restart();x.enable();await x.call('/reconcile');x.deadline();
  expect((await x.call('','GET')).item.status).toBe('REPORT_PUBLISHED');
  if(kind==='grant-revoked')x.f.doc.state.global.grants[0].revokedAt=x.f.pilot.expiresAt;
  // A never-revoked read grant that had already expired when the pilot was approved (lower bound).
  if(kind==='grant-pre-pilot')x.f.doc.state.global.grants[0].expiresAt=x.f.pilot.approvedAt;
  if(kind==='task-owner')x.f.task.ownerId='other';
  if(kind==='native-result')x.documents.get(x.id).state.global.result.contentHash='sha256:'+'0'.repeat(64);
  if(kind==='dispatch-recipient')x.documents.get(x.id).state.global.offer.recipient.instanceId='other';
  const before=x.counts(),r=await x.call('','GET');
  expect(r.status).not.toBe(200);expect(r.item).toBeUndefined();expect(x.counts()).toEqual(before);
 }finally{await x.close();}
});
it('after the recovery window, unpublished saved work is reported as saved and never reconciled',async()=>{
 const x=await recoveryFixture();try{
  await x.call('/run');x.deadline();await x.restart();
  const before=x.counts(),r=await x.call('','GET');
  expect(r).toMatchObject({status:200,item:{status:'REPORT_PENDING',result:null}});expect(['publisher_not_admitted','publication_uncertain']).toContain(r.item.reason);
  expect((await x.call('/reconcile')).status).not.toBe(200);expect(x.counts()).toEqual(before);
 }finally{await x.close();}
});
it('the saved-read scope forbids native commands and nesting, and names only its own pilot',async()=>{
 const f=fixture(),other={...f.pilot,instanceId:'other-instance'};
 await withSavedRead(f.pilot,'d',async()=>{
  expect(savedRead(f.pilot)).toBe(true);expect(savedRead(other)).toBe(false);expect(savedRead(undefined)).toBe(false);
  expect(()=>savedReadCommand()).toThrow('pilot_saved_read_command_forbidden');
  expect(()=>withSavedRead(f.pilot,'d',async()=>1)).toThrow('pilot_saved_read_nested');
 });
 expect(savedRead(f.pilot)).toBe(false);expect(()=>savedReadCommand()).not.toThrow();
});
