import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import {frameworkHandler} from '../service/http.js';
import type {FrameworkAuthority} from '../service/authority.js';
import type {DispatchState} from '../../document-models/dispatch/v1/index.js';
import {canonical,digest} from '../content.js';
import {taskSchema,taskSource} from './contract.js';
import {packetSchema,packetNotesSchema} from './worker-contract.js';
import {TaskWorker,type TaskWorkerPorts} from './worker.js';
import {pilotSignals} from './pilot.js';
import {taskWorkerBindingSchema,taskCapabilityHash,type TaskWorkerBinding} from './worker-contract.js';
export type TaskHostOptions={
 root:string; authority:FrameworkAuthority; binding:TaskWorkerBinding; ports:TaskWorkerPorts;
 token:()=>string;
 /** Fresh host-owned packet/source ACL, provider and publisher admission. No permissive default. */
 admitted:(taskId:string,binding:Readonly<TaskWorkerBinding>)=>Promise<boolean>;
 /** Current Task/Dispatch read authorization, separate from READY/new-work admission.
  * Absent on older hosts: retain their restrictive execution-admission behavior. */
 readable?:(taskId:string,dispatchId:string,binding:Readonly<TaskWorkerBinding>,saved?:boolean)=>Promise<boolean>;
};
const taskIdSchema=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
/** Mount in the existing Framework server. No new listener, schedule or Task/Report store. */
export function openTaskExecutionHost(options:TaskHostOptions){
 const binding=taskWorkerBindingSchema.parse(options.binding);
 if(!options.authority.options.taskDelegation||!options.ports.reports||typeof options.admitted!=='function')throw Error('task_host_dependencies_required');
 const worker=TaskWorker.open(options.root,options.authority,binding,options.ports);
 const fallback=frameworkHandler(options.authority,options.token);
 async function admission(taskId:string){
  const roster=await options.authority.taskDelegationAgents(taskId);
  const p=roster.agents.find(a=>a.id===binding.instanceId&&a.available)?.recipient;
  let ready=false,packetHash:string|null=null;
  let snapshot:{task:ReturnType<typeof taskSource>;packet:z.infer<typeof packetSchema>}|null=null;
  try{
   const task=taskSchema.parse(await options.authority.options.taskDelegation!.readTask(taskId));
   if(task.id!==taskId||task.ownerId!==binding.ownerId||canonical(taskSource(task))!==canonical(roster.task))throw Error('task_changed');
   const notes=packetNotesSchema.parse(JSON.parse(task.bodyMarkdown));
   const packet=packetSchema.parse(await options.ports.packet(notes.packetHash,binding));
   if(digest(packet)!==notes.packetHash)throw Error('packet_changed');
   packetHash=notes.packetHash;
   ready=Boolean(p&&p.runtimeBindingRef===binding.runtimeBindingRef&&p.definitionHash===binding.definitionHash&&p.capabilityHash===taskCapabilityHash(binding,taskId)&&await options.admitted(taskId,Object.freeze({...binding})));
   const after=taskSchema.parse(await options.authority.options.taskDelegation!.readTask(taskId));
   if(canonical(after)!==canonical(task))ready=false;
   if(ready)snapshot={task:taskSource(task),packet};
  }catch{ready=false;}
  return {ready,taskRevision:roster.task.revision,sourceHash:roster.task.sourceHash,packetHash:ready?packetHash:null,snapshot:ready?snapshot:null};
 }
 const handler=async(req:IncomingMessage,res:ServerResponse)=>{
  const url=new URL(req.url??'/','http://localhost');
  if(!url.pathname.startsWith('/task-executions/'))return fallback(req,res);
  const reply=(status:number,value:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store'});res.end(JSON.stringify(value));};
  const secret=options.token(),actual=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+secret);
  if(secret.length<32||actual.length!==expected.length||!timingSafeEqual(actual,expected)||req.headers['x-id-team']||req.headers['x-id-owner']||req.headers['x-id-admin'])return reply(403,{ok:false,error:'forbidden'});
  try{
   // Increment 2: read-only pilot signals (separate from the strict admission contract; older consoles never call it).
   if(req.method==='GET'&&url.pathname==='/task-executions/pilot'){
    if([...url.searchParams.keys()].some(k=>k!=='taskId')||url.searchParams.getAll('taskId').length!==1)return reply(400,{ok:false,error:'invalid_request'});
    const taskId=taskIdSchema.parse(url.searchParams.get('taskId'));
    const pilot=binding.pilot?pilotSignals(binding.pilot,taskId,options.authority.options.now?.()??new Date().toISOString(),worker.pilotConsumed()):null;
    return reply(200,{ok:true,contract:'kapelle.task-host-pilot/v1',instanceId:binding.instanceId,taskId,pilot});
   }
   if(req.method==='GET'&&(url.pathname==='/task-executions/admission'||url.pathname==='/task-executions/sources')){
    if([...url.searchParams.keys()].some(k=>k!=='taskId')||url.searchParams.getAll('taskId').length!==1)return reply(400,{ok:false,error:'invalid_request'});
    const taskId=taskIdSchema.parse(url.searchParams.get('taskId'));
    const {snapshot,...current}=await admission(taskId);
    const {ready}=current;
    if(url.pathname==='/task-executions/sources'){
     if(!ready||!snapshot)return reply(503,{ok:false,error:'host_not_admitted'});
     return reply(200,{ok:true,contract:'kapelle.task-host-sources/v1',instanceId:binding.instanceId,...current,...snapshot});
    }
    return reply(200,{ok:true,contract:'kapelle.task-host/v1',instanceId:binding.instanceId,reason:ready?null:'host_not_admitted',packetRequired:true,...current});
   }
   const match=/^\/task-executions\/([a-f0-9-]{36})(\/(?:run|reconcile))?$/.exec(url.pathname);
   if(!match||url.search)return reply(404,{ok:false,error:'not_found'});
   const dispatchId=z.uuid().parse(match[1]);
   if(!((req.method==='GET'&&!match[2])||(req.method==='POST'&&match[2])))return reply(405,{ok:false,error:'method_not_allowed'});
   if(req.method==='POST'){
    if(!(req.headers['content-type']??'').startsWith('application/json'))return reply(415,{ok:false,error:'json_required'});
    let size=0;const chunks:Buffer[]=[];
    for await(const chunk of req){size+=chunk.length;if(size>256)return reply(413,{ok:false,error:'request_too_large'});chunks.push(chunk);}
    z.object({}).strict().parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
   }
   const state=(await options.authority.read(dispatchId,'kapelle/dispatch')).state.global as DispatchState;
   if(state.ownerId!==binding.ownerId||state.scopeRef!==binding.scopeRef||state.offer?.recipient.instanceId!==binding.instanceId)return reply(409,{ok:false,error:'dispatch_scope_changed'});
   const taskId=taskIdSchema.parse(state.offer.task.taskRef);
   if(req.method==='GET'&&options.readable){
    return await worker.readWithRecovery(dispatchId,async saved=>{
    const allowed=()=>options.readable!(taskId,dispatchId,Object.freeze({...binding}),saved);
    if(!await allowed())return reply(403,{ok:false,error:'saved_read_denied'});
    // After the pilot's recovery window: the read-only projection of the saved record (no port, no write).
    const item=saved?await worker.savedStatus(dispatchId):await worker.inspect(dispatchId);
    if(!await allowed())return reply(403,{ok:false,error:'saved_read_denied'});
    return reply(200,{ok:true,item});
    });
   }
   if(req.method==='POST'&&match[2]==='/reconcile')return reply(200,{ok:true,item:await worker.reconcile(dispatchId)});
   if(!(await admission(taskId)).ready)return reply(503,{ok:false,error:'host_not_admitted'});
   if(req.method==='GET')return reply(200,{ok:true,item:await worker.inspect(dispatchId)});
   // Claim, then detach: the reply carries the durable started claim (202) or the settled outcome (200).
   // A console timeout no longer races a provider call; GET reads the journal while the run continues.
   const item=await worker.begin(dispatchId);
   return reply(item.status==='EXECUTION_RUNNING'?202:200,{ok:true,item});
  }catch(error){
   if(error instanceof z.ZodError||error instanceof SyntaxError)return reply(400,{ok:false,error:'invalid_request'});
   const message=error instanceof Error?error.message:'';
   if(message==='publisher_model_not_admitted')return reply(409,{ok:false,error:'publisher_model_not_admitted'});
   return reply(/^(worker_|Task |Stale |Instance |Source |Definition |Runtime |Grant |Budget )/.test(message)?409:503,{ok:false,error:'task_execution_unavailable'});
  }
 };
 // stop() aborts the active provider call and resolves once any detached run has settled, so a
 // bounded service stop can close the journal without racing a background execution.
 return {handler,stop:async()=>{worker.stop();await worker.drain();},close:()=>worker.close()};
}
