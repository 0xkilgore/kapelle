import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync,mkdtempSync,rmSync,mkdirSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {readReportSnapshot,REPORT_DRIVE_ID,SNAPSHOT_SQL} from '../deploy/report-snapshot.mjs';
const require=createRequire(join(process.env.KAPELLE_SNAPSHOT_RUNTIME_ROOT,'package.json'));
const fixtureRoot=process.env.KAPELLE_SNAPSHOT_FIXTURE_ROOT;
const outputRoot=process.env.KAPELLE_SNAPSHOT_OUTPUT_ROOT;
if(!fixtureRoot||!outputRoot)throw Error('Explicit synthetic fixture/output roots required');
const {PGlite}=await import(pathToFileURL(require.resolve('@electric-sql/pglite')));
const {Kysely}=require('kysely');const {PGliteDialect}=require('kysely-pglite-dialect');
let stages=[],fs,fixtureDir;
if(process.env.PERSISTENT==='1'){
 fixtureDir=mkdtempSync(join(tmpdir(),'report-snapshot-proof-'));
 const capturedFs=JSON.parse(readFileSync(join(fixtureRoot,'filesystem-path.json'))).files[0];
 const fsModule=join(fixtureDir,'atomic.mjs');writeFileSync(fsModule,capturedFs.source.replace('from "@electric-sql/pglite"','from '+JSON.stringify(pathToFileURL(require.resolve('@electric-sql/pglite')).href)));
 const {AtomicNodeFs}=await import(pathToFileURL(fsModule));
 class MeasuredFs extends AtomicNodeFs {async syncToFs(relaxed){const t=performance.now();await super.syncToFs(relaxed);stages.push({stage:'syncToFs',ms:performance.now()-t});}}
 fs=new MeasuredFs(join(fixtureDir,'db'),{flushIntervalMs:3600000});
}
const pg=new PGlite(fs?{fs}:undefined); const db=new Kysely({dialect:new PGliteDialect(pg)}).withSchema('reactor');
await pg.exec(`CREATE SCHEMA reactor; SET search_path=reactor; CREATE TABLE "DocumentSnapshot" (id text primary key,"documentId" text,slug text,name text,scope text,branch text,content jsonb,"documentType" text,"lastOperationIndex" integer,"lastOperationHash" text,"lastUpdatedAt" timestamptz,"snapshotVersion" integer default 1,identifiers jsonb,metadata jsonb,"isDeleted" boolean default false,"deletedAt" timestamptz,UNIQUE("documentId",scope,branch)); CREATE TABLE "SlugMapping" (slug text primary key,"documentId" text,scope text,branch text); CREATE TABLE "DocumentRelationship" (id text primary key,"sourceId" text,"targetId" text,"relationshipType" text); CREATE TABLE "Operation" (id serial primary key,"documentId" text,scope text,branch text,"index" integer,hash text,"opId" text,action jsonb,UNIQUE("documentId",scope,branch,"index")); CREATE TABLE operation_index_operations (ordinal serial primary key,"documentId" text,scope text,branch text,"index" integer,hash text,"opId" text,action jsonb); CREATE INDEX indexed_document ON operation_index_operations("documentId",scope,branch);`);
const captured=readFileSync(join(fixtureRoot,'document-indexer.preimage.js'),'utf8');
assert.equal(createHash('sha256').update(captured).digest('hex'),'68d627b97767df7cddbacc7af4fe28966b0fa8ca4eb367b150e0e2a5ce61a083');
const begin=captured.indexOf('var KyselyDocumentView = class');const end=captured.indexOf('\n};',begin)+3;
class Base {constructor(db){this.db=db;}}
const View=new Function('BaseReadModel','v4',captured.slice(begin,end)+';return KyselyDocumentView;')(Base,randomUUID);
const view=new View(db);const client={documentView:view};
const states=new Map(),counts=new Map();let calls=0;
const original=db.executeQuery.bind(db);db.executeQuery=async(...args)=>{calls++;return original(...args);};
async function op(id,type,scope,action,patch={},apply=true){
 let state=states.get(id);if(!state){state={header:{id,name:id,documentType:type},document:{version:1},auth:{},global:{},local:{}};states.set(id,state);}Object.assign(state,patch);
 const key=id+'/'+scope,index=counts.get(key)||0;counts.set(key,index+1);const hash=createHash('sha256').update(key+index).digest('hex'),opId=randomUUID();
 const row={documentId:id,scope,branch:'main',index,hash,opId,action:{type:action}};
 await db.insertInto('Operation').values(row).execute();await db.insertInto('operation_index_operations').values(row).execute();
 const item={operation:{index,hash,action:row.action},context:{documentId:id,scope,branch:'main',documentType:type,resultingState:JSON.stringify(state)}};
 if(apply)await view.commitOperations([item]);return item;
}
const pending={reportRef:'',title:'',revision:0,producer:null,content:null,lifecycle:'DRAFT',updatedAt:null,projectRef:null,familyRef:null,sourceRef:null,supersedesRef:null,supersededByRef:null};
await op(REPORT_DRIVE_ID,'powerhouse/document-drive','document','CREATE_DOCUMENT');
await op(REPORT_DRIVE_ID,'powerhouse/document-drive','document','UPGRADE_DOCUMENT',{global:{nodes:[]}});
for(let i=0;i<2;i++){
 const id='report-'+String(i).padStart(4,'0');
 await op(id,'kilgore/report','document','CREATE_DOCUMENT');
 await op(id,'kilgore/report','document','UPGRADE_DOCUMENT',{global:{...pending}});
 if(i!==0)await op(id,'kilgore/report','global','REGISTER_REPORT',{global:{...pending,reportRef:'ref:'+id,title:'Report '+i,revision:1,producer:{kind:'AGENT',id:'fixture',label:null},content:{storage:'INLINE_MARKDOWN',contentHash:'a'.repeat(64),byteSize:36703,markdown:'DO_NOT_RETURN_BODY'.repeat(2100)},lifecycle:'FINAL',updatedAt:'2026-09-25T00:00:00.000Z'}});
 states.get(REPORT_DRIVE_ID).global.nodes.push({id,kind:'file'});
 await op(REPORT_DRIVE_ID,'powerhouse/document-drive','global','ADD_FILE');
 await op(REPORT_DRIVE_ID,'powerhouse/document-drive','document','ADD_RELATIONSHIP');
 await db.insertInto('DocumentRelationship').values({id:randomUUID(),sourceId:REPORT_DRIVE_ID,targetId:id,relationshipType:'child'}).execute();
}
// Expand the native-materialized registered shape with distinct IDs; no live data.
await pg.exec(`INSERT INTO "DocumentSnapshot" SELECT id||'-'||i,'report-'||lpad(i::text,4,'0'),slug,CASE WHEN scope='header' THEN 'report-'||lpad(i::text,4,'0') ELSE name END,scope,branch,CASE WHEN scope='header' THEN jsonb_set(jsonb_set(content,'{id}',to_jsonb('report-'||lpad(i::text,4,'0'))),'{name}',to_jsonb('report-'||lpad(i::text,4,'0'))) WHEN scope='global' THEN jsonb_set(content,'{reportRef}',to_jsonb('ref:report-'||lpad(i::text,4,'0'))) ELSE content END,"documentType","lastOperationIndex","lastOperationHash","lastUpdatedAt","snapshotVersion",identifiers,metadata,"isDeleted","deletedAt" FROM "DocumentSnapshot",generate_series(2,1803) i WHERE "documentId"='report-0001';
INSERT INTO "Operation" ("documentId",scope,branch,"index",hash,"opId",action) SELECT 'report-'||lpad(i::text,4,'0'),scope,branch,"index",hash,"opId"||'-'||i,action FROM "Operation",generate_series(2,1803) i WHERE "documentId"='report-0001';
INSERT INTO operation_index_operations ("documentId",scope,branch,"index",hash,"opId",action) SELECT 'report-'||lpad(i::text,4,'0'),scope,branch,"index",hash,"opId"||'-'||i,action FROM operation_index_operations,generate_series(2,1803) i WHERE "documentId"='report-0001';
INSERT INTO "DocumentRelationship" SELECT 'rel-'||i,'${REPORT_DRIVE_ID}','report-'||lpad(i::text,4,'0'),'child' FROM generate_series(2,1803) i;`);
for(let i=2;i<1804;i++)states.get(REPORT_DRIVE_ID).global.nodes.push({id:'report-'+String(i).padStart(4,'0'),kind:'file'});
await op(REPORT_DRIVE_ID,'powerhouse/document-drive','global','ADD_FILE');
await pg.exec('ANALYZE');
writeFileSync(join(outputRoot,'SNAPSHOT-PLAN.json'),JSON.stringify((await pg.query('EXPLAIN (FORMAT JSON) '+SNAPSHOT_SQL,[REPORT_DRIVE_ID])).rows,null,2));
if(fs){
 let size=0;const walk=path=>{for(const name of pg.Module.FS.readdir(path)){if(name==='.'||name==='..')continue;const full=path+'/'+name,st=pg.Module.FS.stat(full);if(pg.Module.FS.isDir(st.mode))walk(full);else size+=st.size;}};walk('/tmp/pglite/base');
 pg.Module.FS.writeFile('/tmp/pglite/base/kapelle-proof-padding',new Uint8Array(Math.max(0,399*1024*1024-size)));
 clearTimeout(fs.flushTimer);fs.flushTimer=undefined;fs.flushIntervalMs=0;
}
await pg.exec('SET search_path=public');
const cases=[],timings=[];

