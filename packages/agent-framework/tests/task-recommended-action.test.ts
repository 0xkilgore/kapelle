import {describe,it,expect} from 'vitest';
import {deterministicPlan,taskRecommendedAction,makeVersion,DETERMINISTIC_PLAN_ID} from '../src/task-delegation/proposal-contract.js';
import {taskSource,type Task} from '../src/task-delegation/contract.js';

// The plan's Recommended action comes from the Task itself (its title, and its notes' first line when the owner included the
// notes), not generic capability text. Proposals saved with the frozen task-course-v1 wording still verify on replay.
const task=(over:Partial<Task>={}):Task=>({id:'11111111-1111-4111-8111-111111111111',ownerId:'owner',revision:3,title:'Draft the Oct 8 EXNA minutes',status:'OPEN',projectId:'example-org',
 bodyMarkdown:'## Use the transcript\nDecision items first.',comments:[],externalRefs:[],...over});

describe('Task-derived Recommended action',()=>{
 it('is the Task title plus the first notes line, framed prepare-only',()=>{
  expect(taskRecommendedAction(task(),true)).toBe('Draft the Oct 8 EXNA minutes. From your notes: Use the transcript\nPrepared as a draft Report for your review: nothing is sent, published, or marked complete.');
  expect(deterministicPlan(task(),true).recommendedAction).not.toMatch(/practical course of action|Research the Task/);
 });
 it('never quotes notes the owner left out, and handles packets, markup, punctuation and long lines',()=>{
  expect(taskRecommendedAction(task(),false)).toBe('Draft the Oct 8 EXNA minutes.\nPrepared as a draft Report for your review: nothing is sent, published, or marked complete.');
  expect(taskRecommendedAction(task({bodyMarkdown:JSON.stringify({notes:'- Ask Harlan for the agenda'})}),true)).toContain('From your notes: Ask Harlan for the agenda');
  expect(taskRecommendedAction(task({title:'Why did turnout drop?',bodyMarkdown:''}),true)).toMatch(/^Why did turnout drop\?\nPrepared/);
  expect(taskRecommendedAction(task({bodyMarkdown:'x'.repeat(400)}),true)).toContain('x'.repeat(297)+'…');
  expect(taskRecommendedAction(task({bodyMarkdown:'Draft the Oct 8 EXNA minutes'}),true)).not.toContain('From your notes');
 });
 it('binds the template id; a task-course-v1 version still replays; an unknown template id is refused',()=>{
  const draft={operationId:'22222222-2222-4222-8222-222222222222',taskId:task().id,revision:3,agentId:'a',recipient:{} as never,sourceHash:taskSource(task()).sourceHash,includeNotes:true,includeComments:false,includeReferences:false,instructions:undefined} as never;
  const make=(plan:ReturnType<typeof deterministicPlan>,id:string)=>()=>makeVersion(task(),draft,plan,1,'',{kind:'deterministic-template',id});
  const v1={recommendedAction:`Research the Task ${JSON.stringify(task().title)}, prepare a practical course of action, and identify unresolved questions.`,instructions:`Review the selected Task context for ${JSON.stringify(task().title)}. Research and prepare a Report with findings, recommended next steps, and open questions. Do not publish, send external messages, or complete the Task.`,deliverable:'A Report containing findings, recommended next steps, and open questions.',effectLimit:'PREPARE_ONLY' as const};
  let threw:unknown=null;
  for(const [plan,id,ok] of [[deterministicPlan(task(),true),DETERMINISTIC_PLAN_ID,true],[v1,'task-course-v1',true],[v1,DETERMINISTIC_PLAN_ID,false],[deterministicPlan(task(),true),'task-course-v1',false],[deterministicPlan(task(),true),'task-course-v9',false]] as const){
   try{make(plan,id)();threw=null;}catch(e){threw=e;}
   if(ok)expect(threw===null||!String(threw).includes('provenance differs'),id).toBe(true);else expect(String(threw),id).toContain('provenance differs');
  }
 });
});
