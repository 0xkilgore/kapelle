import { describe,it,expect } from 'vitest';
import { mkdtempSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardedClose } from '../src/service/close-guard.js';
import { acquireWriterLock,releaseWriterLock } from '../src/worker/writer-lock.js';
describe('runtime close retains writer exclusion',()=>{
 for(let failed=0;failed<5;failed++)it(`failure at cleanup step ${failed} attempts all cleanup and excludes a second opener`,async()=>{
  const root=mkdtempSync(join(tmpdir(),'runtime-close-')),calls=[0,0,0,0,0];let broken=true;
  const lock=acquireWriterLock(root);
  const close=guardedClose(calls.map((_,i)=>async()=>{calls[i]++;if(i===failed&&broken)throw Error('injected');}),()=>releaseWriterLock(lock));
  try{
   await expect(close()).rejects.toThrow('lock_retained');
   expect(calls).toEqual([1,1,1,1,1]);expect(existsSync(join(root,'writer.lock'))).toBe(true);
   expect(()=>acquireWriterLock(root)).toThrow();
   broken=false;await Promise.all([close(),close()]);
   expect(calls).toEqual(calls.map((_,i)=>i===failed?2:1));
   const next=acquireWriterLock(root);releaseWriterLock(next);await close();
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 it('shares an in-flight close and releases only once',async()=>{
  let finish!:()=>void,releases=0;
  const close=guardedClose([()=>new Promise<void>(r=>{finish=r;})],()=>{releases++;});
  const a=close(),b=close();expect(a).toBe(b);expect(releases).toBe(0);finish();await a;await close();expect(releases).toBe(1);
 });
});

it('two concurrent processes cannot both own the same writer lock',async()=>{
 const root=mkdtempSync(join(tmpdir(),'runtime-contenders-'));
 const module=fileURLToPath(new URL('../src/worker/writer-lock.ts',import.meta.url));
 const code=`import {acquireWriterLock,releaseWriterLock} from ${JSON.stringify('file://'+module)};
 let lock;process.send('ready');process.on('message',m=>{if(m==='go'){try{lock=acquireWriterLock(process.argv[1]);process.send('acquired');}catch{process.send('refused');}}else if(m==='close'){if(lock)releaseWriterLock(lock);process.exit(0);}});`;
 const children=[0,1].map(()=>spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code,root],{stdio:['ignore','ignore','pipe','ipc']}));
 const message=(c:typeof children[number])=>new Promise<string>((resolve,reject)=>{c.once('message',m=>resolve(String(m)));c.once('error',reject);});
 try{
  expect(await Promise.all(children.map(message))).toEqual(['ready','ready']);
  const results=children.map(message);children.forEach(c=>c.send('go'));
  expect((await Promise.all(results)).sort()).toEqual(['acquired','refused']);
 }finally{
  await Promise.all(children.map(c=>new Promise<void>(resolve=>{c.once('exit',()=>resolve());c.send('close');})));
  rmSync(root,{recursive:true,force:true});
 }
},10000);
