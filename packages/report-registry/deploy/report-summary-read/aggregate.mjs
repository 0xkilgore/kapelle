import {BOUNDS} from './snapshot.mjs';
const fail=()=>{throw Error('SUMMARY_INCOMPLETE')};
const keys=(v,w)=>v&&typeof v==='object'&&!Array.isArray(v)&&JSON.stringify(Object.keys(v).sort())===JSON.stringify([...w].sort());
const text=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n;
const date=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
export function validateMember(r){
 if(!text(r?.documentId,256)||!text(r.documentType,256))fail();
 if(r.documentType!=='kilgore/report'){if(!keys(r,['documentId','documentType']))fail();return;}
 if(!keys(r,['documentId','documentType','revision','lifecycle','reportRef','title','projectRef','sourceRef','createdAt','updatedAt','publishedAt'])||!Number.isSafeInteger(r.revision)||r.revision<0||!['DRAFT','FINAL','SUPERSEDED','WITHDRAWN'].includes(r.lifecycle)||typeof r.reportRef!=='string'||r.reportRef.length>1000||typeof r.title!=='string'||r.title.length>4000||![r.projectRef,r.sourceRef].every(v=>v===null||text(v,2000))||![r.createdAt,r.updatedAt].every(v=>v===null||date(v))||r.publishedAt!==null)fail();
 if(r.lifecycle==='FINAL'&&(!r.reportRef||!r.title||r.revision<1||!date(r.createdAt)||!date(r.updatedAt)))fail();
}
/** One aggregate per GET, at most 30 internal MCP pages. No body reads or fallback. */
export async function aggregateSummary(call,driveId,{clock=()=>Date.now(),deadlineMs=15000,signal=new AbortController().signal}={}){
 const started=clock(),ids=new Set(),cursors=new Set(),members=[];let first,cursor,offset=0;
 for(let page=0;page<BOUNDS.pages;page++){
  signal.throwIfAborted();const remaining=deadlineMs-(clock()-started);if(remaining<=0)fail();
  const p=await call(cursor?{cursor}:{},Math.min(remaining,5000));signal.throwIfAborted();
  if(!keys(p,['schemaVersion','source','driveId','observationId','observedAt','trust','membership','offset','members','nextCursor','exhausted'])||p.schemaVersion!=='kapelle.report-summary-page.v2'||p.source!=='vetra-report-registry'||p.driveId!==driveId||p.trust!=='fixed-reader-drive-projected'||!text(p.observationId,128)||!date(p.observedAt)||p.offset!==offset||!Array.isArray(p.members)||p.members.length>BOUNDS.page)fail();
  const m=p.membership;
  if(!keys(m,['snapshotId','capturedAt','expiresAt','totalMembers','coverage','consistency','checkpoint','frontierKind','publicationSafe'])||!text(m.snapshotId,128)||!date(m.capturedAt)||!date(m.expiresAt)||p.observedAt!==m.capturedAt||Date.parse(m.expiresAt)<=clock()||Date.parse(m.capturedAt)>clock()+1000||Date.parse(m.expiresAt)-Date.parse(m.capturedAt)>BOUNDS.ttlMs||Date.parse(m.expiresAt)<=Date.parse(m.capturedAt)||!Number.isSafeInteger(m.totalMembers)||m.totalMembers<0||m.totalMembers>BOUNDS.members||m.coverage!=='projected-snapshot'||m.consistency!=='materialized-projection-snapshot'||m.checkpoint!==null||m.frontierKind!=='unavailable'||m.publicationSafe!==false)fail();
  if(!first)first=p;else if(JSON.stringify(m)!==JSON.stringify(first.membership)||p.observationId!==first.observationId||p.observedAt!==first.observedAt)fail();
  for(const r of p.members){validateMember(r);if(ids.has(r.documentId))fail();ids.add(r.documentId);members.push(r);}
  offset+=p.members.length;
  if(offset>m.totalMembers||p.exhausted!==(p.nextCursor===null))fail();
  if(p.exhausted){
   if(offset!==m.totalMembers||clock()-started>=deadlineMs)fail();
   const out={schemaVersion:'kapelle.report-summary-observation.v2',source:p.source,driveId,observationId:p.observationId,observedAt:p.observedAt,trust:p.trust,membership:m,complete:true,rows:members.filter(r=>r.documentType==='kilgore/report'),nonReportMembers:members.filter(r=>r.documentType!=='kilgore/report')};
   if(Buffer.byteLength(JSON.stringify(out))>BOUNDS.responseBytes)fail();return out;
  }
  if(p.members.length!==BOUNDS.page||!/^([a-f0-9]{64})$/.test(p.nextCursor)||cursors.has(p.nextCursor))fail();cursors.add(p.nextCursor);cursor=p.nextCursor;
 }
 fail();
}
