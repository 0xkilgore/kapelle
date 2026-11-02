import {it,expect} from 'vitest';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServiceStop,closeStoresInOrder} from '../src/worker/service-stop.js';
import {acquireWriterLock,releaseWriterLock} from '../src/worker/writer-lock.js';
it('drain timeout and failed close retain locks; graceful retry succeeds without force',async()=>{
 const root=mkdtempSync(join(tmpdir(),'service-stop-')),lock=acquireWriterLock(root);
 let reply!:()=>void,entered!:()=>void,abortCalls=0,closeCalls=0,failClose=true;
 const arrived=new Promise<void>(r=>{entered=r;});
 const server=createServer((_req,res)=>{reply=()=>res.end('done');entered();});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const pending=fetch('http://127.0.0.1:'+(server.address() as any).port);
 await arrived;
 const stop=createServiceStop([server],()=>{abortCalls++;},async()=>{closeCalls++;if(failClose)throw Error('storage still open');releaseWriterLock(lock);},20);
 try{
  await expect(stop()).rejects.toThrow('drain_timeout');expect(closeCalls).toBe(0);expect(()=>acquireWriterLock(root)).toThrow();
  reply();expect(await (await pending).text()).toBe('done');
  await expect(stop()).rejects.toThrow('storage still open');expect(()=>acquireWriterLock(root)).toThrow();
  failClose=false;await Promise.all([stop(),stop()]);expect(closeCalls).toBe(2);expect(abortCalls).toBe(3);
  const next=acquireWriterLock(root);releaseWriterLock(next);await stop();expect(closeCalls).toBe(2);
 }finally{rmSync(root,{recursive:true,force:true});}
});

it('later-store failure retries without double-closing a released worker',async()=>{
 let workerCalls=0,authorityCalls=0,fail=true;
 const close=closeStoresInOrder([()=>{workerCalls++;if(workerCalls>1)throw Error('double close');},()=>{authorityCalls++;if(fail)throw Error('authority busy');}]);
 await expect(close()).rejects.toThrow('authority busy');fail=false;await close();await close();
 expect(workerCalls).toBe(1);expect(authorityCalls).toBe(2);
});
it('busy worker prevents closing its authority',async()=>{
 let authorityCalls=0;
 const close=closeStoresInOrder([()=>{throw Error('worker busy');},()=>{authorityCalls++;}]);
 await expect(close()).rejects.toThrow('worker busy');expect(authorityCalls).toBe(0);
});
