import {z} from 'zod';
import {canonical,digest} from '../../../src/content.js';
import {assert} from '../../../src/validation.js';
import {planHash,versionSchema,type PlanHistory} from '../../../src/task-delegation/proposal-contract.js';
import {generationRequestSchema,generationReceiptSchema,generationInput,generationOutputHash,type GenerationRequest} from '../../../src/task-delegation/generation-contract.js';
const common={actorId:z.string().min(1),occurredAt:z.iso.datetime(),expectedRevision:z.number().int().nonnegative()};
export const RequestTaskGenerationInputSchema=()=>z.object({...common,requestJson:z.string().max(8000)}).strict();
export const ClaimTaskGenerationInputSchema=()=>z.object({...common,requestOperationId:z.string().uuid(),invocationId:z.string().uuid()}).strict();
export const RecordTaskGenerationInputSchema=()=>z.object({...common,requestOperationId:z.string().uuid(),outcome:z.enum(['UNCERTAIN','FAILED','APPLIED']),receiptJson:z.string().max(16000).nullable(),versionJson:z.string().max(40000).nullable(),errorCode:z.enum(['PRODUCER_UNCONFIRMED','PRODUCER_REJECTED','SOURCE_CHANGED','SUPERSEDED']).nullable()}).strict();
export const generationSchemas={REQUEST_TASK_GENERATION:RequestTaskGenerationInputSchema,CLAIM_TASK_GENERATION:ClaimTaskGenerationInputSchema,RECORD_TASK_GENERATION:RecordTaskGenerationInputSchema};
export function generatedProvenance(g:GenerationRequest,outputHash:string){return {kind:'generated' as const,id:g.producer.id,requestOperationId:g.operationId,producerVersion:g.producer.version,producerConfigHash:g.producer.configHash,inputHash:g.inputHash,outputHash};}
/** A superseding edit cannot consume the space reserved for an in-flight receipt. */
export function lateReceiptReserve(h:PlanHistory){
 return (h.generationRequests??[]).reduce((sum,g)=>{
  if(g.status!=='FAILED'||!g.invocationId||g.receipt)return sum;
  const plan={recommendedAction:'界'.repeat(2000),instructions:'界'.repeat(4000),deliverable:'界'.repeat(1000),effectLimit:'PREPARE_ONLY'};
  const retained={...g,receipt:{producer:g.producer,inputHash:g.inputHash,resultId:'界'.repeat(200),plan},outputHash:'sha256:'+'f'.repeat(64)};
  return sum+Buffer.byteLength(JSON.stringify(retained))-Buffer.byteLength(JSON.stringify(g));
 },0);
}
export function generationActive(h:PlanHistory){return (h.generationRequests??[]).some(r=>['PENDING','RUNNING','UNCERTAIN'].includes(r.status));}
export function reduceGeneration(type:string,i:any,h:PlanHistory,proposalId:string){
 const last=h.versions.at(-1)!;h.generationRequests??=[];
 if(type!=='RECORD_TASK_GENERATION'||i.outcome==='APPLIED')assert(!h.dispatchId,'Task proposal already sent');
 if(type==='REQUEST_TASK_GENERATION'){
  const g=generationRequestSchema.parse(JSON.parse(i.requestJson));
  assert(!generationActive(h)&&h.generationRequests.length<20&&h.versions.length<20,'Task generation request unavailable');
  assert(!h.generationRequests.some(r=>r.operationId===g.operationId)&&g.proposalId===proposalId&&g.expectedRevision===i.expectedRevision&&g.baseVersion===last.version&&g.basePlanHash===last.planHash&&g.inputHash===digest(generationInput(proposalId,last,g)),'Task generation input differs');
  assert(g.status==='PENDING'&&!g.invocationId&&!g.receipt&&!g.outputHash&&!g.appliedVersion&&!g.errorCode,'Task generation initial state differs');
  g.actorId=i.actorId;g.requestedAt=i.occurredAt;h.generationRequests.push(g);h.approval=null;
  // Reserve the maximum UTF-8 result shape before granting an invocation.
  const maximumPlan={recommendedAction:'界'.repeat(2000),instructions:'界'.repeat(4000),deliverable:'界'.repeat(1000),effectLimit:'PREPARE_ONLY'};
  const maxHash='sha256:'+'f'.repeat(64),maximumReceipt={producer:g.producer,inputHash:g.inputHash,resultId:'界'.repeat(200),plan:maximumPlan};
  const maximumVersion={...last,version:last.version+1,planHash:maxHash,plan:maximumPlan,draft:{...last.draft,instructions:maximumPlan.instructions},comment:g.comment,actorId:i.actorId,occurredAt:i.occurredAt,provenance:generatedProvenance(g,maxHash)};
  const reserved={...h,versions:[...h.versions,maximumVersion],generationRequests:h.generationRequests.map(r=>r===g?{...r,status:'APPLIED',invocationId:'00000000-0000-4000-8000-000000000000',receipt:maximumReceipt,outputHash:maxHash,appliedVersion:maximumVersion.version}:r)};
  assert(Buffer.byteLength(JSON.stringify(reserved))+lateReceiptReserve(h)<=180000,'Task generation history capacity unavailable');return;
 }
 const g=h.generationRequests.find(r=>r.operationId===i.requestOperationId);
 assert(g&&( !['FAILED','APPLIED'].includes(g.status) || (g.status==='FAILED'&&type==='RECORD_TASK_GENERATION'&&i.outcome==='FAILED'&&i.receiptJson&&!g.receipt&&i.errorCode===g.errorCode)), 'Task generation request unavailable');
 if(type==='CLAIM_TASK_GENERATION'){
  assert(g.status==='PENDING'&&!g.invocationId&&last.version===g.baseVersion&&last.planHash===g.basePlanHash,'Task generation already claimed or superseded');
  g.invocationId=i.invocationId;g.status='RUNNING';return;
 }
 assert(type==='RECORD_TASK_GENERATION','Task generation operation unavailable');
 const receipt=i.receiptJson===null?null:generationReceiptSchema.parse(JSON.parse(i.receiptJson));
 if(receipt)assert(canonical(receipt.producer)===canonical(g.producer)&&receipt.inputHash===g.inputHash&&g.invocationId,'Task generation receipt differs');
 if(i.outcome==='APPLIED'){
  assert(g.invocationId&&receipt&&!i.errorCode&&last.version===g.baseVersion&&last.planHash===g.basePlanHash&&h.versions.length<20,'Task generated revision stale');
  const v=versionSchema.parse(JSON.parse(i.versionJson));
  assert(v.version===last.version+1&&v.planHash===planHash(v)&&canonical(v.plan)===canonical(receipt.plan)&&v.comment===g.comment&&canonical(v.provenance)===canonical(generatedProvenance(g,generationOutputHash(receipt)))&&canonical(v.draft)===canonical({...last.draft,instructions:receipt.plan.instructions})&&canonical(v.source)===canonical(last.source),'Task generated revision differs');
  v.actorId=i.actorId;v.occurredAt=i.occurredAt;h.versions.push(v);h.approval=null;g.appliedVersion=v.version;
 }else{
  assert(i.versionJson===null&&i.errorCode,'Task generation failure receipt differs');
  if(i.outcome==='UNCERTAIN')assert(g.invocationId&&!receipt&&i.errorCode==='PRODUCER_UNCONFIRMED','Task generation uncertainty differs');
 }
 g.status=i.outcome;g.receipt=receipt;g.outputHash=receipt?generationOutputHash(receipt):null;g.errorCode=i.errorCode;
}
