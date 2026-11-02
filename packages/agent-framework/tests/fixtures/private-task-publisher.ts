/** Test-only paired source: native metadata comes from the candidate Report reducer. */
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import ts from 'typescript';
export async function privateTaskPublisherFixture(){
 const root=process.env.KAPELLE_TASK_PUBLISHER_ROOT!;
 const dir=mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),'.private-publisher-')),file=join(dir,'bundle','paired.mjs');
 // The publisher resolves '../deploy/...' and '../document-models/...' from its module: mirror them beside the bundle.
 {const {mkdirSync:md,copyFileSync:cp,existsSync:ex2}=await import('node:fs');for(const rel of ['deploy/report-listing-runtime/model-inventory.json','document-models/report-registry/v1/schema.graphql']){if(ex2(join(root,rel))){md(dirname(join(dir,rel)),{recursive:true});cp(join(root,rel),join(dir,rel));}}}
 await build({stdin:{contents:`export {PrivateTaskReportPublisher} from ${JSON.stringify(join(root,'src/task-publication.ts'))}; export {ReportRegistry} from ${JSON.stringify(join(root,'document-models/report-registry/v1/module.ts'))};`,resolveDir:root},outfile:file,bundle:true,platform:'node',format:'esm',external:['document-model','zod','react'],logLevel:'silent',plugins:[{name:'typescript',setup(b){b.onLoad({filter:/\.ts$/},({path})=>({contents:ts.transpileModule(readFileSync(path,'utf8'),{fileName:path,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText,loader:'js',resolveDir:dirname(path)}));}}]});
 const {PrivateTaskReportPublisher,ReportRegistry:Report}=await import(/* @vite-ignore */ pathToFileURL(file).href);
 const docs=new Map<string,any>();let writes=0,reads=0,lose=false,readerAvailable=true;
 const mcp={async call(name:string,args:Record<string,unknown>):Promise<any>{
  const ids=[...docs.keys()],envelope={schemaVersion:'kapelle.report-drive-snapshot.v1',driveId:'drive',branch:'main',complete:true,totalCount:ids.length,hasMore:false,nextCursor:null,snapshotDigest:'a'.repeat(64),documentIds:ids};
  if(name==='getDocuments')return envelope;
  if(name==='getReportIdentities')return {...envelope,identities:[...docs.values()].map(d=>({header:d.header,state:{global:{reportRef:d.state.global.reportRef??'',publication:d.state.global.publication??null}}}))};
  if(name==='getDocument')return {document:structuredClone(docs.get(String(args.id)))};
  if(name==='getRegistryDeploymentV1'){const {fixtureDeployment}=await import('./model-admission.js');return fixtureDeployment(root,'drive');}
  if(name==='getReportDocumentV1'){
   // Scale bridge: scoped point proof (mirror of detail.mjs pointReader): current Drive members only; blank = no registration yet.
   const d=docs.get(String(args.id));if(!d)throw Error('REPORT_DETAIL_UNAVAILABLE');const doc=structuredClone(d),g=doc.state.global,blank=!g.reportRef;
   return {read:{schemaVersion:'kapelle.report-document-read.v1',driveId:'drive',documentId:doc.header.id,stamp:'b'.repeat(64),lifecycle:g.lifecycle,revision:g.revision,blank,observedAt:new Date().toISOString(),document:{header:{id:doc.header.id,name:doc.header.name,documentType:doc.header.documentType},state:{global:g}}}};
  }
  if(name==='lookupReportPublicationV1'){
   // Publisher dad157d+ looks up through the native V1 tool: mirror deploy/report-summary-read/publication-lookup.mjs over this
   // map (registered by reportRef; pending = blank with the intent name; the body only for an unambiguous 1/0 or 0/1).
   const {createHash:h}=await import('node:crypto');const reportRef=String(args.reportRef),intentName='report-promotion-intent:'+h('sha256').update(reportRef).digest('hex').slice(0,20),all=[...docs.values()];
   const registered=all.filter(d=>d.state.global.reportRef===reportRef),pending=all.filter(d=>!d.state.global.reportRef&&d.header.name===intentName);
   const selected=registered.length===1&&pending.length===0?registered:registered.length===0&&pending.length===1?pending:[];
   return {lookup:{schemaVersion:'kapelle.publication-lookup.v1',driveId:'drive',reportRef,intentName,observedAt:new Date().toISOString(),registeredCount:registered.length,pendingCount:pending.length,memberCount:docs.size,
    documents:selected.map(d=>structuredClone({header:{id:d.header.id,name:d.header.name,documentType:d.header.documentType},state:{global:d.state.global}}))}};
  }
  if(name==='createDocument'){writes++;const d=Report.utils.createDocument();d.header.name=args.name;docs.set(d.header.id,d);return {document:structuredClone(d)};}
  if(name==='addActions'){
   writes++;let d=docs.get(String(args.documentId));
   for(const a of args.actions as any[]){const creator=({REGISTER_REPORT:'registerReport',REQUEST_REVIEW:'requestReview'} as Record<string,string>)[a.type];if(!creator)throw Error('test action not supported');d=Report.reducer(d,Report.actions[creator](a.input));if(d.operations.global.at(-1)?.error)throw Error(d.operations.global.at(-1).error);}
   docs.set(d.header.id,d);if(lose){lose=false;throw Error('lost publication reply');}return {ok:true};
  }
  throw Error('test tool forbidden');
 }};
 const reader={async call(name:string,args:Record<string,unknown>){reads++;if(!readerAvailable)throw Error('independent reader unavailable');if(!['getDocuments','getDocument','getReportDocumentV1'].includes(name))throw Error('reader write forbidden');return mcp.call(name,args);}};
 // Publisher e693b964+ requires a QUALIFIED_LIVE model admission to publish (none for older publishers: no gate).
 const {existsSync:ex}=await import('node:fs');const {createHash:ch}=await import('node:crypto');
 const inventoryPath=join(root,'deploy/report-listing-runtime/model-inventory.json');
 const gated=readFileSync(join(root,'src/task-publication.ts'),'utf8').includes('TASK_PUBLICATION_MODEL_NOT_ADMITTED');
 const {qualifiedAdmission}=await import('./model-admission.js');
 const modelAdmission=gated&&ex(inventoryPath)?{endpoint:'fixture://in-memory',value:qualifiedAdmission(root,'fixture://in-memory','drive')}:undefined;
 return {PrivateTaskReportPublisher,Report,docs,mcp,reader,modelAdmission,counts:()=>({writes,reads}),loseReply(){lose=true;},readerAvailable(value:boolean){readerAvailable=value;},close(){rmSync(dir,{recursive:true,force:true});}};
}
