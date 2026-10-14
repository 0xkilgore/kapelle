import {z} from 'zod';
import {requireOpsApiAccess,OPS_NO_STORE_HEADERS} from '../../../../ops/_lib/config';
import {TaskHostError,readTaskHostSources,readTaskHostContext,readTaskHostProposal,commandTaskHost,findTaskHostDelegationsV2,readTaskHostPriorResult,readTaskHostStatusV2} from '../../../../ops/_lib/taskHost';
import {presentsDelegationToken,requireDelegationClientAccess} from '../../../../ops/_lib/delegationClientAccess';
import {scopedDelegationRead,scopedDelegationCommand} from '../../../../ops/_lib/delegationClientCommands';
export const dynamic='force-dynamic';
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:OPS_NO_STORE_HEADERS});
const taskIdSchema=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/);
const operation=z.string().uuid();
function failure(e:unknown){return json({ok:false,error:e instanceof z.ZodError||e instanceof SyntaxError?'Invalid task request.':e instanceof TaskHostError?e.message:'The saved task request could not be confirmed. Check its status before retrying.'},e instanceof z.ZodError||e instanceof SyntaxError?400:e instanceof TaskHostError?e.status:503);}
async function readBody(request:Request,limit=64000){
 const reader=request.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
 if(reader)for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>limit){await reader.cancel();return null;}chunks.push(p.value);}
 return Buffer.concat(chunks).toString();
}
/** A scoped chat connection (Bearer kdt1.…) takes a separate guard and a separate, bound watch/cancel surface.
 * It never reaches the owner branches below, and owner credentials never reach the scoped ones. */
export async function GET(request:Request){
 if(presentsDelegationToken(request)){
  const access=await requireDelegationClientAccess(request);if(!access.ok)return json({ok:false,error:access.reason},access.status);
  try{return json(await scopedDelegationRead(access.claims,new URL(request.url).searchParams));}catch(e){return failure(e);}
 }
 const access=requireOpsApiAccess(request);if(!access.ok)return json({ok:false,error:access.reason},access.status);
 try{
  const q=new URL(request.url).searchParams,taskId=taskIdSchema.parse(q.get('taskId'));
  if(q.get('sources')==='1')return json(await readTaskHostSources(taskId));
  // Increment 2 reads: discovery v2 and status v2 only (the v1 discovery and execution reads were removed with the step-4 UI).
  if(q.get('delegations')==='2')return json(await findTaskHostDelegationsV2(taskId,{cursor:q.has('cursor')?z.string().min(1).max(500).parse(q.get('cursor')):null}));
  if(q.has('priorResult'))return json(await readTaskHostPriorResult(taskId,operation.parse(q.get('priorResult'))));
  if(q.has('proposalId'))return json(await readTaskHostProposal(taskId,operation.parse(q.get('proposalId'))));
  if(q.has('proposalOperationId'))return json(await readTaskHostProposal(taskId,operation.parse(q.get('proposalOperationId')),true));
  // Status v2 only; an old client asking for the removed v1 execution read is refused before any upstream read.
  if(q.has('operationId'))return q.get('status')==='2'?json(await readTaskHostStatusV2(taskId,operation.parse(q.get('operationId')))):json({ok:false,error:'Invalid task request.'},400);
  return json(await readTaskHostContext(taskId));
 }catch(e){return failure(e);}
}
export async function POST(request:Request){
 if(presentsDelegationToken(request)){
  const access=await requireDelegationClientAccess(request);if(!access.ok)return json({ok:false,error:access.reason},access.status);
  try{
   if(!(request.headers.get('content-type')??'').startsWith('application/json'))return json({ok:false,error:'JSON body required.'},415);
   const text=await readBody(request,4000);if(text===null)return json({ok:false,error:'Request is too large.'},413);
   return json(await scopedDelegationCommand(access.claims,JSON.parse(text)));
  }catch(e){return failure(e);}
 }
 const access=requireOpsApiAccess(request);if(!access.ok)return json({ok:false,error:access.reason},access.status);
 try{
  const origin=request.headers.get('origin');
  if(request.headers.get('x-kapelle-csrf')!=='task-host'||!origin||!['http:','https:'].includes(new URL(origin).protocol)||new URL(origin).host!==request.headers.get('host'))return json({ok:false,error:'Invalid origin.'},403);
  const taskId=taskIdSchema.parse(new URL(request.url).searchParams.get('taskId'));
  const text=await readBody(request);if(text===null)return json({ok:false,error:'Request is too large.'},413);
  return json(await commandTaskHost(taskId,JSON.parse(text)));
 }catch(e){return failure(e);}
}
