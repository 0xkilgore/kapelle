import {createHash} from 'node:crypto';
import {digest} from './snapshot.mjs';
const fail=()=>{throw Error('REPORT_DETAIL_UNAVAILABLE')};
// Admit only a bounded descriptor for the existing private publication store.
// This does not fetch or authenticate BLOB bytes: the console must independently
// bind its owner-scoped receipt and hash/size-verified object before display.
export function isPrivatePublicationDescriptor(g){
 const c=g?.content, ref=typeof g?.reportRef==='string'&&/^report:publication:([a-f0-9]{64}):([a-f0-9]{64}):v([1-9][0-9]*)$/.exec(g.reportRef);
 return Boolean(ref&&c?.storage==='BLOB'&&['text/markdown','text/csv'].includes(c.mimeType)&&c.markdown===null&&Number.isSafeInteger(c.byteSize)&&c.byteSize>=0&&c.byteSize<=262144&&typeof c.contentHash==='string'&&/^[a-f0-9]{64}$/.test(c.contentHash)&&c.blobRef===`blob:kapelle:${ref[1]}:${c.contentHash}`);
}
export function reportInspection(database,sql,driveId){
 // allowBlank (point reads only): a member whose global scope has no operation yet is accepted ONLY when its projected
 // global state is the initial blank Report (a create intent before REGISTER_REPORT). Detail/review never set it.
 async function inspect(trx,id,body,allowBlank=false){
  const membership=(await sql`SELECT r."targetId" FROM reactor."DocumentRelationship" r WHERE r."sourceId"=${driveId} AND r."targetId"=${id} AND r."relationshipType"='child' LIMIT 2`.execute(trx)).rows;if(membership.length!==1)fail();
  const projections=(await sql`SELECT "documentId",scope,"documentType","isDeleted","lastOperationIndex","lastOperationHash","snapshotVersion" FROM reactor."DocumentSnapshot" WHERE "documentId" IN (${driveId},${id}) AND branch='main' ORDER BY "documentId",scope LIMIT 33`.execute(trx)).rows;
  if(projections.length>32||projections.some(r=>r.isDeleted))fail();
  for(const target of [driveId,id])for(const scope of ['header','document','global','auth','local'])if(projections.filter(r=>r.documentId===target&&r.scope===scope).length!==1)fail();
  if(projections.some(r=>r.documentType!==(r.documentId===id?'kilgore/report':'powerhouse/document-drive')))fail();
  const heads=(await sql`SELECT DISTINCT ON ("documentId",scope) "documentId",scope,"index",hash,error FROM reactor."Operation" WHERE "documentId" IN (${driveId},${id}) AND branch='main' ORDER BY "documentId",scope,"index" DESC LIMIT 33`.execute(trx)).rows;
  if(heads.length>32)fail();
  // A REJECTED head (error set) is accepted when the projection processed exactly that operation (state = last accepted);
  // otherwise one rejected action (e.g. a stale review revision) would make this Report unreadable and unreviewable forever.
  for(const h of heads){const p=projections.find(r=>r.documentId===h.documentId&&r.scope===h.scope);if(!p||p.lastOperationIndex!==h.index||p.lastOperationHash!==h.hash)fail();}
  const registered=heads.some(h=>h.documentId===id&&h.scope==='global');
  if((!registered&&!allowBlank)||!heads.some(h=>h.documentId===driveId&&h.scope==='global'))fail();
  const nodes=(await sql`SELECT COUNT(*)::int AS n FROM reactor."DocumentSnapshot" s, LATERAL jsonb_array_elements(s.content->'nodes') n WHERE s."documentId"=${driveId} AND s.branch='main' AND s.scope='global' AND n->>'id'=${id} AND n->>'kind'='file'`.execute(trx)).rows;if(nodes[0]?.n!==1)fail();
  const identity=(await sql`SELECT content->>'id' AS id, content->>'documentType' AS type, content->>'name' AS name FROM reactor."DocumentSnapshot" WHERE "documentId"=${id} AND branch='main' AND scope='header'`.execute(trx)).rows;
  if(identity.length!==1||identity[0].id!==id||identity[0].type!=='kilgore/report')fail();
  const stamp=digest({projections,heads});if(!body)return {stamp};
  if(body==='point'){
   const rows=(await sql`SELECT content FROM reactor."DocumentSnapshot" WHERE "documentId"=${id} AND branch='main' AND scope='global' AND octet_length(content::text)<=1500000`.execute(trx)).rows;
   if(rows.length!==1||!rows[0].content||typeof rows[0].content!=='object'||typeof identity[0].name!=='string')fail();const g=rows[0].content;
   const blank=g.reportRef===''&&g.revision===0&&g.lifecycle==='DRAFT';
   if(!registered&&!blank)fail();
   return {stamp,global:g,name:identity[0].name,blank};
  }
  if(body==='review'){
   const rows=(await sql`SELECT content->'revision' AS revision, content->>'lifecycle' AS lifecycle FROM reactor."DocumentSnapshot" WHERE "documentId"=${id} AND branch='main' AND scope='global'`.execute(trx)).rows;
   if(rows.length!==1||rows[0].lifecycle!=='FINAL'||!Number.isSafeInteger(rows[0].revision)||rows[0].revision<1)fail();
   return {stamp,...rows[0]};
  }
  // SQL byte bound prevents fetching an oversized selected state into JavaScript.
  const rows=(await sql`SELECT content FROM reactor."DocumentSnapshot" WHERE "documentId"=${id} AND branch='main' AND scope='global' AND octet_length(content::text)<=1500000`.execute(trx)).rows;
  if(rows.length!==1)fail();return {stamp,global:rows[0].content};
 }
 const transaction=fn=>database.transaction().setIsolationLevel('repeatable read').execute(async trx=>{await sql`SET TRANSACTION READ ONLY`.execute(trx);return fn(trx);});
 return {inspect,transaction};
}
export function detailReader(database,sql,driveId){
 const {inspect,transaction}=reportInspection(database,sql,driveId);
 return async(id,signal=new AbortController().signal)=>{
  if(typeof id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)||id===driveId)fail();
  signal.throwIfAborted();const a=await transaction(trx=>inspect(trx,id,true));signal.throwIfAborted();const g=a.global;
  const envelope={schemaVersion:'kapelle.report-detail.v2',source:'vetra-report-registry',driveId,observedAt:new Date().toISOString()};
  let result;
  if(['WITHDRAWN','SUPERSEDED'].includes(g.lifecycle))result={...envelope,availability:g.lifecycle.toLowerCase(),document:null};
  else{
   if(g.lifecycle!=='FINAL'||!Number.isSafeInteger(g.revision)||g.revision<1)fail();
   if(!isPrivatePublicationDescriptor(g)){
    if(g.content?.storage!=='INLINE_MARKDOWN'||typeof g.content.markdown!=='string'||g.content.mimeType!=='text/markdown')fail();
    const b=Buffer.from(g.content.markdown),declared=g.content.contentHash?.replace(/^sha256:/,'');
    if(b.length>1000000||b.length!==g.content.byteSize||createHash('sha256').update(b).digest('hex')!==declared)fail();
   }
   result={...envelope,availability:'available',document:{header:{id,documentType:'kilgore/report'},state:{global:g}}};
   if(Buffer.byteLength(JSON.stringify(result))>2000000)fail();
  }
  const after=await transaction(trx=>inspect(trx,id,false));signal.throwIfAborted();if(after.stamp!==a.stamp)fail();return result;
 };
}

/** Scoped selected-Report read (first slice step 3): fixed-Drive membership and the heads of ONLY the Drive and this document,
 * captured twice (stamp equality), no traversal of unrelated Reports. Lifecycle is returned, not enforced: callers that need a
 * published Report require FINAL themselves; the publisher may read its own blank intent. No reusable grant. */
export function pointReader(database,sql,driveId){
 const {inspect,transaction}=reportInspection(database,sql,driveId);
 return async(id,signal=new AbortController().signal)=>{
  if(typeof id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)||id===driveId)fail();
  signal.throwIfAborted();const a=await transaction(trx=>inspect(trx,id,'point',true));signal.throwIfAborted();
  const b=await transaction(trx=>inspect(trx,id,false,true));signal.throwIfAborted();if(a.stamp!==b.stamp)fail();
  const read={schemaVersion:'kapelle.report-document-read.v1',driveId,documentId:id,stamp:a.stamp,lifecycle:a.global.lifecycle,revision:a.global.revision,blank:a.blank,observedAt:new Date().toISOString(),
   document:{header:{id,name:a.name,documentType:'kilgore/report'},state:{global:a.global}}};
  if(Buffer.byteLength(JSON.stringify(read))>1900000)fail();return read;
 };
}
