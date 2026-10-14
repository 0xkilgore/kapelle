/** Registry deploy lock (the mechanical "effective deployment fence").
 * Publishers hold a SHARED flock(2) on the Registry's deploy lock file across check -> create -> register -> readback; the
 * Registry deploy/restart tooling takes the EXCLUSIVE lock before stopping or starting the Reactor. Node has no flock API,
 * so a tiny /usr/bin/perl holder (system tool, no new dependency) takes the lock and keeps it while its stdin stays open:
 * release = close stdin; if the publisher dies, the pipe closes and the kernel releases the lock with the holder. */
import {spawn} from 'node:child_process';
import {lstatSync,openSync,closeSync,constants} from 'node:fs';
import {isAbsolute} from 'node:path';
const PERL='/usr/bin/perl';
const HOLDER=`use strict;use Fcntl qw(:flock);use Time::HiRes qw(sleep time);my($p,$m,$t)=@ARGV;open(my $f,'>>',$p) or exit 3;`+
 `my $op=$m eq 'ex'?LOCK_EX:LOCK_SH;my $end=time+$t/1000;until(flock($f,$op|LOCK_NB)){if(time>=$end){print "BUSY\\n";exit 75}sleep 0.05}`+
 `$|=1;print "LOCKED\\n";while(<STDIN>){}exit 0;`;
export type DeployLock={release():Promise<void>};
/** The lock file must be an owner-only regular file (created 0600 if missing); never a symlink. */
function prepare(path:string){
 if(!isAbsolute(path))throw Error('PRIVATE_PUBLICATION_DEPLOY_LOCK_INVALID');
 let s;try{s=lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw Error('PRIVATE_PUBLICATION_DEPLOY_LOCK_INVALID');
  try{closeSync(openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600));}catch(e2){if((e2 as NodeJS.ErrnoException).code!=='EEXIST')throw Error('PRIVATE_PUBLICATION_DEPLOY_LOCK_INVALID');}
  s=lstatSync(path);}
 if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077))throw Error('PRIVATE_PUBLICATION_DEPLOY_LOCK_INVALID');
}
/** Acquire the lock (waiting up to timeoutMs). Rejects PRIVATE_PUBLICATION_DEPLOY_LOCKED when it stays held. */
export function acquireDeployLock(path:string,mode:'shared'|'exclusive',timeoutMs=10_000):Promise<DeployLock>{
 try{prepare(path);}catch(e){return Promise.reject(e);}
 return new Promise((resolve,reject)=>{
  const child=spawn(PERL,['-e',HOLDER,path,mode==='exclusive'?'ex':'sh',String(timeoutMs)],{stdio:['pipe','pipe','ignore']});
  let out='',settled=false;const exited=new Promise<void>(r=>child.once('exit',()=>r()));
  child.stdout!.on('data',d=>{out+=d;if(settled)return;
   if(out.includes('LOCKED\n')){settled=true;resolve({release:async()=>{child.stdin!.end();await exited;}});}
   else if(out.includes('BUSY\n')){settled=true;reject(Error('PRIVATE_PUBLICATION_DEPLOY_LOCKED'));}});
  child.once('error',()=>{if(!settled){settled=true;reject(Error('PRIVATE_PUBLICATION_DEPLOY_LOCK_UNAVAILABLE'));}});
  child.once('exit',()=>{if(!settled){settled=true;reject(Error('PRIVATE_PUBLICATION_DEPLOY_LOCK_UNAVAILABLE'));}});
 });
}
