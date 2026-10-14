import {activeRecovery,recoveryFor,pilotControl,savedRead,markPilotPublication,preflightPilotPublication,checkPilotPublication} from './recovery.js';
import {createHash} from 'node:crypto';
import {pilotEligibilitySchema,pilotIdentity,pilotAccess} from './pilot.js';
import { z } from 'zod';
import { readdir, lstat, realpath, readFile } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest, canonical } from '../content.js';
import { releaseHash } from '../command-boundary.js';
import { DefinitionReleaseSchema } from '../../document-models/agent-definition/v1/index.js';
import { privateText } from '../worker/sources.js';
import { sha } from '../worker/contracts.js';
import { TaskSourceClient } from './task-client.js';
import { TaskRuntimeAdmission, type TaskRuntimeOptions } from './runtime.js';
import type { TaskReportRequest } from './worker-contract.js';
import type { PrivateTaskPublicationPort } from './private-report-adapter.js';

const id=z.string().min(1).max(200),hash=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const path=z.string().refine(isAbsolute,'absolute_path_required');
const agent=z.object({id,label:z.string().min(1),instanceId:id,definitionId:id,definitionVersion:id,definitionHash:hash}).strict();
// A service has no native Agent instance or definition. Never fill those fields
// with host component IDs or source hashes merely to satisfy the author schema.
const servicePublisher=z.object({id:id.regex(/^service:[A-Za-z0-9][A-Za-z0-9._:-]*$/),label:z.string().min(1).refine(v=>v.trim().length>0),instanceId:z.null(),definitionId:z.null(),definitionVersion:z.null(),definitionHash:z.null()}).strict();
const publisher=z.union([agent.refine(v=>!v.id.startsWith('service:'),'service_publisher_requires_null_native_fields'),servicePublisher]);
const asset=z.object({ref:z.object({id,version:id,contentHash:hash}).strict(),path}).strict();
export const taskLauncherSchema=z.object({
 pilotMode:z.literal('single-task-pilot').optional(),
 contract:z.literal('kapelle.task-launcher/v1'),enabled:z.literal(true),expiresAt:z.iso.datetime(),
 profilePath:path,taskAuthorityUrl:z.string().url(),taskTokenFile:path,
 publisherRoot:path,publisherSourceHash:hash,receiptDir:path,lockDir:path,
 publisherUrl:z.string().url(),publisherTokenFile:path,readerUrl:z.string().url(),readerTokenFile:path,
 admission:z.object({bindingRef:id,ownerId:id,scopeRef:id,driveId:id,actorId:id,authorizationRef:id,libraryOrigin:z.string().url(),author:agent,publisher}).strict(),
 qualification:z.object({release:DefinitionReleaseSchema(),assets:z.array(asset).max(32),
   evidencePath:path,evidenceHash:hash}).strict(),
 /** Host-owned QUALIFIED_LIVE Registry model admission (owner-only file, pinned by hash). Without it the publisher
  * refuses to publish before any create (publisher e693b964); lookup/read of existing Reports are unaffected. */
 modelAdmission:z.object({path,sha256:hash}).strict().optional(),
 // Local single-machine Registry: the publisher holds a SHARED flock on this file across each publication; the Registry
 // deploy/restart tooling takes it EXCLUSIVE before stopping or starting the Reactor.
 registryDeployLock:z.object({path,timeoutMs:z.number().int().min(0).max(120000).optional()}).strict().optional(),
}).strict();
/** Deterministic source pin over the existing publisher's complete src tree; rejects aliases.
 * The pinned tree is trusted installed code, never browser-selected code. */
