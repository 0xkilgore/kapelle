import type { GenerationRequest } from './generation-contract.js';
import { assert } from '../validation.js';
import { z } from 'zod';
import { digest } from '../content.js';
import { draftSchema, acceptedEnvelope, type Task } from './contract.js';
export const planSchema=z.object({recommendedAction:z.string().trim().min(1).max(2000),instructions:z.string().trim().min(1).max(4000),deliverable:z.string().trim().min(1).max(1000),effectLimit:z.literal('PREPARE_ONLY')}).strict();
export const provenanceSchema=z.union([
 z.object({kind:z.enum(['deterministic-template','owner-authored']),id:z.string().min(1).max(100)}).strict(),
 z.object({kind:z.literal('generated'),id:z.string().min(1).max(100),requestOperationId:z.string().uuid(),producerVersion:z.string().min(1).max(100),producerConfigHash:z.string().regex(/^sha256:[a-f0-9]{64}$/),inputHash:z.string().regex(/^sha256:[a-f0-9]{64}$/),outputHash:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict(),
]);
export const planDraftSchema=draftSchema.omit({approval:true});
export const versionSchema=z.object({version:z.number().int().positive(),planHash:z.string().regex(/^sha256:[a-f0-9]{64}$/),provenance:provenanceSchema,plan:planSchema,draft:planDraftSchema,source:z.object({authority:z.literal('task-authority'),content:z.string().max(24000),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),instructionHash:z.string().regex(/^[a-f0-9]{64}$/),comment:z.string().max(4000),actorId:z.string(),occurredAt:z.string()}).strict();
export type PlanVersion=z.infer<typeof versionSchema>;
export type PlanHistory={generationRequests?:GenerationRequest[];versions:PlanVersion[];approval:null|{operationId:string;actorId:string;occurredAt:string;version:number;planHash:string};dispatchId:string|null};
export function planHash(v:Omit<PlanVersion,'planHash'>|PlanVersion){const {planHash:_,actorId:__,occurredAt:___,...value}=v as PlanVersion;return digest(value);}
export function deterministicPlan(task:Task){return planSchema.parse({recommendedAction:`Research the Task ${JSON.stringify(task.title)}, prepare a practical course of action, and identify unresolved questions.`,instructions:`Review the selected Task context for ${JSON.stringify(task.title)}. Research and prepare a Report with findings, recommended next steps, and open questions. Do not publish, send external messages, or complete the Task.`,deliverable:'A Report containing findings, recommended next steps, and open questions.',effectLimit:'PREPARE_ONLY'});}
export function makeVersion(task:Task,draft:z.infer<typeof planDraftSchema>,plan:z.infer<typeof planSchema>,version:number,comment:string,provenance:z.infer<typeof provenanceSchema>):PlanVersion{
 const normalized={...draft,instructions:plan.instructions},e=acceptedEnvelope(task,normalized);
 if(provenance.kind==='deterministic-template')assert(provenance.id==='task-course-v1'&&JSON.stringify(plan)===JSON.stringify(deterministicPlan(task)),'Task proposal provenance differs');
 const v={version,planHash:'',provenance,plan,draft:normalized,source:e.source,instructionHash:e.instructionHash,comment,actorId:'',occurredAt:''};v.planHash=planHash(v);return versionSchema.parse(v);
}
export function readHistory(text:string|null):PlanHistory{if(!text)throw Error('Task proposal unavailable');return JSON.parse(text);}
