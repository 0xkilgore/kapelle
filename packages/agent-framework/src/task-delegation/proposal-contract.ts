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
/** The owner's first readable notes line (a W2 packet's {notes} or plain markdown), bounded; null when there is none. */
function firstNotesLine(body:string):string|null{
 let text=body;try{const v=JSON.parse(body);if(v&&typeof v==='object'&&typeof v.notes==='string')text=v.notes;}catch{}
 const line=text.split('\n').map(l=>l.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/,'').trim()).find(l=>l.length>0);
 return line?(line.length>300?line.slice(0,297)+'…':line):null;
}
/** Template id of deterministicPlan's current wording (bumped whenever its output changes). */
export const DETERMINISTIC_PLAN_ID='task-course-v2';
/** Recommended action derived from the Task itself (its title is the action; its notes' first line the context, ONLY when the
 *  owner included the notes), framed prepare-only. Pure in (Task, includeNotes), so replay yields the same text. */
export function taskRecommendedAction(task:Task,includeNotes:boolean){
 const title=task.title.trim(),line=includeNotes?firstNotesLine(task.bodyMarkdown):null;
 return `${title}${/[.!?]$/.test(title)?'':'.'}${line&&line!==title?` From your notes: ${line}`:''}\nPrepared as a draft Report for your review: nothing is sent, published, or marked complete.`;
}
export function deterministicPlan(task:Task,includeNotes:boolean){return planSchema.parse({recommendedAction:taskRecommendedAction(task,includeNotes),instructions:`Review the selected Task context for ${JSON.stringify(task.title)}. Research and prepare a Report with findings, recommended next steps, and open questions. Do not publish, send external messages, or complete the Task.`,deliverable:'A Report containing findings, recommended next steps, and open questions.',effectLimit:'PREPARE_ONLY'});}
/** FROZEN: the 'task-course-v1' wording, kept so proposals saved with it still verify on replay (approval, generation). */
function deterministicPlanV1(task:Task){return planSchema.parse({recommendedAction:`Research the Task ${JSON.stringify(task.title)}, prepare a practical course of action, and identify unresolved questions.`,instructions:`Review the selected Task context for ${JSON.stringify(task.title)}. Research and prepare a Report with findings, recommended next steps, and open questions. Do not publish, send external messages, or complete the Task.`,deliverable:'A Report containing findings, recommended next steps, and open questions.',effectLimit:'PREPARE_ONLY'});}
export function makeVersion(task:Task,draft:z.infer<typeof planDraftSchema>,plan:z.infer<typeof planSchema>,version:number,comment:string,provenance:z.infer<typeof provenanceSchema>):PlanVersion{
 const normalized={...draft,instructions:plan.instructions},e=acceptedEnvelope(task,normalized);
 if(provenance.kind==='deterministic-template'){const expected=provenance.id===DETERMINISTIC_PLAN_ID?deterministicPlan(task,draft.includeNotes):provenance.id==='task-course-v1'?deterministicPlanV1(task):null;assert(expected!==null&&JSON.stringify(plan)===JSON.stringify(expected),'Task proposal provenance differs');}
 const v={version,planHash:'',provenance,plan,draft:normalized,source:e.source,instructionHash:e.instructionHash,comment,actorId:'',occurredAt:''};v.planHash=planHash(v);return versionSchema.parse(v);
}
export function readHistory(text:string|null):PlanHistory{if(!text)throw Error('Task proposal unavailable');return JSON.parse(text);}
