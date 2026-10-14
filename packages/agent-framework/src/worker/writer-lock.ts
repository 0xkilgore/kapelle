import { openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync, fsyncSync, unlinkSync, existsSync, renameSync, type Stats } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Single-writer lock for a private state directory.
 *
 * Lock file contents (two lines): the owner pid, then the boot identity of the
 * machine when the lock was taken. A legacy lock holds only the pid.
 *
 * Acquisition reclaims a lock only when its owner is provably gone:
 *   - the lock was written in a different boot (no process survives a reboot),
 *   - the lock is legacy and its mtime predates the current boot, or
 *   - no process with the recorded pid exists in this boot (ESRCH).
 * A lock whose owner may be alive is refused (`worker_lock_held`). Reclaimed
 * lock bytes are renamed aside (`writer.lock.stale-<ms>-<pid>`), never deleted,
 * while an exclusive recovery.lock serializes every acquisition and recovery.
 * A crashed guard fails closed and requires offline operator reconciliation; it
 * is never recursively reclaimed by this code.
 *
 * Release keeps the descriptor-identity discipline: a lock is only unlinked
 * while the held descriptor still names the same inode, and a release that
 * loses the descriptor or fails to close becomes terminal so a reused fd is
 * never closed by a later retry.
 *
 * Automatic reclaim applies only to writer.lock under the serialization guard. The
 * explicit `recoverDeadWriterLock` remains for operators and tooling.
 */
export type WriterLock = Readonly<{fd:number;path:string}>;
export type WriterLockRecord = {pid:number;bootId:string|null;legacy:boolean};
export interface WriterLockEnvironment {
  isAlive(pid:number):boolean;
  bootId():string;
  bootTimeSec():number|null;
  now():number;
}
type Lifecycle={dev:number;ino:number;state:'held'|'released'|'descriptor_lost'|'close_failed'};
const lifecycle=new WeakMap<WriterLock,Lifecycle>();

let cachedBootTime:number|null|undefined;
let cachedBootId:string|undefined;
/** Seconds since the epoch at which this machine booted, or null when unknown. */
export function currentBootTimeSec():number|null {
  if(cachedBootTime!==undefined)return cachedBootTime;
  try {
    if(platform()==='darwin'){
      const out=execFileSync('/usr/sbin/sysctl',['-n','kern.boottime'],{encoding:'utf8',timeout:5000});
      const m=/sec\s*=\s*(\d+)/.exec(out);cachedBootTime=m?Number(m[1]):null;
    } else if(platform()==='linux'){
      const up=Number.parseFloat(readFileSync('/proc/uptime','utf8').split(' ')[0]);
      cachedBootTime=Number.isFinite(up)?Math.floor(Date.now()/1000-up):null;
    } else cachedBootTime=null;
  } catch {cachedBootTime=null;}
  return cachedBootTime;
}
/** Stable identity of the current boot; empty when the platform cannot provide one. */
export function currentBootId():string {
  if(cachedBootId!==undefined)return cachedBootId;
  try {
    if(platform()==='linux'){cachedBootId=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();return cachedBootId;}
  } catch {/* fall through to boot time */}
  const t=currentBootTimeSec();cachedBootId=t===null?'':`boot-${t}`;return cachedBootId;
}
function defaultIsAlive(pid:number){
  try {process.kill(pid,0);return true;}
  catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}
}
const defaults:WriterLockEnvironment={isAlive:defaultIsAlive,bootId:currentBootId,bootTimeSec:currentBootTimeSec,now:Date.now};

function exclusive(path:string):WriterLock {
  const fd=openSync(path,'wx',0o600),stat=fstatSync(fd);
  const lock=Object.freeze({fd,path});
  lifecycle.set(lock,{dev:stat.dev,ino:stat.ino,state:'held'});return lock;
}
export function releaseWriterLock(lock:WriterLock) {
  if(lock.path.endsWith('/writer.lock')&&existsSync(join(resolve(lock.path,'..'),'provider-invocation.json')))throw Error('worker_invocation_reconciliation_required');
  const owner=lifecycle.get(lock);
  if(!owner)throw Error('worker_lock_unknown');
  if(owner.state==='released')return;
  if(owner.state!=='held')throw Error('worker_lock_'+owner.state);
  // A descriptor is a reusable number, not an identity. Never close one after losing ownership.
  let held;
  try{held=fstatSync(lock.fd);}catch{owner.state='descriptor_lost';throw Error('worker_lock_descriptor_lost');}
  if(held.dev!==owner.dev||held.ino!==owner.ino){owner.state='descriptor_lost';throw Error('worker_lock_descriptor_lost');}
  const current=lstatSync(lock.path);
  if(!current.isFile()||current.isSymbolicLink()||current.dev!==owner.dev||current.ino!==owner.ino)
    throw Error('worker_lock_ownership_changed');
  // On unlink failure both the exclusion pathname and its owned fd survive for retry.
  unlinkSync(lock.path);
  // Mark terminal BEFORE close: even a close error must never retry a possibly reused fd.
  owner.state='released';
  try{closeSync(lock.fd);}catch{owner.state='close_failed';throw Error('worker_lock_close_failed');}
}

