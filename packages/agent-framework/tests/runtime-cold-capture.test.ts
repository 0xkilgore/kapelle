import {describe,it,expect} from 'vitest';
import {mkdtempSync,realpathSync,readdirSync,lstatSync,existsSync,renameSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {openFrameworkRuntime,type RuntimeOptions} from '../src/service/runtime.js';
import {acquireWriterLock,releaseWriterLock} from '../src/worker/writer-lock.js';
import {context} from './fixtures.js';
const root=()=>realpathSync(mkdtempSync(join(tmpdir(),'runtime-cold-capture-')));
const options=(stateRoot:string):RuntimeOptions=>({stateRoot,reactorRoot:process.env.KAPELLE_SCOPED_REACTOR_ROOT??'/never-load-a-database',ownerId:'owner',scopeRef:'synthetic-league',facts:async()=>context()});
const tick=()=>new Promise(r=>setTimeout(r,30));
function gate(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function assertNoDatabase(path:string){expect(existsSync(join(path,'pglite'))).toBe(false);expect(existsSync(join(path,'commands.sqlite'))).toBe(false);}

describe('runtime cold capture under continuous writer exclusion',()=>{
 it('holds the native lock across pending capture and releases after rejected capture without constructing a database',async()=>{
  const path=root(),entered=gate(),finish=gate();let settled=false;
  const opening=openFrameworkRuntime({...options(path),reactorRoot:'/never-load-a-database',beforeDatabaseOpen:async c=>{expect(Object.isFrozen(c)).toBe(true);c.assertOwnership();expect(c.stateRoot).toBe(path);expect(readdirSync(path)).toEqual(['writer.lock']);entered.resolve();await finish.promise;throw Error('capture_failed');}}).catch(e=>e).finally(()=>{settled=true;});
  try{await entered.promise;expect(()=>acquireWriterLock(path)).toThrow('worker_lock_held');assertNoDatabase(path);expect(settled).toBe(false);finish.resolve();expect((await opening).message).toBe('capture_failed');assertNoDatabase(path);expect(existsSync(join(path,'writer.lock'))).toBe(false);const lock=acquireWriterLock(path);releaseWriterLock(lock);}finally{finish.resolve();await opening;rmSync(path,{recursive:true,force:true});}
 });
 it('pre-aborted open neither acquires a lock nor calls capture',async()=>{
  const path=root(),controller=new AbortController();controller.abort();let called=false;
  try{await expect(openFrameworkRuntime({...options(path),openSignal:controller.signal,beforeDatabaseOpen(){called=true;}})).rejects.toThrow();expect(called).toBe(false);expect(readdirSync(path)).toEqual([]);}finally{rmSync(path,{recursive:true,force:true});}
 });
 it('keeps exclusion when cancelled during capture until the callback settles, then never opens a database',async()=>{
  const path=root(),controller=new AbortController(),entered=gate(),finish=gate();let settled=false;
  const opening=openFrameworkRuntime({...options(path),openSignal:controller.signal,beforeDatabaseOpen:async c=>{expect(c.signal).toBe(controller.signal);entered.resolve();await finish.promise;c.assertOwnership();}}).catch(e=>e).finally(()=>{settled=true;});
  try{await entered.promise;controller.abort();await tick();expect(settled).toBe(false);expect(()=>acquireWriterLock(path)).toThrow('worker_lock_held');assertNoDatabase(path);finish.resolve();expect((await opening).name).toBe('AbortError');assertNoDatabase(path);expect(existsSync(join(path,'writer.lock'))).toBe(false);}finally{finish.resolve();await opening;rmSync(path,{recursive:true,force:true});}
 });
 it('never removes a replacement lock or opens a database after capture changes lock identity',async()=>{
  const path=root();try{await expect(openFrameworkRuntime({...options(path),beforeDatabaseOpen(){renameSync(join(path,'writer.lock'),join(path,'original-held.lock'));writeFileSync(join(path,'writer.lock'),'replacement-owner',{flag:'wx',mode:0o600});}})).rejects.toThrow('runtime_writer_ownership_changed');assertNoDatabase(path);expect(existsSync(join(path,'writer.lock'))).toBe(true);expect(existsSync(join(path,'original-held.lock'))).toBe(true);}finally{rmSync(path,{recursive:true,force:true});}
 });
 it('releases a still-owned lock if loading the database dependencies fails after successful capture',async()=>{
  const path=root();let captured=false;try{await expect(openFrameworkRuntime({...options(path),reactorRoot:join(path,'nonexistent-reactor'),beforeDatabaseOpen(c){c.assertOwnership();captured=true;}})).rejects.toThrow();expect(captured).toBe(true);assertNoDatabase(path);expect(existsSync(join(path,'writer.lock'))).toBe(false);}finally{rmSync(path,{recursive:true,force:true});}
 });
 it.skipIf(!process.env.KAPELLE_SCOPED_REACTOR_ROOT)('keeps the same lock inode through actual runtime construction and guarded close; default reopen still works',async()=>{
  const path=root(),entered=gate(),finish=gate();let inode:number|undefined,runtime:Awaited<ReturnType<typeof openFrameworkRuntime>>|undefined;
  const opening=openFrameworkRuntime({...options(path),beforeDatabaseOpen:async c=>{c.assertOwnership();assertNoDatabase(path);inode=lstatSync(join(path,'writer.lock')).ino;entered.resolve();await finish.promise;}});
  try{
   await entered.promise;
   const lockModule=new URL('../src/worker/writer-lock.ts',import.meta.url).href;
   const code="const m=await import(process.argv[1]);try{const l=m.acquireWriterLock(process.argv[2]);console.log('ACQUIRED');m.releaseWriterLock(l);}catch(e){console.log(e.message);}";
   expect(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',code,lockModule,path],{encoding:'utf8'}).trim()).toBe('worker_lock_held');
   finish.resolve();runtime=await opening;runtime.assertOwnership();expect(lstatSync(join(path,'writer.lock')).ino).toBe(inode);expect(existsSync(join(path,'commands.sqlite'))).toBe(true);expect(await runtime.authority.listInstances()).toEqual([]);
   await expect(openFrameworkRuntime(options(path))).rejects.toThrow('worker_lock_held');await runtime.close();expect(existsSync(join(path,'writer.lock'))).toBe(false);
   runtime=await openFrameworkRuntime(options(path));runtime.assertOwnership();expect(await runtime.authority.listInstances()).toEqual([]);await runtime.close();expect(existsSync(join(path,'writer.lock'))).toBe(false);
  }finally{finish.resolve();runtime??=await opening.catch(()=>undefined);await runtime?.close();rmSync(path,{recursive:true,force:true});}
 },20000);
});
