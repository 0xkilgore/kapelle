import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync,writeFileSync,openSync,closeSync,fsyncSync,linkSync,unlinkSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {ReportRegistryMcp} from './mcp-client.ts';
import {buildPromotionRequestPlan,promotePromotionRequest,toPromoteReportInput,type AdmittedPromotionRequest,type PromotionRequestRuntime} from './promotion-request.ts';
import {verifyRegisteredReport,legacyUnpublished,promotionIntentName} from './promote.ts';
import {parseAgentSnapshot,type AgentSnapshot} from './publication-metadata.ts';

export type PrivatePublicationBinding = {
 schemaVersion:'kapelle.private-report-publisher.v1'; driveId:string; actorId:string;
 author:AgentSnapshot; publisher:AgentSnapshot; authorizationRef:string;
 reportRef:string; sourceRef:string; contentHash:string; publicationId:string;
 libraryOrigin:string; nativePublicationSchema:'kilgore/report.publication.v1';
};
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw Error('PRIVATE_PUBLICATION_RESPONSE_INVALID');return value as Record<string,unknown>;}
export function readPrivateJSON(path:string):Record<string,unknown>{
 const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o077)||s.size>65536||realpathSync(path)!==path)throw Error('PRIVATE_PUBLICATION_CONFIG_UNSAFE');return record(JSON.parse(readFileSync(path,'utf8')));
}
export function readPrivateReaderProfile(path:string){
 const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o077)||s.size>65536||realpathSync(path)!==path)throw Error('PRIVATE_PUBLICATION_CONFIG_UNSAFE');
 const values:Record<string,string>={};for(const line of readFileSync(path,'utf8').split('\n')){const match=/^(KAPELLE_REPORT_REGISTRY_(?:MCP_URL|MCP_TOKEN|DRIVE_ID))='([^']*)'$/.exec(line);if(match){if(values[match[1]])throw Error('PRIVATE_PUBLICATION_READER_PROFILE_INVALID');values[match[1]]=match[2];}}
 if(!values.KAPELLE_REPORT_REGISTRY_MCP_URL||!values.KAPELLE_REPORT_REGISTRY_MCP_TOKEN||!values.KAPELLE_REPORT_REGISTRY_DRIVE_ID)throw Error('PRIVATE_PUBLICATION_READER_PROFILE_INVALID');
 return {endpoint:values.KAPELLE_REPORT_REGISTRY_MCP_URL,token:values.KAPELLE_REPORT_REGISTRY_MCP_TOKEN,driveId:values.KAPELLE_REPORT_REGISTRY_DRIVE_ID};
}
/** Same canonical form as deploy/report-summary-read/deployment.mjs (sorted [relative path, sha256] pairs). */
export function modelInventoryDigest(inventory:Record<string,unknown>):string{
 const keys=Object.keys(inventory).sort();return createHash('sha256').update(JSON.stringify(keys.map(k=>[k,inventory[k]]))).digest('hex');
}
const MAX_ADMISSION_VALIDITY_MS=31*24*3600*1000;
/** Host model admission (v2): the record's own claims (exact 49-file runtime inventory = this
 * package's pin, schema hash, endpoint, Drive) PLUS a binding to one Registry deployment (releaseId + model digest of the
 * inventory) and a bounded validity window. v1 records (no deployment binding) are refused. Returns the admitted deployment. */
