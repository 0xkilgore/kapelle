import { it, expect, vi } from 'vitest';
import { frameworkHandler } from '../src/service/http.js';
import { FrameworkAuthority } from '../src/service/authority.js';
import { NativeBackend } from '../src/service/native-backend.js';
import { pilotAllocationReader, pilotAuthority } from '../src/service/pilot-observation.js';
import { D, release } from './fixtures.js';
import { releaseHash } from '../src/command-boundary.js';

function fixture() {
  const r = release(); r.publisherRef = 'human:owner'; r.contentHash = releaseHash(r);
  const action = D.publishDefinition({actorId:'human:owner',occurredAt:'2026-10-11T12:00:00.000Z',expectedRevision:0,release:r});
  const rows:any[] = [{authorityId:pilotAuthority,collectionId:'collection',operationId:'allocate:task-report-pilot-initial',documentId:'not-added',documentType:'kapelle/agent-instance',status:'PENDING',completedAt:null}];
  const query:any[]=[];
  const q:any={};
  for(const method of ['selectFrom','select','where','orderBy','limit']) q[method]=(...args:any[])=>{query.push([method,...args]);return q;};
  q.execute=async()=>rows;
  const mutation=vi.fn(()=>{throw Error('mutation forbidden');});
  const ownership=vi.fn();
  const store:any={listOwnedDocumentIds:vi.fn(async()=>({documentIds:['definition'],nextCursor:null})),
    readOwnedOperationSnapshot:vi.fn(async()=>({documentId:'definition',name:'PRIVATE NAME',revision:1,initialModelVersion:1,operations:[{action}]})),
    reserveAllocation:mutation,finishAllocation:mutation,reconcile:mutation,inspectOwned:mutation};
  const backend=new NativeBackend(pilotAuthority,'collection','drive',store,{drives:{addFile:mutation},executeScopedAuthority:mutation},()=>'',pilotAllocationReader(q,pilotAuthority,'collection',ownership));
  const authority=new FrameworkAuthority(backend,{get:mutation,save:mutation} as any,{ownerId:'human:owner',scopeRef:'kapelle',facts:mutation});
  const handler=frameworkHandler(authority,()=> 'x'.repeat(32));
  async function request(url='/pilot-native-observation', headers:any={},method='GET') {
    let status=0,body:any;
    const res:any={writeHead:(s:number)=>{status=s;},end:(s:string)=>{body=JSON.parse(s);}};
    await handler({url,method,headers:{authorization:'Bearer '+'x'.repeat(32),...headers}} as any,res);
    expect(mutation).not.toHaveBeenCalled();
    return {status,body};
  }
  return {request,rows,query,store,authority,ownership,action,r};
}
it('full handler/authority/backend/store route observes PENDING without document and redacts definition',async()=>{
 const f=fixture();Object.defineProperty(f.authority.journal,'readOnly',{value:true});const res=await f.request();expect(res.status).toBe(200);expect(res.body.complete).toBe(true);
 expect(res.body.allocations[0]).toMatchObject({documentId:'not-added',status:'PENDING'});
 expect(res.body.definitions[0].release.contentHash).toBe(f.r.contentHash);
 expect(JSON.stringify(res.body)).not.toContain('PRIVATE NAME');expect(res.body.definitions[0].release.instructions).toBeUndefined();
 expect(f.store.readOwnedOperationSnapshot).toHaveBeenCalledTimes(1);expect(f.ownership).toHaveBeenCalledTimes(2);
 expect(f.query).toEqual([
 ['selectFrom','scoped_authority_allocations'],['select',['authorityId','collectionId','operationId','documentId','documentType','status','completedAt']],
 ['where','authorityId','=',pilotAuthority],['where','collectionId','=','collection'],['where','operationId','like','allocate:task-report-pilot%'],['orderBy','operationId','asc'],['limit',201]]);
});
it('includes completed allocations and normalizes database Date without probing membership',async()=>{
 const f=fixture();f.rows[0].status='ALLOCATED';f.rows[0].completedAt=new Date('2026-10-11T12:00:00.000Z');
 const res=await f.request();expect(res.status).toBe(200);expect(res.body.allocations[0].completedAt).toBe('2026-10-11T12:00:00.000Z');
});
it.each(['token','identity-header','query','body','method','owner','scope'])('refuses %s before store reads',async kind=>{
 const f=fixture();let url='/pilot-native-observation',headers:any={},method='GET';
 if(kind==='token')headers.authorization='wrong';if(kind==='identity-header')headers['x-id-owner']='human:owner';
 if(kind==='query')url+='?prefix=anything';if(kind==='body')headers['content-length']='1';if(kind==='method')method='POST';
 if(kind==='owner')f.authority.options.ownerId='other';if(kind==='scope')f.authority.options.scopeRef='other';
 expect((await f.request(url,headers,method)).status).toBeGreaterThanOrEqual(400);expect(f.store.listOwnedDocumentIds).not.toHaveBeenCalled();
});
it.each(['cursor','overflow','row-owner','row-collection','row-prefix','row-status','row-completion','duplicate','definition-owner','definition-hash','snapshot-bound','lease'])('fails closed on %s with zero mutations',async kind=>{
 const f=fixture();
 if(kind==='cursor')f.store.listOwnedDocumentIds.mockResolvedValue({documentIds:['definition'],nextCursor:'more'});
 if(kind==='overflow')f.rows.push(...Array.from({length:200},(_,i)=>({...f.rows[0],operationId:`allocate:task-report-pilot-${i}`})));
 if(kind==='row-owner')f.rows[0].authorityId='other';if(kind==='row-collection')f.rows[0].collectionId='other';if(kind==='row-prefix')f.rows[0].operationId='allocate:other';
 if(kind==='row-status')f.rows[0].status='UNKNOWN';if(kind==='row-completion')f.rows[0].completedAt='2026-10-11T12:00:00.000Z';
 if(kind==='duplicate')f.rows.push({...f.rows[0]});
 if(kind==='definition-owner'){f.action.input.actorId='other';f.action.input.release.publisherRef='other';f.action.input.release.contentHash=releaseHash(f.action.input.release);}
 if(kind==='definition-hash')f.action.input.release.contentHash='sha256:'+'0'.repeat(64);
 if(kind==='snapshot-bound'){f.action.input.release.capabilities=Array.from({length:30},(_,i)=>({id:`cap-${i}`,resourceType:'task',requirement:'REQUIRED',actions:Array.from({length:200},(_,j)=>`action-${j}-`+'z'.repeat(480)),outputTypes:[]}));f.action.input.release.contentHash=releaseHash(f.action.input.release);}
 if(kind==='lease')f.ownership.mockImplementation(()=>{throw Error('lease changed');});
 const res=await f.request();expect(res.status).toBeGreaterThanOrEqual(400);expect(res.body.complete).toBeUndefined();expect(res.body.allocations).toBeUndefined();
});
it('returns an empty complete observation without synthesizing a recipient',async()=>{
 const f=fixture();f.rows.splice(0);f.store.listOwnedDocumentIds.mockResolvedValue({documentIds:[],nextCursor:null});
 const res=await f.request();expect(res.status).toBe(200);expect(res.body.definitions).toEqual([]);expect(res.body.allocations).toEqual([]);
});
it.each(['aggregate','response'])('enforces %s byte bound through the route',async kind=>{
 const f=fixture();
 f.action.input.release.runtimeContracts=Array.from({length:200},(_,i)=>`runtime-${i}-`+'z'.repeat(480));
 f.action.input.release.contentHash=releaseHash(f.action.input.release);
 f.store.listOwnedDocumentIds.mockResolvedValue({documentIds:Array.from({length:kind==='aggregate'?100:12},(_,i)=>`definition-${i}`),nextCursor:null});
 const res=await f.request();expect(res.status).toBe(503);expect(res.body).toEqual({ok:false,error:'authority_unavailable'});
 expect(f.query.length).toBe(kind==='aggregate'?0:7);
});
