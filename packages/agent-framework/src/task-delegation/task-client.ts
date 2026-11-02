import { taskSchema, type Task } from './contract.js';
/** Narrow existing Task Authority GET, with an owner-bound host credential. */
export class TaskSourceClient {
 readonly origin:string;
 constructor(url:string,readonly ownerId:string,readonly token:()=>string,readonly fetcher:typeof fetch=fetch,readonly sourceOwnerId:string=ownerId,readonly preflight?:()=>Promise<void>){
  const u=new URL(url);if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Task authority URL invalid');this.origin=u.origin;
 }
 async readTask(id:string):Promise<Task>{
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(id))throw Error('Task identity invalid');
  // Local admission checks (pin re-hash) run first, so the 2 s budget below covers only the HTTP read itself.
  await this.preflight?.();const token=this.token();if(token.length<32)throw Error('Task authority not configured');
  const r=await this.fetcher(`${this.origin}/v1/tasks/${encodeURIComponent(id)}`,{headers:{authorization:'Bearer '+token},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(2000)});
  // A definite refusal (4xx other than 408/429) is semantic; only timeouts, 408/429 and 5xx are transient (taskReadTransient).
  if(!r.ok)throw Error(r.status>=400&&r.status<500&&r.status!==408&&r.status!==429?'Task authority refused':'Task authority unavailable');const reader=r.body?.getReader();if(!reader)throw Error('Task authority unavailable');const chunks:Uint8Array[]=[];let length=0;
  for(;;){const v=await reader.read();if(v.done)break;length+=v.value.length;if(length>262144){await reader.cancel();throw Error('Task source too large');}chunks.push(v.value);}
  const task=taskSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));if(task.id!==id||task.ownerId!==this.sourceOwnerId)throw Error('Task identity or owner differs');return {...task,ownerId:this.ownerId};
 }
}
/** Task Authority read failures that say nothing about the Task: timeout, transport, 408/429/5xx. Everything else is semantic. */
export function taskReadTransient(e:unknown){
 return e instanceof Error&&(e.name==='TimeoutError'||e.name==='AbortError'||e.message==='Task authority unavailable'||(e instanceof TypeError&&e.message==='fetch failed'));
}
