// Old (47-file) Registry model compatibility (observed in the live pilot): the live Registry model drops REGISTER_REPORT.publication, so a
// FINAL Report is stored with NO publication key. Owner decision (Option C): accept only a UNIQUE reportRef match whose full
// document has no publication key, with every other check strict. Publish readback and lookup use the same rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import {Fake,fixture} from './fixtures/private-publication.ts';
import {lookupPrivateRequest,publishPrivateRequest} from '../src/private-publication.ts';
const legacy=()=>{const m=new Fake();m.legacyModel=true;return m;};
test('old model: first publish accepts the unique reportRef match (no publication key stored) and lookup agrees, without extra writes',async()=>{
 const f=fixture(),m=legacy();
 const published=await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 assert.equal(published.receipt.documentId,'doc-1');assert.equal(Object.hasOwn(m.docs.get('doc-1').state.global,'publication'),false);
 const writes=m.writes;assert.equal(writes,2);
 const found=await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 assert.equal(found?.documentId,'doc-1');assert.deepEqual(found?.publication,f.admitted.request.publication);assert.match(String(found?.verificationRef),/^private-report:[a-f0-9]{64}$/);
 assert.equal(m.writes,writes);
});
test('old model, pilot shape: register applied but the publish failed before its receipt; lookup completes read-only',async()=>{
 const f=fixture(),m=legacy();m.fault='register';
 await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/lost/);
 const writes=m.writes;
 const found=await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 assert.equal(found?.documentId,'doc-1');assert.equal(m.writes,writes);
 // A repeated publish recovers the same Report: no second create (the fixture's attention:READ request adds only its
 // pending REQUEST_REVIEW action, as on the new model; the Task path uses attention NONE).
 const again=await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);assert.equal(again.receipt.documentId,'doc-1');assert.equal(m.docs.size,1);assert.equal(m.writes,writes+1);
});
test('old model: two documents with the same reportRef are refused',async()=>{
 const f=fixture(),m=legacy();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 const twin=structuredClone(m.docs.get('doc-1'));twin.header.id='doc-2';m.docs.set('doc-2',twin);const writes=m.writes;
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/ID_CONFLICT|DUPLICATED/);assert.equal(m.writes,writes);
});
test('a publication that exists but differs is refused (new model); explicit null is treated as no publication (old model)',async()=>{
 const f=fixture(),m=new Fake();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 m.docs.get('doc-1').state.global.publication={...m.docs.get('doc-1').state.global.publication,runRef:'agent://run/other'};
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/METADATA_CONFLICT/);
 m.docs.get('doc-1').state.global.publication=null;
 assert.equal((await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m))?.documentId,'doc-1');
 m.docs.get('doc-1').state.global.publication={};
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/METADATA_CONFLICT|PUBLICATION|publication/);
});
test('old model: content mismatch is refused (bytes, hash, producer, sourceRef, lifecycle, createdBy)',async()=>{
 for(const mutate of [
  (g:any)=>{g.content.markdown='# tampered\n';},(g:any)=>{g.content.contentHash='f'.repeat(64);},(g:any)=>{g.producer.id='other';},
  (g:any)=>{g.sourceRef='agent://source/other';},(g:any)=>{g.lifecycle='WITHDRAWN';},(g:any)=>{g.createdBy='someone-else';},
 ]){
  const f=fixture(),m=legacy();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
  mutate(m.docs.get('doc-1').state.global);
  await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/REPORT_REF_CONFLICT|METADATA_CONFLICT|ID_CONFLICT/);
 }
});
test('old model: first publish readback with tampered bytes is still refused',async()=>{
 const f=fixture(),m=legacy();m.corrupt=true;
 await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/content.markdown/);
});
test('read-only lookup has a 60 s guard; publication keeps 30 s',async()=>{
 const {CompletePrivateReportMcp}=await import('../src/private-publication.ts');
 assert.equal(new CompletePrivateReportMcp(new Fake(),'drive').deadlineMs,30000);
 const f=fixture(),m=legacy();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 const realNow=Date.now;let calls=0;const start=realNow();
 // Each Registry call advances the clock 4.5 s: a lookup makes ~8-9 calls (~36-40 s): over 30 s, within 60 s.
 const orig=m.call.bind(m);m.call=async(n:string,a:any)=>{calls++;return orig(n,a);};
 Date.now=()=>start+calls*4500;
 try{const found=await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m);assert.equal(found?.documentId,'doc-1');}
 finally{Date.now=realNow;}
});
