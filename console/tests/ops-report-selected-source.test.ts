import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readReportDocumentForBinding} from '../app/ops/_lib/reportRegistryUncached';
const id='00000000-0000-4000-8000-000000002268';
function detail(){const at=new Date().toISOString(),markdown='# Current briefing\n\nVerified synthetic result.';return {schemaVersion:'kapelle.report-detail.v2',source:'vetra-report-registry',availability:'available',driveId:'drive',observedAt:at,document:{header:{id,documentType:'kilgore/report'},state:{global:{reportRef:'report:kapelle:morning-digest:2026-09-30:v1',title:'Current briefing',revision:2,createdAt:at,updatedAt:at,lifecycle:'FINAL',sourceRef:null,projectRef:'kapelle',producer:{kind:'AGENT',id:'synthetic',label:'Synthetic author'},attention:{request:'NONE',resolvedAt:null,reviewBy:null},content:{storage:'INLINE_MARKDOWN',mimeType:'text/markdown',markdown,contentHash:createHash('sha256').update(markdown).digest('hex'),byteSize:Buffer.byteLength(markdown),blobRef:null,filename:'briefing.md'}}}}};}
test('selected report beyond1000 opens with one independent fresh GET, no enumeration or write',async t=>{
 const env={...process.env},f=globalThis.fetch;t.after(()=>{process.env=env;globalThis.fetch=f;});
 Object.assign(process.env,{KAPELLE_REPORT_DETAIL_URL:'http://127.0.0.1:14250/v2/reports',KAPELLE_REPORT_REGISTRY_MCP_TOKEN:'x'.repeat(40),KAPELLE_REPORT_REGISTRY_DRIVE_ID:'drive'});
 let calls=0;globalThis.fetch=async(url,init)=>{calls++;assert.equal(String(url),`http://127.0.0.1:14250/v2/reports/${id}`);assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);return new Response(JSON.stringify(detail()),{headers:{'content-type':'application/json'}});};
 assert.equal((await readReportDocumentForBinding(id)).availability,'authoritative');assert.equal(calls,1);
 for(const fault of ['revoked','removed','lifecycle','identity','hash','size','drive','stale','oversize','blob']){
  globalThis.fetch=async()=>{calls++;const d=detail(),g=d.document.state.global;
   if(fault==='revoked'||fault==='removed')return new Response('{}',{status:fault==='revoked'?403:404});
   if(fault==='lifecycle')g.lifecycle='WITHDRAWN';if(fault==='identity')d.document.header.id='other';if(fault==='hash')g.content.markdown+='altered';if(fault==='size')g.content.byteSize++;if(fault==='drive')d.driveId='other';if(fault==='stale')d.observedAt='2026-01-01T00:00:00.000Z';if(fault==='blob')g.content.storage='BLOB';
   return new Response(JSON.stringify(d),{headers:{'content-type':'application/json',...(fault==='oversize'?{'content-length':'2000001'}:{})}});
  };
  assert.equal((await readReportDocumentForBinding(id)).availability,'unavailable',fault);
 }
 assert.equal(calls,11); // Each failure is one read, never a fallback or retry.
});

test('only bounded private publication descriptors reach the separate verified body reader',async t=>{
 const env={...process.env},f=globalThis.fetch;t.after(()=>{process.env=env;globalThis.fetch=f;});
 Object.assign(process.env,{KAPELLE_REPORT_DETAIL_URL:'http://127.0.0.1:14250/v2/reports',KAPELLE_REPORT_REGISTRY_MCP_TOKEN:'x'.repeat(40),KAPELLE_REPORT_REGISTRY_DRIVE_ID:'drive'});
 let calls=0;
 for(const fault of ['none','csv','namespace','scope','hash','bytes','mime','inline','remote','lifecycle']){
  globalThis.fetch=async()=>{calls++;const d=detail(),g=d.document.state.global,c=g.content as any;
   g.reportRef='report:publication:'+('a'.repeat(64))+':'+('b'.repeat(64))+':v1';
   c.storage='BLOB';c.markdown=null;c.contentHash='c'.repeat(64);c.byteSize=1024;c.blobRef='blob:kapelle:'+('a'.repeat(64))+':'+c.contentHash;
   if(fault==='csv')c.mimeType='text/csv';if(fault==='namespace')g.reportRef='report:other';if(fault==='scope')c.blobRef='blob:kapelle:'+('d'.repeat(64))+':'+c.contentHash;
   if(fault==='hash')c.contentHash='bad';if(fault==='bytes')c.byteSize=262145;if(fault==='mime')c.mimeType='text/html';if(fault==='inline')c.markdown='unverified bytes';if(fault==='remote')c.blobRef='https://example.invalid/private';if(fault==='lifecycle')g.lifecycle='WITHDRAWN';
   return Response.json(d);
  };
  assert.equal((await readReportDocumentForBinding(id)).availability,['none','csv'].includes(fault)?'authoritative':'unavailable',fault);
 }
 assert.equal(calls,10,'one selected read each; no external blob fetch or library scan');
});

