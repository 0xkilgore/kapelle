import {z} from 'zod';
import {nativeDraftSchema,nativeReceiptSchema} from './nativeDelegationContract';
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/),hex=z.string().regex(/^[a-f0-9]{64}$/);
export const proposalPlanSchema=z.object({recommendedAction:z.string().trim().min(1).max(2000),instructions:z.string().trim().min(1).max(4000),deliverable:z.string().trim().min(1).max(1000),effectLimit:z.literal('PREPARE_ONLY')}).strict();
const producerSchema=z.object({id:z.string().min(1).max(100),version:z.string().min(1).max(100),configHash:digest}).strict();
const provenanceSchema=z.union([
 z.object({kind:z.enum(['deterministic-template','owner-authored']),id:z.string().min(1).max(100)}).strict(),
 z.object({kind:z.literal('generated'),id:z.string().min(1).max(200),requestOperationId:z.string().uuid(),producerVersion:z.string().min(1).max(100),producerConfigHash:digest,inputHash:digest,outputHash:digest}).strict(),
]);
const generationReceiptSchema=z.object({producer:producerSchema,inputHash:digest,resultId:z.string().min(1).max(200),plan:proposalPlanSchema}).strict();
export const generationRequestSchema=z.object({operationId:z.string().uuid(),proposalId:z.string().uuid(),expectedRevision:z.number().int().nonnegative(),baseVersion:z.number().int().positive(),basePlanHash:digest,comment:z.string().trim().min(1).max(4000),producer:producerSchema,inputHash:digest,status:z.enum(['PENDING','RUNNING','UNCERTAIN','FAILED','APPLIED']),invocationId:z.string().uuid().nullable(),receipt:generationReceiptSchema.nullable(),outputHash:digest.nullable(),appliedVersion:z.number().int().positive().nullable(),errorCode:z.enum(['PRODUCER_UNCONFIRMED','PRODUCER_REJECTED','SOURCE_CHANGED','SUPERSEDED']).nullable(),actorId:z.string(),requestedAt:z.string()}).strict();
export const proposalVersionSchema=z.object({version:z.number().int().positive(),planHash:digest,provenance:provenanceSchema,plan:proposalPlanSchema,draft:nativeDraftSchema,source:z.object({authority:z.literal('task-authority'),content:z.string().max(24000),hash:hex}).strict(),instructionHash:hex,comment:z.string().max(4000),actorId:z.string(),occurredAt:z.string()}).strict();
export const proposalSchema=z.object({proposalId:z.string().uuid(),revision:z.number().int().nonnegative(),status:z.string(),currentVersion:z.number().int().positive(),versions:z.array(proposalVersionSchema).min(1).max(20),approval:z.object({operationId:z.string().uuid(),actorId:z.string(),occurredAt:z.string(),version:z.number().int().positive(),planHash:digest}).nullable(),dispatchId:z.string().uuid().nullable(),generationRequests:z.array(generationRequestSchema).max(20).default([])});
export const approvedReceiptSchema=nativeReceiptSchema.extend({approvedPlan:proposalPlanSchema,approval:z.object({proposalId:z.string().uuid(),version:z.number().int().positive(),planHash:digest,operationId:z.string().uuid()}).strict()});
export type TaskProposal= z.infer<typeof proposalSchema>;
export function canonicalProposal(value:unknown):string{if(Array.isArray(value))return '['+value.map(canonicalProposal).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonicalProposal(v)).join(',')+'}';return JSON.stringify(value);}
export function unfinishedGeneration(p:TaskProposal){return p.generationRequests.find(r=>['PENDING','RUNNING','UNCERTAIN'].includes(r.status));}
export async function validateProposal(value:unknown,hash:(s:string)=>Promise<string>){
 const p=proposalSchema.parse(value),same=(a:unknown,b:unknown)=>canonicalProposal(a)===canonicalProposal(b);
 const digestValue=async(v:unknown)=>'sha256:'+await hash(canonicalProposal(v));
 if(p.versions.length!==p.currentVersion)throw Error('Proposal history is incomplete');
 for(const [i,v] of p.versions.entries()){
  const {planHash,actorId,occurredAt,...content}=v;
  if(v.version!==i+1||planHash!==await digestValue(content)||v.source.hash!==await hash(v.source.content)||v.instructionHash!==await hash(JSON.stringify(v.plan.instructions))||v.draft.instructions!==v.plan.instructions||v.draft.agentId!==v.draft.recipient.instanceId)throw Error('Proposal history verification failed');
 }
 if(new Set(p.generationRequests.map(r=>r.operationId)).size!==p.generationRequests.length)throw Error('Duplicate generation identity');
 for(const r of p.generationRequests){
  const base=p.versions[r.baseVersion-1];
  if(!base||r.proposalId!==p.proposalId||r.basePlanHash!==base.planHash)throw Error('Generation base differs');
  const input={contract:'kapelle.task-plan-generation/v1',operationId:r.operationId,proposalId:p.proposalId,baseVersion:r.baseVersion,basePlanHash:r.basePlanHash,comment:r.comment,producer:r.producer,plan:base.plan,draft:base.draft,source:base.source};
  if(r.inputHash!==await digestValue(input))throw Error('Generation input differs');
  if(r.receipt){if(!same(r.receipt.producer,r.producer)||r.receipt.inputHash!==r.inputHash||r.outputHash!==await digestValue(r.receipt))throw Error('Generation receipt differs');}
  else if(r.outputHash)throw Error('Generation output lacks receipt');
  if(r.status==='APPLIED'){
   const v=r.appliedVersion?p.versions[r.appliedVersion-1]:null;
   if(!v||!r.receipt||!r.invocationId||r.errorCode||v.version!==r.baseVersion+1||!same(v.plan,r.receipt.plan)||v.comment!==r.comment||!same(v.source,base.source)||!same(v.draft,{...base.draft,instructions:v.plan.instructions})||!same(v.provenance,{kind:'generated',id:r.producer.id,requestOperationId:r.operationId,producerVersion:r.producer.version,producerConfigHash:r.producer.configHash,inputHash:r.inputHash,outputHash:r.outputHash}))throw Error('Applied generation differs from saved receipt');
  }else if(r.appliedVersion!==null)throw Error('Unapplied generation claims a version');
 }
 for(const v of p.versions)if(v.provenance.kind==='generated'&&!p.generationRequests.some(r=>r.status==='APPLIED'&&r.operationId===(v.provenance as {requestOperationId:string}).requestOperationId&&r.appliedVersion===v.version))throw Error('Generated version lacks receipt');
 const last=p.versions.at(-1)!;
 if(p.approval&&(p.approval.version!==last.version||p.approval.planHash!==last.planHash||unfinishedGeneration(p)))throw Error('Approval does not match current plan');
 if(p.dispatchId&&!p.approval)throw Error('Dispatch lacks proposal approval');
 return p;
}
