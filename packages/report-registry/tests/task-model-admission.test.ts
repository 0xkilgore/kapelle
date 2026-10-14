// Task-path live model admission (pilot follow-up): publish refuses BEFORE any retained plan, create intent, lock or Registry
// call unless the host supplies a QUALIFIED_LIVE admission of the 49-file publication-capable model. Lookup/read of an
// existing Report don't need it (pilot-style recovery of an already-created Report still works).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readdirSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {taskFixture,qualifiedModelAdmission} from './fixtures/task-publication.ts';
import {PrivateTaskReportPublisher} from '../src/task-publication.ts';
const root=()=>realpathSync(mkdtempSync(join(tmpdir(),'task-model-admission-')));
const untouched=(dir:string,mcp:{calls:number;writes:number})=>{assert.equal(mcp.calls,0);assert.equal(mcp.writes,0);assert.equal(existsSync(join(dir,'receipts'))?readdirSync(join(dir,'receipts')).length:0,0);};
test('no model admission: publish refuses before any file, lock or Registry call',async()=>{
 const dir=root(),f=taskFixture(dir);const {modelAdmission:_,...options}=f.options;
 await assert.rejects(new PrivateTaskReportPublisher(options).publish(f.request),/TASK_PUBLICATION_MODEL_NOT_ADMITTED/);untouched(dir,f.mcp);
});
test('old 47-file model (inventory without the publication overlay) is refused before create',async()=>{
 const dir=root(),f=taskFixture(dir),value:any=qualifiedModelAdmission(f.options.modelAdmission.endpoint,'drive');
 delete value.runtimeInventory['v1/src/publication.ts'];delete value.runtimeInventory['v1/tests/unread-runtime.test.ts'];
 await assert.rejects(new PrivateTaskReportPublisher({...f.options,modelAdmission:{value,endpoint:f.options.modelAdmission.endpoint}}).publish(f.request),/MODEL_INVENTORY_NOT_ADMITTED/);untouched(dir,f.mcp);
});
test('a schema-only or wrong-endpoint/wrong-drive admission is refused before create',async()=>{
 for(const change of [(v:any)=>{v.runtimeInventory={};},(v:any)=>{v.status='SOURCE_PREPARED';},(v:any)=>{v.endpoint='http://127.0.0.1:14250/mcp';},(v:any)=>{v.driveId='other-drive';}]){
  const dir=root(),f=taskFixture(dir),value:any=qualifiedModelAdmission(f.options.modelAdmission.endpoint,'drive');change(value);
  await assert.rejects(new PrivateTaskReportPublisher({...f.options,modelAdmission:{value,endpoint:f.options.modelAdmission.endpoint}}).publish(f.request),/MODEL_(INVENTORY_)?NOT_ADMITTED/);untouched(dir,f.mcp);
 }
});
test('a qualified 49-file admission publishes; lookup/read work without any admission',async()=>{
 const dir=root(),f=taskFixture(dir);
 const published=await f.publisher.publish(f.request);assert.equal(published.documentId,'doc-1');
 const {modelAdmission:_,...options}=f.options,reader=new PrivateTaskReportPublisher(options);
 assert.equal((await reader.lookup(f.request))?.documentId,'doc-1');assert.equal((await reader.read(f.request.publicationId)).documentId,'doc-1');
});

