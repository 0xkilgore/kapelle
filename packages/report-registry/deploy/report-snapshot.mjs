import {createHash} from 'node:crypto';

export const REPORT_DRIVE_ID = '00000000-0000-4000-8000-000000000001';
export const SNAPSHOT_SCHEMA = 'kapelle.report-drive-snapshot.v1';
export const SNAPSHOT_MAX_BYTES = 2_000_000;
export const SNAPSHOT_TIMEOUT_MS = 6_000;

// One MVCC statement on Reactor's existing Kysely connection. No DB owner,
// migration, cursor, caller SQL, body hydration or cross-request scope cache.
// Raw SQL needs explicit schema qualification. jsonb_to_record decomposes the
// stored global/content objects once, without coercing their saved JSON types.
export const SNAPSHOT_SQL = `WITH
drive AS MATERIALIZED (SELECT * FROM "reactor"."DocumentSnapshot" WHERE "documentId"=$1 AND branch='main' AND scope='global' AND NOT "isDeleted"),
nodes AS MATERIALIZED (SELECT n FROM drive, jsonb_array_elements(content->'nodes') n LIMIT 10001),
members AS MATERIALIZED (SELECT n->>'id' AS id FROM nodes WHERE n->>'kind'='file'),
ids AS MATERIALIZED (SELECT id FROM members UNION SELECT $1),
snaps AS MATERIALIZED (SELECT s.id,s."documentId",s.scope,s."documentType",s."isDeleted",s."lastOperationIndex",s."lastOperationHash",s."snapshotVersion",
 CASE WHEN s.scope='header' THEN jsonb_build_object('id',s.content->'id','name',s.content->'name')
 WHEN s.scope='global' AND s."documentId"<>$1 THEN jsonb_build_object(
 '_shape',s.content ?& ARRAY['reportRef','title','revision','producer','content','lifecycle','updatedAt'],'reportRef',r."reportRef",'title',r.title,'projectRef',r."projectRef",'familyRef',r."familyRef",'sourceRef',r."sourceRef",'revision',r.revision,'producer',r.producer,'lifecycle',r.lifecycle,'updatedAt',r."updatedAt",'supersedesRef',r."supersedesRef",'supersededByRef',r."supersededByRef",'publication',r.publication,
 'content',CASE WHEN r.content IS NULL OR r.content='null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object('storage',c.storage,'contentHash',c."contentHash",'byteSize',c."byteSize") END)
 ELSE '{}'::jsonb END AS content FROM "reactor"."DocumentSnapshot" s JOIN ids ON ids.id=s."documentId"
 CROSS JOIN LATERAL jsonb_to_record(CASE WHEN s.scope='global' AND s."documentId"<>$1 THEN s.content ELSE '{}'::jsonb END)
 AS r("reportRef" jsonb,title jsonb,"projectRef" jsonb,"familyRef" jsonb,"sourceRef" jsonb,revision jsonb,producer jsonb,lifecycle jsonb,"updatedAt" jsonb,"supersedesRef" jsonb,"supersededByRef" jsonb,publication jsonb,content jsonb)
 CROSS JOIN LATERAL jsonb_to_record(CASE WHEN jsonb_typeof(r.content)='object' THEN r.content ELSE '{}'::jsonb END) AS c(storage jsonb,"contentHash" jsonb,"byteSize" jsonb)
 WHERE s.branch='main'),
journal AS MATERIALIZED (SELECT o."documentId",o.scope,o."index",o.hash,o."opId" FROM "reactor"."Operation" o JOIN ids ON ids.id=o."documentId" WHERE o.branch='main'),
indexed AS MATERIALIZED (SELECT o."documentId",o.scope,o."index",o.hash,o."opId",o.ordinal,o.action->>'type' AS "actionType" FROM "reactor".operation_index_operations o JOIN ids ON ids.id=o."documentId" WHERE o.branch='main'),
first_upgrade AS (SELECT "documentId", min(ordinal) AS ordinal FROM indexed WHERE "actionType"='UPGRADE_DOCUMENT' GROUP BY "documentId"),
touches AS MATERIALIZED (
 SELECT s."documentId",s.scope,i.ordinal,i."index",i.hash FROM snaps s JOIN indexed i ON i."documentId"=s."documentId"
 LEFT JOIN first_upgrade u ON u."documentId"=i."documentId"
 WHERE s.scope='header' OR s.scope=i.scope
 OR (i."actionType"='CREATE_DOCUMENT' AND s.scope IN ('document','auth'))
 OR (i."actionType"='UPGRADE_DOCUMENT' AND i.ordinal=u.ordinal AND s.scope NOT IN ('header','document','auth'))
),
expected AS (SELECT DISTINCT ON ("documentId",scope) "documentId",scope,"index",hash,count(*) OVER (PARTITION BY "documentId",scope) AS version FROM touches ORDER BY "documentId",scope,ordinal DESC),
rels AS MATERIALIZED (SELECT "targetId" AS id FROM "reactor"."DocumentRelationship" WHERE "sourceId"=$1 AND "relationshipType"='child'),
checks AS (SELECT
 (SELECT count(*) FROM drive)=1
 AND (SELECT jsonb_typeof(content->'nodes') FROM drive)='array'
 AND (SELECT count(*) FROM nodes)<=10000
 AND NOT EXISTS(SELECT 1 FROM nodes WHERE n->>'kind' IS NULL OR n->>'kind' NOT IN ('file','folder'))
 AND NOT EXISTS(SELECT 1 FROM members WHERE id IS NULL OR length(id)=0 OR length(id)>256)
 AND (SELECT count(*) FROM members)=(SELECT count(DISTINCT id) FROM members)
 AND (SELECT count(*) FROM rels)=(SELECT count(*) FROM members)
 AND NOT EXISTS((SELECT id FROM members EXCEPT SELECT id FROM rels) UNION ALL (SELECT id FROM rels EXCEPT SELECT id FROM members))
 AND (SELECT count(*) FROM snaps WHERE scope='header')=(SELECT count(*) FROM ids)
 AND (SELECT count(*) FROM snaps WHERE scope='global')=(SELECT count(*) FROM ids)
 AND NOT EXISTS(SELECT id,scope FROM ids CROSS JOIN unnest(ARRAY['header','document','auth','global','local']) AS scope EXCEPT SELECT "documentId",scope FROM snaps)
 AND NOT EXISTS(SELECT 1 FROM snaps WHERE (scope='global' AND "documentId"<>$1 AND content->>'_shape' IS DISTINCT FROM 'true') OR "isDeleted" OR (scope='header' AND (content->>'id' IS DISTINCT FROM "documentId" OR "documentType" IS DISTINCT FROM CASE WHEN "documentId"=$1 THEN 'powerhouse/document-drive' ELSE 'kilgore/report' END)))
 AND NOT EXISTS((SELECT "documentId",scope,"lastOperationIndex","lastOperationHash","snapshotVersion"::bigint FROM snaps EXCEPT ALL SELECT "documentId",scope,"index",hash,version FROM expected) UNION ALL (SELECT "documentId",scope,"index",hash,version FROM expected EXCEPT ALL SELECT "documentId",scope,"lastOperationIndex","lastOperationHash","snapshotVersion"::bigint FROM snaps))
 AND NOT EXISTS(SELECT "documentId",scope FROM indexed EXCEPT SELECT "documentId",scope FROM snaps)
 AND NOT EXISTS((SELECT "documentId",scope,"index",hash,"opId" FROM journal EXCEPT ALL SELECT "documentId",scope,"index",hash,"opId" FROM indexed) UNION ALL (SELECT "documentId",scope,"index",hash,"opId" FROM indexed EXCEPT ALL SELECT "documentId",scope,"index",hash,"opId" FROM journal))
 AND NOT EXISTS(SELECT 1 FROM indexed WHERE "actionType"='DELETE_DOCUMENT')
 AS valid),
rows AS (SELECT "documentId" AS id,max(content->>'name') FILTER(WHERE scope='header') AS name,(jsonb_agg(content) FILTER(WHERE scope='global'))->0 AS g FROM snaps WHERE "documentId"<>$1 GROUP BY "documentId")
SELECT (SELECT valid FROM checks) AS valid,
 COALESCE((SELECT jsonb_agg(id ORDER BY id COLLATE "C") FROM members),'[]'::jsonb) AS "documentIds",
 COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'documentId',id,'name',name,'reportRef',g->'reportRef','title',g->'title','projectRef',g->'projectRef','familyRef',g->'familyRef','sourceRef',g->'sourceRef',
 'revision',g->'revision','producer',g->'producer','lifecycle',g->'lifecycle','updatedAt',g->'updatedAt',
 'supersedesRef',g->'supersedesRef','supersededByRef',g->'supersededByRef',
 'content',CASE WHEN g->'content'='null'::jsonb THEN 'null'::jsonb ELSE jsonb_build_object('storage',g#>'{content,storage}','contentHash',g#>'{content,contentHash}','byteSize',g#>'{content,byteSize}') END,
 'publication',g->'publication') ORDER BY id COLLATE "C") FROM rows),'[]'::jsonb) AS reports,
 COALESCE((SELECT jsonb_agg(jsonb_build_array("documentId",scope,"lastOperationIndex","lastOperationHash","snapshotVersion") ORDER BY "documentId" COLLATE "C",scope COLLATE "C") FROM snaps),'[]'::jsonb) AS fence`;