test('one bounded retry on a transient 503 (busy or projection budget), then fail closed; nothing else is retried',async t=>{
 const env={...process.env},f=globalThis.fetch,now=Date.now;t.after(()=>{process.env=env;globalThis.fetch=f;Date.now=now;});
 Object.assign(process.env,{KAPELLE_REPORT_DETAIL_URL:'http://127.0.0.1:14250/v2/reports',KAPELLE_REPORT_REGISTRY_MCP_TOKEN:'x'.repeat(40),KAPELLE_REPORT_REGISTRY_DRIVE_ID:'drive'});
 const refusal=(error:string|null,status=503)=>new Response(error===null?'':JSON.stringify({error}),{status,headers:{'content-type':'application/json'}});
 const run=async(answers:(()=>Response)[])=>{let calls=0;globalThis.fetch=async(_u,init)=>{assert.equal(init?.method,'GET');return answers[Math.min(calls++,answers.length-1)]();};
  const read=await readReportDocumentForBinding(id);return {state:read.availability,calls};};
 const ok=()=>Response.json(detail());
 // A transient refusal, then a good read: the Report opens with exactly two GETs.
 for(const code of ['report_projection_unavailable','reader_busy'])assert.deepEqual(await run([()=>refusal(code),ok]),{state:'authoritative',calls:2},code);
 // Two transient refusals: fail closed after exactly one retry.
 assert.deepEqual(await run([()=>refusal('report_projection_unavailable')]),{state:'unavailable',calls:2});
 // Other refusals are not retried: other 503 codes, an empty 503, and non-503 statuses.
 for(const [code,status] of [['listing_suspended',503],[null,503],['report_projection_unavailable',502],['upstream_unavailable',502],['forbidden_document',403],['unauthorized',401]] as const)
  assert.deepEqual(await run([()=>refusal(code,status),ok]),{state:'unavailable',calls:1},`${code} ${status}`);
 // A refusal that arrives late in the 6 s budget (the proxy's 5 s Reactor budget) leaves no room for a real attempt: no retry.
 let calls=0;globalThis.fetch=async()=>{calls++;Date.now=()=>now()+4800;return refusal('report_projection_unavailable');};
 assert.equal((await readReportDocumentForBinding(id)).availability,'unavailable');assert.equal(calls,1);Date.now=now;
});

test('a caller abort during the retry backoff fails closed without a second GET',async t=>{
 const env={...process.env},f=globalThis.fetch;t.after(()=>{process.env=env;globalThis.fetch=f;});
 Object.assign(process.env,{KAPELLE_REPORT_DETAIL_URL:'http://127.0.0.1:14250/v2/reports',KAPELLE_REPORT_REGISTRY_MCP_TOKEN:'x'.repeat(40),KAPELLE_REPORT_REGISTRY_DRIVE_ID:'drive'});
 const caller=new AbortController();let calls=0;
 globalThis.fetch=async()=>{calls++;setTimeout(()=>caller.abort(),20);return Response.json({error:'reader_busy'},{status:503});};
 assert.equal((await readReportDocumentForBinding(id,caller.signal)).availability,'unavailable');assert.equal(calls,1);
});
