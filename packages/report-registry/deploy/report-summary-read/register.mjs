import {publicationLookup} from './publication-lookup.mjs';
import {reviewScopeReader} from './review-scope.mjs';
import {detailReader,pointReader} from './detail.mjs';
import {deploymentReader} from './deployment.mjs';
import {sql} from 'kysely';
import {MetadataSnapshots} from './snapshot.mjs';
import {metadataDatabase} from './database.mjs';
const byOwner=new WeakMap();
const activeByOwner=new WeakMap();
async function bounded(owner,fn){const n=activeByOwner.get(owner)??0;if(n>=2)throw Error("REPORT_READER_BUSY");activeByOwner.set(owner,n+1);try{return await fn();}finally{activeByOwner.set(owner,(activeByOwner.get(owner)??1)-1);}}
export function attachSummaryTools(tools,module,driveId,z,toolWithCallback){
 if(!module?.database)throw Error('SUMMARY_OWNER_REQUIRED');
 let reader=byOwner.get(module);
 if(!reader){reader=new MetadataSnapshots(metadataDatabase(module.database,sql),{driveId,authorize:async()=>`fixed-reader:${driveId}`});byOwner.set(module,reader);}
 tools.getReportSummaryPage=toolWithCallback({name:'getReportSummaryPage',description:'Bounded projected metadata; trusted loopback proxy only, no bodies.',inputSchema:{cursor:z.string().regex(/^[a-f0-9]{64}$/).optional()},outputSchema:{page:z.unknown()}},async args=>bounded(module,async()=>({page:await reader.page(args,AbortSignal.timeout(5000))})));
 const readDetail=detailReader(module.database,sql,driveId);
 tools.getReportDetailV2=toolWithCallback({name:'getReportDetailV2',description:'Fresh fixed-Drive authorized selected Report detail.',inputSchema:{id:z.string().uuid()},outputSchema:{detail:z.unknown()}},async args=>{if(Object.keys(args).length!==1)throw Error('REPORT_DETAIL_REQUEST');return bounded(module,async()=>({detail:await readDetail(args.id,AbortSignal.timeout(5000))}));});
 const reviewScope=reviewScopeReader(module.database,sql,driveId);
 tools.getReportReviewScope=toolWithCallback({name:'getReportReviewScope',description:'Exact current fixed-Drive reviewer preflight; trusted proxy only, no body or reusable grant.',inputSchema:{id:z.string().uuid()},outputSchema:{scope:z.unknown()}},async args=>{if(Object.keys(args).length!==1)throw Error('REPORT_REVIEW_SCOPE_REQUEST');return bounded(module,async()=>({scope:await reviewScope(args.id,AbortSignal.timeout(5000))}));});
 const pointRead=pointReader(module.database,sql,driveId);
 tools.getReportDocumentV1=toolWithCallback({name:'getReportDocumentV1',description:'Scoped fixed-Drive selected Report read (membership + this document\'s heads only); trusted proxy only.',inputSchema:{id:z.string().uuid()},outputSchema:{read:z.unknown()}},async args=>{if(Object.keys(args).length!==1)throw Error('REPORT_DOCUMENT_READ_REQUEST');return bounded(module,async()=>({read:await pointRead(args.id,AbortSignal.timeout(5000))}));});
 const deployment=deploymentReader(driveId);
 tools.getRegistryDeploymentV1=toolWithCallback({name:'getRegistryDeploymentV1',description:'This Reactor process\'s release id and loaded Report-model digest (boot and now); producer only, no body.',inputSchema:{},outputSchema:{deployment:z.unknown()}},async args=>{if(Object.keys(args??{}).length!==0)throw Error('REGISTRY_DEPLOYMENT_REQUEST');return {deployment:deployment()};});
 const lookup=publicationLookup(module.database,sql,driveId);
 tools.lookupReportPublicationV1=toolWithCallback({name:'lookupReportPublicationV1',description:'Fixed-Drive native-head-verified exact publication identity lookup; producer only.',inputSchema:{reportRef:z.string().min(1).max(1000)},outputSchema:{lookup:z.unknown()}},async args=>{if(Object.keys(args).length!==1)throw Error('PUBLICATION_LOOKUP_REQUEST');return bounded(module,async()=>({lookup:await lookup(args.reportRef,AbortSignal.timeout(5000))}));});
 return tools;
}
