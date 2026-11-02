import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {loadPromotionRequest,buildPromotionRequestPlan,promotePromotionRequest} from '../src/promotion-request.ts';
import {lookupPrivateRequest,publishPrivateRequest,parsePrivateBinding,CompletePrivateReportMcp,assertNativeModelAdmission,modelInventoryDigest} from '../src/private-publication.ts';
import type {ReportRegistryMcp} from '../src/mcp-client.ts';
import {Fake,fixture} from './fixtures/private-publication.ts';
test('private publication preserves metadata and exact bytes; same request returns same receipt and URL',async()=>{
 const f=fixture(),m=new Fake();const first=await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);const again=await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);assert.equal(m.docs.size,1);assert.deepEqual(first.receipt,again.receipt);assert.equal(first.libraryUrl,'https://private.example/ops/library/doc-1');assert.equal(first.verifiedRevision,2);assert.deepEqual(JSON.parse(readFileSync(first.receipt.receiptPath,'utf8')).publication,f.admitted.request.publication);
});
test('new private publication uses six fresh metadata calls and only selected Report bodies',async()=>{
 const f=fixture(),m=new Fake(),trace:Array<{name:string,args:Record<string,unknown>}>=[];
 const call=m.call.bind(m);m.call=async(name,args)=>{trace.push({name,args});return call(name,args);};
 await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 assert.equal(trace.filter(x=>x.name==='getReportIdentities').length,1);
 assert.equal(trace.filter(x=>x.name==='getDocuments').length,5);
 const reads=trace.filter(x=>x.name==='getDocument');assert.equal(reads.length,3);
 assert.ok(reads.every(x=>x.args.id==='doc-1'));
});
for(const fault of ['create','register','actions'])test('lost '+fault+' response recovers one native report',async()=>{
 const f=fixture(),m=new Fake();m.fault=fault;await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/lost/);const recovered=await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);assert.equal(m.docs.size,1);assert.equal(recovered.receipt.documentId,'doc-1');assert.equal(recovered.verifiedRevision,2);
});
test('truncated listing blocks before any native mutation',async()=>{const f=fixture(),m=new Fake();m.docs.set('hidden',{header:{id:'hidden'},state:{global:{}}});m.incomplete=true;await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/LIST_INCOMPLETE/);assert.equal(m.writes,0);});
test('caller cannot claim another publisher or bypass runtime binding',async()=>{const f=fixture(),m=new Fake();const changed=structuredClone(f.admitted);changed.request.publication!.publisher.id='imposter';await assert.rejects(publishPrivateRequest(changed,f.runtime,f.binding,m,m),/AUTHORITY_MISMATCH/);await assert.rejects(promotePromotionRequest(f.admitted,f.runtime,m),/BINDING_REQUIRED/);assert.equal(m.calls,0);});
test('exact markdown readback catches corrupted bytes with unchanged claimed hash',async()=>{const f=fixture(),m=new Fake();m.corrupt=true;await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/content.markdown/);assert.equal(m.docs.size,1);m.corrupt=false;const result=await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);assert.equal(result.receipt.documentId,'doc-1');assert.equal(m.docs.size,1);});
test('native membership changes before create prevent mutation',async()=>{const m=new Fake(),g=new CompletePrivateReportMcp(m,'drive');await g.call('getDocuments',{parentId:'drive'});m.docs.set('external',{});await assert.rejects(g.call('createDocument',{driveId:'drive',documentType:'kilgore/report',name:'test'}),/MEMBERSHIP_CHANGED/);assert.equal(m.writes,0);});
test('lost create hidden by eventual membership cannot trigger a second create',async()=>{const f=fixture(),m=new Fake();m.fault='create';await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/lost/);const saved=new Map(m.docs);m.docs.clear();await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/CREATE_UNCERTAIN/);assert.equal(m.writes,1);m.docs=saved;const result=await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);assert.equal(result.receipt.documentId,'doc-1');assert.equal(m.docs.size,1);});
test('changed plan cannot reuse a pending create identity',async()=>{const f=fixture(),m=new Fake();m.fault='create';await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/lost/);f.admitted.request.title='Changed report';f.runtime.planDigest=buildPromotionRequestPlan(f.admitted).planDigest;await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/INTENT_CONFLICT/);assert.equal(m.writes,1);});
test('independently truncated reader blocks before writes even with complete producer',async()=>{const f=fixture(),m=new Fake();m.docs.set('existing',{header:{id:'existing',name:'Other',documentType:'kilgore/report'},state:{global:{}}});const reader={call:async(name:string,args:Record<string,unknown>)=>name==='getDocuments'?{documentIds:[]}:m.call(name,args)};await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,reader),/READER_INCOMPLETE|LIST_INCOMPLETE/);assert.equal(m.writes,0);});
test('publicationId cannot be reused under another reportRef',async()=>{const f=fixture(),m=new Fake();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);f.admitted.request.reportRef='report:test:other';f.binding.reportRef=f.admitted.request.reportRef;f.runtime.planDigest=buildPromotionRequestPlan(f.admitted).planDigest;const before=m.writes;await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/PUBLICATION_ID_CONFLICT/);assert.equal(m.writes,before);assert.equal(m.docs.size,1);});