export function assertNativeModelAdmission(value:unknown,endpoint:string,driveId:string,now=new Date()){
 const v=record(value);const inventory=JSON.parse(readFileSync(new URL('../deploy/report-listing-runtime/model-inventory.json',import.meta.url),'utf8'));
 if(!isDeepStrictEqual(v.runtimeInventory,inventory)||Object.keys(inventory).length!==49)throw Error('PRIVATE_PUBLICATION_MODEL_INVENTORY_NOT_ADMITTED');
 const schema=readFileSync(new URL('../document-models/report-registry/v1/schema.graphql',import.meta.url));
 if(!schema.toString().includes('input ReportPublicationInput'))throw Error('PRIVATE_PUBLICATION_MODEL_SOURCE_REQUIRED');
 if(v.schemaVersion!=='kapelle.report-publication-model-admission.v2'||v.status!=='QUALIFIED_LIVE'||v.endpoint!==endpoint||v.driveId!==driveId||v.nativeSchemaHash!==createHash('sha256').update(schema).digest('hex')||typeof v.releaseReceiptRef!=='string'||!v.releaseReceiptRef)throw Error('PRIVATE_PUBLICATION_MODEL_NOT_ADMITTED');
 const d=record(v.deployment),until=typeof v.validUntil==='string'?Date.parse(v.validUntil):NaN;
 if(typeof d.releaseId!=='string'||!/^[A-Za-z0-9._:@-]{1,200}$/.test(d.releaseId)||d.modelDigest!==modelInventoryDigest(inventory))throw Error('PRIVATE_PUBLICATION_MODEL_DEPLOYMENT_NOT_ADMITTED');
 if(!Number.isFinite(until)||new Date(until).toISOString()!==v.validUntil||until<=now.getTime()||until-now.getTime()>MAX_ADMISSION_VALIDITY_MS)throw Error('PRIVATE_PUBLICATION_MODEL_ADMISSION_EXPIRED');
 return {releaseId:d.releaseId,modelDigest:d.modelDigest as string};
}
export type LiveDeployment={bootId:string;releaseId:string;modelDigest:string};
/** The generation string the proxy enforces at each mutation (same form as its registryGeneration). */
export function deploymentGeneration(d:LiveDeployment){return `v1:${d.releaseId}:${d.modelDigest}:${d.bootId}`;}
/** The Registry deployment actually behind the producer endpoint now (native getRegistryDeploymentV1): its boot and current
 * release id and loaded-model digest must all equal the admitted deployment. */
