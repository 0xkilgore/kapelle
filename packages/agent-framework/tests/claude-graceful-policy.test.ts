import {describe,it,expect} from 'vitest';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,existsSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {ownedClaudeProcesses,type TerminationRecord} from '../src/worker/claude-process.js';
import {invocationFence} from '../src/worker/invocation-fence.js';
import {acquireWriterLock,releaseWriterLock,recoverDeadWriterLock} from '../src/worker/writer-lock.js';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(f:()=>boolean){for(let i=0;i<700;i++){if(f())return;await delay(10);}throw Error('fixture deadline');}
const temp=()=>realpathSync(mkdtempSync(join(tmpdir(),'graceful-policy-')));
async function setup(mode='hold',fail=false){
 const root=temp(),lock=acquireWriterLock(root),fence=invocationFence(lock),controller=new AbortController();
 const script=join(root,'child.mjs');copyFileSync(join(import.meta.dirname,'fixtures/graceful-child.mjs'),script);
 let record:TerminationRecord|undefined,uncertain=false,closed=false;
 const scope=ownedClaudeProcesses({auditPath:join(root,'audit.json'),uncertain(){uncertain=true;writeFileSync(join(root,'uncertain'),'consumed');},record(r){record=r;if(fail&&r.cancelledAt!==null)throw Error('fixture journal failure');fence.record(r);}});
 const child=scope.spawn({command:process.execPath,args:[script,root,mode],cwd:root,env:{PATH:'/usr/bin:/bin'},signal:controller.signal});
 child.on('close',()=>{closed=true;});
 await until(()=>existsSync(join(root,mode==='pipe'?'grandchild-ready':'ready')));
 const release=()=>writeFileSync(join(root,'release'),'yes');
 return {root,lock,fence,scope,child,controller,script,get record(){return record!;},get uncertain(){return uncertain;},get closed(){return closed;},release,async finish(keep=false){release();await scope.drain().catch(()=>{});if(!keep){fence.settle();releaseWriterLock(lock);rmSync(root,{recursive:true,force:true});}}};
}
describe('Claude graceful-only policy',()=>{
 it('coalesces abort and SDK requests, denying numeric and force signals before actual close',async()=>{
  const f=await setup();try{
   f.controller.abort();f.scope.cancel();f.child.kill('SIGTERM');
   for(const s of ['SIGKILL','SIGINT',9,15,0] as const)expect(f.child.kill(s)).toBe(false);
   await until(()=>existsSync(join(f.root,'terms')));
   expect(readFileSync(join(f.root,'terms'),'utf8')).toBe('TERM\n');expect(f.record.termAttempts).toBe(1);expect(f.record.blockedSignals).toBe(5);expect(f.uncertain).toBe(true);
   expect(f.record.events.findIndex(e=>e.event==='cancellation_requested')).toBeLessThan(f.record.events.findIndex(e=>e.event==='sigterm_attempt'));
   expect(()=>acquireWriterLock(f.root)).toThrow('reconciliation_required');expect(()=>releaseWriterLock(f.lock)).toThrow('reconciliation_required');expect(()=>f.scope.assertIdentified()).toThrow();
  }finally{await f.finish();}
 });
 it('refuses changed binary identity permanently and retains reconciliation after close',async()=>{
  const f=await setup();try{
   writeFileSync(f.script,'// changed');f.scope.cancel();expect(f.record.identityMismatch).toBe(true);expect(f.record.termAttempts).toBe(0);
   f.child.kill('SIGTERM');expect(existsSync(join(f.root,'terms'))).toBe(false);f.release();await expect(f.scope.drain()).rejects.toThrow('reconciliation_required');expect(()=>f.fence.settle()).toThrow('reconciliation_required');expect(()=>acquireWriterLock(f.root)).toThrow('reconciliation_required');
  }finally{await f.finish(true);}
 });
 it('never signals when cancellation persistence fails and retains the fence',async()=>{
  const f=await setup('hold',true);try{f.scope.cancel();await delay(80);expect(existsSync(join(f.root,'terms'))).toBe(false);expect(f.record.termAttempts).toBe(0);f.release();await expect(f.scope.drain()).rejects.toThrow('reconciliation_required');expect(()=>f.fence.settle()).toThrow('reconciliation_required');}finally{await f.finish(true);}
 });
 it('fails before spawn if ownership persistence fails',async()=>{
  const root=temp(),scope=ownedClaudeProcesses({auditPath:join(root,'audit.json'),uncertain(){},record(){throw Error('fixture persistence failure');}});
  expect(()=>scope.spawn({command:process.execPath,args:[join(import.meta.dirname,'fixtures/graceful-child.mjs'),root,'hold'],cwd:root,env:{},signal:new AbortController().signal})).toThrow('fixture persistence failure');await delay(80);expect(existsSync(join(root,'ready'))).toBe(false);rmSync(root,{recursive:true,force:true});
 });
 it('does not spawn for a pre-aborted invocation',()=>{
  const root=temp(),controller=new AbortController();controller.abort();const scope=ownedClaudeProcesses({auditPath:join(root,'audit.json'),uncertain(){}});
  expect(()=>scope.spawn({command:process.execPath,args:[],cwd:root,env:{},signal:controller.signal})).toThrow();expect(existsSync(join(root,'audit.json'))).toBe(false);rmSync(root,{recursive:true,force:true});
 });
 it('admits natural success only after close without a signal',async()=>{
  const f=await setup();let settled=false;const drain=f.scope.drain(true).then(()=>{settled=true;});try{f.scope.assertIdentified();await delay(60);expect(settled).toBe(false);f.release();await drain;expect(f.record.termAttempts).toBe(0);expect(f.uncertain).toBe(false);}finally{await f.finish();}
 });
 it('converts a result with a lingering child to uncertainty after two seconds',async()=>{
  const f=await setup();let settled=false;const start=Date.now(),drain=f.scope.drain(true).then(()=>{settled=true;});try{await until(()=>f.uncertain);expect(Date.now()-start).toBeGreaterThanOrEqual(1950);expect(settled).toBe(false);expect(f.closed).toBe(false);expect(f.record.termAttempts).toBe(1);f.release();await drain;}finally{await f.finish();}
 },10000);
 it('holds ownership when an exited direct child leaves an inherited pipe open',async()=>{
  const f=await setup('pipe');try{await until(()=>f.record.state==='exited');f.scope.cancel();await delay(100);expect(f.record.termAttempts).toBe(0);expect(f.closed).toBe(false);expect(()=>f.fence.settle()).toThrow('reconciliation_required');expect(()=>acquireWriterLock(f.root)).toThrow('reconciliation_required');f.release();await f.scope.drain();expect(existsSync(join(f.root,'grandchild-exit'))).toBe(true);expect(f.closed).toBe(true);}finally{await f.finish();}
 });
 it('retains the durable fence after owner crash even after the orphan exits voluntarily',async()=>{
  const root=temp(),loader=process.env.KAPELLE_WORKER_HOST_TSX!;
  const parent=spawn(process.execPath,['--import',loader,join(import.meta.dirname,'fixtures/graceful-parent.mts'),root],{stdio:['ignore','ignore','pipe']});
  let errors='';parent.stderr.on('data',v=>errors+=v);const ended=new Promise<number|null>(r=>parent.once('exit',r));
  try{expect(await ended,errors).toBe(77);expect(existsSync(join(root,'ready'))).toBe(true);expect(()=>acquireWriterLock(root)).toThrow('reconciliation_required');expect(()=>recoverDeadWriterLock(root,parent.pid!)).toThrow('reconciliation_required');writeFileSync(join(root,'release'),'yes');await until(()=>existsSync(join(root,'child-exit')));expect(()=>acquireWriterLock(root)).toThrow('reconciliation_required');}finally{writeFileSync(join(root,'release'),'yes');}
 },10000);
});
