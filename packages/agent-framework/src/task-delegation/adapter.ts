import type { FrameworkAuthority } from '../service/authority.js';
import type { DispatchState, DispatchOffer } from '../../document-models/dispatch/v1/index.js';
import { canonical } from '../command-boundary.js';
import { dispatchOfferHash, instructionsHash } from '../dispatch/contracts.js';
import { assert } from '../validation.js';
import { acceptedEnvelope, contract, draftSchema, parseEnvelope, taskSchema, type Draft } from './contract.js';
/** Existing native Dispatch and its prepared-command journal are the only stores. */
export class TaskDelegations {
 private chain:Promise<unknown>=Promise.resolve();
 constructor(readonly authority:FrameworkAuthority){}
 private key(id:string){assert(/^[a-f0-9-]{36}$/.test(id),'Task operation invalid');return `task-delegation:${id}`;}
 async lookup(operationId:string){
  const key=this.key(operationId),entry=this.authority.journal.get(key);
  if(!entry)return null;
  const receipt=await this.authority.receipt(key);
  if(receipt.result.disposition==='UNRESOLVED')throw Error('Task acceptance uncertain');
  assert(receipt.result.disposition==='ACCEPTED','Task acceptance rejected');
  const state=(await this.authority.read(receipt.documentId,'kapelle/dispatch')).state.global as DispatchState;
  assert(state.offer&&state.ownerId===this.authority.options.ownerId&&state.scopeRef===this.authority.options.scopeRef,'Task receipt scope differs');
  const e=parseEnvelope(state.offer);
  assert(e.draft.operationId===operationId,'Task operation binding differs');
  return {contract,operationId,assignmentId:receipt.documentId,dispatchId:receipt.documentId,taskId:e.draft.taskId,revision:e.draft.revision,agentId:e.draft.agentId,recipient:e.draft.recipient,instructionHash:e.instructionHash,sourceHash:e.draft.sourceHash,source:e.source,approval:e.draft.approval,approvedPlan:e.approvedPlan,accepted:true as const,status:state.phase,offerHash:state.offer.contentHash,result:state.result,taskCompleted:false as const,effectsAuthorized:false as const};
 }
 submit(value:unknown){
  const draft=draftSchema.parse(value);
  const run=this.chain.then(()=>this.submitLocked(draft));this.chain=run.catch(()=>undefined);return run;
 }
 private async submitLocked(draft:Draft){
  const a=this.authority,key=this.key(draft.operationId),prior=a.journal.get(key);
  if(prior){
   const saved=parseEnvelope(prior.command.input.offer as DispatchOffer);
   assert(canonical(saved.draft)===canonical(draft),'Task operation payload conflict');
   // Reconcile a possibly committed native write before consulting a changed source.
   const existing=await this.lookup(draft.operationId);assert(existing,'Task acceptance uncertain');return existing;
  }
  assert(a.options.taskDelegation,'Task delegation is not configured');
  const task=taskSchema.parse(await a.options.taskDelegation.readTask(draft.taskId));
  assert(task.ownerId===a.options.ownerId,'Task owner differs');
  const approvedPlan=await a.taskProposalPlan(draft);
  const envelope=acceptedEnvelope(task,draft,approvedPlan);
  const roster=await a.taskDelegationAgents(draft.taskId);
  const recipient=roster.agents.find(i=>i.id===draft.agentId&&i.available)?.recipient;
  assert(recipient&&canonical(recipient)===canonical(draft.recipient),'Task recipient capability changed');
  const instructions=JSON.stringify(envelope);
  const offer:DispatchOffer={contentHash:'',scopeRef:a.options.scopeRef,task:{authorityRef:'task-authority',taskRef:draft.taskId,commitmentHash:'sha256:'+draft.sourceHash},originalRequesterId:a.options.ownerId,senderId:a.options.ownerId,senderAgent:null,recipient:{instanceId:recipient.instanceId,definitionId:recipient.definitionId,definitionVersion:recipient.definitionVersion,definitionHash:recipient.definitionHash},parentDispatchRef:null,parentContentHash:null,continuationOfRef:null,instructions,instructionsHash:instructionsHash(instructions),sources:[{documentRef:draft.taskId,documentType:'task-authority/task',contentVersion:draft.revision+1,contentHash:'sha256:'+envelope.source.hash}],permissionRef:a.options.taskDelegation.permissionRef,expiresAt:new Date(Date.parse(a.options.now?.()??new Date().toISOString())+86400000).toISOString()};
  offer.contentHash=dispatchOfferHash(offer);
  const allocation={documentId:await a.taskProposalDispatch(draft)};
  // CREATE persists instructions + selected bytes before any recipient can ACCEPT.
  const receipt=await a.command({operationId:key,documentId:allocation.documentId,documentType:'kapelle/dispatch',expectedRevision:0,type:'CREATE_DISPATCH',input:{dispatchId:allocation.documentId,ownerId:a.options.ownerId,offer}});
  assert(receipt.result.disposition==='ACCEPTED','Task acceptance rejected');
  return this.lookup(draft.operationId);
 }
}