test('two blank intents with distinct reportRefs serialize the same publicationId before scanning',async()=>{
 const f=fixture(),m=new Fake();
 const other={...f.admitted,request:structuredClone(f.admitted.request)};other.request.reportRef='report:test:private:other';
 const otherRuntime={...f.runtime,planDigest:buildPromotionRequestPlan(other).planDigest,publicationBinding:{...f.binding,reportRef:other.request.reportRef}};
 for(const [id,ref] of [['blank-1',f.admitted.request.reportRef],['blank-2',other.request.reportRef]]){
  m.docs.set(id,{header:{id,name:'report-promotion-intent:'+createHash('sha256').update(ref).digest('hex').slice(0,20),documentType:'kilgore/report'},state:{global:{}}});
 }
 let enter!:()=>void,release!:()=>void;
 const entered=new Promise<void>(r=>enter=r),barrier=new Promise<void>(r=>release=r);
 const call=m.call.bind(m);let scans=0;
 m.call=async(name,args)=>{if(name==='getReportIdentities'&&++scans===1){enter();await barrier;}return call(name,args);};
 const first=promotePromotionRequest(f.admitted,{...f.runtime,publicationBinding:f.binding},m);
 await entered;
 try {
  await assert.rejects(promotePromotionRequest(other,otherRuntime,m),/PROMOTION_LOCKED/);
  assert.equal(scans,1);assert.equal(m.writes,0);
 }finally{release();}
 await first;
 await assert.rejects(promotePromotionRequest(other,otherRuntime,m),/PUBLICATION_ID_CONFLICT/);
 assert.equal([...m.docs.values()].filter(d=>d.state.global.publication).length,1);
 assert.equal(m.docs.size,2);
});

