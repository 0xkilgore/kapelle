// G1: read-only Dispatch list by recipient over the existing authority listener.
// Bounded page, explicit completeness, owner/scope enforced server-side, no execution state implied.
import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {taskDelegationFixture} from './task-delegation-fixture.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {dispatchOfferHash} from '../src/dispatch/contracts.js';
import {createDispatch} from '../document-models/dispatch/v1/index.js';
const native=process.env.KAPELLE_SCOPED_REACTOR_ROOT&&process.env.KAPELLE_PLATFORM_MODELS_ROOT;

async function sendOne(f:Awaited<ReturnType<typeof taskDelegationFixture>>){
 const task=(await f.readTask(f.platform.taskId))!;
 const roster=await f.authority.taskDelegationAgents(task.id),agent=roster.agents.find(a=>a.available)!,op=randomUUID(),api=new TaskProposals(f.authority);
 const proposal=await api.create({operationId:op,draft:{operationId:op,taskId:task.id,revision:roster.task.revision,agentId:agent.id,recipient:agent.recipient!,sourceHash:roster.task.sourceHash,includeNotes:true,includeComments:false,includeReferences:false}});
 const p=proposal!;
 return (await api.approveAndSend(p.proposalId,{operationId:randomUUID(),expectedRevision:p.revision,version:1,planHash:p.versions[0].planHash})).item!;
}


/** A REAL Dispatch record in the same collection whose owner or scope differs from the authority's.
 * Written through the backend's own prepare/reconcile path with the generated action creator, so the
 * record is stored exactly like any other; only the authority's owner/scope filter can keep it out. */
async function foreignRecord(f:Awaited<ReturnType<typeof taskDelegationFixture>>,template:any,over:{ownerId:string;scopeRef?:string}){
 const backend=f.authority.backend,op='foreign:'+randomUUID(),owner=over.ownerId;
 const {documentId}=await backend.allocate(op,'kapelle/dispatch','Foreign dispatch');
 // The reducer binds sender and requester to the owner that creates the record; the offer is otherwise the real one.
 const offer={...template,senderId:owner,originalRequesterId:owner,...(over.scopeRef?{scopeRef:over.scopeRef}:{})};offer.contentHash=dispatchOfferHash(offer);
 const action=createDispatch({actorId:owner,occurredAt:f.ctx.occurredAt,expectedRevision:0,dispatchId:documentId,ownerId:owner,offer});
 const read=await backend.read(documentId,'kapelle/dispatch');
 const receipt=await backend.commit(documentId,await backend.prepare(documentId,'kapelle/dispatch',op,read.nativeRevision,action as never));
 expect(receipt.errors??[],JSON.stringify(receipt)).toEqual([]);
 const doc=(await backend.read(documentId,'kapelle/dispatch')).document,stored=doc.state.global as any,last=(doc as any).operations?.global?.at(-1);
 expect(last?.error??null,JSON.stringify({receipt,last})).toBeNull();
 expect(stored.ownerId).toBe(over.ownerId);expect(stored.offer.recipient.instanceId).toBe(template.recipient.instanceId);
 return documentId;
}