export async function assertLiveDeployment(mcp:ReportRegistryMcp,admitted:{releaseId:string;modelDigest:string},driveId:string):Promise<LiveDeployment>{
 let d:Record<string,unknown>;try{d=record(record(await mcp.call('getRegistryDeploymentV1',{})).deployment);}catch(e){throw Error('PRIVATE_PUBLICATION_MODEL_DEPLOYMENT_UNAVAILABLE');}
 if(d.schemaVersion!=='kapelle.registry-deployment.v1'||d.driveId!==driveId||typeof d.bootId!=='string'||!d.bootId)throw Error('PRIVATE_PUBLICATION_MODEL_DEPLOYMENT_UNAVAILABLE');
 if(d.bootReleaseId!==admitted.releaseId||d.releaseId!==admitted.releaseId||d.bootModelDigest!==admitted.modelDigest||d.currentModelDigest!==admitted.modelDigest)throw Error('PRIVATE_PUBLICATION_MODEL_DEPLOYMENT_MISMATCH');
 return {bootId:d.bootId,releaseId:admitted.releaseId,modelDigest:admitted.modelDigest};
}
export function parsePrivateBinding(value:unknown):PrivatePublicationBinding {
 const v=record(value);if(v.schemaVersion!=='kapelle.private-report-publisher.v1'||v.nativePublicationSchema!=='kilgore/report.publication.v1')throw Error('PRIVATE_PUBLICATION_BINDING_INVALID');
 for(const key of ['driveId','actorId','authorizationRef','reportRef','sourceRef','contentHash','publicationId','libraryOrigin'])if(typeof v[key]!=='string'||!String(v[key]).trim()||String(v[key]).length>4000)throw Error('PRIVATE_PUBLICATION_BINDING_INVALID');
 const origin=new URL(String(v.libraryOrigin));if(origin.origin!==v.libraryOrigin||origin.username||origin.password||origin.search||origin.hash||!(origin.protocol==='https:'||(origin.protocol==='http:'&&['localhost','127.0.0.1'].includes(origin.hostname))))throw Error('PRIVATE_PUBLICATION_ORIGIN_INVALID');
 return {...v,author:parseAgentSnapshot(v.author),publisher:parseAgentSnapshot(v.publisher)} as PrivatePublicationBinding;
}
export function assertPrivateBinding(admitted:AdmittedPromotionRequest,runtime:PromotionRequestRuntime,binding:PrivatePublicationBinding){
 const p=admitted.request.publication;
 if(!p)throw Error('PRIVATE_PUBLICATION_METADATA_REQUIRED');
 if(binding.driveId!==runtime.driveId||binding.actorId!==runtime.actorId||binding.reportRef!==admitted.request.reportRef||binding.sourceRef!==p.sourceRef||binding.contentHash!==p.contentHash||binding.publicationId!==p.publicationId||binding.authorizationRef!==p.authorizationRef||!isDeepStrictEqual(binding.author,p.author)||!isDeepStrictEqual(binding.publisher,p.publisher))throw Error('PRIVATE_PUBLICATION_AUTHORITY_MISMATCH');
}
function ids(value:unknown,driveId:string):string[]{
 const v=record(value);const list=v.documentIds;
 if(v.schemaVersion!=='kapelle.report-drive-snapshot.v1'||v.driveId!==driveId||v.branch!=='main'||v.complete!==true||v.hasMore!==false||v.nextCursor!==null||typeof v.snapshotDigest!=='string'||! /^[a-f0-9]{64}$/.test(v.snapshotDigest))throw Error('PRIVATE_PUBLICATION_LIST_INCOMPLETE');
 if(!Array.isArray(list)||list.length>10000||list.some(x=>typeof x!=='string'||!x||x.length>256)||new Set(list).size!==list.length||v.totalCount!==list.length)throw Error('PRIVATE_PUBLICATION_LIST_INCOMPLETE');return list;
}
function same(a:string[],b:string[]){const values=new Set(b);return a.length===b.length&&a.every(x=>values.has(x));}
/** Fresh native snapshot on each scope check; no Drive-body hydration or cross-call authority cache. */
export class CompletePrivateReportMcp implements ReportRegistryMcp {
 readonly inner:ReportRegistryMcp; readonly driveId:string; readonly started=Date.now();
 bytes=0; known=new Set<string>(); listed=false; independentChecked=false; reader?:ReportRegistryMcp;
 readonly callWithStart?:ReportRegistryMcp["callWithStart"];
 readonly deadlineMs:number;
 constructor(inner:ReportRegistryMcp,driveId:string,reader?:ReportRegistryMcp,deadlineMs=30000){this.inner=inner;this.driveId=driveId;this.reader=reader;this.deadlineMs=deadlineMs;if(inner.callWithStart)this.callWithStart=(name,args,beforeSend)=>this.invoke(name,args,beforeSend);}
 async raw(name:string,args:Record<string,unknown>,client:ReportRegistryMcp=this.inner,beforeSend?:()=>void){
  if(Date.now()-this.started>this.deadlineMs)throw Error('PRIVATE_PUBLICATION_READ_DEADLINE');
  const result=await (beforeSend?client.callWithStart!(name,args,beforeSend):client.call(name,args));this.bytes+=Buffer.byteLength(JSON.stringify(result));
  if(this.bytes>64000000||Date.now()-this.started>this.deadlineMs)throw Error('PRIVATE_PUBLICATION_READ_BOUND');return result;
 }
 async completeList(){
  const result=record(await this.raw('getDocuments',{parentId:this.driveId}));
  if(result.schemaVersion!=='kapelle.report-drive-snapshot.v1'||result.driveId!==this.driveId||result.branch!=='main'||result.complete!==true||result.hasMore!==false||result.nextCursor!==null||typeof result.snapshotDigest!=='string'||!/^[a-f0-9]{64}$/.test(result.snapshotDigest))throw Error('PRIVATE_PUBLICATION_LIST_INCOMPLETE');
  return ids(result,this.driveId);
 }
 async call(name:string,args:Record<string,unknown>):Promise<unknown>{return this.invoke(name,args);}
 private async invoke(name:string,args:Record<string,unknown>,beforeSend?:()=>void):Promise<unknown>{
  if(name==='getDocuments'){
   if(args.parentId!==this.driveId)throw Error('PRIVATE_PUBLICATION_SCOPE_MISMATCH');const listed=await this.completeList();this.known=new Set(listed);this.listed=true;return {documentIds:listed};
  }
  if(name==='getReportIdentities'){
   if(args.parentId!==this.driveId)throw Error('PRIVATE_PUBLICATION_SCOPE_MISMATCH');
   const result=await this.raw(name,args),listed=ids(result,this.driveId);
   if(this.listed&&!same([...this.known],listed))throw Error('PRIVATE_PUBLICATION_IDENTITIES_INCOMPLETE');
   if(this.reader&&!this.independentChecked){
    const independent=ids(await this.raw('getDocuments',{parentId:this.driveId},this.reader),this.driveId);
    if(!same(listed,independent))throw Error('PRIVATE_PUBLICATION_READER_INCOMPLETE');
    this.independentChecked=true;
   }
   this.known=new Set(listed);this.listed=true;return result;
  }
  if(name==='createDocument'){
   if(!this.listed||args.driveId!==this.driveId||args.documentType!=='kilgore/report'||!same([...this.known],await this.completeList()))throw Error('PRIVATE_PUBLICATION_MEMBERSHIP_CHANGED');
   const created=record(await this.raw(name,args,this.inner,beforeSend));const doc=created.document?record(created.document):null;const id=created.documentId??(doc?record(doc.header).id:null);if(typeof id!=='string'||!id)throw Error('PRIVATE_PUBLICATION_CREATE_UNCERTAIN');this.known.add(id);return created;
  }
  if(name==='getDocument'||name==='addActions'){
   const id=name==='getDocument'?args.id:args.documentId;if(typeof id!=='string'||!this.known.has(id))throw Error('PRIVATE_PUBLICATION_SCOPE_MISMATCH');
   if(name==='addActions'&&!same([...this.known],await this.completeList()))throw Error('PRIVATE_PUBLICATION_MEMBERSHIP_CHANGED');
   const result=await this.raw(name,args);
   if(name==='getDocument'&&record(record(result).document).header&&record(record(record(result).document).header).id!==id)throw Error('PRIVATE_PUBLICATION_READBACK_IDENTITY');return result;
  }
  throw Error('PRIVATE_PUBLICATION_TOOL_FORBIDDEN');
 }
}
/** Task publications bind reportRef to publicationId ('report:task:'+hex <-> 'task-report:'+hex), so a publicationId can never
 * appear under another reportRef and a reportRef-keyed native lookup is a complete identity proof. Only these use the
 * listing-free path; other private publications keep CompletePrivateReportMcp (its publicationId collision scan). */
