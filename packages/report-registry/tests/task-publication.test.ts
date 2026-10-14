import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,realpathSync,readdirSync,readFileSync,statSync,rmSync,linkSync,unlinkSync,symlinkSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {taskFixture} from './fixtures/task-publication.ts';
import {PrivateTaskReportPublisher} from '../src/task-publication.ts';
function root(){return realpathSync(mkdtempSync(join(tmpdir(),'task-publication-')));}
function files(root:string):unknown{return readdirSync(root).sort().map(name=>{const path=join(root,name),s=statSync(path);return {name,mode:s.mode,mtime:s.mtimeMs,value:s.isDirectory()?files(path):readFileSync(path).toString('base64')};});}
test('retained plan survives reopening; lookups and reads do not touch files or native writes',async()=>{
 const dir=root();try{const f=taskFixture(dir);assert.equal(await f.publisher.lookup(f.request),null);assert.deepEqual(readdirSync(dir),[]);
 const first=await f.publisher.publish(f.request),before=files(dir),writes=f.mcp.writes;
 const reopened=new PrivateTaskReportPublisher({...f.options,now:()=>{throw Error('clock regenerated');}});
 assert.deepEqual(await reopened.lookup(f.request),first);assert.deepEqual(await reopened.read(f.request.publicationId),first);
 assert.deepEqual(files(dir),before);assert.equal(f.mcp.writes,writes);
 assert.equal(first.publication.publishedAt,'2026-09-28T12:00:00.000Z');assert.equal(first.publication.author.definitionHash,f.admission.author.definitionHash!.slice(7));
 for(const change of [()=>f.admission.publisher.id='imposter',()=>f.admission.driveId='other-drive',()=>f.admission.authorizationRef='other-authorization']){
  const saved=structuredClone(f.admission);change();await assert.rejects(reopened.lookup(f.request),/RETAINED_BINDING_CHANGED/);Object.assign(f.admission,saved);
 }
 await assert.rejects(reopened.lookup({...f.request,packetHash:'sha256:'+'0'.repeat(64)}),/RETAINED_BINDING_CHANGED/);
 await assert.rejects(reopened.lookup({...f.request,markdown:'changed'}),/IDENTITY_MISMATCH/);
 assert.equal(f.mcp.writes,writes);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('admission and selected independent reader loss prevent a success result',async()=>{
 const dir=root();try{const f=taskFixture(dir);const denied=new PrivateTaskReportPublisher({...f.options,authorize:async()=>null});assert.equal(await denied.admitted(f.request),false);await assert.rejects(denied.publish(f.request),/NOT_ADMITTED/);assert.equal(f.mcp.writes,0);
 f.admission.author.instanceId='other';await assert.rejects(f.publisher.publish(f.request),/ADMISSION_MISMATCH/);f.admission.author.instanceId='instance';
 await f.publisher.publish(f.request);const writes=f.mcp.writes;
 const broken=new PrivateTaskReportPublisher({...f.options,reader:{call:async()=>{throw Error('reader unavailable');}}});await assert.rejects(broken.lookup(f.request),/reader unavailable/);assert.equal(f.mcp.writes,writes);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
for(const mode of ['kill-create','kill-register'])test('whole publisher process destruction at '+mode+' recovers by lookup only',()=>{
 const dir=root();try{
 const child=fileURLToPath(new URL('./fixtures/task-publication-child.ts',import.meta.url));
 const killed=spawnSync(process.execPath,['--experimental-strip-types',child,dir,mode],{encoding:'utf8',timeout:10000});assert.equal(killed.signal,'SIGKILL',killed.stderr);
 const before=files(dir);
 for(let i=0;i<2;i++){
  const result=spawnSync(process.execPath,['--experimental-strip-types',child,dir,'lookup'],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);
  const read=JSON.parse(result.stdout);if(mode==='kill-create')assert.equal(read,null);else{assert.equal(read.publication.contentVersion,1);assert.equal(read.publication.publishedAt,'2026-09-28T12:00:00.000Z');}
  assert.deepEqual(files(dir),before);
 }
 const state=JSON.parse(readFileSync(join(dir,'native-fixture.json'),'utf8'));assert.equal(state.docs.length,1);assert.equal(state.writes,mode==='kill-create'?1:2);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

for(const mode of ['kill-retain','observe-retain'])test('retention link window: '+mode+' preserves original plan and read-only recovery',async()=>{
 const dir=root();try{
  const child=fileURLToPath(new URL('./fixtures/task-publication-child.ts',import.meta.url));
  const installed=spawnSync(process.execPath,['--experimental-strip-types',child,dir,mode],{encoding:'utf8',timeout:10000});
  if(mode==='kill-retain')assert.equal(installed.signal,'SIGKILL',installed.stderr);
  else {assert.equal(installed.status,0,installed.stderr);const line=installed.stdout.split('\n').find(x=>x.startsWith('CONCURRENT='));const concurrent=JSON.parse(line!.slice(11));assert.equal(concurrent.result,null);assert.ok(concurrent.calls>0);assert.equal(concurrent.writes,0);}
  const receiptDir=join(dir,'receipts'),name=readdirSync(receiptDir).find(n=>/^\.task-plan-[a-f0-9]{64}\.json$/.test(n))!,path=join(receiptDir,name),original=readFileSync(path,'utf8');
  assert.equal(statSync(path).nlink,mode==='kill-retain'?2:1);
  const before=files(dir);
  const recovered=spawnSync(process.execPath,['--experimental-strip-types',child,dir,'lookup-retained'],{encoding:'utf8',timeout:10000});
  assert.equal(recovered.status,0,recovered.stderr);const observed=JSON.parse(recovered.stdout);assert.ok(observed.calls>0);assert.deepEqual(files(dir),before);
  if(mode==='kill-retain'){
   assert.equal(observed.result,null);assert.equal(observed.writes,0);
   const f=taskFixture(dir),retry=new PrivateTaskReportPublisher({...f.options,now:()=>{throw Error('original timestamp lost');}});
   await assert.rejects(retry.publish({...f.request,packetHash:'sha256:'+'0'.repeat(64)}),/RETAINED_BINDING_CHANGED/);
   const originalPublisher=f.admission.publisher.id;f.admission.publisher.id='other';
   await assert.rejects(retry.publish(f.request),/RETAINED_BINDING_CHANGED/);f.admission.publisher.id=originalPublisher;
   assert.equal(f.mcp.writes,0);assert.equal(readFileSync(path,'utf8'),original);
   // Explicit publish retry is permitted here only because this interruption was BEFORE any native call.
   const published=await retry.publish(f.request);assert.equal(published.publication.publishedAt,JSON.parse(original).publishedAt);
   assert.equal(readFileSync(path,'utf8'),original);assert.equal(statSync(path).nlink,2);
   const writes=f.mcp.writes,stable=files(dir);assert.deepEqual(await retry.lookup(f.request),published);assert.equal(f.mcp.writes,writes);assert.deepEqual(files(dir),stable);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('concurrent staging unlink during descriptor read retries only the read',()=>{
 const dir=root();try{
  const child=fileURLToPath(new URL('./fixtures/task-publication-child.ts',import.meta.url));
  assert.equal(spawnSync(process.execPath,['--experimental-strip-types',child,dir,'kill-retain'],{encoding:'utf8',timeout:10000}).signal,'SIGKILL');
  const receipts=join(dir,'receipts'),name=readdirSync(receipts).find(n=>n.endsWith('.json'))!,path=join(receipts,name),before=readFileSync(path,'utf8');
  const result=spawnSync(process.execPath,['--experimental-strip-types',child,dir,'unlink-during-read'],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);const observed=JSON.parse(result.stdout);assert.equal(observed.result,null);assert.ok(observed.calls>0);assert.equal(observed.writes,0);
  assert.equal(statSync(path).nlink,1);assert.equal(readFileSync(path,'utf8'),before);assert.equal(readdirSync(receipts).length,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('unexplained, external and extra hard links remain unsafe; symlinks and public modes remain refused',async()=>{
 const dir=root();try{
  const f=taskFixture(dir);await f.publisher.publish(f.request);const receipts=join(dir,'receipts'),name=readdirSync(receipts).find(n=>/^\.task-plan-[a-f0-9]{64}\.json$/.test(n))!,path=join(receipts,name),writes=f.mcp.writes;
  for(const alias of [join(dir,name+'.00000000-0000-4000-8000-000000000000.tmp'),path+'.unrecognized.tmp']){
   linkSync(path,alias);const before=files(dir);await assert.rejects(f.publisher.lookup(f.request),/ARTIFACT_UNSAFE/);assert.deepEqual(files(dir),before);unlinkSync(alias);
  }
  const valid=path+'.00000000-0000-4000-8000-000000000000.tmp';linkSync(path,valid);
  const extra=path+'.00000000-0000-4000-8000-000000000001.tmp';linkSync(path,extra);await assert.rejects(f.publisher.lookup(f.request),/ARTIFACT_UNSAFE/);unlinkSync(extra);
  const target=join(dir,'external-link');linkSync(path,target);unlinkSync(valid);symlinkSync(target,valid);await assert.rejects(f.publisher.lookup(f.request),/ARTIFACT_UNSAFE/);unlinkSync(valid);unlinkSync(target);
  chmodSync(path,0o644);await assert.rejects(f.publisher.lookup(f.request),/ARTIFACT_UNSAFE/);chmodSync(path,0o600);
  assert.ok(await f.publisher.lookup(f.request));assert.equal(f.mcp.writes,writes);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('publication beyond the first100 IDs recovers without writes and refuses a truncated inventory',async()=>{
 const dir=root();try{
  const f=taskFixture(dir);
  for(let i=1;i<=150;i++){const id='existing-'+i;f.mcp.docs.set(id,{header:{id,name:id,documentType:'kilgore/report'},state:{global:{reportRef:'report:'+id,publication:null}}});}
  f.mcp.fault='register';await assert.rejects(f.publisher.publish(f.request),/lost register response/);
  assert.equal(f.mcp.docs.size,151);const writes=f.mcp.writes;
  // Lookup no longer lists at all (native lookup + scoped point proofs); an unprovable selected read must refuse without writes.
  f.mcp.pointFault='unavailable';
  await assert.rejects(f.publisher.lookup(f.request),/REPORT_DETAIL_UNAVAILABLE/);assert.equal(f.mcp.writes,writes);
  f.mcp.pointFault='';
  const recovered=await f.publisher.lookup(f.request);assert.equal(recovered?.documentId,'doc-151');
  assert.equal((await f.publisher.publish(f.request)).documentId,'doc-151');assert.equal(f.mcp.docs.size,151);assert.equal(f.mcp.writes,writes);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