describe.skipIf(!native)('GET /dispatches: Dispatch records by recipient',()=>{
 it('lists only this owner/scope/recipient with phases, bounded pages and explicit completeness; never implies execution',async()=>{
  const f=await taskDelegationFixture();
  try{
   const url=await f.serve(0),headers={authorization:'Bearer '+f.token};
   const get=(q:string,h:Record<string,string>=headers)=>fetch(url+'/dispatches'+q,{headers:h});
   // Access: token required; caller identity headers refused; recipient required; bad phase/limit refused.
   expect((await get('?recipient='+f.instance,{authorization:'Bearer wrong'})).status).toBe(403);
   expect((await get('?recipient='+f.instance,{...headers,'x-id-owner':'owner'})).status).toBe(403);
   expect((await get('')).status).toBe(400);
   expect((await get('?recipient='+f.instance+'&phase=BOGUS')).status).toBe(400);
   expect((await get('?recipient='+f.instance+'&limit=500')).status).toBe(400);
   // Empty, complete.
   let body=await (await get('?recipient='+f.instance)).json();
   expect(body).toMatchObject({ok:true,contract:'kapelle.dispatch-list/v1',recipient:f.instance,items:[],scanned:0,nextCursor:null,complete:true});
   // Two Dispatches for the same recipient (two approved rounds on one Task).
   const first=await sendOne(f),second=await sendOne(f);
   body=await (await get('?recipient='+f.instance)).json();
   expect(body.complete).toBe(true);expect(body.scanned).toBe(2);
   expect(body.items.map((i:any)=>i.dispatchId).sort()).toEqual([first.dispatchId,second.dispatchId].sort());
   const item=body.items.find((i:any)=>i.dispatchId===first.dispatchId);
   // After approve-and-send the record is OFFERED; ACCEPTED is written only when the worker accepts it.
   expect(item).toMatchObject({phase:'OFFERED',taskRef:f.platform.taskId,authorityRef:'task-authority',recipientInstanceId:f.instance,result:null,cancellationReason:null,proposalOperationId:first.operationId});
   expect(typeof item.expiresAt).toBe('string');expect(item.acceptedAt===null||typeof item.acceptedAt==='string').toBe(true);
   // Dispatch records carry no worker/execution fields: the list is the native record only.
   for(const k of ['status','worker','execution','outputRetained'])expect(k in item).toBe(false);
   // Phase filter.
   expect((await (await get('?recipient='+f.instance+'&phase=RESULT_RECORDED')).json()).items).toEqual([]);
   expect((await (await get('?recipient='+f.instance+'&phase=ACCEPTED,OFFERED')).json()).items).toHaveLength(2);
   // Another recipient in the same scope sees nothing, completely.
   expect(await (await get('?recipient='+randomUUID())).json()).toMatchObject({items:[],complete:true});
   // Authorization evidence: real records for the SAME recipient but a foreign owner, and a foreign scope,
   // exist in the collection and are never listed. `scanned` shows they were read and filtered out.
   const template=((await f.authority.backend.read(first.dispatchId,'kapelle/dispatch')).document.state.global as any).offer;
   const foreignOwner=await foreignRecord(f,template,{ownerId:'foreign-owner'});
   const foreignScope=await foreignRecord(f,template,{ownerId:'owner',scopeRef:'foreign-scope'});
   body=await (await get('?recipient='+f.instance)).json();
   expect(body.scanned).toBe(4);expect(body.complete).toBe(true);
   expect(body.items.map((i:any)=>i.dispatchId).sort()).toEqual([first.dispatchId,second.dispatchId].sort());
   for(const id of [foreignOwner,foreignScope])expect(body.items.some((i:any)=>i.dispatchId===id)).toBe(false);
   // The same owner check guards the direct document read.
   expect((await fetch(url+'/documents/'+foreignOwner+'?type=kapelle%2Fdispatch',{headers})).status).not.toBe(200);
   // Bounded pages: limit=1 reports an incomplete read with a continuation. Filtering happens after
   // paging, so a page can hold zero records for this recipient (a foreign record was read there);
   // following the cursor to the end yields exactly the two legitimate records and `complete`.
   const collected:string[]=[];let cursor:string|null=null,pages=0;
   do{
    const page=await (await get('?recipient='+f.instance+'&limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''))).json();
    pages++;expect(page.scanned).toBeLessThanOrEqual(1);expect(page.items.length).toBeLessThanOrEqual(page.scanned);
    for(const i of page.items)collected.push(i.dispatchId);
    expect(page.complete).toBe(page.nextCursor===null);cursor=page.nextCursor;
   }while(cursor&&pages<10);
   expect(pages).toBeGreaterThanOrEqual(4);expect(pages).toBeLessThan(10);expect(cursor).toBeNull();
   expect(collected.sort()).toEqual([first.dispatchId,second.dispatchId].sort());
   // Recording a result shows in the record; the list still asserts nothing about execution.
   await f.complete(second.operationId);
   const recorded=(await (await get('?recipient='+f.instance+'&phase=RESULT_RECORDED')).json()).items;
   expect(recorded).toHaveLength(1);expect(recorded[0].dispatchId).toBe(second.dispatchId);expect(recorded[0].result?.reportId).toBeTruthy();
  }finally{await f.close();}
 },120000);
});

// Increment 2: exact Task filter, historical recipients, cursor bound to its query.
describe.skipIf(!native)('GET /dispatches?taskRef=: Task-filtered Dispatch discovery',()=>{
 it('finds a Task\'s Dispatches without naming the recipient, excludes other Tasks, pages with a bound cursor',async()=>{
  const f=await taskDelegationFixture();
  try{
   const url=await f.serve(0),headers={authorization:'Bearer '+f.token};
   const get=(q:string)=>fetch(url+'/dispatches'+q,{headers});
   const taskRef=f.platform.taskId;
   expect((await get('?taskRef='+encodeURIComponent('bad task'))).status).toBe(400);
   expect((await get('')).status).toBe(400);
   const first=await sendOne(f),second=await sendOne(f);
   // A real record for the SAME owner/scope/recipient but ANOTHER Task: listed by recipient, never by this Task.
   const template=((await f.authority.backend.read(first.dispatchId,'kapelle/dispatch')).document.state.global as any).offer;
   const otherTask=await foreignRecord(f,{...template,task:{...template.task,taskRef:'other-task'}},{ownerId:'owner'});
   let body=await (await get('?taskRef='+taskRef)).json();
   expect(body).toMatchObject({ok:true,contract:'kapelle.dispatch-list/v1',recipient:null,taskRef,complete:true,nextCursor:null});
   expect(body.items.map((i:any)=>i.dispatchId).sort()).toEqual([first.dispatchId,second.dispatchId].sort());
   expect(body.items.every((i:any)=>i.taskRef===taskRef)).toBe(true);
   expect((await (await get('?recipient='+f.instance)).json()).items.some((i:any)=>i.dispatchId===otherTask)).toBe(true);
   expect((await (await get('?taskRef=other-task')).json()).items.map((i:any)=>i.dispatchId)).toEqual([otherTask]);
   // Recipient AND Task.
   expect((await (await get('?taskRef='+taskRef+'&recipient='+randomUUID())).json()).items).toEqual([]);
   // Recipient-only responses keep their exact v1 shape (no taskRef key).
   expect('taskRef' in (await (await get('?recipient='+f.instance)).json())).toBe(false);
   // Bounded pages with a bound cursor: following it yields exactly this Task's records and `complete`.
   const collected:string[]=[];let cursor:string|null=null,pages=0,firstCursor:string|null=null;
   do{
    const page=await (await get('?taskRef='+taskRef+'&limit=1'+(cursor?'&cursor='+encodeURIComponent(cursor):''))).json();
    pages++;expect(page.scanned).toBeLessThanOrEqual(1);for(const i of page.items)collected.push(i.dispatchId);
    expect(page.complete).toBe(page.nextCursor===null);cursor=page.nextCursor;firstCursor??=cursor;
   }while(cursor&&pages<10);
   expect(cursor).toBeNull();expect(collected.sort()).toEqual([first.dispatchId,second.dispatchId].sort());
   // The cursor cannot change Task, recipient or phases.
   expect(firstCursor).toMatch(/^b1\./);
   for(const q of ['?taskRef=other-task','?recipient='+f.instance,'?taskRef='+taskRef+'&phase=OFFERED','?taskRef='+taskRef+'&recipient='+f.instance])
    expect((await get(q+'&limit=1&cursor='+encodeURIComponent(firstCursor!))).status,q).not.toBe(200);
   expect((await get('?taskRef='+taskRef+'&limit=1&cursor='+encodeURIComponent('raw-backend-cursor'))).status).not.toBe(200);
  }finally{await f.close();}
 },120000);
});
