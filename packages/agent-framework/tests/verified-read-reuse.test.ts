// Step 1 (single-machine first slice): bounded reuse of a SUCCESSFUL full Report verification for status/facts reads.
// Observed live: every Task-page status read re-ran a ~80 s Registry lookup and the console aborted at 20 s. Fail-closed matrix below.
import {it,expect} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {digest} from '../src/content.js';
import {independentlyVerifiedReports,VERIFIED_READ_REUSE_MS} from '../src/task-delegation/runtime.js';
const hex=(s:string)=>createHash('sha256').update(s).digest('hex');
function world(){
 const dispatchId=randomUUID(),inputHash=digest('input'),publicationId='task-report:'+digest({dispatchId,inputHash}).slice(7),markdown='# Report\nbody\n';
 const instanceId='instance-1',driveId='drive',documentId=randomUUID(),planDigest=hex('plan');
 const agent={id:instanceId,label:'Author',instanceId,definitionId:'def',definitionVersion:'1',definitionHash:hex('def')};
 const evidence={documentId,driveId,reportRef:'report:task:'+publicationId.slice(12),sourceRef:'dispatch:'+dispatchId,producerId:instanceId,revision:1,
  publication:{publicationId,author:agent,publisher:{id:'service:pub',label:'Publisher',instanceId:null,definitionId:null,definitionVersion:null,definitionHash:null},
   runRef:`kapelle-task://dispatch/${dispatchId}?input=${inputHash.slice(7)}`,sourceRef:'dispatch:'+dispatchId,provenanceRef:`kapelle-task://execution/${hex('exec')}?packet=${hex('packet')}`,
   contentHash:hex(markdown),contentVersion:1,authorizationRef:'auth:ref',publishedAt:'2026-10-14T01:11:29.357Z'},
  markdown,planDigest,verificationRef:'private-report:'+hex(JSON.stringify({driveId,documentId,planDigest})),scope:{ownerId:'owner',scopeRef:'scope',driveId,admissionRef:'binding'}};
 const receipt={publicationId,dispatchId,inputHash,reportId:documentId,contentVersion:1,contentHash:'sha256:'+hex(markdown),verificationRef:evidence.verificationRef};
 let reads=0,fail=false,probes=0,probeFail=false;let now=1_000_000;
 const doc={header:{id:documentId,documentType:'kilgore/report'},state:{global:{lifecycle:'FINAL',sourceRef:'dispatch:'+dispatchId,content:{storage:'INLINE_MARKDOWN',markdown,contentHash:hex(markdown),byteSize:Buffer.byteLength(markdown)}}}};
 let probeDoc:any=doc;
 const port={bindingRef:'binding',admitted:async()=>true,publish:async()=>evidence,lookup:async()=>evidence,read:async()=>{reads++;if(fail)throw Error('registry unavailable');return structuredClone(evidence);}};
 const probe=async()=>{probes++;if(probeFail)throw Error('reader unavailable');return {document:structuredClone(probeDoc)};};
 const v=independentlyVerifiedReports(port as any,'owner','scope',instanceId,{clock:()=>now,probe});
 const noProbe=independentlyVerifiedReports(port as any,'owner','scope',instanceId,{clock:()=>now});
 return {v,noProbe,receipt,evidence,doc,reads:()=>reads,probes:()=>probes,setFail:(x:boolean)=>{fail=x;},setProbeFail:(x:boolean)=>{probeFail=x;},setProbeDoc:(d:any)=>{probeDoc=d;},advance:(ms:number)=>{now+=ms;}};
}
it('a successful full read is reused by status reads within the window: one reader probe, no second full lookup',async()=>{
 const w=world();await w.v.reports.read(w.receipt);expect(w.reads()).toBe(1);
 const r=await w.v.reports.readVerified!(w.receipt);expect(w.reads()).toBe(1);expect(r.bytes.toString()).toBe(w.evidence.markdown);
 expect(w.probes()).toBe(1);r.bytes[0]=0;expect((await w.v.reports.readVerified!(w.receipt)).bytes.toString()).toBe(w.evidence.markdown); // returned copies can't poison the cache
 expect((await w.v.facts()).length).toBe(1);expect(w.reads()).toBe(1);
});
it('the window is bounded: after it expires a status read does a full read again',async()=>{
 const w=world();await w.v.reports.read(w.receipt);w.advance(VERIFIED_READ_REUSE_MS);await w.v.reports.readVerified!(w.receipt);expect(w.reads()).toBe(2);
});
it('fail-closed: a failed read evicts; status reads then fail (no stale success) and facts grant nothing',async()=>{
 const w=world();await w.v.reports.read(w.receipt);w.setFail(true);
 await expect(w.v.reports.read(w.receipt)).rejects.toThrow();
 await expect(w.v.reports.readVerified!(w.receipt)).rejects.toThrow();expect(await w.v.facts()).toEqual([]);
 w.setFail(false);expect((await w.v.facts()).length).toBe(1);
});
it('fail-closed: a different receipt (changed hash/version/verificationRef) never hits the cache',async()=>{
 const w=world();await w.v.reports.read(w.receipt);
 for(const change of [{contentHash:'sha256:'+'f'.repeat(64)},{contentVersion:2},{verificationRef:'private-report:'+'0'.repeat(64)}]){
  const before=w.reads();await expect(w.v.reports.readVerified!({...w.receipt,...change})).rejects.toThrow();expect(w.reads()).toBe(before+1);
 }
});
it('no prior success → readVerified performs a full read; a clock going backwards is not reuse',async()=>{
 const w=world();await w.v.reports.readVerified!(w.receipt);expect(w.reads()).toBe(1);
 w.advance(-1);await w.v.reports.readVerified!(w.receipt);expect(w.reads()).toBe(2);
});
it('facts() reuses within the window and stops granting the fact once the Report becomes unreadable after expiry',async()=>{
 const w=world();await w.v.reports.read(w.receipt);expect((await w.v.facts()).length).toBe(1);expect(w.reads()).toBe(1);
 w.advance(VERIFIED_READ_REUSE_MS+1);w.setFail(true);expect(await w.v.facts()).toEqual([]);
});
it('no probe configured: every status read is a full read (old behaviour)',async()=>{
 const w=world();await w.noProbe.reports.read(w.receipt);await w.noProbe.reports.readVerified!(w.receipt);await w.noProbe.facts();expect(w.reads()).toBe(3);
});
it('fail-closed: a failing probe never reuses; the full read decides (reader/Registry down -> refused, no fact)',async()=>{
 const w=world();await w.v.reports.read(w.receipt);w.setProbeFail(true);w.setFail(true);
 await expect(w.v.reports.readVerified!(w.receipt)).rejects.toThrow('registry unavailable');expect(await w.v.facts()).toEqual([]);
 w.setFail(false);const before=w.reads();await w.v.reports.readVerified!(w.receipt);expect(w.reads()).toBe(before+1); // probe still failing: full read again
 w.setProbeFail(false);const after=w.reads();await w.v.reports.readVerified!(w.receipt);expect(w.reads()).toBe(after); // probe back: reuse resumes
});
it.each([
 ['changed bytes',(d:any)=>{d.state.global.content.markdown='# tampered\n';}],
 ['stale hash',(d:any)=>{d.state.global.content.contentHash='0'.repeat(64);}],
 ['wrong size',(d:any)=>{d.state.global.content.byteSize=1;}],
 ['withdrawn',(d:any)=>{d.state.global.lifecycle='WITHDRAWN';}],
 ['other sourceRef',(d:any)=>{d.state.global.sourceRef='dispatch:other';}],
 ['other document',(d:any)=>{d.header.id='other';}],
 ['other type',(d:any)=>{d.header.documentType='kapelle/other';}],
 ['blob storage',(d:any)=>{d.state.global.content.storage='BLOB';}],
])('fail-closed: a probe showing %s is never reused; the full read decides',async(_n,mutate)=>{
 const w=world();await w.v.reports.read(w.receipt);const d=structuredClone(w.doc);mutate(d);w.setProbeDoc(d);
 const before=w.reads();await w.v.reports.readVerified!(w.receipt);expect(w.reads()).toBe(before+1);
 w.setFail(true);await expect(w.v.reports.readVerified!(w.receipt)).rejects.toThrow('registry unavailable');expect(await w.v.facts()).toEqual([]);
});
it('the verified-read wrapper forwards publishReady and omits it when the publisher has no publish gate',async()=>{
 let calls=0;const base={bindingRef:'binding',admitted:async()=>true,publish:async()=>null,lookup:async()=>null,read:async()=>null};
 const gated=independentlyVerifiedReports({...base,publishReady:async()=>{calls++;throw Error('PRIVATE_PUBLICATION_MODEL_DEPLOYMENT_MISMATCH');}} as any,'owner','scope','instance-1');
 expect(typeof gated.reports.publishReady).toBe('function');
 await expect(gated.reports.publishReady!()).rejects.toThrow('MODEL_DEPLOYMENT_MISMATCH');expect(calls).toBe(1);
 expect(independentlyVerifiedReports(base as any,'owner','scope','instance-1').reports.publishReady).toBeUndefined();
});
