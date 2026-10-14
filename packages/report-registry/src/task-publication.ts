/** Host-installed Task bridge for the EXISTING private publisher. No listener,
 * scheduler, credentials, model admission bypass, alternate Registry or outbox.
 * The host must admit native model, actual Agent/authorization and independent
 * reader scope in authorize() on EVERY operation. Unavailable admission is null. */
import {createHash,randomUUID} from 'node:crypto';
import {constants,readdirSync,existsSync,mkdirSync,lstatSync,realpathSync,openSync,fstatSync,readFileSync,writeFileSync,fsyncSync,closeSync,linkSync,unlinkSync} from 'node:fs';
import {join,isAbsolute,basename,dirname} from 'node:path';
import type {Stats} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import type {ReportRegistryMcp} from './mcp-client.ts';
import {parseAgentSnapshot,type AgentSnapshot} from './publication-metadata.ts';
import {buildPromotionRequestPlan,parsePromotionRequest,type AdmittedPromotionRequest} from './promotion-request.ts';
import {acquireDeployLock} from './deploy-lock.ts';
import {publishPrivateRequest,lookupPrivateRequest,parsePrivateBinding,assertNativeModelAdmission,assertLiveDeployment,deploymentGeneration} from './private-publication.ts';

export type TaskPublicationRequest={publicationId:string;ownerId:string;scopeRef:string;instanceId:string;dispatchId:string;inputHash:string;taskId:string;sourceRef:string;packetHash:string;executionHash:string;markdown:string;contentHash:string};
export type TaskPublisherAdmission={bindingRef:string;ownerId:string;scopeRef:string;driveId:string;actorId:string;authorizationRef:string;libraryOrigin:string;author:AgentSnapshot;publisher:AgentSnapshot};
export type TaskPublisherOptions={
 bindingRef:string;receiptDir:string;lockDir:string;mcp:ReportRegistryMcp;reader:ReportRegistryMcp;
 /** Fresh host authority, NOT an assertion accepted from the Task/browser. Definition
  * hashes in host snapshots use sha256: form; persisted/native metadata uses bare hex. */
 authorize:(request:TaskPublicationRequest)=>Promise<TaskPublisherAdmission|null>;
 now?:()=>string;
 /** Host-owned live Registry model admission (QUALIFIED_LIVE v2: exact 49-file runtime inventory, schema hash, endpoint,
  * Drive, bound to one Registry deployment, bounded validity). Required to PUBLISH; lookup/read of existing Reports do not
  * need it. Prefer {load}: the host re-reads (and re-hashes) its owner file on every check, so withdrawal is effective. */
 modelAdmission?:{value:unknown;endpoint:string}|{load:()=>Promise<{value:unknown;endpoint:string}>};
 /** Registry deploy lock (local single-machine Registry): a SHARED flock held across the model check, create, register and
  * readback; the deploy/restart tooling takes it EXCLUSIVE before stopping or starting the Reactor. */
 deployLock?:{path:string;timeoutMs?:number};
};
function canonical(v:unknown):string {
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(v&&typeof v==='object')return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';
 return JSON.stringify(v);
}
function hash(v:string){return createHash('sha256').update(v).digest('hex');}
function bare(v:string){if(!/^sha256:[a-f0-9]{64}$/.test(v))throw Error('TASK_PUBLICATION_HASH_INVALID');return v.slice(7);}
function parseRequest(value:TaskPublicationRequest):TaskPublicationRequest {
 const r=structuredClone(value),keys=['publicationId','ownerId','scopeRef','instanceId','dispatchId','inputHash','taskId','sourceRef','packetHash','executionHash','markdown','contentHash'];
 if(Object.keys(r).length!==keys.length||keys.some(k=>typeof (r as any)[k]!=='string'||!(r as any)[k]||(k!=='markdown'&&(r as any)[k].length>200)))throw Error('TASK_PUBLICATION_REQUEST_INVALID');
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.dispatchId)||r.markdown.length>32000||!r.markdown.trim()||r.sourceRef!=='dispatch:'+r.dispatchId)throw Error('TASK_PUBLICATION_REQUEST_INVALID');
 for(const h of [r.inputHash,r.packetHash,r.executionHash,r.contentHash])bare(h);
 if(hash(r.markdown)!==bare(r.contentHash)||r.publicationId!=='task-report:'+hash(canonical({dispatchId:r.dispatchId,inputHash:r.inputHash})))throw Error('TASK_PUBLICATION_IDENTITY_MISMATCH');
 return r;
}
function agent(value:AgentSnapshot){return parseAgentSnapshot({...value,definitionHash:value.definitionHash===null?null:bare(value.definitionHash)});}
type Saved={schemaVersion:'kapelle.task-publication-plan.v1';request:TaskPublicationRequest;admission:TaskPublisherAdmission;publishedAt:string;planDigest:string};

