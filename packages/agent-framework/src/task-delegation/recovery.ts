import {AsyncLocalStorage} from 'node:async_hooks';
import {digest} from '../content.js';
import {assert} from '../validation.js';
import type {TaskPilot} from './pilot.js';
/** Process-internal scope from an owned worker's fresh durable-record validator.
 * Never serialized, accepted from HTTP, or supplied as a facts/receipt boolean. */
export type Recovery={pilot:TaskPilot;dispatchId:string;offerHash:string;publicationId:string;now:string;mode:'read'|'reconcile';beforeWrite:()=>Promise<void>};
const scope=new AsyncLocalStorage<()=>Recovery>();
export function withPilotRecovery<T>(validate:()=>Recovery,run:()=>Promise<T>):Promise<T>{assert(!scope.getStore(),'pilot_recovery_nested');validate();return scope.run(validate,run);}
export function activeRecovery(){return scope.getStore()?.();}
export function recoveryFor(p:TaskPilot,dispatchId?:string){
 const r=activeRecovery();if(!r)return undefined;
 assert(digest(r.pilot)===digest(p)&&(!dispatchId||r.dispatchId===dispatchId)&&r.now<p.recoveryExpiresAt,'pilot_recovery_scope');return r;
}
export function recoveryCommand(type:string,id:string){
 const r=activeRecovery();if(r)assert(r.mode==='reconcile'&&type==='RECORD_DISPATCH_RESULT'&&id===r.dispatchId,'pilot_recovery_command_forbidden');
}

/** Saved reads after a pilot's recovery window (Increment 2 B-1). The scope permits identity checks and native/journal reads
 * only: never admission, a Registry call, a native command, a journal write, a reconcile or a run. Process-internal; never
 * serialized or accepted from HTTP. */
const savedReads=new AsyncLocalStorage<{pilot:TaskPilot;dispatchId:string}>();
export function withSavedRead<T>(p:TaskPilot,dispatchId:string,run:()=>Promise<T>):Promise<T>{
 assert(!activeRecovery()&&!controls.getStore()&&!savedReads.getStore(),'pilot_saved_read_nested');return savedReads.run({pilot:p,dispatchId},run);
}
export function savedRead(p?:TaskPilot){const s=savedReads.getStore();return !!(p&&s&&digest(s.pilot)===digest(p));}
export function savedReadCommand(){assert(!savedReads.getStore(),'pilot_saved_read_command_forbidden');}

/** Exact owner reductions can read expired pilot metadata, never admit work. */
type Control={pilot:TaskPilot;documentId:string;type:string};
const controls=new AsyncLocalStorage<Control>();
export function withPilotControl<T>(control:Control,run:()=>Promise<T>){assert(!activeRecovery()&&!controls.getStore(),'pilot_control_nested');return controls.run(control,run);}
export function pilotControl(p?:TaskPilot){const c=controls.getStore();return !!(p&&c&&digest(c.pilot)===digest(p));}
export function controlCommand(type:string,id:string){const c=controls.getStore();if(c)assert(c.type===type&&c.documentId===id,'pilot_control_command_forbidden');}

/** Only the installed transport can mark a pilot publication as possibly sent.
 * All asynchronous preflight finishes first; marker and call have no await between. */
const publication=new AsyncLocalStorage<{id:string;preflight:()=>Promise<void>;mark:()=>void}>();
export function withPilotPublication<T>(id:string,preflight:()=>Promise<void>,mark:()=>void,run:()=>Promise<T>){assert(!publication.getStore(),'pilot_publication_nested');return publication.run({id,preflight,mark},run);}
export function markPilotPublication(){const p=publication.getStore();assert(p,'pilot_publication_transport_required');p.mark();}

export async function preflightPilotPublication(){const p=publication.getStore();assert(p,'pilot_publication_transport_required');await p.preflight();}

export function checkPilotPublication(id:string){const p=publication.getStore();if(p)assert(p.id===id,'pilot_publication_identity_changed');}