for(let i=0;i<3;i++){calls=0;stages=[];const t=performance.now();let snapshot;try{snapshot=await readReportSnapshot(client,REPORT_DRIVE_ID);}catch(error){const failure={status:'HOLD',error:String(error),ms:performance.now()-t,queries:calls,stages:[...stages],persistent:!!fs};writeFileSync(join(outputRoot,fs?'SNAPSHOT-PERSISTENT-PROOF.json':'SNAPSHOT-PROOF.json'),JSON.stringify(failure,null,2));throw error;}timings.push({ms:performance.now()-t,bytes:Buffer.byteLength(JSON.stringify(snapshot)),queries:calls,documents:snapshot.totalCount,stages:[...stages]});assert.equal(snapshot.totalCount,1804);assert.equal(snapshot.reports[0].classification,'pending');assert.equal(snapshot.reports[1].classification,'registered');assert.ok(!JSON.stringify(snapshot).includes('DO_NOT_RETURN_BODY'));}
cases.push('1804 native-view reports including blank intent; complete body-free metadata; one query');
async function rejects(name,change,restore){await change();await assert.rejects(readReportSnapshot(client,REPORT_DRIVE_ID),/INCOMPLETE_OR_STALE/);await restore();cases.push(name);}
await rejects('missing relationship',()=>db.deleteFrom('DocumentRelationship').where('targetId','=','report-0000').execute(),()=>db.insertInto('DocumentRelationship').values({id:randomUUID(),sourceId:REPORT_DRIVE_ID,targetId:'report-0000',relationshipType:'child'}).execute());
await rejects('view hash lag',()=>db.updateTable('DocumentSnapshot').set({lastOperationHash:'stale'}).where('documentId','=','report-0001').where('scope','=','global').execute(),async()=>{const row=await db.selectFrom('Operation').select('hash').where('documentId','=','report-0001').where('scope','=','global').executeTakeFirst();await db.updateTable('DocumentSnapshot').set({lastOperationHash:row.hash}).where('documentId','=','report-0001').where('scope','=','global').execute();});
await rejects('missing earlier materialized write despite current tail',()=>db.updateTable('DocumentSnapshot').set({snapshotVersion:1}).where('documentId','=','report-0001').where('scope','=','header').execute(),()=>db.updateTable('DocumentSnapshot').set({snapshotVersion:3}).where('documentId','=','report-0001').where('scope','=','header').execute());
await rejects('deleted member',()=>db.updateTable('DocumentSnapshot').set({isDeleted:true}).where('documentId','=','report-0000').where('scope','=','header').execute(),()=>db.updateTable('DocumentSnapshot').set({isDeleted:false}).where('documentId','=','report-0000').where('scope','=','header').execute());
await rejects('malformed pending state is not hidden',()=>db.updateTable('DocumentSnapshot').set({content:{...pending,title:'partial'}}).where('documentId','=','report-0000').where('scope','=','global').execute(),()=>db.updateTable('DocumentSnapshot').set({content:pending}).where('documentId','=','report-0000').where('scope','=','global').execute());
for(const scope of ['auth','local']){
 const saved=await db.selectFrom('DocumentSnapshot').selectAll().where('documentId','=','report-0001').where('scope','=',scope).executeTakeFirstOrThrow();
 await rejects('missing required '+scope+' scope',()=>db.deleteFrom('DocumentSnapshot').where('id','=',saved.id).execute(),()=>db.insertInto('DocumentSnapshot').values(saved).execute());
}
const item=await op('report-0001','kilgore/report','global','UPDATE_CONTENT',{},false);await assert.rejects(readReportSnapshot(client,REPORT_DRIVE_ID),/INCOMPLETE_OR_STALE/);await view.commitOperations([item]);cases.push('committed journal/index ahead of view rejected; admitted after native materialization');
await db.insertInto('Operation').values({documentId:'report-0001',scope:'global',branch:'main',index:2,hash:'gap',opId:'gap',action:{type:'UPDATE_CONTENT'}}).execute();await assert.rejects(readReportSnapshot(client,REPORT_DRIVE_ID),/INCOMPLETE_OR_STALE/);await db.deleteFrom('Operation').where('opId','=','gap').execute();cases.push('journal/index commit gap rejected');
await assert.rejects(readReportSnapshot(client,'other'),/SCOPE/);cases.push('wrong Drive rejected before query');
const final=await readReportSnapshot(client,REPORT_DRIVE_ID);assert.equal(final.totalCount,1804);
// Use the captured native indexer's real cursor implementation over the same
// database. Its default first page is100; only following all continuations is complete.
await pg.exec('ALTER TABLE reactor."DocumentRelationship" ADD COLUMN "createdAt" timestamptz DEFAULT now(), ADD COLUMN "updatedAt" timestamptz DEFAULT now(), ADD COLUMN metadata jsonb');
const indexerBegin=captured.indexOf('var KyselyDocumentIndexer = class');
const indexerEnd=captured.indexOf('\n};',indexerBegin)+3;
const Indexer=new Function('BaseReadModel','v4',captured.slice(indexerBegin,indexerEnd)+';return KyselyDocumentIndexer;')(Base,randomUUID);
const indexer=new Indexer(db);
let page=await indexer.getOutgoing(REPORT_DRIVE_ID,['child']);assert.equal(page.results.length,100);assert.equal(page.nextCursor,'100');
const pagedIds=[];let pages=0;
while(true){pages++;pagedIds.push(...page.results.map(v=>v.targetId));if(!page.next)break;page=await page.next();}
assert.equal(pages,19);assert.deepEqual(pagedIds.sort(),final.documentIds);
cases.push('actual native KyselyDocumentIndexer cursor: first100,19pages reach1804 unique members; full snapshot exactly matches all pages');

