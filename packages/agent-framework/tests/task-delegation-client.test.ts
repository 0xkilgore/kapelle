import { it, expect } from 'vitest';
import { TaskSourceClient } from '../src/task-delegation/task-client.js';
it('uses only the existing bounded owner-scoped Task GET and rejects identity/owner drift or oversized reads',async()=>{
 const task={id:'existing-task',ownerId:'owner',revision:2,title:'Task',status:'OPEN',projectId:null,bodyMarkdown:'notes',comments:[],externalRefs:[]};
 let value:unknown=task,calls=0;
 const client=new TaskSourceClient('http://127.0.0.1:4499','owner',()=> 'synthetic-owner-token-over-thirty-two-chars',async(url,init)=>{calls++;expect(String(url)).toBe('http://127.0.0.1:4499/v1/tasks/existing-task');expect(init?.method??'GET').toBe('GET');expect(init?.redirect).toBe('error');return Response.json(value);});
 expect(await client.readTask(task.id)).toEqual(task);value={...task,ownerId:'other'};await expect(client.readTask(task.id)).rejects.toThrow('owner');value={...task,id:'wrong'};await expect(client.readTask(task.id)).rejects.toThrow('identity');value={...task,bodyMarkdown:'x'.repeat(262144)};await expect(client.readTask(task.id)).rejects.toThrow('too large');await expect(client.readTask('../bad')).rejects.toThrow('identity');expect(calls).toBe(4);
 expect(()=>new TaskSourceClient('http://example.com','owner',()=> 'token')).toThrow('URL');
});

it('only an explicit source-owner binding translates the read projection; raw identity drift still refuses',async()=>{
 const task={id:'pilot-task',ownerId:'legacy-owner',revision:2,title:'Pilot',status:'OPEN',projectId:null,bodyMarkdown:'synthetic',comments:[],externalRefs:[]};
 let value=task;const fetcher:typeof fetch=async()=>Response.json(value);
 const strict=new TaskSourceClient('http://127.0.0.1:4261','human:owner',()=> 'synthetic-token-over-thirty-two-characters',fetcher);
 await expect(strict.readTask(task.id)).rejects.toThrow('owner');
 const mapped=new TaskSourceClient('http://127.0.0.1:4261','human:owner',()=> 'synthetic-token-over-thirty-two-characters',fetcher,'legacy-owner');
 expect(await mapped.readTask(task.id)).toEqual({...task,ownerId:'human:owner'});expect(task.ownerId).toBe('legacy-owner');
 value={...task,ownerId:'human:owner'};await expect(mapped.readTask(task.id)).rejects.toThrow('owner');
 value={...task,ownerId:'another-user'};await expect(mapped.readTask(task.id)).rejects.toThrow('owner');
 value={...task,id:'other-task'};await expect(mapped.readTask(task.id)).rejects.toThrow('identity');
});
import {taskReadTransient} from '../src/task-delegation/task-client.js';
it('the 2 s Task-read budget starts after the local preflight (the pin re-hash used to consume it)',async()=>{
 const task={id:'t1',ownerId:'owner'};let order:string[]=[];
 const fetcher=(async(_url:unknown,init?:RequestInit)=>{order.push('fetch');expect(init?.signal?.aborted).toBe(false);await new Promise(r=>setTimeout(r,300));expect(init?.signal?.aborted).toBe(false);throw Object.assign(Error('stop'),{name:'Sentinel'});}) as typeof fetch;
 const client=new TaskSourceClient('http://127.0.0.1:4261','owner',()=> 'synthetic-token-over-thirty-two-characters',fetcher,'owner',async()=>{order.push('preflight');await new Promise(r=>setTimeout(r,2100));});
 await expect(client.readTask(task.id)).rejects.toThrow('stop');expect(order).toEqual(['preflight','fetch']);
},10000);
it.each([[403,'Task authority refused',false],[404,'Task authority refused',false],[408,'Task authority unavailable',true],[429,'Task authority unavailable',true],[503,'Task authority unavailable',true]] as const)('HTTP %i is %s',async(status,message,transient)=>{
 const client=new TaskSourceClient('http://127.0.0.1:4261','owner',()=> 'synthetic-token-over-thirty-two-characters',(async()=>new Response(null,{status})) as typeof fetch);
 const e=await client.readTask('t1').catch((x:unknown)=>x);expect((e as Error).message).toBe(message);expect(taskReadTransient(e)).toBe(transient);
});
it('only timeouts, transport and unavailable reads are transient',()=>{
 expect(taskReadTransient(Object.assign(Error('x'),{name:'TimeoutError'}))).toBe(true);expect(taskReadTransient(new TypeError('fetch failed'))).toBe(true);
 for(const m of ['Task source changed','Task identity or owner differs','task_token_changed','pilot_file_pin_changed'])expect(taskReadTransient(Error(m))).toBe(false);
});