/** link(temp, final) exclusively installs an already-fsynced inode. Two links are
 * valid ONLY while its one UUID staging alias remains inside the same private root.
 * Never accept an unexplained/external hard link; recovery must not unlink anything.
 * false means the installer unlinked that alias while this read was checking it. */
function retainedLinks(path:string,fd:number,state:Stats):boolean {
 if(state.nlink===1)return true;
 if(state.nlink!==2)throw Error('TASK_PUBLICATION_ARTIFACT_UNSAFE');
 const prefix=basename(path)+'.';let aliases=0;
 for(const name of readdirSync(dirname(path))){
  if(!name.startsWith(prefix)||! /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(name.slice(prefix.length)))continue;
  let alias:number;
  try{alias=openSync(join(dirname(path),name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw Error('TASK_PUBLICATION_ARTIFACT_UNSAFE');}
  try{const a=fstatSync(alias);if(a.dev===state.dev&&a.ino===state.ino){
   if(!a.isFile()||a.uid!==state.uid||(a.mode&0o077))throw Error('TASK_PUBLICATION_ARTIFACT_UNSAFE');aliases++;
  }}finally{closeSync(alias);}
 }
 const current=fstatSync(fd);
 if(current.nlink===1)return false; // bounded read retry; no cleanup or metadata repair
 if(current.nlink!==2||aliases!==1)throw Error('TASK_PUBLICATION_ARTIFACT_UNSAFE');
 return true;
}

export class PrivateTaskReportPublisher {
 readonly bindingRef:string;
 private readonly options:TaskPublisherOptions;
 constructor(options:TaskPublisherOptions){
  if(!options.bindingRef||!isAbsolute(options.receiptDir)||!isAbsolute(options.lockDir))throw Error('TASK_PUBLICATION_HOST_REQUIRED');
  this.bindingRef=options.bindingRef;this.options={...options};
 }
 private async admission(request:TaskPublicationRequest){
  const value=await this.options.authorize(structuredClone(request));if(!value)return null;
  const a=structuredClone(value);
  if(a.bindingRef!==this.bindingRef||a.ownerId!==request.ownerId||a.scopeRef!==request.scopeRef||a.author.id!==request.instanceId||a.author.instanceId!==request.instanceId)throw Error('TASK_PUBLICATION_ADMISSION_MISMATCH');
  // Validate host snapshots and binding using the same parsers as private CLI publication.
  const author=agent(a.author),publisher=agent(a.publisher);
  parsePrivateBinding({schemaVersion:'kapelle.private-report-publisher.v1',nativePublicationSchema:'kilgore/report.publication.v1',...a,author,publisher,reportRef:'report:task:'+request.publicationId.slice(12),sourceRef:request.sourceRef,contentHash:bare(request.contentHash),publicationId:request.publicationId});
  return a;
 }
 async admitted(value:TaskPublicationRequest){return (await this.admission(parseRequest(value)))!==null;}
 private path(publicationId:string){return join(this.options.receiptDir,'.task-plan-'+hash(publicationId)+'.json');}
 private root(create=false){
  const root=this.options.receiptDir;if(create)mkdirSync(root,{recursive:true,mode:0o700});
  if(!existsSync(root))return false;
  const s=lstatSync(root);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)||realpathSync(root)!==root)throw Error('TASK_PUBLICATION_ARTIFACT_ROOT_UNSAFE');
  return true;
 }
 private load(publicationId:string):Saved|null {
  if(!this.root())return null;const path=this.path(publicationId);
  for(let attempt=0;attempt<3;attempt++){let fd:number;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  try{
   const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid?.()||(s.mode&0o077)||s.size>262144)throw Error('TASK_PUBLICATION_ARTIFACT_UNSAFE');
   if(!retainedLinks(path,fd,s))continue;
   const data=readFileSync(fd),after=fstatSync(fd),named=lstatSync(path);
   if(named.isSymbolicLink()||named.dev!==s.dev||named.ino!==s.ino)throw Error('TASK_PUBLICATION_ARTIFACT_UNSAFE');
   if(s.size!==after.size||s.mtimeMs!==after.mtimeMs||s.mode!==after.mode||s.uid!==after.uid||data.length!==s.size)throw Error('TASK_PUBLICATION_ARTIFACT_CHANGED');
   // Unlink changes ctime, not content. Reread the now single-link inode instead
   // of ignoring ctime changes or spuriously refusing a concurrent safe install.
   if(s.nlink===2&&after.nlink===1)continue;
   if(s.ctimeMs!==after.ctimeMs||s.nlink!==after.nlink)throw Error('TASK_PUBLICATION_ARTIFACT_CHANGED');
   const saved=JSON.parse(data.toString('utf8')) as Saved;
   if(saved.schemaVersion!=='kapelle.task-publication-plan.v1'||parseRequest(saved.request).publicationId!==publicationId)throw Error('TASK_PUBLICATION_ARTIFACT_INVALID');
   const plan=this.plan(saved);if(plan.runtime.planDigest!==saved.planDigest)throw Error('TASK_PUBLICATION_PLAN_CHANGED');
   return saved;
  }finally{closeSync(fd);}
  }
  throw Error('TASK_PUBLICATION_ARTIFACT_CHANGED');
 }

 private plan(saved:Saved){
  const r=saved.request,a=saved.admission,author=agent(a.author),publisher=agent(a.publisher);
  const contentPath=join(this.options.receiptDir,'task-result.md');
  const request=parsePromotionRequest({schemaVersion:'report-promotion-request.v2',contentPath,title:'Task result: '+r.taskId,
   reportRef:'report:task:'+r.publicationId.slice(12),sourceRef:r.sourceRef,expectedContentHash:bare(r.contentHash),expectedByteSize:Buffer.byteLength(r.markdown),producer:{kind:'AGENT',id:author.id,label:author.label},attention:{request:'NONE'},occurredAt:saved.publishedAt,
   publication:{publicationId:r.publicationId,author,publisher,runRef:'kapelle-task://dispatch/'+r.dispatchId+'?input='+bare(r.inputHash),sourceRef:r.sourceRef,provenanceRef:'kapelle-task://execution/'+bare(r.executionHash)+'?packet='+bare(r.packetHash),contentHash:bare(r.contentHash),contentVersion:1,authorizationRef:a.authorizationRef,publishedAt:saved.publishedAt},
  });
  const admitted:AdmittedPromotionRequest={request,content:{filename:'task-result.md',bytes:Buffer.from(r.markdown),contentHash:bare(r.contentHash),byteSize:Buffer.byteLength(r.markdown)}};
  const runtime={confirmation:'promote-to-live-report-registry',planDigest:buildPromotionRequestPlan(admitted).planDigest,driveId:a.driveId,actorId:a.actorId,receiptDir:this.options.receiptDir,lockDir:this.options.lockDir};
  const binding=parsePrivateBinding({schemaVersion:'kapelle.private-report-publisher.v1',nativePublicationSchema:'kilgore/report.publication.v1',driveId:a.driveId,actorId:a.actorId,author,publisher,authorizationRef:a.authorizationRef,libraryOrigin:a.libraryOrigin,reportRef:request.reportRef,sourceRef:r.sourceRef,contentHash:bare(r.contentHash),publicationId:r.publicationId});
  return {admitted,runtime,binding};
 }
 private retain(request:TaskPublicationRequest,admission:TaskPublisherAdmission){
  const prior=this.load(request.publicationId);if(prior)return this.match(prior,request,admission);
  this.root(true);
  const saved:Saved={schemaVersion:'kapelle.task-publication-plan.v1',request,admission,publishedAt:this.options.now?.()??new Date().toISOString(),planDigest:''};
  saved.planDigest=this.plan(saved).runtime.planDigest;
  const path=this.path(request.publicationId),temp=path+'.'+randomUUID()+'.tmp';
  const fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(saved)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  try{try{linkSync(temp,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
  finally{unlinkSync(temp);}
  const dir=openSync(this.options.receiptDir,'r');try{fsyncSync(dir);}finally{closeSync(dir);}
  return this.match(this.load(request.publicationId)!,request,admission);
 }
 private match(saved:Saved,request:TaskPublicationRequest,admission:TaskPublisherAdmission){
  if(!isDeepStrictEqual(saved.request,request)||!isDeepStrictEqual(saved.admission,admission))throw Error('TASK_PUBLICATION_RETAINED_BINDING_CHANGED');return saved;
 }
 private async verify(saved:Saved){
  const current=await this.admission(saved.request);if(!current)throw Error('TASK_PUBLICATION_NOT_ADMITTED');
  this.match(saved,saved.request,current);const p=this.plan(saved);
  const result=await lookupPrivateRequest(p.admitted,p.runtime,p.binding,this.options.mcp,this.options.reader);
  if(!result)return null;
  // Scope comes from fresh host/reader admission, never invented native fields.
  return {...result,scope:{ownerId:current.ownerId,scopeRef:current.scopeRef,driveId:current.driveId,admissionRef:current.bindingRef}};
 }
 async lookup(value:TaskPublicationRequest){
  const request=parseRequest(value),a=await this.admission(request);if(!a)throw Error('TASK_PUBLICATION_NOT_ADMITTED');
  const saved=this.load(request.publicationId);return saved?this.verify(this.match(saved,request,a)):null;
 }
 /** Re-read the host admission, check its claims and the live Registry deployment. No file, lock or Registry write. */
 private async modelReady(driveId?:string){
  const source=this.options.modelAdmission;if(!source)throw Error('TASK_PUBLICATION_MODEL_NOT_ADMITTED');
  let current:{value:unknown;endpoint:string};
  try{current='load' in source?await source.load():source;}catch{throw Error('TASK_PUBLICATION_MODEL_NOT_ADMITTED');}
  // Readiness without a host Drive checks the Drive the admission names; publish always passes the host-authorized Drive.
  if(driveId===undefined){const named=(current.value as {driveId?:unknown}|null)?.driveId;if(typeof named!=='string')throw Error('PRIVATE_PUBLICATION_MODEL_NOT_ADMITTED');driveId=named;}
  // Validity uses the wall clock, never the plan-timestamp hook (options.now stamps the retained plan once).
  const admitted=assertNativeModelAdmission(current.value,current.endpoint,driveId,new Date());
  return assertLiveDeployment(this.options.mcp,admitted,driveId);
 }
 /** Publish readiness for a NEW execution (Framework preflight, before claim/inference): the same admission + live deployment
  * check as publish, for the host's Drive. Existing-Report lookup/read never call this. */
 async publishReady(driveId?:string){await this.modelReady(driveId);}
 async publish(value:TaskPublicationRequest){
  const request=parseRequest(value),a=await this.admission(request);if(!a)throw Error('TASK_PUBLICATION_NOT_ADMITTED');
  // Before any retained plan, intent, lock or Registry write: a fresh admission bound to the deployment actually behind the
  // endpoint (an older model package; a same-endpoint swap or a withdrawn admission) must refuse here.
  // Mechanical deployment fence: no Registry deploy/restart can happen between this check and the readback below.
  const lock=this.options.deployLock?await acquireDeployLock(this.options.deployLock.path,'shared',this.options.deployLock.timeoutMs??10_000):null;
  try{
  const live=await this.modelReady(a.driveId);
  const saved=this.retain(request,a),p=this.plan(saved);
  // Fence: the same deployment (same process boot and model) before create, before register and after register.
  // Any fence failure (changed boot, mismatch, unavailable, withdrawn) is reported as DEPLOYMENT_CHANGED: it can happen after a
  // write, so it must never be confused with the pre-write refusals above (callers label those as 'no write happened').
  const fence=async()=>{let now;try{now=await this.modelReady(a.driveId);}catch{throw Error('PRIVATE_PUBLICATION_MODEL_DEPLOYMENT_CHANGED');}if(now.bootId!==live.bootId)throw Error('PRIVATE_PUBLICATION_MODEL_DEPLOYMENT_CHANGED');};
  // The proxy refuses a create/register whose generation differs from the RUNNING deployment (check at the write itself).
  await publishPrivateRequest(p.admitted,p.runtime,p.binding,this.options.mcp,this.options.reader,fence,deploymentGeneration(live));
  const result=await this.verify(saved);if(!result)throw Error('TASK_PUBLICATION_READBACK_MISSING');return result;
  }finally{await lock?.release();}
 }
 async read(publicationId:string){
  const saved=this.load(publicationId);if(!saved)throw Error('TASK_PUBLICATION_PLAN_MISSING');
  const result=await this.verify(saved);if(!result)throw Error('TASK_PUBLICATION_READBACK_MISSING');return result;
 }
}
