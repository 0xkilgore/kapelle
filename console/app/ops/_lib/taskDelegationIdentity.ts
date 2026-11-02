/**
 * Task-bound delegation identity and the capability-based Pipeline recommendation.
 *
 * Both run in the browser and on the server, so the hash function is injected.
 * No model call is made: the recommendation is a template over the Task's saved
 * context and the qualified recipient's declared capabilities.
 */
import type {NativeRoster} from './nativeDelegationContract';

export const DELEGATION_IDENTITY_CONTRACT='kapelle.task-delegation-identity/v1';
/** Bounded probe depth for prior assignments on one Task. */
export const MAX_DELEGATION_ROUNDS=12;

/** Deterministic assignment identity: one per Task, admitted recipient and round.
 * A second device or tab derives the same identity, so a duplicate submission
 * recovers the saved proposal instead of creating another one. */
export async function delegationOperationId(taskId:string,instanceId:string,round:number,hash:(text:string)=>Promise<string>):Promise<string>{
 if(!Number.isSafeInteger(round)||round<1||round>MAX_DELEGATION_ROUNDS)throw Error('Delegation round is out of range.');
 const hex=await hash(DELEGATION_IDENTITY_CONTRACT+'|'+taskId+'|'+instanceId+'|'+round);
 if(!/^[a-f0-9]{64}$/.test(hex))throw Error('Delegation identity hash is invalid.');
 const variant=((parseInt(hex[16],16)&0x3)|0x8).toString(16);
 return hex.slice(0,8)+'-'+hex.slice(8,12)+'-8'+hex.slice(13,16)+'-'+variant+hex.slice(17,20)+'-'+hex.slice(20,32);
}

export type PipelineRecommendationInput={
 task:Pick<NativeRoster['task'],'title'|'projectId'|'comments'|'references'>&{notes:string};
 recipientName:string;
};

/** Deterministic, capability-based initial work plan for the Pipeline recipient. */
export function pipelineRecommendation(input:PipelineRecommendationInput):{instructions:string;summary:string}{
 const title=input.task.title.trim().slice(0,500);
 const project=input.task.projectId?.trim()||null;
 const context=[
  'the task notes',
  input.task.comments.length>0?`${input.task.comments.length} activity note${input.task.comments.length===1?'':'s'}`:null,
  input.task.references.length>0?`${input.task.references.length} connected reference identifier${input.task.references.length===1?'':'s'}`:null,
 ].filter((v):v is string=>v!==null).join(', ');
 const instructions=[
  `Prepare a decision brief and draft next action for the task "${title}"${project?` (project: ${project})`:''} from its saved context: ${context}.`,
  'Use only the supplied source contents and the saved task context. Do not browse, fetch linked contents, contact anyone, or submit anything.',
  'The brief must state the evidence from the supplied sources, the unknowns that remain, and one drafted next action for the owner to approve.',
  'Return the brief as a Report linked back to this task. Do not complete the task.',
 ].join('\n');
 if(instructions.length>4000)throw Error('Pipeline recommendation exceeds the instruction bound.');
 return {instructions,summary:`Recommended for ${input.recipientName}: prepare a decision brief and draft next action from this task's saved context. No outreach, publishing, or task completion.`};
}

/** Agent kit (owner, Oct 15: the "easy" promise): a kit agent's default plan comes from the Task's OWN title and notes, framed
 * prepare-only. The owner can still Edit plan; the Framework still binds the exact approved text. */
export function kitRecommendation(input:PipelineRecommendationInput):{instructions:string;summary:string}{
 const title=input.task.title.trim().slice(0,500),notes=input.task.notes.trim().slice(0,2500);
 const project=input.task.projectId?.trim()||null;
 const instructions=[
  `${title}${project?` (project: ${project})`:''}.`,
  notes?`Owner's notes: ${notes}`:null,
  'Use only the supplied source contents and the saved task context. Do not browse, fetch linked contents, contact anyone, or submit anything.',
  'Prepare it as a draft for the owner to review: never send, publish, schedule or deploy anything, and never say it was sent.',
  'Cite the source for each fact and list anything the sources do not state under "Unknown or not stated". Return it as a Report linked back to this task. Do not complete the task.',
 ].filter((v):v is string=>v!==null).join('\n');
 if(instructions.length>4000)throw Error('Kit recommendation exceeds the instruction bound.');
 return {instructions,summary:`Recommended for ${input.recipientName}: ${title}. Prepared as a draft from this task's notes and sources; nothing is sent or published.`};
}