function privateFile(path:string,s:Stats){
  if(!s.isFile() || s.isSymbolicLink() || s.nlink!==1 || s.uid!==process.getuid?.() || s.mode&0o077)throw Error('worker_lock_unsafe');
  if(s.size>256)throw Error('worker_lock_unreadable');
  return path;
}
/** Parse an existing lock after verifying it is a private regular file owned by this user. */
export function readWriterLock(path:string,stat:Stats=lstatSync(path)):WriterLockRecord {
  const fd=openSync(privateFile(path,stat),'r');
  let text:string;
  try {const opened=fstatSync(fd);privateFile(path,opened);if(opened.dev!==stat.dev||opened.ino!==stat.ino)throw Error('worker_lock_ownership_changed');text=readFileSync(fd,'utf8');} finally {closeSync(fd);}
  const lines=text.split('\n');
  const first=(lines[0]??'').trim();
  if(!/^\d{1,10}$/.test(first))throw Error('worker_lock_unreadable');
  const pid=Number(first);
  if(!Number.isSafeInteger(pid) || pid<=1)throw Error('worker_lock_unreadable');
  const second=(lines[1]??'').trim();
  return second?{pid,bootId:second,legacy:false}:{pid,bootId:null,legacy:true};
}
function ownerProvablyGone(record:WriterLockRecord,lockMtimeSec:number,env:WriterLockEnvironment){
  const boot=env.bootId();
  if(record.bootId!==null && boot!=='' && record.bootId!==boot)return 'different_boot';
  if(record.legacy){const t=env.bootTimeSec();if(t!==null && lockMtimeSec<t)return 'predates_boot';}
  if(!env.isAlive(record.pid))return 'no_such_process';
  return null;
}
function acquireUnderGuard(root:string,overrides:Partial<WriterLockEnvironment>={}):WriterLock {
  const env={...defaults,...overrides};
  const path=join(root,'writer.lock');
  for(let attempt=0;attempt<3;attempt++){
    let lock:WriterLock;
    try {lock=exclusive(path);}
    catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;
      let s:Stats;
      try {s=lstatSync(path);} catch(err){if((err as NodeJS.ErrnoException).code==='ENOENT')continue;throw err;}
      const record=readWriterLock(path,s);
      if(!ownerProvablyGone(record,s.mtimeMs/1000,env))throw Error('worker_lock_held');
      const quarantine=`${path}.stale-${env.now()}-${record.pid}`;
      try {renameSync(path,quarantine);}
      catch(err){if((err as NodeJS.ErrnoException).code!=='ENOENT')throw err;}
      continue;
    }
    try {
      writeFileSync(lock.fd,`${process.pid}\n${env.bootId()}\n`);fsyncSync(lock.fd);
      return lock;
    }catch(e){releaseWriterLock(lock);throw e;}
  }
  throw Error('worker_lock_held');
}
/** All acquirers take the same guard before reading or replacing writer.lock.
 * Never remove/reclaim a guard from an unprotected read: doing so recreates the
 * replacement-owner race at another pathname. A crashed guard fails closed. */
export function acquireWriterLock(root:string,overrides:Partial<WriterLockEnvironment>={}):WriterLock {
  if(existsSync(join(root,'provider-invocation.json')))throw Error('worker_invocation_reconciliation_required');
  const dir=lstatSync(root);
  if(!dir.isDirectory()||dir.isSymbolicLink()||dir.uid!==process.getuid?.()||dir.mode&0o077)throw Error('private_worker_directory_required');
  let guard:WriterLock;
  try {guard=exclusive(join(root,'recovery.lock'));}
  catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw Error('worker_lock_recovery_in_progress');throw e;}
  let writer:WriterLock|undefined;
  try {
    writeFileSync(guard.fd,String(process.pid));fsyncSync(guard.fd);
    if(existsSync(join(root,'provider-invocation.json')))throw Error('worker_invocation_reconciliation_required');
    writer=acquireUnderGuard(root,overrides);
  } catch(error) {releaseWriterLock(guard);throw error;}
  try {releaseWriterLock(guard);} catch(error) {releaseWriterLock(writer);throw error;}
  return writer;
}
/** Explicit offline recovery of a lock whose pid is known to the operator. Kept for operators and tooling. */
export function recoverDeadWriterLock(root:string,expectedPid:number) {
  if(existsSync(join(root,'provider-invocation.json')))throw Error('worker_invocation_reconciliation_required');
  if(resolve(root)!==root || !Number.isSafeInteger(expectedPid) || expectedPid<=1)throw Error('worker_recovery_identity_required');
  const dir=lstatSync(root);
  if(!dir.isDirectory() || dir.isSymbolicLink() || dir.uid!==process.getuid?.() || dir.mode&0o077)throw Error('private_worker_directory_required');
  const recovery=exclusive(join(root,'recovery.lock'));
  try {
    writeFileSync(recovery.fd,String(process.pid));fsyncSync(recovery.fd);
    const path=join(root,'writer.lock'),s=lstatSync(path);
    let record:WriterLockRecord;
    try {record=readWriterLock(path,s);} catch {throw Error('worker_recovery_lock_mismatch');}
    if(record.pid!==expectedPid)throw Error('worker_recovery_lock_mismatch');
    try {process.kill(expectedPid,0);throw Error('worker_writer_still_alive');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw Error('worker_writer_not_proven_dead');}
    const current=lstatSync(path);
    if(current.ino!==s.ino || current.dev!==s.dev)throw Error('worker_recovery_lock_changed');
    unlinkSync(path);
  }finally {releaseWriterLock(recovery);}
}
