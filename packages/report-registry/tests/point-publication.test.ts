import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,realpathSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {taskFixture} from './fixtures/task-publication.ts';
import {PrivateTaskReportPublisher} from '../src/task-publication.ts';
import {derivedTaskIdentity} from '../src/private-publication.ts';

// Scale bridge: Task publication with ZERO full-Drive listings.
const LISTINGS=['getDocuments','getReportIdentities','getReportLibraryMetadata'];
function root(){return realpathSync(mkdtempSync(join(tmpdir(),'point-publication-')));}
function traced(dir:string,hook?:(role:string,name:string,args:Record<string,unknown>)=>void|Promise<void>){
 const f=taskFixture(dir),trace:{role:string;name:string}[]=[];const call=f.mcp.call.bind(f.mcp);
 const client=(role:string)=>({call:async(name:string,args:Record<string,unknown>)=>{trace.push({role,name});await hook?.(role,name,args);return call(name,args);}});
 const publisher=new PrivateTaskReportPublisher({...f.options,mcp:client('producer'),reader:client('reader')});
 return {...f,publisher,trace};
}

test('Task identities are derived; other private publications keep the listing path',()=>{
 assert.equal(derivedTaskIdentity({publicationId:'task-report:'+'a'.repeat(64),reportRef:'report:task:'+'a'.repeat(64)}),true);
 assert.equal(derivedTaskIdentity({publicationId:'task-report:'+'a'.repeat(64),reportRef:'report:task:'+'b'.repeat(64)}),false);
 assert.equal(derivedTaskIdentity({publicationId:'private:test:1',reportRef:'report:test:private:1'}),false);
});
test('first publish, its readback, a repeat publish and lookup make zero listing calls; one create, one register',async()=>{
 const dir=root();try{
  const f=traced(dir);
  const first=await f.publisher.publish(f.request);
  assert.equal(f.trace.filter(t=>LISTINGS.includes(t.name)).length,0,JSON.stringify(f.trace));
  assert.equal(f.trace.filter(t=>t.name==='createDocument').length,1);assert.equal(f.trace.filter(t=>t.name==='addActions').length,1);
  // Independent reader: its own scoped proof only.
  assert.deepEqual([...new Set(f.trace.filter(t=>t.role==='reader').map(t=>t.name))],['getReportDocumentV1']);
  f.trace.length=0;
  assert.equal((await f.publisher.publish(f.request)).documentId,first.documentId);
  assert.equal((await f.publisher.lookup(f.request))?.documentId,first.documentId);
  assert.equal(f.trace.filter(t=>LISTINGS.includes(t.name)||t.name==='createDocument'||t.name==='addActions').length,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a registration that appears between the identity lookup and create refuses with zero writes',async()=>{
 const dir=root();try{
  let lookups=0;
  const f=traced(dir,(role,name)=>{if(name==='lookupReportPublicationV1'&&++lookups===2){
   const g=f.mcp;g.docs.set('rival',{header:{id:'rival',name:'rival',documentType:'kilgore/report'},state:{global:{reportRef:'report:task:'+f.request.publicationId.slice(12),publication:null}}});
  }});
  await assert.rejects(f.publisher.publish(f.request),/MEMBERSHIP_CHANGED/);
  assert.equal(f.mcp.writes,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('an unverified native lookup refuses before any write; never read as absence and no listing fallback',async()=>{
 const dir=root();try{
  const f=traced(dir);f.mcp.lookupFault='unverified';
  await assert.rejects(f.publisher.publish(f.request),/PUBLICATION_LOOKUP_UNVERIFIED/);
  assert.equal(f.mcp.writes,0);assert.equal(f.trace.filter(t=>LISTINGS.includes(t.name)).length,0);
  assert.equal(readdirSync(join(dir,'receipts')).filter(n=>n.startsWith('.private-create-')).length,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a twin blank intent appearing right after create refuses the register: one create, no addActions',async()=>{
 const dir=root();try{
  const f=taskFixture(dir);const call=f.mcp.call.bind(f.mcp);
  f.mcp.call=async(name,args)=>{const v=await call(name,args);if(name==='createDocument'){const d=f.mcp.docs.get(v.document.header.id);f.mcp.docs.set('twin',{header:{...structuredClone(d.header),id:'twin'},state:{global:{}}});}return v;};
  const client={call:f.mcp.call.bind(f.mcp)};
  await assert.rejects(new PrivateTaskReportPublisher({...f.options,mcp:client,reader:client}).publish(f.request),/MEMBERSHIP_CHANGED|ID_CONFLICT/);
  assert.equal(f.mcp.writes,1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('lost register reply recovers through the native lookup with no listing and no second create',async()=>{
 const dir=root();try{
  const f=traced(dir);f.mcp.fault='register';
  await assert.rejects(f.publisher.publish(f.request),/lost register response/);
  const writes=f.mcp.writes;f.trace.length=0;
  assert.equal((await f.publisher.lookup(f.request))?.documentId,'doc-1');
  assert.equal((await f.publisher.publish(f.request)).documentId,'doc-1');
  assert.equal(f.mcp.writes,writes);assert.equal(f.trace.filter(t=>LISTINGS.includes(t.name)).length,0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
