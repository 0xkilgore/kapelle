import {it,expect} from 'vitest';
import {mkdtempSync,chmodSync,openSync,closeSync,fstatSync,writeSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {acquireWriterLock,releaseWriterLock} from '../src/worker/writer-lock.js';
it('unlink failure retains fd/exclusion; retry succeeds and repeated release cannot close a reused fd',()=>{
 const root=mkdtempSync(join(tmpdir(),'lock-release-')),lock=acquireWriterLock(root),otherPath=join(root,'unrelated');
 let other:number|undefined,reused:number|undefined;
 try{
  chmodSync(root,0o500);expect(()=>releaseWriterLock(lock)).toThrow();
  expect(fstatSync(lock.fd).isFile()).toBe(true);expect(existsSync(lock.path)).toBe(true);
  chmodSync(root,0o700);other=openSync(otherPath,'w');expect(other).not.toBe(lock.fd);
  expect(()=>acquireWriterLock(root)).toThrow();releaseWriterLock(lock);expect(()=>writeSync(other!,'safe')).not.toThrow();
  reused=openSync(join(root,'reused'),'w');expect(reused).toBe(lock.fd);
  releaseWriterLock(lock);releaseWriterLock(lock);expect(()=>writeSync(reused!,'still safe')).not.toThrow();
 }finally{chmodSync(root,0o700);if(other!==undefined)closeSync(other);if(reused!==undefined)closeSync(reused);rmSync(root,{recursive:true,force:true});}
});
it('external descriptor loss/reuse becomes terminal without closing the replacement',()=>{
 const root=mkdtempSync(join(tmpdir(),'lock-descriptor-')),lock=acquireWriterLock(root);
 const filler=openSync(join(root,'guard-fd-slot'),'w');closeSync(lock.fd);const other=openSync(join(root,'unrelated'),'w');
 try{expect(other).toBe(lock.fd);expect(()=>releaseWriterLock(lock)).toThrow('descriptor_lost');
  expect(()=>releaseWriterLock(lock)).toThrow('descriptor_lost');expect(()=>writeSync(other,'safe')).not.toThrow();expect(existsSync(lock.path)).toBe(true);
 }finally{closeSync(other);closeSync(filler);rmSync(root,{recursive:true,force:true});}
});