const fail = () => {throw Error('REPORT_SNAPSHOT_INCOMPLETE_OR_STALE');};
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const nullableString = x => x === null || typeof x === 'string';
const keysOnly=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
function validatePublication(value) {
 if(value===null)return;
 const refs=['publicationId','runRef','sourceRef','provenanceRef','contentHash','authorizationRef','publishedAt'];
 if(!keysOnly(value,[...refs,'contentVersion','author','publisher'])||refs.some(key=>typeof value[key]!=='string'||!value[key])||!Number.isSafeInteger(value.contentVersion)||value.contentVersion<1)fail();
 for(const role of ['author','publisher']){
  const agent=value[role],optional=['instanceId','definitionId','definitionVersion','definitionHash'];
  if(!keysOnly(agent,['id','label',...optional])||typeof agent.id!=='string'||!agent.id||typeof agent.label!=='string'||!agent.label||optional.some(key=>!nullableString(agent[key])))fail();
 }
}
export function classifyReport(row) {
 if(!keysOnly(row,['documentId','name','classification','reportRef','title','projectRef','familyRef','sourceRef','revision','producer','lifecycle','updatedAt','supersedesRef','supersededByRef','content','publication']))fail();
 if (!object(row) || typeof row.documentId !== 'string' || !row.documentId || typeof row.name !== 'string' || typeof row.reportRef !== 'string' || typeof row.title !== 'string' || !Number.isSafeInteger(row.revision) || row.revision<0) fail();
 for (const key of ['projectRef','familyRef','sourceRef','updatedAt','supersedesRef','supersededByRef']) if (!nullableString(row[key])) fail();
 if (!['DRAFT','FINAL','SUPERSEDED','WITHDRAWN'].includes(row.lifecycle)) fail();
 if (row.revision===0 && row.reportRef==='' && row.title==='' && row.producer===null && row.content===null && row.publication===null && row.lifecycle==='DRAFT' && ['projectRef','familyRef','sourceRef','updatedAt','supersedesRef','supersededByRef'].every(key=>row[key]===null)) return 'pending';
 if (row.revision<1 || !row.reportRef || !row.title || !object(row.producer) || !['AGENT','HUMAN','SERVICE','IMPORT'].includes(row.producer.kind) || typeof row.producer.id!=='string' || !row.producer.id || !nullableString(row.producer.label) || !object(row.content) || !['INLINE_MARKDOWN','BLOB'].includes(row.content.storage) || typeof row.content.contentHash!=='string' || !/^[a-f0-9]{64}$/.test(row.content.contentHash) || !Number.isSafeInteger(row.content.byteSize) || row.content.byteSize<0 || typeof row.updatedAt!=='string' || !Number.isFinite(Date.parse(row.updatedAt))) fail();
 if(!keysOnly(row.producer,['id','kind','label'])||!keysOnly(row.content,['storage','contentHash','byteSize']))fail();
 validatePublication(row.publication);
 return 'registered';
}
export function validateReportSnapshot(value, driveId) {
 if (!object(value) || value.schemaVersion!==SNAPSHOT_SCHEMA || value.driveId!==driveId || value.branch!=='main' || value.complete!==true || value.hasMore!==false || value.nextCursor!==null || !Array.isArray(value.documentIds) || !Array.isArray(value.reports) || value.totalCount!==value.documentIds.length || value.reports.length!==value.totalCount || value.totalCount>10000 || typeof value.snapshotDigest!=='string' || !/^[a-f0-9]{64}$/.test(value.snapshotDigest)) fail();
 const ids=value.documentIds;
 if (ids.some((id,i)=>typeof id!=='string'||!id||id.length>256||(i>0&&ids[i-1]>=id))) fail();
 value.reports.forEach((row,i)=>{if(row.documentId!==ids[i] || classifyReport(row)!==row.classification)fail();});
 if (Buffer.byteLength(JSON.stringify(value))>SNAPSHOT_MAX_BYTES) throw Error('REPORT_SNAPSHOT_BYTE_BOUND');
 return value;
}
export async function readReportSnapshot(client, parentId) {
 if (parentId!==REPORT_DRIVE_ID) throw Error('REPORT_SNAPSHOT_SCOPE');
 const db=client?.documentView?._db;
 if (!db || typeof db.executeQuery!=='function') throw Error('REPORT_SNAPSHOT_RUNTIME');
 const started=performance.now();
 const result=await db.executeQuery({sql:SNAPSHOT_SQL,parameters:[REPORT_DRIVE_ID],query:{kind:'RawNode',sqlFragments:[SNAPSHOT_SQL],parameters:[]}});
 if (performance.now()-started>=SNAPSHOT_TIMEOUT_MS) throw Error('REPORT_SNAPSHOT_DEADLINE');
 if (result.rows.length!==1 || result.rows[0].valid!==true) fail();
 const {documentIds,reports,fence}=result.rows[0];
 for (const row of reports) row.classification=classifyReport(row);
 const snapshotDigest=createHash('sha256').update(JSON.stringify({documentIds,reports,fence})).digest('hex');
 const snapshot=validateReportSnapshot({schemaVersion:SNAPSHOT_SCHEMA,driveId:REPORT_DRIVE_ID,branch:'main',complete:true,documentIds,totalCount:documentIds.length,hasMore:false,nextCursor:null,reports,snapshotDigest},REPORT_DRIVE_ID);
 if(performance.now()-started>=SNAPSHOT_TIMEOUT_MS)throw Error('REPORT_SNAPSHOT_DEADLINE');
 return snapshot;
}
