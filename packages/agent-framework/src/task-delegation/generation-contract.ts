import {z} from 'zod';
import {digest} from '../content.js';
import {planSchema, type PlanVersion} from './proposal-contract.js';
const hash=z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const producerIdentitySchema=z.object({id:z.string().min(1).max(100),version:z.string().min(1).max(100),configHash:hash}).strict();
export const generationBodySchema=z.object({operationId:z.string().uuid(),expectedRevision:z.number().int().nonnegative(),baseVersion:z.number().int().positive(),basePlanHash:hash,comment:z.string().trim().min(1).max(4000)}).strict();
export const generationReceiptSchema=z.object({producer:producerIdentitySchema,inputHash:hash,resultId:z.string().min(1).max(200),plan:planSchema}).strict();
export const generationRequestSchema=generationBodySchema.extend({
 proposalId:z.string().min(1).max(200),producer:producerIdentitySchema,inputHash:hash,
 status:z.enum(['PENDING','RUNNING','UNCERTAIN','FAILED','APPLIED']),invocationId:z.string().uuid().nullable(),
 receipt:generationReceiptSchema.nullable(),outputHash:hash.nullable(),appliedVersion:z.number().int().positive().nullable(),
 errorCode:z.enum(['PRODUCER_UNCONFIRMED','PRODUCER_REJECTED','SOURCE_CHANGED','SUPERSEDED']).nullable(),
 actorId:z.string(),requestedAt:z.string(),
}).strict();
export type GenerationRequest=z.infer<typeof generationRequestSchema>;
export type GenerationReceipt=z.infer<typeof generationReceiptSchema>;
export function generationInput(proposalId:string,base:PlanVersion,request:Pick<GenerationRequest,'operationId'|'comment'|'producer'>){
 return {contract:'kapelle.task-plan-generation/v1' as const,operationId:request.operationId,proposalId,baseVersion:base.version,basePlanHash:base.planHash,comment:request.comment,producer:request.producer,plan:base.plan,draft:base.draft,source:base.source};
}
export type GenerationInput=ReturnType<typeof generationInput>;
export interface TaskProposalProducer {
 readonly identity:z.infer<typeof producerIdentitySchema>;
 readonly timeoutMs:number;
 admitted(input:GenerationInput):Promise<boolean>;
 generate(input:GenerationInput,invocationId:string,signal:AbortSignal):Promise<GenerationReceipt>;
 /** Read-only recovery by saved invocation; never generate here, including when absent. */
 lookup(input:GenerationInput,invocationId:string):Promise<GenerationReceipt|null>;
}
export function generationOutputHash(receipt:GenerationReceipt){return digest(generationReceiptSchema.parse(receipt));}
