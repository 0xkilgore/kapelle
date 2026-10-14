import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {readFileSync,lstatSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {currentBootId} from './writer-lock.js';
export type ClaudeSpawnOptions={command:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;signal:AbortSignal};
export type ProcessPin={path:string;sha256:string};
export type TerminationRecord={invocationId:string;parentPid:number;bootId:string;pid:number|null;startIdentity:string|null;cwdIdentity:string;binaryPins:ProcessPin[];state:'prepared'|'running'|'cancelling'|'unconfirmed'|'exited'|'closed';cancelledAt:number|null;termAttempts:number;blockedSignals:number;identityMismatch:boolean;auditFailed:boolean;events:Array<{event:string;at:number}>};
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const directoryIdentity=(path:string)=>{const s=lstatSync(path);if(!s.isDirectory()||s.isSymbolicLink())throw Error('claude_cwd_identity');return `${s.dev}:${s.ino}`;};
function startIdentity(pid:number){
 const value=execFileSync('/bin/ps',['-p',String(pid),'-o','ppid=','-o','lstart='],{encoding:'utf8',timeout:1000}).trim();
 if(!value||Number(value.split(/\s+/)[0])!==process.pid)throw Error('claude_child_identity');return value;
}
/** Graceful-only direct-child policy. No raw PID, process-group or descendant signals.
 * A durable fence remains until actual close AND caller settlement, including parent crashes. */
export function ownedClaudeProcesses(config:{auditPath:string;record?:(r:TerminationRecord)=>void;uncertain:()=>void;pins?:ProcessPin[]}) {
 let accepting=true,child:ChildProcess|undefined,identityReady=false,exited=false,closed=false,cancelled=false,failed=false;
 let observer:ReturnType<typeof setTimeout>|undefined,normalExit:ReturnType<typeof setTimeout>|undefined;
 let closeResolve!:()=>void;const closing=new Promise<void>(r=>closeResolve=r);
 let options:ClaudeSpawnOptions,record:TerminationRecord;
 function audit(event:string){
  record.events=[...record.events,{event,at:Date.now()}].slice(-64);record.auditFailed=failed;
  const temp=config.auditPath+'.next';const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(record));fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,config.auditPath);
  const dir=openSync(dirname(config.auditPath),'r');try{fsyncSync(dir);}finally{closeSync(dir);}
  config.record?.(structuredClone(record));
 }
 function safeAudit(event:string){try{audit(event);return true;}catch{failed=true;record.auditFailed=true;return false;}}
 function markUncertain(){try{config.uncertain();return true;}catch{failed=true;record.auditFailed=true;return false;}}
 function cancel(){
  if(!child)return;
  if(!cancelled){cancelled=true;record.cancelledAt=Date.now();record.state='cancelling';
   if(!markUncertain()||!safeAudit('cancellation_requested'))failed=true;
   observer=setTimeout(()=>{if(!closed){record.state='unconfirmed';markUncertain();safeAudit('termination_unconfirmed_worker_unavailable');}},10000);
  }
 }
 function permittedTerm(){
  if(!child||closed||exited||child.exitCode!==null||child.signalCode!==null||!identityReady||failed||record.identityMismatch||record.termAttempts)return false;
  try{
   if(record.parentPid!==process.pid||record.bootId!==currentBootId()||record.startIdentity!==startIdentity(child.pid!)||record.cwdIdentity!==directoryIdentity(options.cwd)||record.binaryPins.some(p=>hash(p.path)!==p.sha256))throw Error('mismatch');
  }catch{record.identityMismatch=true;safeAudit('identity_mismatch_signal_denied');return false;}
  record.termAttempts=1;if(!safeAudit('sigterm_attempt'))return false;
  // The still-owned ChildProcess handle is used only after identity verification.
  try{return child.kill('SIGTERM');}catch{safeAudit('signal_failed');return false;}
 }
 function request(signal:NodeJS.Signals|number|undefined='SIGTERM'){
  if(!child||closed)return false;
  cancel();
  if(signal!=='SIGTERM'){record.blockedSignals++;safeAudit('disallowed_signal_blocked');return false;}
  return permittedTerm();
 }
 return {
  spawn(o:ClaudeSpawnOptions){
   if(!accepting||child)throw Error('claude_process_scope_closed');o.signal.throwIfAborted();options=o;
   const paths=[o.command,...(o.args[0]?.match(/\.(?:mjs|js|ts)$/)?[o.args[0]]:[])];
   const pins=[...new Map([...paths.map(path=>({path,sha256:hash(path)})),...(config.pins??[])].map(p=>[p.path,p])).values()];
   if(pins.some(p=>hash(p.path)!==p.sha256))throw Error('claude_process_pin_changed');
   const boot=currentBootId();if(!boot)throw Error('claude_boot_identity_unavailable');
   record={invocationId:randomUUID(),parentPid:process.pid,bootId:boot,pid:null,startIdentity:null,cwdIdentity:directoryIdentity(o.cwd),binaryPins:pins,state:'prepared',cancelledAt:null,termAttempts:0,blockedSignals:0,identityMismatch:false,auditFailed:false,events:[]};
   audit('before_spawn'); // Failure here cannot start a child.
   try{child=spawn(o.command,o.args,{cwd:o.cwd,env:o.env,stdio:['pipe','pipe','ignore'],windowsHide:true});}
   catch(error){record.state='closed';safeAudit('spawn_failed');closed=true;closeResolve();throw error;}
   child.on('error',()=>{cancel();safeAudit('spawn_or_transport_error');});
   child.once('spawn',()=>{
    record.pid=child!.pid??null;
    try{record.startIdentity=startIdentity(child!.pid!);identityReady=true;record.state=cancelled?'cancelling':'running';if(!safeAudit('spawn_identified'))cancel();}
    catch{record.identityMismatch=true;cancel();safeAudit('spawn_identity_unconfirmed');}
    if(cancelled)permittedTerm();
   });
   child.once('exit',()=>{exited=true;record.state='exited';safeAudit('child_exit');});
   const abort=()=>request('SIGTERM');o.signal.addEventListener('abort',abort,{once:true});
   child.once('close',()=>{closed=true;clearTimeout(observer);clearTimeout(normalExit);o.signal.removeEventListener('abort',abort);record.state='closed';safeAudit('child_and_streams_closed');closeResolve();});
   if(o.signal.aborted)abort();
   return {stdin:child.stdin!,stdout:child.stdout!,get killed(){return child!.killed;},get exitCode(){return child!.exitCode;},kill:request,on:child.on.bind(child),once:child.once.bind(child),off:child.off.bind(child)};
  },
  assertIdentified(){if(child&&(!identityReady||failed||record.identityMismatch||cancelled))throw Error('claude_process_admission_unconfirmed');},
  cancel(){request('SIGTERM');},
  async drain(success=false){
   accepting=false;if(!child){if(failed)throw Error('claude_termination_audit_failed');return;}
   if(!closed){if(success&&!cancelled)normalExit=setTimeout(()=>request('SIGTERM'),2000);else request('SIGTERM');await closing;}
   if(failed||record.identityMismatch)throw Error('claude_termination_reconciliation_required');
  },
 };
}