// Exercise the actual composed MCP tool, proxy and selected publisher reader
// over this owning connection, not a fabricated complete envelope.
const {composeSnapshotMcp}=await import('../deploy/report-listing-runtime/compose-snapshot.mjs');
const {createMcpAuthProxy}=await import('../deploy/mcp-auth-proxy.ts');
const {HttpReportRegistryMcp}=await import('../src/mcp-client.ts');
const {CompletePrivateReportMcp}=await import('../src/private-publication.ts');
const {createServer}=await import('node:http');
const {symlinkSync}=await import('node:fs');
const runtimeDir=mkdtempSync(join(tmpdir(),'report-snapshot-mcp-'));
const preimage=readFileSync(process.env.KAPELLE_SNAPSHOT_MCP_PREIMAGE || join(fixtureRoot,'mcp-server.preimage.mjs'));
const candidate=composeSnapshotMcp(preimage);
assert.throws(()=>composeSnapshotMcp(Buffer.concat([preimage,Buffer.from('\n')])),/PREIMAGE_MISMATCH/);
const bundleDir=join(runtimeDir,'node_modules/@powerhousedao/reactor-mcp/dist');
mkdirSync(bundleDir,{recursive:true});
cpSync(new URL('../deploy/report-summary-read',import.meta.url),join(runtimeDir,'deploy/report-summary-read'),{recursive:true});
writeFileSync(join(bundleDir,'server.mjs'),candidate);
writeFileSync(join(bundleDir,'baseline.mjs'),preimage);
writeFileSync(join(bundleDir,'report-snapshot.mjs'),readFileSync(new URL('../deploy/report-snapshot.mjs',import.meta.url)));
for (const name of ['document-model','@modelcontextprotocol','zod','kysely','change-case']) symlinkSync(new URL('../node_modules/'+name,import.meta.url).pathname,join(runtimeDir,'node_modules',name),'dir');
for(const name of ['reactor','shared']) symlinkSync(new URL('../node_modules/@powerhousedao/'+name,import.meta.url).pathname,join(runtimeDir,'node_modules/@powerhousedao',name),'dir');
let upstream,proxy,legacy=false;
try{
 const {o:createProvider}=await import(pathToFileURL(join(bundleDir,'server.mjs')));
 const {tools}=await createProvider({client,summaryReportModule:{database:db}});
 const {o:baselineProvider}=await import(pathToFileURL(join(bundleDir,'baseline.mjs')));
 const baseline=await baselineProvider({client,summaryReportModule:{database:db}});
 assert.deepEqual(Object.keys(tools).filter(name=>name!=='getReportLibraryMetadata').sort(),Object.keys(baseline.tools).sort());
 for(const name of ['getReportSummaryPage','getReportDetailV2','getReportReviewScope','lookupReportPublicationV1','getDocuments','getDocument','createDocument','addActions']) assert.ok(tools[name],name);
 assert.equal(tools.getReportLibraryMetadata.inputSchema.parentId.safeParse('other').success,false);
 let toolCalls=0;
 upstream=createServer(async(req,res)=>{try{
  let text='';for await(const chunk of req)text+=chunk;
  const v=JSON.parse(text);assert.equal(v.params.name,'getReportLibraryMetadata');toolCalls++;
  const result=legacy?{structuredContent:{documentIds:final.documentIds.slice(0,100)},content:[]}:await tools.getReportLibraryMetadata.callback(v.params.arguments);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:v.id,result}));
 }catch{res.statusCode=500;res.end('{}');}});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
 const writer='synthetic-producer-'.padEnd(40,'p'),reader='synthetic-reader-'.padEnd(40,'r');
 proxy=createMcpAuthProxy({readerToken:reader,producerToken:writer,driveId:REPORT_DRIVE_ID,upstream:'http://127.0.0.1:'+upstream.address().port+'/mcp',audit:()=>{}});
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+proxy.address().port+'/mcp';
 const producer=new HttpReportRegistryMcp(url,writer),independent=new HttpReportRegistryMcp(url,reader);
 const guarded=new CompletePrivateReportMcp(producer,REPORT_DRIVE_ID,independent);
 const all=await guarded.completeList();assert.equal(all.length,1804);assert.equal(all.at(-1),'report-1803');
 const identities=await guarded.call('getReportIdentities',{parentId:REPORT_DRIVE_ID});
 assert.equal(identities.identities.length,1804);assert.equal(identities.identities.at(-1).state.global.reportRef,'ref:report-1803');
 const metadata=await independent.call('getReportLibraryMetadata',{parentId:REPORT_DRIVE_ID});assert.equal(metadata.totalCount,1804);assert.ok(!JSON.stringify(metadata).includes('DO_NOT_RETURN_BODY'));
 await assert.rejects(independent.call('getReportIdentities',{parentId:REPORT_DRIVE_ID}));
 const before=toolCalls;await assert.rejects(producer.call('getDocuments',{parentId:'other'}));assert.equal(toolCalls,before);
 legacy=true;await assert.rejects(new CompletePrivateReportMcp(producer,REPORT_DRIVE_ID).completeList());legacy=false;
 const relationship=await db.selectFrom('DocumentRelationship').selectAll().where('targetId','=','report-1803').executeTakeFirstOrThrow();
 await db.deleteFrom('DocumentRelationship').where('id','=',relationship.id).execute();
 await assert.rejects(new CompletePrivateReportMcp(producer,REPORT_DRIVE_ID).completeList());
 await db.insertInto('DocumentRelationship').values(relationship).execute();
 assert.equal((await new CompletePrivateReportMcp(producer,REPORT_DRIVE_ID).completeList()).length,1804);
 cases.push('actual composed MCP to authenticated proxy to selected publisher: 1804 IDs and identities including last record; independent metadata body-free; reader identity tool denied; wrong Drive denied before query; legacy100 and missing-member inventories fail closed; restored inventory recovers');
 writeFileSync(join(outputRoot,'server.candidate.mjs'),candidate);
}finally{
 if(proxy)await new Promise(r=>proxy.close(r));if(upstream)await new Promise(r=>upstream.close(r));rmSync(runtimeDir,{recursive:true,force:true});
}
const result={persistent:!!fs,fixtureConstruction:'Native view materializes Drive, blank and registered representatives; remaining1802 registered rows clone that shape with distinct document/op IDs. Not live history replay.',environment:'isolated PGlite0.3.15/Kysely; exact captured6.2.1 KyselyDocumentView.commitOperations; synthetic1804 documents,36703+byte bodies; NOT live admission',viewSourceSha256:createHash('sha256').update(captured).digest('hex'),sqlSha256:createHash('sha256').update(SNAPSHOT_SQL).digest('hex'),cases,timings};
writeFileSync(join(outputRoot,fs?'SNAPSHOT-PERSISTENT-PROOF.json':'SNAPSHOT-PROOF.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));await db.destroy();if(fixtureDir)rmSync(fixtureDir,{recursive:true});