export function derivedTaskIdentity(binding:{publicationId:string;reportRef:string}):boolean{
 const m=/^task-report:([a-f0-9]{64})$/.exec(binding.publicationId);return !!m&&binding.reportRef==='report:task:'+m[1];
}
type PointRead={document:{header:{id:string;name:string;documentType:string};state:{global:Record<string,unknown>}};blank:boolean;lifecycle:unknown;revision:unknown};
/** Scale bridge: the private publication boundary WITHOUT any full-Drive listing.
 * Identity/absence for THIS reportRef = native lookupReportPublicationV1 (head-verified, two captures); every selected read =
 * the scoped native point proof getReportDocumentV1 (fixed-Drive membership + that document's heads only). Before create the
 * lookup must still be 0/0; before addActions it must still select exactly this document; a timeout/unverified lookup refuses
 * (never read as absence, no fallback to listing). Same read deadline/byte bounds as CompletePrivateReportMcp. */
export class PointPrivateReportMcp implements ReportRegistryMcp {
 readonly inner:ReportRegistryMcp; readonly driveId:string; readonly reportRef:string; readonly reader:ReportRegistryMcp; readonly started=Date.now();
 readonly deadlineMs:number; bytes=0; known=new Set<string>(); answered:NativeLookup|null=null;
 /** Model-admission fence: the admitted live deployment must be unchanged before create, before addActions and after addActions. */
 fence?:()=>Promise<void>;
 /** The admitted Registry deployment generation, sent with every create/register so the proxy enforces it AT the write. */
 generation?:string;
 readonly callWithStart?:ReportRegistryMcp["callWithStart"];
 constructor(inner:ReportRegistryMcp,driveId:string,reportRef:string,reader:ReportRegistryMcp,deadlineMs=30000){
  this.inner=inner;this.driveId=driveId;this.reportRef=reportRef;this.reader=reader;this.deadlineMs=deadlineMs;
  if(inner.callWithStart)this.callWithStart=(name,args,beforeSend)=>this.invoke(name,args,beforeSend);
 }
 async raw(name:string,args:Record<string,unknown>,client:ReportRegistryMcp=this.inner,beforeSend?:()=>void){
  if(Date.now()-this.started>this.deadlineMs)throw Error('PRIVATE_PUBLICATION_READ_DEADLINE');
  const result=await (beforeSend?client.callWithStart!(name,args,beforeSend):client.call(name,args));this.bytes+=Buffer.byteLength(JSON.stringify(result));
  if(this.bytes>64000000||Date.now()-this.started>this.deadlineMs)throw Error('PRIVATE_PUBLICATION_READ_BOUND');return result;
 }
 lookup(){return nativeLookup({call:(name,args)=>this.raw(name,args)},this.driveId,this.reportRef);}
 /** Scoped native proof for one document; the client decides the role (producer = this.inner, independent reader = this.reader). */
 async pointRead(id:string,client:ReportRegistryMcp=this.inner):Promise<PointRead>{
  const read=record(record(await this.raw('getReportDocumentV1',{id},client)).read),doc=record(read.document),header=record(doc.header),global=record(record(doc.state).global);
  if(read.schemaVersion!=='kapelle.report-document-read.v1'||read.driveId!==this.driveId||read.documentId!==id||header.id!==id||header.documentType!=='kilgore/report'||typeof header.name!=='string'||typeof read.blank!=='boolean'||read.lifecycle!==global.lifecycle||read.revision!==global.revision)throw Error('PRIVATE_PUBLICATION_POINT_READ_INVALID');
  return {document:{header:{id,name:header.name,documentType:'kilgore/report'},state:{global}},blank:read.blank,lifecycle:read.lifecycle,revision:read.revision};
 }
 async call(name:string,args:Record<string,unknown>):Promise<unknown>{return this.invoke(name,args);}
 private async invoke(name:string,args:Record<string,unknown>,beforeSend?:()=>void):Promise<unknown>{
  if(name==='getReportIdentities'){
   // promote's identity scan, answered for THIS reportRef only: the registered and pending sets V1 proves complete.
   if(args.parentId!==this.driveId)throw Error('PRIVATE_PUBLICATION_SCOPE_MISMATCH');
   const l=await this.lookup();
   if(l.registeredCount+l.pendingCount>1)throw Error('PRIVATE_PUBLICATION_ID_CONFLICT');
   this.answered=l;this.known=new Set(l.documents.map(d=>d.header.id));
   const identities=l.documents.map(d=>{const g=record(d.state.global);return {header:{id:d.header.id,name:d.header.name,documentType:'kilgore/report'},state:{global:{reportRef:typeof g.reportRef==='string'?g.reportRef:'',publication:g.publication??null}}};});
   const documentIds=identities.map(i=>i.header.id);
   return {schemaVersion:'kapelle.report-drive-snapshot.v1',driveId:this.driveId,branch:'main',complete:true,documentIds,totalCount:documentIds.length,hasMore:false,nextCursor:null,
    snapshotDigest:createHash('sha256').update(JSON.stringify(identities)).digest('hex'),identities};
  }
  if(name==='getDocument'){
   const id=args.id;if(typeof id!=='string'||!this.known.has(id))throw Error('PRIVATE_PUBLICATION_SCOPE_MISMATCH');
   return {document:(await this.pointRead(id)).document};
  }
  if(name==='createDocument'){
   if(!this.answered||this.answered.registeredCount+this.answered.pendingCount!==0||args.driveId!==this.driveId||args.documentType!=='kilgore/report')throw Error('PRIVATE_PUBLICATION_MEMBERSHIP_CHANGED');
   const now=await this.lookup();if(now.registeredCount+now.pendingCount!==0)throw Error('PRIVATE_PUBLICATION_MEMBERSHIP_CHANGED');
   await this.fence?.();
   const created=record(await this.raw(name,this.generation?{...args,expectedRegistryGeneration:this.generation}:args,this.inner,beforeSend));const doc=created.document?record(created.document):null;const id=created.documentId??(doc?record(doc.header).id:null);
   if(typeof id!=='string'||!id)throw Error('PRIVATE_PUBLICATION_CREATE_UNCERTAIN');this.known.add(id);return created;
  }
  if(name==='addActions'){
   const id=args.documentId;if(typeof id!=='string'||!this.known.has(id))throw Error('PRIVATE_PUBLICATION_SCOPE_MISMATCH');
   // The native lookup must still select exactly this document (its blank intent, or the registered Report for attention).
   const now=await this.lookup();if(now.registeredCount+now.pendingCount!==1||now.documents[0]?.header.id!==id)throw Error('PRIVATE_PUBLICATION_MEMBERSHIP_CHANGED');
   await this.fence?.();
   const result=await this.raw(name,this.generation?{...args,expectedRegistryGeneration:this.generation}:args,this.inner,beforeSend);
   // A restart into another deployment between the check and the send is caught here: never claim this write.
   await this.fence?.();return result;
  }
  throw Error('PRIVATE_PUBLICATION_TOOL_FORBIDDEN');
 }
}
export async function publishPrivateRequest(admitted:AdmittedPromotionRequest,runtime:PromotionRequestRuntime,binding:PrivatePublicationBinding,mcp:ReportRegistryMcp,reader:ReportRegistryMcp,fence?:()=>Promise<void>,generation?:string){
 assertPrivateBinding(admitted,runtime,binding);
 const point=derivedTaskIdentity(binding);
 const guarded=point?new PointPrivateReportMcp(mcp,runtime.driveId,binding.reportRef,reader):new CompletePrivateReportMcp(mcp,runtime.driveId,reader);
 if(fence||generation){if(!(guarded instanceof PointPrivateReportMcp))throw Error('PRIVATE_PUBLICATION_MODEL_FENCE_REQUIRES_TASK_IDENTITY');guarded.fence=fence;guarded.generation=generation;}
 const receipt=await promotePromotionRequest(admitted,{...runtime,publicationBinding:binding},guarded);
 const doc=record(record(await guarded.call('getDocument',{id:receipt.documentId})).document);const state=record(record(doc.state).global);const content=record(state.content);const markdown=content.markdown;
 if(typeof markdown!=='string'||!Buffer.from(markdown).equals(admitted.content.bytes)||createHash('sha256').update(markdown).digest('hex')!==receipt.contentHash||!(isDeepStrictEqual(state.publication,admitted.request.publication)||legacyUnpublished(state))||state.createdBy!==runtime.actorId||!Number.isSafeInteger(state.revision))throw Error('PRIVATE_PUBLICATION_READBACK_MISMATCH');
 if(guarded instanceof PointPrivateReportMcp){
  // No listing: the native lookup must now select exactly this registered Report, and the independent reader's own scoped
  // proof must return the same state.
  const final=await guarded.lookup();if(final.registeredCount!==1||final.pendingCount!==0||final.documents[0].header.id!==receipt.documentId)throw Error('PRIVATE_PUBLICATION_MEMBERSHIP_CHANGED');
  const readerDoc=(await guarded.pointRead(receipt.documentId,reader)).document;if(readerDoc.header.id!==receipt.documentId||!isDeepStrictEqual(readerDoc.state.global,state))throw Error('PRIVATE_PUBLICATION_READER_READBACK_MISMATCH');
 }else{
 const finalIds=await guarded.completeList();if(!finalIds.includes(receipt.documentId))throw Error('PRIVATE_PUBLICATION_MEMBERSHIP_CHANGED');
 if(!same(finalIds,ids(await guarded.raw('getDocuments',{parentId:runtime.driveId},reader),runtime.driveId)))throw Error('PRIVATE_PUBLICATION_READER_INCOMPLETE');
 const readerDoc=record(record(await guarded.raw('getDocument',{id:receipt.documentId},reader)).document);if(record(readerDoc.header).id!==receipt.documentId||!isDeepStrictEqual(record(readerDoc.state).global,state))throw Error('PRIVATE_PUBLICATION_READER_READBACK_MISMATCH');
 }
 const result={receipt,publicationId:admitted.request.publication!.publicationId,planDigest:buildPromotionRequestPlan(admitted).planDigest,verifiedRevision:state.revision,libraryUrl:binding.libraryOrigin+'/ops/library/'+encodeURIComponent(receipt.documentId),verification:'exact-native-readback' as const,libraryVisibility:'requires-authenticated-console-read' as const};
 const verificationReceiptPath=receipt.receiptPath+'.private.json';
 if(existsSync(verificationReceiptPath)){const saved=readPrivateJSON(verificationReceiptPath);if(saved.publicationId!==result.publicationId||saved.planDigest!==result.planDigest||saved.libraryUrl!==result.libraryUrl||record(saved.receipt).documentId!==receipt.documentId)throw Error('PRIVATE_PUBLICATION_VERIFICATION_CONFLICT');}
 else {const temp=verificationReceiptPath+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify({...result,verifiedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600,flag:'wx'});const fd=openSync(temp,'r');try{fsyncSync(fd);}finally{closeSync(fd);}try{linkSync(temp,verificationReceiptPath);}finally{unlinkSync(temp);}const dir=openSync(dirname(verificationReceiptPath),'r');try{fsyncSync(dir);}finally{closeSync(dir);}}
 return {...result,verificationReceiptPath};
}

