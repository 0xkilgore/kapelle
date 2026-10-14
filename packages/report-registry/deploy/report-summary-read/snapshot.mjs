import {randomBytes, createHash} from 'node:crypto';
export const BOUNDS=Object.freeze({members:3000,page:100,pages:30,ttlMs:30000,retainedBytes:8000000,responseBytes:2000000,snapshots:8,pending:2});
const token=()=>randomBytes(32).toString('hex');
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=code=>{throw Error(code)};
/** Port of e876ea6 immutable snapshot cursor policy; fixed 6.2.1 reader/Drive policy. */
export class MetadataSnapshots {
 constructor(adapter,{driveId,authorize,clock=()=>performance.now(),wall=()=>Date.now()}={}) {
  if(!driveId||typeof authorize!=='function')fail('SUMMARY_CONFIG');
  this.adapter=adapter;this.driveId=driveId;this.authorize=authorize;this.clock=clock;this.wall=wall;this.snapshots=new Map();this.pending=0;
 }
 async page(input={},signal=new AbortController().signal) {
  if(!input||Array.isArray(input)||Object.keys(input).some(k=>k!=='cursor')||(input.cursor!==undefined&&!/^[a-f0-9]{64}$/.test(input.cursor)))fail('SUMMARY_REQUEST');
  signal.throwIfAborted();const scope=await this.authorize();signal.throwIfAborted();if(typeof scope!=='string'||!scope)fail('SUMMARY_DENIED');
  for(const [k,s]of this.snapshots)if(s.deadline<=this.clock())this.snapshots.delete(k);
  let s,offset=0;
  if(input.cursor!==undefined){for(const item of this.snapshots.values()){const i=item.cursors.indexOf(input.cursor);if(i>=0){s=item;offset=i*BOUNDS.page;break;}}
   if(!s||s.scope!==scope)fail('SUMMARY_CURSOR');
  }else{
   if(this.pending>=BOUNDS.pending||this.snapshots.size+this.pending>=BOUNDS.snapshots)fail('SUMMARY_BUSY');
   this.pending++;const started=this.clock(),capturedAt=new Date(this.wall()).toISOString();
   try{
    const captured=await this.adapter.capture(this.driveId,BOUNDS.members,signal);signal.throwIfAborted();
    if(captured.members.length>BOUNDS.members||new Set(captured.members.map(r=>r.documentId)).size!==captured.members.length)fail('SUMMARY_MEMBERSHIP');
    if(this.clock()-started>=BOUNDS.ttlMs)fail('SUMMARY_EXPIRED');
    const bytes=Buffer.byteLength(JSON.stringify(captured.members));
    if(bytes>BOUNDS.responseBytes-4096||bytes+[...this.snapshots.values()].reduce((n,v)=>n+v.bytes,0)>BOUNDS.retainedBytes)fail('SUMMARY_SIZE');
    s={...captured,bytes,scope,snapshotId:token(),observationId:token(),capturedAt,expiresAt:new Date(this.wall()+BOUNDS.ttlMs-(this.clock()-started)).toISOString(),deadline:started+BOUNDS.ttlMs,cursors:Array.from({length:Math.max(1,Math.ceil(captured.members.length/BOUNDS.page))},token)};
    this.snapshots.set(s.snapshotId,s);
   }finally{this.pending--;}
  }
  try{
   // Recheck current membership/deletion and projection version stamps, without bodies.
   await this.adapter.validate(this.driveId,s,signal);signal.throwIfAborted();
   if(await this.authorize()!==s.scope)fail('SUMMARY_DENIED');
   signal.throwIfAborted();if(this.clock()>=s.deadline)fail('SUMMARY_EXPIRED');
   const nextCursor=s.cursors[offset/BOUNDS.page+1]??null;
   const members=s.members.slice(offset,offset+BOUNDS.page);
   return {schemaVersion:'kapelle.report-summary-page.v2',source:'vetra-report-registry',driveId:this.driveId,observationId:s.observationId,observedAt:s.capturedAt,trust:'fixed-reader-drive-projected',membership:{snapshotId:s.snapshotId,capturedAt:s.capturedAt,expiresAt:s.expiresAt,totalMembers:s.members.length,coverage:'projected-snapshot',consistency:'materialized-projection-snapshot',checkpoint:null,frontierKind:'unavailable',publicationSafe:false},offset,members,nextCursor,exhausted:nextCursor===null};
  }catch(e){this.snapshots.delete(s.snapshotId);throw e;}
 }
}
export {digest};
