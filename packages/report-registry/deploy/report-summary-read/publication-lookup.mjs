import {createHash} from 'node:crypto';
import {digest} from './snapshot.mjs';
const fail=()=>{throw Error('PUBLICATION_LOOKUP_UNVERIFIED')};
/** Fixed native owner database; unlike discovery summaries every member's applied
 * projection is checked against its native operation head before identity absence
 * is returned. Only the matching body is fetched. No reusable mutation grant. */
export function publicationLookup(database,sql,driveId){
 const tx=fn=>database.transaction().setIsolationLevel('repeatable read').execute(async trx=>{await sql`SET TRANSACTION READ ONLY`.execute(trx);return fn(trx);});
 async function capture(trx,reportRef,intentName,body){
  const drives=(await sql`SELECT content->'nodes' AS nodes FROM reactor."DocumentSnapshot" WHERE "documentId"=${driveId} AND branch='main' AND scope='global' AND octet_length((content->'nodes')::text)<=2000000`.execute(trx)).rows;
  const nodes=drives[0]?.nodes;if(drives.length!==1||!Array.isArray(nodes)||nodes.length>3000)fail();
  if(nodes.some(n=>!n||typeof n.id!=='string'||!n.id||!['file','folder'].includes(n.kind))||new Set(nodes.map(n=>n.id)).size!==nodes.length)fail();
  const files=nodes.filter(n=>n.kind==='file');if(files.some(n=>typeof n.documentType!=='string'))fail();
  const edges=(await sql`SELECT "targetId" FROM reactor."DocumentRelationship" WHERE "sourceId"=${driveId} AND "relationshipType"='child' ORDER BY "targetId" LIMIT 3001`.execute(trx)).rows;
  if(edges.length!==files.length||new Set(edges.map(r=>r.targetId)).size!==files.length||edges.some(r=>!files.some(n=>n.id===r.targetId)))fail();
  const ids=[driveId,...files.map(n=>n.id)].sort();if(new Set(ids).size!==ids.length)fail();
  const projections=(await sql`SELECT "documentId",scope,"documentType","isDeleted","lastOperationIndex","lastOperationHash","snapshotVersion", CASE WHEN scope='header' THEN jsonb_build_object('id',content->>'id','name',content->>'name','type',content->>'documentType') WHEN scope='global' AND "documentType"='kilgore/report' THEN jsonb_build_object('reportRef',content->>'reportRef','revision',content->'revision','lifecycle',content->>'lifecycle') ELSE NULL END AS identity FROM reactor."DocumentSnapshot" WHERE "documentId" IN (${sql.join(ids)}) AND branch='main' ORDER BY "documentId",scope LIMIT 15006`.execute(trx)).rows;
  if(projections.length!==ids.length*5)fail();
  const heads=(await sql`SELECT DISTINCT ON ("documentId",scope) "documentId",scope,"index",hash,error FROM reactor."Operation" WHERE "documentId" IN (${sql.join(ids)}) AND branch='main' ORDER BY "documentId",scope,"index" DESC LIMIT 15006`.execute(trx)).rows;
  const byId=new Map();for(const p of projections){if(!byId.has(p.documentId))byId.set(p.documentId,new Map());const scopes=byId.get(p.documentId);if(scopes.has(p.scope)||p.isDeleted!==false)fail();scopes.set(p.scope,p);}
  const globalHeads=new Set();for(const h of heads){const p=byId.get(h.documentId)?.get(h.scope);/* A head the reducer REJECTED (error set) is accepted when the projection has processed exactly that operation: the
    rejection left the last accepted state in place. A stale/missing projection still fails. */if(!p||p.lastOperationIndex!==h.index||p.lastOperationHash!==h.hash)fail();if(h.scope==='global')globalHeads.add(h.documentId);}
  const registered=[],pending=[];
  for(const id of ids){const scopes=byId.get(id);if(!scopes||['header','document','global','auth','local'].some(s=>!scopes.has(s)))fail();const type=id===driveId?'powerhouse/document-drive':files.find(n=>n.id===id).documentType;
   if([...scopes.values()].some(p=>p.documentType!==type))fail();const header=scopes.get('header').identity;
   if(header?.id!==id||header.type!==type||typeof header.name!=='string')fail();
   // An empty Drive created with no operations has no global head: accepted only as a proof of EMPTY membership.
   if(id===driveId){if(!globalHeads.has(id)&&(files.length!==0||edges.length!==0||nodes.length!==0))fail();continue;}
   if(type!=='kilgore/report')continue;
   const g=scopes.get('global').identity;if(!g||typeof g.reportRef!=='string'||g.reportRef.length>1000||!Number.isSafeInteger(g.revision)||g.revision<0)fail();
   if(!globalHeads.has(id)&&(g.reportRef!==''||g.revision!==0||g.lifecycle!=='DRAFT'))fail();
   if(g.reportRef===reportRef)registered.push(id);
   if(!g.reportRef&&header.name===intentName)pending.push(id);
  }
  const stamp=digest({nodes,edges,projections,heads});const documents=[];
  const selected=registered.length===1?registered:registered.length===0&&pending.length===1?pending:[];
  if(body)for(const id of selected){const rows=(await sql`SELECT content FROM reactor."DocumentSnapshot" WHERE "documentId"=${id} AND branch='main' AND scope='global' AND octet_length(content::text)<=1500000`.execute(trx)).rows;if(rows.length!==1)fail();const header=byId.get(id).get('header').identity;documents.push({header:{id,name:header.name,documentType:header.type},state:{global:rows[0].content}});}
  return {stamp,registeredCount:registered.length,pendingCount:pending.length,memberCount:files.length,documents};
 }
 return async(reportRef,signal=new AbortController().signal)=>{
  if(typeof reportRef!=='string'||!reportRef.trim()||reportRef.length>1000||reportRef.includes('\0'))fail();
  const intentName='report-promotion-intent:'+createHash('sha256').update(reportRef).digest('hex').slice(0,20);
  signal.throwIfAborted();const a=await tx(trx=>capture(trx,reportRef,intentName,true));signal.throwIfAborted();const b=await tx(trx=>capture(trx,reportRef,intentName,false));signal.throwIfAborted();if(a.stamp!==b.stamp)fail();
  const out={schemaVersion:'kapelle.publication-lookup.v1',driveId,reportRef,intentName,observedAt:new Date().toISOString(),registeredCount:a.registeredCount,pendingCount:a.pendingCount,memberCount:a.memberCount,documents:a.documents};if(Buffer.byteLength(JSON.stringify(out))>1900000)fail();return out;
 };
}
