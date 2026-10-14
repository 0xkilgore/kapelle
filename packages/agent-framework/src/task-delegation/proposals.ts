import { z } from 'zod';
import type { FrameworkAuthority } from '../service/authority.js';
import { canonical } from '../content.js';
import { assert } from '../validation.js';
import { taskSchema } from './contract.js';
import { planDraftSchema, planSchema, deterministicPlan, makeVersion, readHistory, type PlanVersion } from './proposal-contract.js';
import { TaskDelegations } from './adapter.js';
const uuid=z.string().uuid();
export const createProposalSchema=z.object({operationId:uuid,draft:planDraftSchema.omit({instructions:true}).extend({instructions:z.string().trim().min(1).max(4000).optional()})}).strict();
export const reviseProposalSchema=z.object({operationId:uuid,expectedRevision:z.number().int().nonnegative(),baseVersion:z.number().int().positive(),basePlanHash:z.string(),comment:z.string().trim().max(4000),plan:planSchema,draft:planDraftSchema}).strict();
export const approveProposalSchema=z.object({operationId:uuid,expectedRevision:z.number().int().nonnegative(),version:z.number().int().positive(),planHash:z.string()}).strict();
export class TaskProposals {
 private chain:Promise<unknown>=Promise.resolve();
 constructor(readonly authority:FrameworkAuthority,readonly dispatches=new TaskDelegations(authority)){}
 private serial<T>(run:()=>Promise<T>){const p=this.chain.then(run);this.chain=p.catch(()=>{});return p;}
 private key(id:string){return 'task-proposal:'+uuid.parse(id);}
 async read(id:string){const d=await this.authority.read(id,'kapelle/review-intent');assert(d.state.document.version===3,'Task proposal unavailable');const s=d.state.global as any,h=readHistory(s.taskPlanJson);return {proposalId:id,revision:s.revision,status:s.status,currentVersion:h.versions.at(-1)!.version,...h,generationRequests:h.generationRequests??[]};}
 async lookup(operationId:string){const entry=this.authority.journal.get(this.key(operationId));if(!entry)return null;const receipt=await this.authority.receipt(this.key(operationId));assert(receipt.result.disposition==='ACCEPTED','Task acceptance uncertain');return this.read(receipt.documentId);}
 create(raw:unknown){const body=createProposalSchema.parse(raw);return this.serial(async()=>{
  const a=this.authority,key=this.key(body.operationId),prior=a.journal.get(key);
  if(prior){assert(prior.command.type==='CREATE_TASK_PROPOSAL','Task operation payload conflict');const saved=JSON.parse(String(prior.command.input.versionJson)) as PlanVersion;const compare={...saved.draft,...(body.draft.instructions===undefined?{instructions:undefined}:{})};assert(canonical(compare)===canonical(body.draft),'Task operation payload conflict');return this.lookup(body.operationId);}
  assert(body.draft.operationId===body.operationId,'Task proposal operation identity differs');assert(a.options.taskDelegation,'Task delegation is not configured');
  const task=taskSchema.parse(await a.options.taskDelegation.readTask(body.draft.taskId));
  const provided=body.draft.instructions;const plan=planSchema.parse({...deterministicPlan(task),...(provided?{instructions:provided}:{})});
  const version=makeVersion(task,{...body.draft,instructions:plan.instructions},plan,1,'',{kind:provided?'owner-authored':'deterministic-template',id:provided?'owner-initial-v1':'task-course-v1'});
  const allocation=await a.allocate(key+':allocation','kapelle/review-intent','Task recommended course',3);
  await a.command({operationId:key,documentId:allocation.documentId,documentType:'kapelle/review-intent',expectedRevision:0,type:'CREATE_TASK_PROPOSAL',input:{reviewId:allocation.documentId,instanceId:version.draft.agentId,scopeRef:a.options.scopeRef,versionJson:JSON.stringify(version)}});
  return this.lookup(body.operationId);
 });}
 revise(id:string,raw:unknown){const body=reviseProposalSchema.parse(raw);return this.serial(async()=>{
  const a=this.authority,key=this.key(body.operationId),prior=a.journal.get(key);
  if(prior){const v=JSON.parse(String(prior.command.input.versionJson)) as PlanVersion;assert(prior.command.type==='REVISE_TASK_PROPOSAL'&&prior.command.documentId===id&&prior.command.expectedRevision===body.expectedRevision&&prior.command.input.baseVersion===body.baseVersion&&prior.command.input.basePlanHash===body.basePlanHash&&canonical(v.plan)===canonical(body.plan)&&v.comment===body.comment&&canonical(v.draft)===canonical({...body.draft,instructions:body.plan.instructions}),'Task operation payload conflict');return this.lookup(body.operationId);}
  const current=await this.read(id),last=current.versions.at(-1)!;assert(!current.dispatchId&&current.revision===body.expectedRevision&&last.version===body.baseVersion&&last.planHash===body.basePlanHash,'Stale Task proposal');
  assert(canonical(body.plan)!==canonical(last.plan)||canonical(body.draft)!==canonical(last.draft),'Task comment requires an explicit revised plan');
  assert(a.options.taskDelegation,'Task delegation is not configured');const task=taskSchema.parse(await a.options.taskDelegation.readTask(body.draft.taskId));
  const version=makeVersion(task,body.draft,body.plan,last.version+1,body.comment,{kind:'owner-authored',id:'owner-revision-v1'});
  await a.command({operationId:key,documentId:id,documentType:'kapelle/review-intent',expectedRevision:body.expectedRevision,type:'REVISE_TASK_PROPOSAL',input:{baseVersion:body.baseVersion,basePlanHash:body.basePlanHash,versionJson:JSON.stringify(version)}});
  return this.lookup(body.operationId);
 });}
 approveAndSend(id:string,raw:unknown){const body=approveProposalSchema.parse(raw);return this.serial(async()=>{
  const a=this.authority,key=this.key(body.operationId),prior=a.journal.get(key);
  let proposal=await this.read(id),last=proposal.versions.at(-1)!;
  if(prior){assert(prior.command.type==='APPROVE_TASK_PROPOSAL'&&prior.command.documentId===id&&prior.command.expectedRevision===body.expectedRevision&&prior.command.input.version===body.version&&prior.command.input.planHash===body.planHash,'Task operation payload conflict');proposal=(await this.lookup(body.operationId))!;last=proposal.versions.at(-1)!;}
  else{
   assert(!proposal.generationRequests.some(r=>['PENDING','RUNNING','UNCERTAIN'].includes(r.status)),'Task generation must settle before approval');
   assert(!proposal.dispatchId&&proposal.revision===body.expectedRevision&&last.version===body.version&&last.planHash===body.planHash,'Stale Task proposal');
   const allocation=await a.allocate('task-delegation:'+last.draft.operationId+':allocation','kapelle/dispatch','Approved Task delegation');
   await a.command({operationId:key,documentId:id,documentType:'kapelle/review-intent',expectedRevision:body.expectedRevision,type:'APPROVE_TASK_PROPOSAL',input:{version:body.version,planHash:body.planHash,operationId:body.operationId,dispatchId:allocation.documentId}});
   proposal=(await this.lookup(body.operationId))!;
  }
  const item=await this.dispatches.submit({...last.draft,approval:{proposalId:id,version:body.version,planHash:body.planHash,operationId:body.operationId}});
  return {proposal,item};
 });}
}