type NativeLookup={registeredCount:number;pendingCount:number;memberCount:number;documents:{header:{id:string;name:string;documentType:string};state:{global:Record<string,unknown>}}[]};
/** Strict parse of lookupReportPublicationV1 {lookup}: exact drive/reportRef/intent echo, safe counts, at most one body. */
async function nativeLookup(mcp:ReportRegistryMcp,driveId:string,reportRef:string):Promise<NativeLookup>{
 const v=record(record(await mcp.call('lookupReportPublicationV1',{reportRef})).lookup);
 if(v.schemaVersion!=='kapelle.publication-lookup.v1'||v.driveId!==driveId||v.reportRef!==reportRef||v.intentName!==promotionIntentName(reportRef))throw Error('PRIVATE_PUBLICATION_LOOKUP_INVALID');
 const counts=[v.registeredCount,v.pendingCount,v.memberCount];
 if(counts.some(n=>!Number.isSafeInteger(n)||(n as number)<0)||(v.registeredCount as number)+(v.pendingCount as number)>(v.memberCount as number)||!Array.isArray(v.documents)||v.documents.length>1)throw Error('PRIVATE_PUBLICATION_LOOKUP_INVALID');
 const documents=v.documents.map(d=>{const header=record(record(d).header),global=record(record(record(d).state).global);if(typeof header.id!=='string'||!header.id||header.documentType!=='kilgore/report'||typeof header.name!=='string')throw Error('PRIVATE_PUBLICATION_LOOKUP_INVALID');return {header:{id:header.id,name:header.name,documentType:header.documentType},state:{global}};});
 if(documents.length!==(v.registeredCount===1&&v.pendingCount===0||v.registeredCount===0&&v.pendingCount===1?1:0))throw Error('PRIVATE_PUBLICATION_LOOKUP_INVALID');
 return {registeredCount:v.registeredCount as number,pendingCount:v.pendingCount as number,memberCount:v.memberCount as number,documents};
}
/** No promotion, lock, create-intent, attention action or receipt file writes.
 * A blank create intent is pending. A FINAL registered Report is complete even if
 * an optional attention action was interrupted (attention is independently mutable).
 * Both clients must be host-admitted for this Drive; scope is never inferred from a Report. */
