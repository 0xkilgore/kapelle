import type {TaskProposalProducer} from '../src/task-delegation/generation-contract.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { context, policy } from './fixtures.js';
import { nativePlatformFixture } from './native-platform-fixture.js';
import { openFrameworkRuntime } from '../src/service/runtime.js';
import { frameworkHandler } from '../src/service/http.js';
import { digest, releaseHash, type ModelType } from '../src/command-boundary.js';
import { assert } from '../src/validation.js';
import { contract, taskSchema, type Task } from '../src/task-delegation/contract.js';
import { TaskDelegations } from '../src/task-delegation/adapter.js';
export async function taskDelegationFixture(taskProposalProducer?:TaskProposalProducer){
 const platform=await nativePlatformFixture(process.env.KAPELLE_PLATFORM_MODELS_ROOT!);
 await platform.act(platform.taskId,'addComment',{id:'synthetic-note',bodyMarkdown:'Synthetic activity context.'},'owner');
 await platform.act(platform.taskId,'addExternalRef',{id:'synthetic-ref',authority:'fixture',opaqueId:'reference-123',deepLink:null},'owner');
 const root=mkdtempSync(join(tmpdir(),'task-delegation-')),ctx=context(),r=ctx.definitions[0].release;
 r.capabilities=[{id:'task-read',resourceType:'task',actions:['read'],requirement:'OPTIONAL',outputTypes:['report']},{id:'task-receive',resourceType:'task-delegation',actions:['receive'],requirement:'OPTIONAL',outputTypes:['report']}];
 r.runtimeContracts=[contract];r.documentModels=[{documentType:'kapelle/dispatch',version:1}];r.contentHash=releaseHash(r);
 ctx.runtimeBindingContracts={...ctx.runtimeBindingContracts,'local-adapter':contract};
 ctx.resources=[{id:platform.taskId,resourceType:'task',revision:1,contentHash:digest('task'),allowedActions:['read']},{id:'task-delegation:owner',resourceType:'task-delegation',revision:1,contentHash:digest('permission'),allowedActions:['receive','dispatch']}];
 let demoHandler:((req:IncomingMessage,res:ServerResponse)=>Promise<boolean>)|undefined;
 let completion:((operationId:string)=>Promise<Awaited<ReturnType<TaskDelegations['lookup']>>>)|undefined;
 let result:any=null,readOverride:((t:Task)=>Task)|undefined;
 const admittedTaskIds=new Set([platform.taskId]);
 async function readTask(id:string){assert(admittedTaskIds.has(id),'Task unavailable');const doc=await platform.read(id);const s=(doc.state as any).global;const t=taskSchema.parse({...s,revision:doc.operations.global.length,id,comments:s.comments??[],externalRefs:s.externalRefs??[]});return readOverride?readOverride(t):t;}
 const options={taskProposalProducer,stateRoot:join(root,'framework'),reactorRoot:process.env.KAPELLE_SCOPED_REACTOR_ROOT!,ownerId:'owner',scopeRef:ctx.scopeRef,now:()=>ctx.occurredAt,taskDelegation:{readTask,permissionRef:'task-delegation:owner'},facts:async()=>({...ctx,dispatch:{parents:[],agents:[],tasks:[],sources:[],results:result?[result]:[]}})};
 let runtime=await openFrameworkRuntime(options),n=0;
 async function command(id:string,type:ModelType,name:string,input:Record<string,unknown>,actor='owner',operationId=`fixture:${n++}`){const d=await runtime.authority.read(id,type);const c={operationId,documentId:id,documentType:type,expectedRevision:d.state.global.revision,type:name,input};const out=actor==='owner'?await runtime.authority.command(c):await runtime.authority.dispatchCommand(c,actor);assert(out.result.disposition==='ACCEPTED',JSON.stringify(out));return out;}
 const definition=(await runtime.authority.allocate('fixture-definition','kapelle/agent-definition','Synthetic task definition')).documentId;
 await command(definition,'kapelle/agent-definition','PUBLISH_DEFINITION',{release:r});
 const instance=(await runtime.authority.allocate('fixture-instance','kapelle/agent-instance','Synthetic task worker')).documentId;
 await command(instance,'kapelle/agent-instance','CREATE_INSTANCE',{instanceId:instance,scopeRef:ctx.scopeRef,definitionRef:{id:r.definitionId,version:r.packageVersion,contentHash:r.contentHash},name:'Synthetic task worker',responsibilities:['Work on synthetic Task instructions'],operatingPolicy:'No external effects; return a Report',modelPolicy:policy});
 await command(instance,'kapelle/agent-instance','SET_RUNTIME_BINDING',{runtimeBindingRef:'local-adapter'});
 for(const [ref,action] of [[platform.taskId,'read'],['task-delegation:owner','receive']])await command(instance,'kapelle/agent-instance','GRANT_CAPABILITY',{grant:{id:'grant:'+ref,principalId:instance,resourceRef:ref,actions:[action],expiresAt:'2026-09-12T12:00:00.000Z',reviewPolicy:'ALWAYS'}});
 await command(instance,'kapelle/agent-instance','REQUEST_RESUME',{});
 let tasks=new TaskDelegations(runtime.authority),server:ReturnType<typeof createServer>|undefined;
 const token='synthetic-task-delegation-owner-credential';
 async function serve(port=0, demo=false){const ownerHandler=frameworkHandler(runtime.authority,()=>token);server=createServer(async(req,res)=>{
 const url=new URL(req.url??'/', 'http://localhost');
 if(demo && (url.pathname.startsWith('/__fixture/')||url.pathname.startsWith('/v1/tasks/'))){
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(403);res.end();return;}
  try{if(demoHandler&&await demoHandler(req,res))return;let value:unknown;
   if(req.method==='GET'&&url.pathname==='/__fixture/state')value={synthetic:true,taskId:platform.taskId,agentId:instance};
   else if(req.method==='GET'&&url.pathname.startsWith('/v1/tasks/'))value=await readTask(decodeURIComponent(url.pathname.slice('/v1/tasks/'.length)));
   else if(req.method==='POST'&&url.pathname.startsWith('/__fixture/complete/'))value=await api.complete(url.pathname.slice('/__fixture/complete/'.length));
   else if(req.method==='POST'&&url.pathname==='/__fixture/change-source'){const t=await readTask(platform.taskId);await platform.act(t.id,'updateTitle',{expectedRevision:t.revision,title:'Changed synthetic task '+t.revision},'owner');value=await readTask(t.id);}
   else if(req.method==='POST'&&url.pathname==='/__fixture/disable-agent'){ctx.runtimeBindingContracts={...ctx.runtimeBindingContracts,'local-adapter':'unqualified'};value={ok:true};}
   else{res.writeHead(404);res.end();return;}
   res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));
  }catch{res.writeHead(409);res.end(JSON.stringify({error:'synthetic_control_failed'}));}return;
 }
 await ownerHandler(req,res);
 });await new Promise<void>((ok,bad)=>{server!.once('error',bad);server!.listen(port,'127.0.0.1',ok);});return `http://127.0.0.1:${(server.address() as any).port}`;}
 async function stopServer(){if(server){server.closeAllConnections();await new Promise<void>(ok=>server!.close(()=>ok()));server=undefined;}}
 const api = {root,ctx,platform,instance,token,command,readTask,serve,setReadOverride(f?:typeof readOverride){readOverride=f;},get authority(){return runtime.authority;},get tasks(){return tasks;},
 async addTask(title:string){
  const id=await platform.createTask(title);admittedTaskIds.add(id);
  ctx.resources=[...ctx.resources,{id,resourceType:'task',revision:1,contentHash:digest(id),allowedActions:['read']}];
  await command(instance,'kapelle/agent-instance','GRANT_CAPABILITY',{grant:{id:'grant:'+id,principalId:instance,resourceRef:id,actions:['read'],expiresAt:'2026-09-12T12:00:00.000Z',reviewPolicy:'ALWAYS'}});
  return id;
 },
 setDemoHandler(handler:typeof demoHandler){demoHandler=handler;},
 setCompletion(handler:typeof completion){completion=handler;},
 setResultFact(value:typeof result){result=value;},
 async offline<T>(run:(config:unknown)=>Promise<T>){
  const config={synthetic:true,options:{stateRoot:options.stateRoot,reactorRoot:options.reactorRoot,ownerId:options.ownerId,scopeRef:options.scopeRef},now:ctx.occurredAt,facts:await options.facts(),task:await readTask(platform.taskId)};
  await stopServer();await runtime.close();
  try{return await run(config);}finally{runtime=await openFrameworkRuntime(options);tasks=new TaskDelegations(runtime.authority);}
 },
 async restart(){await stopServer();await runtime.close();runtime=await openFrameworkRuntime(options);tasks=new TaskDelegations(runtime.authority);},
 async coldLookup(operationId:string){
  const file=join(root,'cold-options.json');writeFileSync(file,JSON.stringify({synthetic:true,options:{stateRoot:options.stateRoot,reactorRoot:options.reactorRoot,ownerId:options.ownerId,scopeRef:options.scopeRef},now:ctx.occurredAt,facts:await options.facts(),task:await readTask(platform.taskId),operationId}));
  await stopServer();await runtime.close();
  try{return await new Promise<any>((ok,bad)=>{
   const child=spawn(process.execPath,[process.env.KAPELLE_TEST_TSX_CLI!,fileURLToPath(new URL('../scripts/task-delegation-cold-read.ts',import.meta.url)),file],{cwd:fileURLToPath(new URL('..',import.meta.url)),env:process.env,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',bad);child.on('close',code=>{const line=output.split('\n').find(l=>l.startsWith('COLD_RECEIPT='));if(code!==0||!line)bad(Error(output));else ok(JSON.parse(line.slice('COLD_RECEIPT='.length)));});
  });}finally{runtime=await openFrameworkRuntime(options);tasks=new TaskDelegations(runtime.authority);}
 },
 async complete(operationId:string){if(completion)return completion(operationId);const receipt=await tasks.lookup(operationId);assert(receipt,'Task not found');const bundle=await runtime.authority.dispatchBundle(receipt.dispatchId,instance);const offer=(bundle.document.state.global as any).offer;await command(receipt.dispatchId,'kapelle/dispatch','ACCEPT_DISPATCH',{inputHash:offer.contentHash},instance,'accept:'+operationId);
 const reportId=await platform.report('Synthetic Task result. No provider called.',`dispatch:${receipt.dispatchId}`,instance);const report=await platform.coldRead(reportId),s=(report.state as any).global;
 assert(s.lifecycle==='FINAL'&&s.sourceRef===`dispatch:${receipt.dispatchId}`&&s.producer.id===instance,'Report provenance differs');
 result={dispatchId:receipt.dispatchId,inputHash:offer.contentHash,reportId,contentVersion:1,contentHash:s.content.contentHash,verificationRef:'synthetic-native-report:'+reportId};
 await command(receipt.dispatchId,'kapelle/dispatch','RECORD_DISPATCH_RESULT',{inputHash:offer.contentHash,reportId,contentVersion:1,contentHash:result.contentHash,verificationRef:result.verificationRef},instance,'result:'+operationId);return tasks.lookup(operationId);},
 async close(){await stopServer();await runtime.close();await platform.close();rmSync(root,{recursive:true,force:true});}};
 return api;
}
