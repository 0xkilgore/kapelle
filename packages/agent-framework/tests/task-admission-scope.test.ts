import {it,expect,describe} from 'vitest';
import {mkdtempSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareTaskLauncher,publisherSourceHash} from '../src/task-delegation/launcher.js';
import {digest,canonical} from '../src/content.js';
import {releaseHash,type TrustedContext} from '../src/command-boundary.js';
import {sha} from '../src/worker/contracts.js';
import * as I from '../document-models/agent-instance/v1/index.js';
import {apply,context,installed,policy,ready} from './fixtures.js';
const publisherRoot=process.env.KAPELLE_TASK_PUBLISHER_ROOT;
const taskId='admitted-task', permissionRef='task-delegation:owner', later='2026-09-11T00:00:00.000Z';
// Production-composed admission: Task facts come only from the real launcher's runtime.facts(), never injected.
async function launch(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'task-admission-')));
 const write=(name:string,value:unknown)=>{const p=join(root,name);writeFileSync(p,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});return p;};
 const base=context();const release={...structuredClone(base.definitions[0].release),definitionId:'task-reporter',runtimeContracts:['kapelle.task-delegation/v1'],
  capabilities:[{id:'task-read',requirement:'REQUIRED',resourceType:'task',actions:['read'],outputTypes:['report']},{id:'task-receive',requirement:'REQUIRED',resourceType:'task-delegation',actions:['receive'],outputTypes:['report']}]} as any;
 release.contentHash=releaseHash(release);
 const assets=[release.instructions,...release.skills,...release.qualificationFixtures].map((ref:any,i:number)=>({ref,path:write('asset-'+i,canonical({id:ref.id,version:ref.version}))}));
 const b={ownerId:'owner',scopeRef:base.scopeRef,instanceId:'reporter-1',runtimeBindingRef:'task-runtime',definitionHash:release.contentHash,capabilityHash:'a'.repeat(64),modelProfile:policy.preferredProfile,budgetPolicyRef:policy.budgetPolicyRef,
  inference:{model:'fixture',credentialTeamId:randomUUID(),credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'fixture',cliVersion:'fixture',maxOutputTokens:1000,maxBudgetUsd:1,timeoutMs:1000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'}};
 const packetHash=digest('packet');
 const profilePath=write('profile.json',{contract:'kapelle.task-runtime-profile/v1',expiresAt:later,permissionRef,publisherBindingRef:'fixture-publisher',binding:b,packets:[{taskId,hash:packetHash,path:join(root,'packet.json')}]});
 const sourceHash=await publisherSourceHash(publisherRoot!);
 const proofText=JSON.stringify({contract:'kapelle.task-runtime-qualification/v1',status:'PASS',bindingHash:digest(b),publisherSourceHash:sourceHash,expiresAt:later});
 const author={id:b.instanceId,label:'Reporter',instanceId:b.instanceId,definitionId:release.definitionId,definitionVersion:release.packageVersion,definitionHash:release.contentHash};
 const origin='http://127.0.0.1:9';
 const c={contract:'kapelle.task-launcher/v1',enabled:true,expiresAt:later,profilePath,taskAuthorityUrl:origin,taskTokenFile:write('task.token','fixture-task-token-'.padEnd(40,'t')),
  publisherRoot,publisherSourceHash:sourceHash,receiptDir:join(root,'receipts'),lockDir:join(root,'locks'),publisherUrl:origin+'/mcp',publisherTokenFile:write('writer.token','w'.repeat(40)),readerUrl:origin+'/mcp',readerTokenFile:write('reader.token','r'.repeat(40)),
  admission:{bindingRef:'fixture-publisher',ownerId:b.ownerId,scopeRef:b.scopeRef,driveId:'drive',actorId:'publisher-actor',authorizationRef:'fixture:authorization',libraryOrigin:'https://private.example',author,
   publisher:{id:'service:report-publisher',label:'Private Report publisher',instanceId:null,definitionId:null,definitionVersion:null,definitionHash:null}},
  qualification:{release,assets,evidencePath:write('qualification.json',proofText),evidenceHash:'sha256:'+sha(proofText)}};
 const configPath=write('launcher.json',c);let now=base.occurredAt;
 const options=await prepareTaskLauncher(configPath,{runtime:{stateRoot:join(root,'native'),reactorRoot:'/unused',ownerId:b.ownerId,scopeRef:b.scopeRef,now:()=>now,facts:async()=>base},
  workerRoot:join(root,'worker'),token:()=>'w'.repeat(40),claudeHost:{managerRoot:'/unused',cliPath:'/unused',runtimeRoot:join(root,'claude')}});
 const ctx=async():Promise<TrustedContext>=>({...(await options.runtime.facts()),principalId:'owner',ownerId:'owner',scopeRef:base.scopeRef,occurredAt:now} as TrustedContext);
 return {root,release,b,options,ctx,configPath,c,write,setNow:(v:string)=>{now=v;}};
}
const grant=(principalId:string,resourceRef:string,actions:string[],id='g-'+resourceRef+'-'+actions.join())=>({grant:{id,principalId,resourceRef,actions,expiresAt:'2026-09-10T23:00:00.000Z',reviewPolicy:'ALWAYS'}});
function bound(ctx:TrustedContext,release:any){
 const empty=I.utils.createDocument();empty.header.id='reporter-1';
 return apply(empty,'CREATE_INSTANCE',{instanceId:'reporter-1',scopeRef:ctx.scopeRef,definitionRef:{id:release.definitionId,version:release.packageVersion,contentHash:release.contentHash},
  name:'Reporter',responsibilities:['reconcile'],operatingPolicy:'Prepare only',modelPolicy:policy},ctx);
}
describe.skipIf(!publisherRoot)('admitted Task read is bound to the configured instance',()=>{
 it('is absent from shared resources and lets only the bound instance take the exact Task/read grant and become READY',async()=>{
  const x=await launch();try{
   const ctx=await x.ctx();
   expect(ctx.resources.some(r=>r.id===taskId)).toBe(false);
   expect(ctx.admittedTaskReads).toEqual([{instanceId:'reporter-1',resource:{id:taskId,resourceType:'task',revision:0,contentHash:digest('packet'),allowedActions:['read']}}]);
   let d=bound(ctx,x.release);
   d=apply(d,'SET_RUNTIME_BINDING',{runtimeBindingRef:'task-runtime'},ctx);
   d=apply(d,'GRANT_CAPABILITY',grant('reporter-1',taskId,['read']),ctx);
   d=apply(d,'GRANT_CAPABILITY',grant('reporter-1',permissionRef,['receive']),ctx);
   d=apply(d,'REQUEST_RESUME',{},ctx);
   expect(d.state.global.desiredState).toBe('READY');expect(d.state.global.grants.map(g=>[g.resourceRef,g.actions])).toEqual([[taskId,['read']],[permissionRef,['receive']]]);
  }finally{rmSync(x.root,{recursive:true,force:true});}
 });
 it('refuses unrelated-instance LINK_DOCUMENT and Task/read grants, even for a definition that declares Task/read',async()=>{
  const x=await launch();try{
   const ctx=await x.ctx();
   expect(()=>apply(installed(ctx),'LINK_DOCUMENT',{documentRef:taskId,access:'PRIVATE'},ctx)).toThrow('Document link not authorized');
   // Unrelated qualified definition with Task/read capability.
   const other={...structuredClone(context().definitions[0].release),definitionId:'other-task-reader',capabilities:[{id:'task-read',requirement:'OPTIONAL',resourceType:'task',actions:['read'],outputTypes:['report']}]} as any;
   other.contentHash=releaseHash(other);
   const ctx2={...ctx,definitions:[...ctx.definitions,{release:other,qualified:true}]};
   const empty=I.utils.createDocument();empty.header.id='other-1';
   const o=apply(empty,'CREATE_INSTANCE',{instanceId:'other-1',scopeRef:ctx.scopeRef,definitionRef:{id:other.definitionId,version:other.packageVersion,contentHash:other.contentHash},name:'Other',responsibilities:['reconcile'],operatingPolicy:'x',modelPolicy:policy},ctx2);
   expect(()=>apply(o,'GRANT_CAPABILITY',grant('other-1',taskId,['read']),ctx2)).toThrow('Grant exceeds instance or document scope');
   expect(()=>apply(o,'LINK_DOCUMENT',{documentRef:taskId,access:'PRIVATE'},ctx2)).toThrow('Document link not authorized');
   // The bound instance cannot link the admitted Task either: admission only serves grant/readiness checks.
   expect(()=>apply(bound(ctx,x.release),'LINK_DOCUMENT',{documentRef:taskId,access:'PRIVATE'},ctx)).toThrow('Document link not authorized');
  }finally{rmSync(x.root,{recursive:true,force:true});}
 });
 it('refuses a wrong Task, a wrong action, and expired or revoked admission',async()=>{
  const x=await launch();try{
   const ctx=await x.ctx();const d=apply(bound(ctx,x.release),'SET_RUNTIME_BINDING',{runtimeBindingRef:'task-runtime'},ctx);
   expect(()=>apply(d,'GRANT_CAPABILITY',grant('reporter-1','other-task',['read']),ctx)).toThrow('Grant exceeds instance or document scope');
   expect(()=>apply(d,'GRANT_CAPABILITY',grant('reporter-1',taskId,['update']),ctx)).toThrow('Grant exceeds instance or document scope');
   x.setNow(later);await expect(x.options.runtime.facts()).rejects.toThrow('task_launcher_revoked');
   x.setNow(context().occurredAt);writeFileSync(x.configPath,JSON.stringify({...x.c,expiresAt:'2026-09-10T13:00:00.000Z'}));
   await expect(x.options.runtime.facts()).rejects.toThrow('task_launcher_revoked');
  }finally{rmSync(x.root,{recursive:true,force:true});}
 });
 it('keeps independently authorized resource grants unchanged',async()=>{
  const x=await launch();try{
   const ctx=await x.ctx();
   expect(ready(ctx).state.global.grants.map(g=>g.resourceRef)).toEqual(['contracts']);
   expect(()=>apply(installed(ctx),'GRANT_CAPABILITY',grant('commissioner-1','contracts',['delete']),ctx)).toThrow('Grant exceeds instance or document scope');
  }finally{rmSync(x.root,{recursive:true,force:true});}
 });
});
