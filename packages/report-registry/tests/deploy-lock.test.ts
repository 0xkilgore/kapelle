import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readdirSync,existsSync,symlinkSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {acquireDeployLock} from '../src/deploy-lock.ts';
import {taskFixture} from './fixtures/task-publication.ts';
import {PrivateTaskReportPublisher} from '../src/task-publication.ts';

// The mechanical deployment fence for the local single-machine Registry.
const root=()=>realpathSync(mkdtempSync(join(tmpdir(),'deploy-lock-')));
test('shared holders coexist; exclusive waits for them and refuses when they stay; exclusive blocks new shared',async()=>{
 const dir=root(),lock=join(dir,'REGISTRY-DEPLOY.lock');
 const a=await acquireDeployLock(lock,'shared',1000),b=await acquireDeployLock(lock,'shared',1000);
 await assert.rejects(acquireDeployLock(lock,'exclusive',300),/DEPLOY_LOCKED/);
 await a.release();await assert.rejects(acquireDeployLock(lock,'exclusive',300),/DEPLOY_LOCKED/);
 await b.release();const ex=await acquireDeployLock(lock,'exclusive',1000);
 await assert.rejects(acquireDeployLock(lock,'shared',300),/DEPLOY_LOCKED/);
 await ex.release();await (await acquireDeployLock(lock,'shared',1000)).release();
});
test('a crashed holder never strands the lock (kernel releases it with the holder)',async()=>{
 const dir=root(),lock=join(dir,'REGISTRY-DEPLOY.lock'),helper=fileURLToPath(new URL('../src/deploy-lock.ts',import.meta.url));
 const child=spawn(process.execPath,['--experimental-strip-types','--disable-warning=ExperimentalWarning','-e',
  `import(${JSON.stringify(helper)}).then(async m=>{await m.acquireDeployLock(${JSON.stringify(lock)},'shared',2000);process.stdout.write('held\\n');setInterval(()=>{},1000);});`],{stdio:['ignore','pipe','inherit']});
 await new Promise<void>(r=>child.stdout!.on('data',d=>{if(String(d).includes('held'))r();}));
 await assert.rejects(acquireDeployLock(lock,'exclusive',300),/DEPLOY_LOCKED/);
 child.kill('SIGKILL');
 const ex=await acquireDeployLock(lock,'exclusive',3000);await ex.release();
});
test('unsafe lock paths are refused (symlink, group/other-accessible, relative)',async()=>{
 const dir=root(),target=join(dir,'target');writeFileSync(target,'',{mode:0o600});symlinkSync(target,join(dir,'link'));
 await assert.rejects(acquireDeployLock(join(dir,'link'),'shared',100),/DEPLOY_LOCK_INVALID/);
 const open=join(dir,'open');writeFileSync(open,'');chmodSync(open,0o644);
 await assert.rejects(acquireDeployLock(open,'shared',100),/DEPLOY_LOCK_INVALID/);
 await assert.rejects(acquireDeployLock('relative.lock','shared',100),/DEPLOY_LOCK_INVALID/);
});
test('publish while a deploy holds the lock: refused before ANY Registry call, file, plan or lock',async()=>{
 const dir=root(),f=taskFixture(dir),lock=join(dir,'REGISTRY-DEPLOY.lock'),deploy=await acquireDeployLock(lock,'exclusive',1000);
 try{
  const publisher=new PrivateTaskReportPublisher({...f.options,deployLock:{path:lock,timeoutMs:300}});
  await assert.rejects(publisher.publish(f.request),/DEPLOY_LOCKED/);
  assert.equal(f.mcp.calls,0);assert.equal(f.mcp.writes,0);
  assert.equal(existsSync(join(dir,'receipts'))?readdirSync(join(dir,'receipts')).length:0,0);
  assert.equal(existsSync(join(dir,'locks'))?readdirSync(join(dir,'locks')).length:0,0);
 }finally{await deploy.release();}
});
test('the publisher holds the lock from the model check through register and independent readback',async()=>{
 const dir=root(),f=taskFixture(dir),lock=join(dir,'REGISTRY-DEPLOY.lock');const attempts:string[]=[];
 const call=f.mcp.call.bind(f.mcp);
 const probe=async(at:string)=>{try{const ex=await acquireDeployLock(lock,'exclusive',0);await ex.release();attempts.push(at+':acquired');}catch{attempts.push(at+':blocked');}};
 f.mcp.call=async(name:string,args:Record<string,unknown>)=>{if(['getRegistryDeploymentV1','createDocument','addActions','getReportDocumentV1'].includes(name))await probe(name);return call(name,args);};
 const client={call:(n:string,a:Record<string,unknown>)=>f.mcp.call(n,a)};
 const publisher=new PrivateTaskReportPublisher({...f.options,mcp:client,reader:client,deployLock:{path:lock,timeoutMs:1000}});
 assert.equal((await publisher.publish(f.request)).documentId,'doc-1');
 assert.ok(attempts.length>=6);assert.ok(attempts.every(a=>a.endsWith(':blocked')),attempts.join());
 await probe('after');assert.equal(attempts.at(-1),'after:acquired');
});
