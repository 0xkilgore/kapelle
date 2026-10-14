import {digest} from './snapshot.mjs';
const fail=()=>{throw Error('SUMMARY_PROJECTION_UNVERIFIED')};
const isText=(v,n,empty=false)=>typeof v==='string'&&v.length<=n&&(empty||v.length>0);
const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function member(r){
 if(!isText(r.documentId,256)||!isText(r.documentType,256)||r.isDeleted!==false)fail();
 if(r.documentType!=='kilgore/report')return {documentId:r.documentId,documentType:r.documentType};
 const m=r.metadata;if(!m||typeof m!=='object'||!['DRAFT','FINAL','SUPERSEDED','WITHDRAWN'].includes(m.lifecycle)||!Number.isSafeInteger(m.revision)||m.revision<0||!isText(m.reportRef,1000,true)||!isText(m.title,4000,true)||![m.projectRef,m.sourceRef].every(v=>v===null||isText(v,2000))||![m.createdAt,m.updatedAt].every(v=>v===null||time(v)))fail();
 if(m.lifecycle==='FINAL'&&(!m.reportRef||!m.title||!time(m.createdAt)||!time(m.updatedAt)||m.revision<1))fail();
 return {documentId:r.documentId,documentType:r.documentType,...m,publishedAt:null};
}
/** Exact 6.2.1 internal schema adapter. Requires existing owner Kysely handle; never constructs a database. */
export function metadataDatabase(database,sql){
 if(!database?.transaction||!sql)throw Error('SUMMARY_OWNER_REQUIRED');
 const base=drive=>sql`SELECT r."targetId" AS "documentId", s."documentType", s."isDeleted", s."lastOperationIndex", s."lastOperationHash", s."snapshotVersion"
 FROM reactor."DocumentRelationship" r LEFT JOIN reactor."DocumentSnapshot" s ON s."documentId"=r."targetId" AND s.branch='main' AND s.scope='global'
 WHERE r."sourceId"=${drive} AND r."relationshipType"='child' ORDER BY r."targetId" LIMIT 3001`;
 async function driveCheck(trx,drive){const q=await sql`SELECT "documentId", "documentType", "isDeleted" FROM reactor."DocumentSnapshot" WHERE "documentId"=${drive} AND branch='main' AND scope='global'`.execute(trx);if(q.rows.length!==1||q.rows[0].documentType!=='powerhouse/document-drive'||q.rows[0].isDeleted!==false)fail();}
 async function transaction(fn,signal){signal.throwIfAborted();const out=await database.transaction().setIsolationLevel('repeatable read').execute(async trx=>{await sql`SET TRANSACTION READ ONLY`.execute(trx);signal.throwIfAborted();const result=await fn(trx);signal.throwIfAborted();return result;});signal.throwIfAborted();return out;}
 return {
  async capture(drive,max,signal){return transaction(async trx=>{
   await driveCheck(trx,drive);const stamps=(await base(drive).execute(trx)).rows;
   if(stamps.length>max||new Set(stamps.map(r=>r.documentId)).size!==stamps.length||stamps.some(r=>r.isDeleted!==false))fail();
   const rows=(await sql`SELECT r."targetId" AS "documentId", s."documentType", s."isDeleted", jsonb_build_object('revision',s.content->'revision','lifecycle',s.content->'lifecycle','reportRef',s.content->'reportRef','title',s.content->'title','projectRef',s.content->'projectRef','sourceRef',s.content->'sourceRef','createdAt',s.content->'createdAt','updatedAt',s.content->'updatedAt') AS metadata
    FROM reactor."DocumentRelationship" r LEFT JOIN reactor."DocumentSnapshot" s ON s."documentId"=r."targetId" AND s.branch='main' AND s.scope='global'
    WHERE r."sourceId"=${drive} AND r."relationshipType"='child' ORDER BY r."targetId" LIMIT 3001`.execute(trx)).rows;
   if(rows.length!==stamps.length)fail();return {members:rows.map(member),stamp:digest(stamps)};
  },signal);},
  async validate(drive,snapshot,signal){return transaction(async trx=>{await driveCheck(trx,drive);const current=(await base(drive).execute(trx)).rows;if(digest(current)!==snapshot.stamp)throw Error('SUMMARY_SNAPSHOT_CHANGED');},signal);}
 };
}