export async function publisherSourceHash(root:string) {
 if(!isAbsolute(root)||await realpath(root)!==resolve(root))throw Error('publisher_root_invalid');
 const entries:Array<[string,string]>=[];
 async function walk(dir:string,prefix:string){
  for(const name of (await readdir(dir)).sort()){
   const file=join(dir,name),relative=prefix+name,s=await lstat(file);
   if(s.isSymbolicLink())throw Error('publisher_source_alias');
   if(s.isDirectory())await walk(file,relative+'/');
   else if(s.isFile()) {if(s.size>2000000)throw Error('publisher_source_bound');entries.push([relative,sha(await readFile(file,'utf8'))]);}
   else throw Error('publisher_source_type');
  }
 }
 await walk(join(root,'src'),'src/');return digest(entries);
}
export async function privateToken(file:string){
 const token=(await privateText(file,1024)).trim();
 if(token.length<32||/\s/.test(token))throw Error('task_launcher_token_invalid');return token;
}
export async function prepareTaskLauncher(configPath:string,base:Pick<TaskRuntimeOptions,'runtime'|'workerRoot'|'token'|'claudeHost'>):Promise<TaskRuntimeOptions>{
 const c=taskLauncherSchema.parse(JSON.parse(await privateText(configPath)));
 const now=base.runtime.now??(()=>new Date().toISOString());
 const admission=await TaskRuntimeAdmission.load(c.profilePath,now),p=admission.profile,b=p.binding,a=c.admission;
 if(b.ownerId!==base.runtime.ownerId||b.scopeRef!==base.runtime.scopeRef||a.ownerId!==b.ownerId||a.scopeRef!==b.scopeRef||a.bindingRef!==p.publisherBindingRef||a.author.id!==b.instanceId||a.author.instanceId!==b.instanceId||a.author.definitionHash!==b.definitionHash||a.publisher.id===a.author.id||a.publisher.instanceId===b.instanceId)
  throw Error('task_launcher_scope_invalid');
 const roots=[base.runtime.stateRoot,base.workerRoot,c.receiptDir,c.lockDir].map(v=>resolve(v));
 if(roots.some((a,i)=>roots.some((b,j)=>i!==j&&(a===b||a.startsWith(b+'/')))))throw Error('task_launcher_storage_overlap');
 if(Boolean(c.pilotMode)!==Boolean(b.pilot))throw Error('pilot_explicit_opt_in_required');
 const release=c.qualification.release;
 if(releaseHash(release)!==release.contentHash||release.contentHash!==b.definitionHash||release.definitionId!==a.author.definitionId||release.packageVersion!==a.author.definitionVersion||!release.runtimeContracts.includes('kapelle.task-delegation/v1')||!release.modelProfiles.includes(b.modelProfile))throw Error('task_launcher_release_invalid');
 async function current(metadataOnly=false){
  const controlOnly=!!b.pilot&&(metadataOnly||pilotControl(b.pilot)||savedRead(b.pilot));
  if((c.expiresAt<=now()&&!controlOnly)||canonical(taskLauncherSchema.parse(JSON.parse(await privateText(configPath))))!==canonical(c))throw Error('task_launcher_revoked');
  await admission.current(metadataOnly);
  const evidence=await privateText(c.qualification.evidencePath,c.pilotMode?16777216:undefined);
  if('sha256:'+sha(evidence)!==c.qualification.evidenceHash)throw Error('task_launcher_qualification_changed');
  const proof=c.pilotMode?pilotEligibilitySchema.parse(JSON.parse(evidence)):z.object({contract:z.literal('kapelle.task-runtime-qualification/v1'),status:z.literal('PASS'),bindingHash:hash,publisherSourceHash:hash,expiresAt:z.iso.datetime()}).strict().parse(JSON.parse(evidence));
  if(c.pilotMode){
   const pilot=pilotIdentity(b.pilot,{ownerId:b.ownerId,scopeRef:b.scopeRef},b.instanceId);
   if(pilot.definitionHash!==b.definitionHash||pilot.runtimeBindingRef!==b.runtimeBindingRef||p.packets.length!==1||p.packets[0].taskId!==pilot.taskId||p.packets[0].hash!==pilot.packetHash||p.permissionRef!==pilot.permissionRef||proof.expiresAt!==pilot.recoveryExpiresAt||c.expiresAt!==pilot.recoveryExpiresAt||p.expiresAt!==pilot.recoveryExpiresAt)throw Error('pilot_profile_changed');
   if(await publisherSourceHash(c.publisherRoot)!==c.publisherSourceHash)throw Error('task_launcher_publisher_code_changed');
   const pins=pilotEligibilitySchema.parse(proof);
   if(pins.approvedAt!==pilot.approvedAt||pins.admissionExpiresAt!==pilot.expiresAt)throw Error('pilot_deadlines_changed');
   for(const pin of [...pins.sourcePins,...pins.dependencyPins]){
    if(await realpath(pin.path)!==resolve(pin.path)||(await lstat(pin.path)).isSymbolicLink()||createHash('sha256').update(await readFile(pin.path)).digest('hex')!==pin.sha256)throw Error('pilot_file_pin_changed');
   }
  }
  if(proof.bindingHash!==digest(b)||proof.publisherSourceHash!==c.publisherSourceHash||(proof.expiresAt<=now()&&!controlOnly))throw Error('task_launcher_qualification_invalid');
  for(const ref of [release.instructions,...release.skills,...release.qualificationFixtures]){
   const candidates=c.qualification.assets.filter(v=>canonical(v.ref)===canonical(ref));
   if(candidates.length!==1||'sha256:'+sha(await privateText(candidates[0].path,262144,false))!==ref.contentHash)throw Error('task_launcher_asset_changed');
  }
 }
 // A saved read after the recovery window: identity only (pilotIdentity), never time-based access to run or publish.
 async function access(){await current();if(b.pilot){if(savedRead(b.pilot))pilotIdentity(b.pilot,{ownerId:b.ownerId,scopeRef:b.scopeRef},b.instanceId);else pilotAccess(b.pilot,{ownerId:b.ownerId,scopeRef:b.scopeRef,occurredAt:now()},b.instanceId);}}
 await current(true);
 if(await publisherSourceHash(c.publisherRoot)!==c.publisherSourceHash)throw Error('task_launcher_publisher_code_changed');
 // Two credential files AND two credential values; the server must admit distinct scoped identities.
 async function credentials(){
  if(c.publisherTokenFile===c.readerTokenFile)throw Error('independent_report_reader_required');
  const [writer,reader]=await Promise.all([privateToken(c.publisherTokenFile),privateToken(c.readerTokenFile)]);
  if(writer===reader)throw Error('independent_report_reader_required');return {writer,reader};
 }
 await credentials();await privateToken(c.taskTokenFile);
 const {HttpReportRegistryMcp}=await import(/* @vite-ignore */ pathToFileURL(join(c.publisherRoot,'src/mcp-client.ts')).href);
 const {PrivateTaskReportPublisher}=await import(/* @vite-ignore */ pathToFileURL(join(c.publisherRoot,'src/task-publication.ts')).href);
 // Validate actual transport endpoints before opening native stores. No request is sent here.
 new HttpReportRegistryMcp(c.publisherUrl,(await credentials()).writer);
 new HttpReportRegistryMcp(c.readerUrl,(await credentials()).reader);
 const client=(reader:boolean)=>{
  const send=async(name:string,args:Record<string,unknown>,beforeSend?:()=>void)=>{
   // A saved read never reaches the Registry (no reads either: the console verifies the Report itself).
   if(savedRead(b.pilot))throw Error('pilot_saved_read_registry_forbidden');
   await access();
   // lookupReportPublicationV1 (publisher dad157d+) and the scoped point proof getReportDocumentV1 (scale bridge) are READ ONLY
   // native reads: never a pilot write marker or recovery write. The independent reader may use the point proof, not V1.
   const read=['getDocuments','getReportIdentities','getDocument','lookupReportPublicationV1','getReportDocumentV1','getRegistryDeploymentV1'].includes(name);
   if((reader&&!['getDocuments','getDocument','getReportDocumentV1'].includes(name))||(activeRecovery()?.mode==='read'&&!read))throw Error('independent_reader_write_forbidden');
   const tokens=await credentials();
   if(!read){if(b.pilot)await preflightPilotPublication();else await activeRecovery()?.beforeWrite();}
   await access();
   const transport=new HttpReportRegistryMcp(reader?c.readerUrl:c.publisherUrl,reader?tokens.reader:tokens.writer);
   if(b.pilot&&!read){
    if(typeof transport.callWithStart!=='function')throw Error('publisher_transport_boundary_required');
    return transport.callWithStart(name,args,()=>{markPilotPublication();beforeSend?.();});
   }
   if(beforeSend)throw Error('publisher_transport_boundary_forbidden');
   return transport.call(name,args);
  };
  return {call:(name:string,args:Record<string,unknown>)=>send(name,args),
   ...(b.pilot?{callWithStart:(name:string,args:Record<string,unknown>,beforeSend:()=>void)=>send(name,args,beforeSend)}:{})};
 };
 // Model admission: checked at prepare, and for a publisher that supports it (d089023+,
 // publishReady) RE-READ and re-hashed from the owner file on every check, so withdrawal or change after prepare is effective.
 let modelAdmission:{value:unknown;endpoint:string}|{load:()=>Promise<{value:unknown;endpoint:string}>}|undefined;
 if(c.modelAdmission){
  const pinned=c.modelAdmission;
  const load=async()=>{const text=await privateText(pinned.path,65536);if('sha256:'+sha(text)!==pinned.sha256)throw Error('task_launcher_model_admission_changed');return {value:JSON.parse(text),endpoint:c.publisherUrl};};
  const first=await load();
  modelAdmission=typeof PrivateTaskReportPublisher.prototype.publishReady==='function'?{load}:first;
 }
 const publisher:PrivateTaskPublicationPort=new PrivateTaskReportPublisher({bindingRef:a.bindingRef,receiptDir:c.receiptDir,lockDir:c.lockDir,mcp:client(false),reader:client(true),...(modelAdmission?{modelAdmission}:{}),...(c.registryDeployLock?{deployLock:{path:c.registryDeployLock.path,...(c.registryDeployLock.timeoutMs!==undefined?{timeoutMs:c.registryDeployLock.timeoutMs}:{})}}:{}),
  authorize:async(request:TaskReportRequest)=>{
   checkPilotPublication(request.publicationId);await access();
   if(activeRecovery()){const recovery=recoveryFor(b.pilot!,request.dispatchId)!;if(recovery.publicationId!==request.publicationId)throw Error('pilot_recovery_publication_changed');}
   if(request.ownerId!==a.ownerId||request.scopeRef!==a.scopeRef||request.instanceId!==b.instanceId||!p.packets.some(e=>e.taskId===request.taskId&&e.hash===request.packetHash))return null;
   return a;
  }});
 if(b.pilot)Object.assign(publisher,{publicationStartBoundary:'transport'});
 // Bind publish readiness to the host-admitted Drive (port contract takes no arguments).
 const ready=(publisher as unknown as {publishReady?:(driveId:string)=>Promise<void>}).publishReady;
 if(typeof ready==='function')Object.assign(publisher,{publishReady:()=>ready.call(publisher,a.driveId)});
 let taskToken=await privateToken(c.taskTokenFile);
 const taskSource=new TaskSourceClient(c.taskAuthorityUrl,b.ownerId,()=>taskToken,async(...args:Parameters<typeof fetch>)=>{
  // Refuse a credential change during construction of this individual request.
  if(new Headers(args[1]?.headers).get('authorization')!=='Bearer '+taskToken)throw Error('task_token_changed');
  return fetch(...args);
 },b.taskSourceOwnerId??b.ownerId,async()=>{await access();taskToken=await privateToken(c.taskTokenFile);await access();});
 const reader=client(true),reportProbe=async(documentId:string)=>{await access();return reader.call('getDocument',{id:documentId});};
 return {...base,profilePath:c.profilePath,taskSource,publisher,reportProbe,runtime:{...base.runtime,facts:async()=>{
  await current();const facts=await base.runtime.facts();
  return {...facts,definitions:[...facts.definitions.filter(d=>d.release.definitionId!==release.definitionId),{release,qualified:!c.pilotMode,...(b.pilot?{pilot:b.pilot}:{})}],
   runtimeBindingRefs:[...new Set([...facts.runtimeBindingRefs,b.runtimeBindingRef])],
   runtimeBindingContracts:{...facts.runtimeBindingContracts,[b.runtimeBindingRef]:'kapelle.task-delegation/v1'},
   budgetPolicyRefs:[...new Set([...facts.budgetPolicyRefs,b.budgetPolicyRef])],
   resources:[...facts.resources.filter(r=>r.id!==p.permissionRef),{id:p.permissionRef,resourceType:'task-delegation',revision:1,contentHash:digest({permission:p.permissionRef,binding:b}),allowedActions:['receive','dispatch']}],
   // Each admitted packet's Task is readable only by this binding's instance, for its exact grant/readiness checks.
   // Dispatch admission still substitutes the live Task revision/source hash (contract.ts acceptOffer).
   admittedTaskReads:p.packets.map(e=>({instanceId:b.instanceId,resource:{id:e.taskId,resourceType:'task',revision:0,contentHash:e.hash,allowedActions:['read']}}))};
 }}};
}
