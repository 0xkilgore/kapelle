import {it,expect,describe} from 'vitest';
import {mkdtempSync,writeFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {prepareTaskLauncher,publisherSourceHash,taskLauncherSchema} from '../src/task-delegation/launcher.js';
import {digest,canonical} from '../src/content.js';
import {releaseHash} from '../src/command-boundary.js';
import {sha} from '../src/worker/contracts.js';
import {context,policy} from './fixtures.js';
import {privateTaskPublisherFixture} from './fixtures/private-task-publisher.js';
const publisherRoot=process.env.KAPELLE_TASK_PUBLISHER_ROOT;
const service={id:'service:report-publisher',label:'Private Report publisher',instanceId:null,definitionId:null,definitionVersion:null,definitionHash:null};
const native={id:'native-publisher',label:'Native publisher',instanceId:'native-publisher',definitionId:'definition',definitionVersion:'1',definitionHash:'sha256:'+'a'.repeat(64)};
it('accepts truthful service provenance only as publisher and retains strict native author',()=>{
 const {author,publisher}=taskLauncherSchema.shape.admission.shape;
 expect(publisher.parse(service)).toEqual(service);expect(publisher.parse(native)).toEqual(native);
 expect(author.safeParse(service).success).toBe(false);
 for(const key of ['instanceId','definitionId','definitionVersion','definitionHash'] as const){
  expect(publisher.safeParse({...service,[key]:native[key]}).success).toBe(false);
  expect(author.safeParse({...native,[key]:null}).success).toBe(false);
 }
 for(const value of [{...service,id:''},{...service,id:'service:'},{...service,id:'service:bad identity'},{...service,id:'native-author'},{...service,label:' '},{...service,extra:'untrusted'},{...native,id:service.id}])expect(publisher.safeParse(value).success).toBe(false);
});
describe.skipIf(!publisherRoot)('concrete Task launcher',()=>{
 it.each(['native','service'])('loads %s publisher with independent HTTP reader; identity/config/qualification changes refuse',async(kind)=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'task-launcher-'))),pub=await privateTaskPublisherFixture();
  const writer='fixture-writer-'.padEnd(40,'w'),reader='fixture-reader-'.padEnd(40,'r');let writerCalls=0,readerCalls=0;
  const server=createServer(async(req,res)=>{try{
   const chunks=[];for await(const c of req)chunks.push(c);const v=JSON.parse(Buffer.concat(chunks).toString());
   const auth=req.headers.authorization,isReader=auth==='Bearer '+reader;
   if(!isReader&&auth!=='Bearer '+writer){res.writeHead(403);res.end();return;}
   if(isReader)readerCalls++;else writerCalls++;
   const result=await (isReader?pub.reader:pub.mcp).call(v.params.name,v.params.arguments);
   res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:v.id,result:{structuredContent:result}}));
  }catch{res.writeHead(500);res.end();}});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+(server.address() as any).port;
  const write=(name:string,value:unknown)=>{const p=join(root,name);writeFileSync(p,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});return p;};
  try{
   const ctx=context(),release=ctx.definitions[0].release;
   release.runtimeContracts=['kapelle.task-delegation/v1'];release.contentHash=releaseHash(release);
   const assets=[release.instructions,...release.skills,...release.qualificationFixtures].map((ref,i)=>({ref,path:write('asset-'+i,canonical({id:ref.id,version:ref.version}))}));
   const b={ownerId:'owner',scopeRef:ctx.scopeRef,instanceId:randomUUID(),runtimeBindingRef:'pipeline-task-runtime',definitionHash:release.contentHash,capabilityHash:'a'.repeat(64),modelProfile:policy.preferredProfile,budgetPolicyRef:policy.budgetPolicyRef,inference:{model:'fixture',credentialTeamId:randomUUID(),credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'fixture',cliVersion:'fixture',maxOutputTokens:1000,maxBudgetUsd:1,timeoutMs:1000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'}};
   const packetHash=digest('packet');
   const profilePath=write('profile.json',{contract:'kapelle.task-runtime-profile/v1',expiresAt:'2026-09-11T00:00:00.000Z',permissionRef:'task-delegation:owner',publisherBindingRef:'fixture-publisher',binding:b,packets:[{taskId:'task',hash:packetHash,path:join(root,'packet.json')}]});
   const sourceHash=await publisherSourceHash(publisherRoot!);
   const proof={contract:'kapelle.task-runtime-qualification/v1',status:'PASS',bindingHash:digest(b),publisherSourceHash:sourceHash,expiresAt:'2026-09-11T00:00:00.000Z'};
   const proofText=JSON.stringify(proof),evidencePath=write('qualification.json',proofText);
   const author={id:b.instanceId,label:'Pipeline fixture',instanceId:b.instanceId,definitionId:release.definitionId,definitionVersion:release.packageVersion,definitionHash:release.contentHash};
   const c={contract:'kapelle.task-launcher/v1',enabled:true,expiresAt:'2026-09-11T00:00:00.000Z',profilePath,taskAuthorityUrl:origin,taskTokenFile:write('task.token','fixture-task-token-'.padEnd(40,'t')),
    publisherRoot,publisherSourceHash:sourceHash,receiptDir:join(root,'receipts'),lockDir:join(root,'publisher-locks'),publisherUrl:origin+'/mcp',publisherTokenFile:write('writer.token',writer),readerUrl:origin+'/mcp',readerTokenFile:write('reader.token',reader),
    admission:{bindingRef:'fixture-publisher',ownerId:b.ownerId,scopeRef:b.scopeRef,driveId:'drive',actorId:'publisher-actor',authorizationRef:'fixture:authorization',libraryOrigin:'https://private.example',author,publisher:kind==='service'?service:{...author,id:'publisher',instanceId:'publisher'}},qualification:{release,assets,evidencePath,evidenceHash:'sha256:'+sha(proofText)}};
   // Publisher e693b964+ requires a QUALIFIED_LIVE model admission to publish; pin one built from the publisher's own
   // 49-file inventory and schema (owner-only file, sha256 in the launcher config).
   const {readFileSync:rf,existsSync:ex}=await import('node:fs');const {createHash:ch}=await import('node:crypto');
   const inv=join(publisherRoot!,'deploy/report-listing-runtime/model-inventory.json');
   if(ex(inv)){
    const {qualifiedAdmission}=await import('./fixtures/model-admission.js');void ch;void rf;
    const text=JSON.stringify(qualifiedAdmission(publisherRoot!,c.publisherUrl,'drive'));
    (c as any).modelAdmission={path:write('model-admission.json',text),sha256:'sha256:'+sha(text)};
    await expect(prepareTaskLauncher(write('admission-changed.json',{...c,modelAdmission:{...(c as any).modelAdmission,sha256:'sha256:'+'0'.repeat(64)}}),{runtime:{stateRoot:join(root,'native'),reactorRoot:'/unused',ownerId:b.ownerId,scopeRef:b.scopeRef,now:()=>ctx.occurredAt,facts:async()=>ctx},workerRoot:join(root,'worker'),token:()=>writer,claudeHost:{managerRoot:'/unused',cliPath:'/unused',runtimeRoot:join(root,'runtime')}} as any)).rejects.toThrow('model_admission_changed');
   }
   const configPath=write('launcher.json',c),base={runtime:{stateRoot:join(root,'native'),reactorRoot:'/unused',ownerId:b.ownerId,scopeRef:b.scopeRef,now:()=>ctx.occurredAt,facts:async()=>ctx},workerRoot:join(root,'worker'),token:()=>writer,claudeHost:{managerRoot:'/unused',cliPath:'/unused',runtimeRoot:join(root,'claude')}};
   await expect(prepareTaskLauncher(configPath,{...base,workerRoot:join(base.runtime.stateRoot,'nested')})).rejects.toThrow('storage_overlap');
   for(const publisher of [{...native,id:author.id},{...native,instanceId:author.instanceId}])await expect(prepareTaskLauncher(write('impersonation.json',{...c,admission:{...c.admission,publisher}}),base)).rejects.toThrow('scope_invalid');
   const options=await prepareTaskLauncher(configPath,base);expect(writerCalls+readerCalls).toBe(0);
   const dispatchId=randomUUID(),inputHash=digest('input'),markdown='Fixture report';
   const request={publicationId:'task-report:'+digest({dispatchId,inputHash}).slice(7),ownerId:b.ownerId,scopeRef:b.scopeRef,instanceId:b.instanceId,dispatchId,inputHash,taskId:'task',sourceRef:'dispatch:'+dispatchId,packetHash,executionHash:digest('execution'),markdown,contentHash:'sha256:'+sha(markdown)};
   const published:any=await options.publisher.publish(request);
   expect(published.markdown).toBe(markdown);expect(writerCalls).toBeGreaterThan(0);expect(readerCalls).toBeGreaterThan(0);
   const metadata=[...pub.docs.values()][0].state.global.publication;
   expect(metadata.publisher).toEqual({...c.admission.publisher,definitionHash:c.admission.publisher.definitionHash?.replace('sha256:','')??null});
   expect(metadata.author.id).toBe(author.id);expect(metadata.publisher.id).not.toBe(author.id);
   const writes=pub.counts().writes;await options.publisher.read(request.publicationId);expect(pub.counts().writes).toBe(writes);
   expect((await options.runtime.facts()).runtimeBindingContracts[b.runtimeBindingRef]).toBe('kapelle.task-delegation/v1');
   for(const field of ['actorId','driveId'] as const){
    writeFileSync(configPath,JSON.stringify({...c,admission:{...c.admission,[field]:'changed'}}));
    await expect(options.publisher.admitted(request)).rejects.toThrow('revoked');
   }
   writeFileSync(configPath,JSON.stringify({...c,admission:{...c.admission,publisher:{...c.admission.publisher,label:c.admission.publisher.label+' '}}}));
   await expect(options.publisher.admitted(request)).rejects.toThrow('revoked');
   writeFileSync(configPath,JSON.stringify(c));
   writeFileSync(c.readerTokenFile,writer);await expect(options.publisher.read(request.publicationId)).rejects.toThrow('independent_report_reader');writeFileSync(c.readerTokenFile,reader);
   writeFileSync(evidencePath,JSON.stringify({...proof,status:'FAIL'}));await expect(options.runtime.facts()).rejects.toThrow('qualification_changed');writeFileSync(evidencePath,proofText);
   writeFileSync(configPath,JSON.stringify({...c,enabled:false}));await expect(options.publisher.admitted(request)).rejects.toThrow();writeFileSync(configPath,JSON.stringify(c));
   await expect(prepareTaskLauncher(write('wrong-source.json',{...c,publisherSourceHash:digest('wrong')}),base)).rejects.toThrow('qualification_invalid');
   expect(pub.counts().writes).toBe(writes);
  }finally{await new Promise<void>(r=>server.close(()=>r()));pub.close();rmSync(root,{recursive:true,force:true});}
 },30000);
});
