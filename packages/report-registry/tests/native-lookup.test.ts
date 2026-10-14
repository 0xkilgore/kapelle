import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupPrivateRequest,publishPrivateRequest} from '../src/private-publication.ts';
import {promotionIntentName} from '../src/promote.ts';
import {Fake,fixture} from './fixtures/private-publication.ts';

// Classification matrix for lookupPrivateRequest over lookupReportPublicationV1.
function traced(m:Fake){const trace:string[]=[];const call=m.call.bind(m);m.call=async(name,args)=>{trace.push(name);return call(name,args);};return trace;}
const blank=(id:string,name:string)=>({header:{id,name,documentType:'kilgore/report'},state:{global:{}}});

test('1/0: one V1 lookup + scoped producer and reader point proofs + one closing V1 lookup; no listing at all',async()=>{
 const f=fixture(),m=new Fake();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);const writes=m.writes,trace=traced(m);
 const result=await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 assert.equal(result?.documentId,'doc-1');assert.equal(m.writes,writes);
 assert.deepEqual(trace,['lookupReportPublicationV1','getReportDocumentV1','getReportDocumentV1','lookupReportPublicationV1']);
});
test('0/0 and 0/1 (a pending blank intent) are not published: null, no reads beyond the lookup, no writes',async()=>{
 const f=fixture(),m=new Fake(),trace=traced(m);
 assert.equal(await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),null);
 m.docs.set('intent',blank('intent',promotionIntentName(f.binding.reportRef)));
 assert.equal(await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),null);
 assert.deepEqual(trace,['lookupReportPublicationV1','lookupReportPublicationV1']);assert.equal(m.writes,0);
});
test('2/0, 1/1 and 0/2 are conflicts',async()=>{
 const f=fixture(),m=new Fake();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);const good=m.docs.get('doc-1'),intent=promotionIntentName(f.binding.reportRef);
 m.docs.set('dup',{...structuredClone(good),header:{...good.header,id:'dup'}});
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/ID_CONFLICT/);m.docs.delete('dup');
 m.docs.set('stray',blank('stray',intent));
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/ID_CONFLICT/);
 m.docs.delete('doc-1');m.docs.set('stray2',blank('stray2',intent));
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/ID_CONFLICT/);
});
test('an unverified native capture (head or stamp mismatch) refuses; it is never read as absence',async()=>{
 const f=fixture(),m=new Fake();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);m.lookupFault='unverified';
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/PUBLICATION_LOOKUP_UNVERIFIED/);
});
test('membership is proven per read: an unprovable candidate (producer or reader proof) refuses; an impossible count refuses',async()=>{
 const f=fixture(),m=new Fake();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 m.lookupMemberSkew=-1;await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/LOOKUP_INVALID/);m.lookupMemberSkew=0;
 m.pointFault='unavailable';await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/REPORT_DETAIL_UNAVAILABLE/);m.pointFault='';
 const reader={call:async(name:string,args:Record<string,unknown>)=>{if(name==='getReportDocumentV1')throw Error('REPORT_DETAIL_UNAVAILABLE');return m.call(name,args);}};
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,reader),/REPORT_DETAIL_UNAVAILABLE/);
 assert.equal((await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m))?.documentId,'doc-1');
});
test('a malformed or foreign V1 answer refuses',async()=>{
 const f=fixture(),m=new Fake();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);const call=m.call.bind(m);
 const mutations:((l:any)=>void)[]=[l=>l.driveId='other',l=>l.reportRef='report:other',l=>l.intentName='report-promotion-intent:0',l=>l.schemaVersion='v0',
  l=>l.registeredCount=1.5,l=>l.documents=[],l=>l.documents.push(l.documents[0]),l=>l.documents[0].header.documentType='powerhouse/document-drive',l=>l.memberCount=0];
 for(const mutate of mutations){
  m.call=async(name,args)=>{const v=await call(name,args);if(name==='lookupReportPublicationV1')mutate(v.lookup);return v;};
  await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/LOOKUP_INVALID/);
 }
});
test('the candidate must still carry the reportRef on the authoritative read',async()=>{
 const f=fixture(),m=new Fake();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);const call=m.call.bind(m);
 m.call=async(name,args)=>{const v=await call(name,args);if(name==='getReportDocumentV1')v.read.document.state.global.reportRef='report:moved';return v;};
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/ID_CONFLICT/);
});
test('old 47-file model (no publication stored): Option C still accepts the unique reportRef match via V1',async()=>{
 const f=fixture(),m=new Fake();m.legacyModel=true;await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 assert.equal(Object.hasOwn(m.docs.get('doc-1').state.global,'publication'),false);
 assert.equal((await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m))?.documentId,'doc-1');
});
test('the read-only lookup uses exactly the native lookup and the scoped point proof',async()=>{
 const f=fixture(),m=new Fake();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);const writes=m.writes,seen=new Set<string>();const call=m.call.bind(m);
 m.call=async(name,args)=>{seen.add(name);return call(name,args);};
 await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 assert.deepEqual([...seen].sort(),['getReportDocumentV1','lookupReportPublicationV1']);assert.equal(m.writes,writes);
});