test('model admission requires the exact composed runtime inventory, not schema alone',()=>{
 const inventory=JSON.parse(readFileSync(new URL('../deploy/report-listing-runtime/model-inventory.json',import.meta.url),'utf8'));
 const nativeSchemaHash=createHash('sha256').update(readFileSync(new URL('../document-models/report-registry/v1/schema.graphql',import.meta.url))).digest('hex');
 const now=new Date('2026-10-14T00:00:00.000Z');
 const admission={schemaVersion:'kapelle.report-publication-model-admission.v2',status:'QUALIFIED_LIVE',endpoint:'http://127.0.0.1:14250/mcp',driveId:'drive',nativeSchemaHash,releaseReceiptRef:'fixture://qualified-runtime',runtimeInventory:inventory,
  deployment:{releaseId:'fixture-release',modelDigest:modelInventoryDigest(inventory)},validUntil:'2026-10-20T00:00:00.000Z'};
 assert.deepEqual(assertNativeModelAdmission(admission,admission.endpoint,'drive',now),{releaseId:'fixture-release',modelDigest:modelInventoryDigest(inventory)});
 // v1 (no deployment binding) is refused: a record's own claims are not enough.
 assert.throws(()=>assertNativeModelAdmission({...admission,schemaVersion:'kapelle.report-publication-model-admission.v1'},admission.endpoint,'drive',now),/MODEL_NOT_ADMITTED/);
 assert.throws(()=>assertNativeModelAdmission({...admission,deployment:{releaseId:'fixture-release',modelDigest:'0'.repeat(64)}},admission.endpoint,'drive',now),/DEPLOYMENT_NOT_ADMITTED/);
 assert.throws(()=>assertNativeModelAdmission({...admission,deployment:{modelDigest:modelInventoryDigest(inventory)}},admission.endpoint,'drive',now),/DEPLOYMENT_NOT_ADMITTED/);
 for(const validUntil of ['2026-10-13T00:00:00.000Z','2026-12-31T00:00:00.000Z','soon',undefined])
  assert.throws(()=>assertNativeModelAdmission({...admission,validUntil},admission.endpoint,'drive',now),/ADMISSION_EXPIRED/);
 assert.throws(()=>assertNativeModelAdmission({...admission,runtimeInventory:{}},admission.endpoint,'drive',now),/INVENTORY_NOT_ADMITTED/);
 const changed={...inventory,'v1/src/reducers/attention.ts':'0'.repeat(64)};
 assert.throws(()=>assertNativeModelAdmission({...admission,runtimeInventory:changed},admission.endpoint,'drive',now),/INVENTORY_NOT_ADMITTED/);
});

for(const fault of ['create','register','actions'])test('read-only lookup after lost '+fault+' reply never reconciles by writing',async()=>{
 const f=fixture(),m=new Fake();m.fault=fault;
 await assert.rejects(publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/lost/);
 const writes=m.writes;
 const result=await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 assert.equal(result?.documentId??null,fault==='create'?null:'doc-1');
 assert.deepEqual(await lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),result);
 assert.equal(m.writes,writes);
 if(result){assert.equal(result.publication.contentVersion,1);assert.equal(result.revision,fault==='register'?1:2);}
});
test('lookup refuses conflicting metadata, duplicate identities and independent readback loss without writes',async()=>{
 const f=fixture(),m=new Fake();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);const writes=m.writes;
 const good=structuredClone(m.docs.get('doc-1'));
 for(const mutate of [(d:any)=>d.state.global.publication.contentVersion++, (d:any)=>d.state.global.content.markdown='wrong', (d:any)=>d.state.global.producer.id='other']){
  const d=structuredClone(good);mutate(d);m.docs.set('doc-1',d);
  await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/CONFLICT/);
 }
 m.docs.set('doc-1',good);m.docs.set('duplicate',{...good,header:{...good.header,id:'duplicate'}});
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/ID_CONFLICT/);m.docs.delete('duplicate');
 const reader={call:async(name:string,args:Record<string,unknown>)=>{const r=await m.call(name,args);if(name==='getReportDocumentV1')r.read.document.state.global.content.markdown='reader mismatch';return r;}};
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,reader),/READER_READBACK_MISMATCH/);
 // Lookup no longer lists; an unprovable selected read (the scoped proof) is what must refuse now.
 m.pointFault='unavailable';await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,m),/REPORT_DETAIL_UNAVAILABLE/);m.pointFault='';
 assert.equal(m.writes,writes);
});
test('lookup refuses a competing registration that changes identities without changing membership',async()=>{
 const f=fixture(),m=new Fake();await publishPrivateRequest(f.admitted,f.runtime,f.binding,m,m);
 m.docs.set('blank',{header:{id:'blank',name:'Blank',documentType:'kilgore/report'},state:{global:{}}});
 const call=m.call.bind(m),writes=m.writes;let changed=false;
 const reader={call:async(name:string,args:Record<string,unknown>)=>{const value=await call(name,args);if(name==='getReportDocumentV1'&&!changed){changed=true;const other=structuredClone(m.docs.get('doc-1'));other.header.id='blank';m.docs.set('blank',other);}return value;}};
 await assert.rejects(lookupPrivateRequest(f.admitted,f.runtime,f.binding,m,reader),/IDENTITIES_CHANGED/);assert.equal(m.writes,writes);
});
