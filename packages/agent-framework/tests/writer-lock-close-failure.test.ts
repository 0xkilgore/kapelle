import {it,expect,vi} from 'vitest';
const fault=vi.hoisted(()=>({fd:-1}));
vi.mock('node:fs',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('node:fs')>();
 return {...actual,closeSync:(fd:number)=>{actual.closeSync(fd);if(fd===fault.fd){fault.fd=-1;throw Error('synthetic close failure after close');}}};
});
import {mkdtempSync,openSync,closeSync,writeSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireWriterLock,releaseWriterLock} from '../src/worker/writer-lock.js';
it('failed close is terminal and cannot close a reused descriptor',()=>{
 const root=mkdtempSync(join(tmpdir(),'lock-close-fault-')),lock=acquireWriterLock(root);
 const filler=openSync(join(root,'guard-slot'),'w');let replacement:number|undefined;
 try{
  fault.fd=lock.fd;expect(()=>releaseWriterLock(lock)).toThrow('worker_lock_close_failed');
  replacement=openSync(join(root,'replacement'),'w');expect(replacement).toBe(lock.fd);
  expect(()=>releaseWriterLock(lock)).toThrow('worker_lock_close_failed');
  expect(()=>writeSync(replacement!,'still owned')).not.toThrow();
 }finally{fault.fd=-1;if(replacement!==undefined)closeSync(replacement);closeSync(filler);rmSync(root,{recursive:true,force:true});}
});