// The admission is re-read for every publish and bound to the deployment actually behind the
// endpoint; withdrawal, change, expiry or a same-endpoint deployment mismatch refuse with zero plan/intent/lock/publication calls.
import {packageModelDigest} from './fixtures/private-publication.ts';
const noArtifacts=(dir:string)=>{assert.equal(existsSync(join(dir,'receipts'))?readdirSync(join(dir,'receipts')).length:0,0);assert.equal(existsSync(join(dir,'locks'))?readdirSync(join(dir,'locks')).length:0,0);};
const onlyDeploymentReads=(f:any,calls:string[])=>{assert.equal(f.mcp.writes,0);assert.ok(calls.every(n=>n==='getRegistryDeploymentV1'),calls.join());};
function loaded(dir:string){
 const f=taskFixture(dir),endpoint=f.options.modelAdmission.endpoint;let current:any={value:qualifiedModelAdmission(endpoint,'drive'),endpoint};const calls:string[]=[];
 const client={call:async(name:string,args:Record<string,unknown>)=>{calls.push(name);return f.mcp.call(name,args);}};
 const publisher=new PrivateTaskReportPublisher({...f.options,mcp:client,reader:client,modelAdmission:{load:async()=>{if(current instanceof Error)throw current;return structuredClone(current);}}});
 return {f,publisher,calls,set:(v:any)=>{current=v;},endpoint};
}
test('withdrawn, changed, expired or v1 admission after construction refuses with zero artifacts and no write',async()=>{
 const cases:[(endpoint:string)=>any,RegExp][]=[
  [()=>new Error('ENOENT'),/MODEL_NOT_ADMITTED/],
  [(e)=>{const v:any=qualifiedModelAdmission(e,'drive');delete v.runtimeInventory['v1/src/publication.ts'];return {value:v,endpoint:e};},/INVENTORY_NOT_ADMITTED/],
  [(e)=>({value:{...qualifiedModelAdmission(e,'drive'),status:'REVOKED'},endpoint:e}),/MODEL_NOT_ADMITTED/],
  [(e)=>({value:qualifiedModelAdmission(e,'drive','2026-10-01T00:00:00.000Z'),endpoint:e}),/ADMISSION_EXPIRED/],
  [(e)=>({value:{...qualifiedModelAdmission(e,'drive'),schemaVersion:'kapelle.report-publication-model-admission.v1'},endpoint:e}),/MODEL_NOT_ADMITTED/],
 ];
 for(const [make,error] of cases){const dir=root(),x=loaded(dir);x.set(make(x.endpoint));
  await assert.rejects(x.publisher.publish(x.f.request),error);onlyDeploymentReads(x.f,x.calls);assert.equal(x.calls.length,0);noArtifacts(dir);
  await assert.rejects(x.publisher.publishReady('drive'),error);}
});
test('same-endpoint deployment mismatch (other model, other release, files changed under the running Reactor) refuses',async()=>{
 for(const change of [(d:any)=>{d.modelDigest='0'.repeat(64);},(d:any)=>{d.releaseId='other-release';},(d:any)=>{d.currentModelDigest='1'.repeat(64);},(d:any)=>{d.currentReleaseId='rolled-back';}]){
  const dir=root(),x=loaded(dir);change(x.f.mcp.deployment);
  await assert.rejects(x.publisher.publish(x.f.request),/MODEL_DEPLOYMENT_MISMATCH/);onlyDeploymentReads(x.f,x.calls);assert.deepEqual(x.calls,['getRegistryDeploymentV1']);noArtifacts(dir);
  await assert.rejects(x.publisher.publishReady('drive'),/MODEL_DEPLOYMENT_MISMATCH/);
 }
 const dir=root(),x=loaded(dir);x.f.mcp.deploymentFault='unavailable';
 await assert.rejects(x.publisher.publish(x.f.request),/MODEL_DEPLOYMENT_UNAVAILABLE/);noArtifacts(dir);assert.equal(x.f.mcp.writes,0);
});
test('deploy fence: a restart into another deployment between check and send never registers under it',async()=>{
 // (1) before create: zero writes; (2) after create, before register: the blank intent only, no register;
 // (3) between the last check and the register send: the register is not claimed (publish refuses).
 for(const [trigger,writes] of [['lookupReportPublicationV1#2',0],['createDocument',1],['addActions',2]] as const){
  const dir=root(),x=loaded(dir);let n=0;const call=x.f.mcp.call.bind(x.f.mcp);
  x.f.mcp.call=async(name:string,args:Record<string,unknown>)=>{const result=await call(name,args);
   if(name===trigger||(trigger==='lookupReportPublicationV1#2'&&name==='lookupReportPublicationV1'&&++n===2)){x.f.mcp.deployment={...x.f.mcp.deployment,bootId:'boot-2',modelDigest:'0'.repeat(64)};}
   return result;};
  // Pre-retain check passed, so any fence failure is the mid-write class (never the pre-write labels).
  await assert.rejects(x.publisher.publish(x.f.request),/MODEL_DEPLOYMENT_CHANGED/);
  assert.equal(x.f.mcp.writes,writes,trigger);
 }
});
test('an unchanged qualified deployment publishes, and a same-model restart before publish is fine; publishReady passes',async()=>{
 const dir=root(),x=loaded(dir);await x.publisher.publishReady('drive');await x.publisher.publishReady();
 x.f.mcp.deployment={...x.f.mcp.deployment,bootId:'boot-restarted'};
 assert.equal((await x.publisher.publish(x.f.request)).documentId,'doc-1');assert.equal(x.f.mcp.deployment.modelDigest,packageModelDigest());
 assert.equal(existsSync(join(dir,'locks'))?readdirSync(join(dir,'locks')).length:0,0);
});
test('at the write: create and register carry the admitted deployment generation for the proxy to enforce',async()=>{
 const dir=root(),x=loaded(dir),seen:Record<string,unknown>[]=[];const call=x.f.mcp.call.bind(x.f.mcp);
 x.f.mcp.call=async(name:string,args:Record<string,unknown>)=>{if(name==='createDocument'||name==='addActions')seen.push(args);return call(name,args);};
 await x.publisher.publish(x.f.request);
 const d=x.f.mcp.deployment;
 assert.equal(seen.length,2);
 for(const args of seen)assert.equal(args.expectedRegistryGeneration,`v1:${d.releaseId}:${d.modelDigest}:${d.bootId}`);
});
