import {z} from 'zod';
import {canonical,digest} from '../content.js';
import {assert} from '../validation.js';
import type {FrameworkAuthority} from '../service/authority.js';
import {TaskProposals} from './proposals.js';
import {taskSchema} from './contract.js';
import {makeVersion, type PlanVersion} from './proposal-contract.js';
import {generatedProvenance} from '../../document-models/review-intent/v3/generation.js';
import {generationBodySchema,generationRequestSchema,generationInput,generationReceiptSchema,generationOutputHash,producerIdentitySchema,type GenerationRequest,type GenerationReceipt} from './generation-contract.js';

/** Native request/claim/result history; no browser or parallel execution store is authoritative. */
export class TaskGenerations {
 readonly proposals:TaskProposals;
 constructor(readonly authority:FrameworkAuthority){this.proposals=new TaskProposals(authority);}
 private async receipt(key:string){const r=await this.authority.receipt(key);assert(r.result.disposition==='ACCEPTED','Task generation acceptance uncertain');return this.proposals.read(r.documentId);}
 async request(proposalId:string,raw:unknown){
  const body=generationBodySchema.parse(raw),a=this.authority,key='task-generation-request:'+body.operationId,prior=a.journal.get(key);
  if(prior){
   const g=generationRequestSchema.parse(JSON.parse(String(prior.command.input.requestJson)));
   assert(prior.command.documentId===proposalId&&canonical(generationBodySchema.parse({operationId:g.operationId,expectedRevision:g.expectedRevision,baseVersion:g.baseVersion,basePlanHash:g.basePlanHash,comment:g.comment}))===canonical(body),'Task generation payload conflict');
   return this.receipt(key);
  }
  const current=await this.proposals.read(proposalId),base=current.versions.at(-1)!,producer=a.options.taskProposalProducer;
  assert(producer,'Task generation producer unavailable');
  z.number().int().min(1).max(60000).parse(producer.timeoutMs);
  assert(!current.dispatchId&&current.revision===body.expectedRevision&&base.version===body.baseVersion&&base.planHash===body.basePlanHash,'Stale Task generation base');
  const identity=producerIdentitySchema.parse(producer.identity),input=generationInput(proposalId,base,{...body,producer:identity});
  const request=generationRequestSchema.parse({...body,proposalId,producer:identity,inputHash:digest(input),status:'PENDING',invocationId:null,receipt:null,outputHash:null,appliedVersion:null,errorCode:null,actorId:'',requestedAt:''});
  await a.taskGenerationCommand({operationId:key,documentId:proposalId,documentType:'kapelle/review-intent',expectedRevision:body.expectedRevision,type:'REQUEST_TASK_GENERATION',input:{requestJson:JSON.stringify(request)}});
  return this.receipt(key);
 }
 private async settle(id:string,g:GenerationRequest,outcome:'UNCERTAIN'|'FAILED'|'APPLIED',receipt:GenerationReceipt|null,version:PlanVersion|null,errorCode:GenerationRequest['errorCode']){
  const a=this.authority;let key=`task-generation-${outcome.toLowerCase()}:${g.operationId}`;const prior=a.journal.get(key);
  if(prior)return this.receipt(key);
  const current=await this.proposals.read(id),now=current.generationRequests.find(r=>r.operationId===g.operationId)!;
  if(now.status==='APPLIED'||(now.status==='FAILED'&&(!receipt||now.receipt)))return current;
  if(now.status==='FAILED'){outcome='FAILED';version=null;errorCode=now.errorCode;key='task-generation-failed:'+g.operationId;if(a.journal.get(key))return this.receipt(key);}
  await a.taskGenerationCommand({operationId:key,documentId:id,documentType:'kapelle/review-intent',expectedRevision:current.revision,type:'RECORD_TASK_GENERATION',input:{requestOperationId:g.operationId,outcome,receiptJson:receipt?JSON.stringify(receipt):null,versionJson:version?JSON.stringify(version):null,errorCode}});
  return this.receipt(key);
 }
 private async freshBase(id:string,g:GenerationRequest){
  const current=await this.proposals.read(id),base=current.versions.at(-1)!;
  assert(!current.dispatchId&&base.version===g.baseVersion&&base.planHash===g.basePlanHash,'Task generation source changed');
  const task=taskSchema.parse(await this.authority.options.taskDelegation!.readTask(base.draft.taskId));
  assert(task.ownerId===this.authority.options.ownerId&&canonical(makeVersion(task,base.draft,base.plan,base.version,base.comment,base.provenance))===canonical({...base,actorId:'',occurredAt:''}),'Task generation source changed');
  const roster=await this.authority.taskDelegationAgents(task.id),recipient=roster.agents.find(r=>r.id===base.draft.agentId&&r.available)?.recipient;
  assert(recipient&&canonical(recipient)===canonical(base.draft.recipient),'Task generation capability changed');
  return {base,task};
 }
 async run(id:string,operationId:string){
  z.string().uuid().parse(operationId);
  let current=await this.proposals.read(id),g=current.generationRequests.find(r=>r.operationId===operationId);
  assert(g,'Task generation request unavailable');
  if(['FAILED','APPLIED'].includes(g.status))return current;
  const producer=this.authority.options.taskProposalProducer;
  if(!producer||canonical(producerIdentitySchema.parse(producer.identity))!==canonical(g.producer))return this.settle(id,g,'FAILED',null,null,'PRODUCER_REJECTED');
  let base:PlanVersion;
  try{base=(await this.freshBase(id,g)).base;}catch{return this.settle(id,g,'FAILED',null,null,'SOURCE_CHANGED');}
  const input=generationInput(id,base,g);
  assert(digest(input)===g.inputHash,'Task generation input changed');
  if(!await producer.admitted(input).catch(()=>false))return this.settle(id,g,'FAILED',null,null,'PRODUCER_REJECTED');
  z.number().int().min(1).max(60000).parse(producer.timeoutMs);
  const claim=await this.authority.claimTaskGeneration(id,operationId);
  current=await this.proposals.read(id);g=current.generationRequests.find(r=>r.operationId===operationId)!;
  assert(claim.invocationId&&claim.invocationId===g.invocationId,'Task generation invocation uncertain');
  let raw:unknown;
  try{
   const signal=AbortSignal.timeout(producer.timeoutMs);
   raw=await Promise.race([
    claim.invoke?producer.generate(input,claim.invocationId,signal):producer.lookup(input,claim.invocationId),
    new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(Error('generation_timeout')),{once:true})),
   ]);
   if(!raw)return this.settle(id,g,'UNCERTAIN',null,null,'PRODUCER_UNCONFIRMED');
  }catch{return this.settle(id,g,'UNCERTAIN',null,null,'PRODUCER_UNCONFIRMED');}
  let receipt:GenerationReceipt;
  try{receipt=generationReceiptSchema.parse(raw);assert(receipt.inputHash===g.inputHash&&canonical(receipt.producer)===canonical(g.producer),'Task generation receipt differs');}
  catch{return this.settle(id,g,'FAILED',null,null,'PRODUCER_REJECTED');}
  let version:PlanVersion;
  try{
   const fresh=await this.freshBase(id,g);
   version=makeVersion(fresh.task,fresh.base.draft,receipt.plan,fresh.base.version+1,g.comment,generatedProvenance(g,generationOutputHash(receipt)));
  }catch{return this.settle(id,g,'FAILED',receipt,null,'SOURCE_CHANGED');}
  // Result receipt and generated version are retained atomically by one native operation.
  try{return await this.settle(id,g,'APPLIED',receipt,version,null);}
  catch(error){
   // A prepared/committed native operation must reconcile before any alternate outcome.
   if(this.authority.journal.get('task-generation-applied:'+g.operationId))throw error;
   return this.settle(id,g,'FAILED',receipt,null,'SOURCE_CHANGED');
  }
 }
}
