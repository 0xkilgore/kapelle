import {openSync,closeSync,writeFileSync,readFileSync,fsyncSync,lstatSync,renameSync,unlinkSync,existsSync,fstatSync} from 'node:fs';
import {dirname,join} from 'node:path';
import type {TerminationRecord} from './claude-process.js';
/** A surviving record is an operator-reconciliation fence, even after parent death. */
export function invocationFence(lock:{path:string;fd:number}) {
 const root=dirname(lock.path),file=join(root,'provider-invocation.json');
 let owned=false,id:string|undefined,latest:TerminationRecord|undefined;
 const syncDir=()=>{const fd=openSync(root,'r');try{fsyncSync(fd);}finally{closeSync(fd);}};
 const owner=()=>{const held=fstatSync(lock.fd),current=lstatSync(lock.path);if(held.dev!==current.dev||held.ino!==current.ino)throw Error('worker_lock_ownership_changed');};
 return {
  record(value:TerminationRecord){
   owner();
   if(!owned){const fd=openSync(file,'wx',0o600);owned=true;id=value.invocationId;try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}syncDir();}
   else {
    const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||JSON.parse(readFileSync(file,'utf8')).invocationId!==id||value.invocationId!==id)throw Error('invocation_fence_changed');
    const temp=file+'.next';const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,file);syncDir();
   }
   latest=value;
  },
  settle(){
   if(!owned)return;
   owner();if(latest?.state!=='closed'||latest.auditFailed||latest.identityMismatch||!existsSync(file)||JSON.parse(readFileSync(file,'utf8')).invocationId!==id)throw Error('worker_invocation_reconciliation_required');
   unlinkSync(file);syncDir();owned=false;
  },
 };
}