export async function lookupPrivateRequest(admitted:AdmittedPromotionRequest,runtime:PromotionRequestRuntime,binding:PrivatePublicationBinding,mcp:ReportRegistryMcp,reader:ReportRegistryMcp){
 const plan=buildPromotionRequestPlan(admitted);
 assertPrivateBinding(admitted,runtime,binding);
 if(runtime.planDigest!==plan.planDigest)throw Error('PROMOTION_PLAN_DIGEST_MISMATCH');
 // Read-only lookup through the native lookupReportPublicationV1: one Reactor-side READ ONLY
 // transaction that head-verifies every member, captures twice and compares (fails closed on any change), instead of
 // about six full-drive snapshots through the proxy. Same 60 s bound; no write is possible on this path (wrapper below).
 // Scale bridge B: no listing at all. Selected reads are scoped native proofs (getReportDocumentV1), producer and independent
 // reader each with its own credential. Same 60 s bound; no write is possible on this path (wrapper below).
 const guarded=new PointPrivateReportMcp(mcp,runtime.driveId,binding.reportRef,reader,60000);
 const readonly:ReportRegistryMcp={call:(name,args)=>{
  if(!['lookupReportPublicationV1','getReportDocumentV1'].includes(name))throw Error('PRIVATE_PUBLICATION_LOOKUP_WRITE_FORBIDDEN');
  return guarded.raw(name,args,mcp);
 }};
 const first=await nativeLookup(readonly,runtime.driveId,binding.reportRef);
 // Classification: 1/0 registered candidate; 0/1 pending blank intent and 0/0 absent (both: not published yet); else conflict.
 if(first.registeredCount===0&&first.pendingCount<=1)return null;
 if(first.registeredCount!==1||first.pendingCount!==0||first.documents.length!==1)throw Error('PRIVATE_PUBLICATION_ID_CONFLICT');
 const candidate=first.documents[0].header.id;
 // The candidate's Drive membership is proven per read by the scoped native proof (producer here, independent reader below);
 // no listing is consulted (it was the cost this bridge removes).
 const response={document:(await guarded.pointRead(candidate)).document};
 const doc=record(response.document);if(record(doc.header).id!==candidate)throw Error('PRIVATE_PUBLICATION_READBACK_IDENTITY');
 const state=record(record(doc.state).global);
 if(state.reportRef!==binding.reportRef)throw Error('PRIVATE_PUBLICATION_ID_CONFLICT');
 // Old (47-file) Registry model compatibility (Option C, unchanged): a UNIQUE reportRef match with no publication value is
 // accepted with every other check strict; otherwise the stored publication must equal this request's exactly.
 if(!legacyUnpublished(state)&&!isDeepStrictEqual(state.publication,admitted.request.publication))throw Error('PRIVATE_PUBLICATION_METADATA_CONFLICT');
 if(state.lifecycle==='DRAFT')return null;
 const document=verifyRegisteredReport(response,toPromoteReportInput(admitted,runtime,admitted.request.contentPath),{
  filename:admitted.content.filename,markdown:admitted.content.bytes.toString('utf8'),hash:admitted.content.contentHash,byteSize:admitted.content.byteSize,
 });
 const independent=(await guarded.pointRead(document.header.id,reader)).document as unknown as Record<string,unknown>;
 if(record(independent.header).id!==document.header.id||record(independent.header).documentType!=='kilgore/report'||!isDeepStrictEqual(record(independent.state).global,state))throw Error('PRIVATE_PUBLICATION_READER_READBACK_MISMATCH');
 // A previously blank document can register the same reportRef without changing membership. One more native lookup at the
 // end must classify identically (same counts, same single candidate) before completion is accepted.
 const last=await nativeLookup(readonly,runtime.driveId,binding.reportRef);
 if(last.registeredCount!==first.registeredCount||last.pendingCount!==first.pendingCount||last.memberCount!==first.memberCount||last.documents[0]?.header.id!==candidate)throw Error('PRIVATE_PUBLICATION_IDENTITIES_CHANGED');
 // Stable across attention/revision updates: the proof identifies independently verified
 // immutable publication bytes and plan, not the mutable document revision or a local path.
 const publication=admitted.request.publication!;
 const verificationRef='private-report:'+createHash('sha256').update(JSON.stringify({driveId:runtime.driveId,documentId:document.header.id,planDigest:plan.planDigest})).digest('hex');
 return {documentId:document.header.id,driveId:runtime.driveId,reportRef:String(state.reportRef),sourceRef:String(state.sourceRef),
  producerId:String(record(state.producer).id),revision:Number(state.revision),publication,markdown:admitted.content.bytes.toString('utf8'),
  planDigest:plan.planDigest,verificationRef};
}
