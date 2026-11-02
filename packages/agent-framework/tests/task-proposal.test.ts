import {describe,it,expect} from 'vitest';
import {createZip} from 'document-model';
import {utils as proposalUtils} from '../document-models/review-intent/v3/index.js';
import {randomUUID} from 'node:crypto';
import {taskDelegationFixture} from './task-delegation-fixture.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
async function request(f:Awaited<ReturnType<typeof taskDelegationFixture>>){const roster=await f.authority.taskDelegationAgents(f.platform.taskId),a=roster.agents.find(a=>a.available)!;const operationId=randomUUID();return {operationId,draft:{operationId,taskId:f.platform.taskId,revision:roster.task.revision,agentId:a.id,recipient:a.recipient!,sourceHash:roster.task.sourceHash,includeNotes:true,includeComments:true,includeReferences:true}};}
const enabled=process.env.KAPELLE_SCOPED_REACTOR_ROOT&&process.env.KAPELLE_PLATFORM_MODELS_ROOT;
describe.skipIf(!enabled)('Native proposal-first Task workflow',()=>{
 it('retains deterministic suggestion and explicit owner revisions, then approves exact final plan and recovers one Dispatch',async()=>{
  const f=await taskDelegationFixture();try{
   let api=new TaskProposals(f.authority);const req=await request(f);const original=(await api.create(req))!;expect(original.versions[0].provenance.kind).toBe('deterministic-template');expect(original.dispatchId).toBe(null);expect(await f.authority.backend.list('kapelle/dispatch')).toHaveLength(0);
   expect(await api.create(req)).toEqual(original);await expect(api.create({...req,draft:{...req.draft,includeNotes:false}})).rejects.toThrow('payload conflict');
   const first=original.versions[0],revision={operationId:randomUUID(),expectedRevision:original.revision,baseVersion:1,basePlanHash:first.planHash,comment:'Narrow this to preparation and list two options.',plan:{...first.plan,recommendedAction:'Compare two implementation options.',instructions:'Research two options and prepare a comparison. No external actions.',deliverable:'A comparison Report with two options.'},draft:first.draft};
   const revised=(await api.revise(original.proposalId,revision))!;expect(revised.versions[0]).toEqual(first);expect(revised.versions[1].comment).toBe(revision.comment);expect(revised.versions[1].draft.instructions).toBe(revision.plan.instructions);expect(revised.approval).toBe(null);const portable=await proposalUtils.loadFromInput(new Uint8Array(await createZip(await f.authority.read(original.proposalId,'kapelle/review-intent'))));expect(JSON.parse(portable.state.global.taskPlanJson!).versions).toEqual(revised.versions);
   expect(await api.revise(original.proposalId,revision)).toEqual(revised);await expect(api.approveAndSend(original.proposalId,{operationId:randomUUID(),expectedRevision:original.revision,version:1,planHash:first.planHash})).rejects.toThrow('Stale');
   await f.restart();api=new TaskProposals(f.authority);expect(await api.read(original.proposalId)).toEqual(revised);
   const last=revised.versions.at(-1)!,approval={operationId:randomUUID(),expectedRevision:revised.revision,version:last.version,planHash:last.planHash};
   const sent=await api.approveAndSend(original.proposalId,approval);expect(sent.item?.approval).toEqual({proposalId:original.proposalId,version:2,planHash:last.planHash,operationId:approval.operationId});expect(sent.item?.instructionHash).toBe(last.instructionHash);expect(sent.item?.approvedPlan).toEqual(last.plan);expect(sent.item?.effectsAuthorized).toBe(false);
   await f.restart();api=new TaskProposals(f.authority);expect(await api.approveAndSend(original.proposalId,approval)).toEqual(sent);expect(await f.authority.backend.list('kapelle/dispatch')).toHaveLength(1);
   await expect(api.revise(original.proposalId,{...revision,operationId:randomUUID(),expectedRevision:sent.proposal.revision,baseVersion:2,basePlanHash:last.planHash})).rejects.toThrow('Stale');
   const result=await f.complete(req.operationId);expect(result?.result).toBeTruthy();expect((await f.platform.task()).status).toBe('OPEN');
  }finally{await f.close();}
 },120000);
 it('rejects stale Task/capability, unapproved direct send, hidden effect scope and comment-only inferred rewrite',async()=>{
  const f=await taskDelegationFixture();try{
   const api=new TaskProposals(f.authority),req=await request(f),p=(await api.create(req))!,v=p.versions[0];
   await expect(f.tasks.submit(v.draft)).rejects.toThrow('approval required');
   await expect(api.revise(p.proposalId,{operationId:randomUUID(),expectedRevision:p.revision,baseVersion:1,basePlanHash:v.planHash,comment:'Please rethink.',plan:v.plan,draft:v.draft})).rejects.toThrow('explicit revised plan');
   expect(()=>api.revise(p.proposalId,{operationId:randomUUID(),expectedRevision:p.revision,baseVersion:1,basePlanHash:v.planHash,comment:'Publish',plan:{...v.plan,effectLimit:'PUBLISH'},draft:v.draft})).toThrow();
   const t=await f.readTask(req.draft.taskId);await f.platform.act(t.id,'updateTitle',{expectedRevision:t.revision,title:'Changed source'},'owner');
   await expect(api.approveAndSend(p.proposalId,{operationId:randomUUID(),expectedRevision:p.revision,version:1,planHash:v.planHash})).rejects.toThrow('source changed');expect((await api.read(p.proposalId)).approval).toBe(null);
  }finally{await f.close();}
 },120000);
 it('allows explicit edits with empty owner comment and rejects changed recipient capability before approval',async()=>{
 const f=await taskDelegationFixture();try{const api=new TaskProposals(f.authority),req=await request(f),p=(await api.create(req))!,v=p.versions[0];const edit=(await api.revise(p.proposalId,{operationId:randomUUID(),expectedRevision:p.revision,baseVersion:1,basePlanHash:v.planHash,comment:'',plan:{...v.plan,deliverable:'A research memo with citations.'},draft:v.draft}))!;expect(edit.versions[1].comment).toBe('');f.ctx.runtimeBindingContracts={...f.ctx.runtimeBindingContracts,'local-adapter':'unqualified'};await expect(api.approveAndSend(p.proposalId,{operationId:randomUUID(),expectedRevision:edit.revision,version:2,planHash:edit.versions[1].planHash})).rejects.toThrow('recipient unavailable');expect((await api.read(p.proposalId)).approval).toBe(null);}finally{await f.close();}
 },120000);
 it('checks final envelope bounds before locking approval, leaving an oversized plan editable',async()=>{
 const f=await taskDelegationFixture();try{f.setReadOverride(t=>({...t,bodyMarkdown:'x'.repeat(23000)}));const api=new TaskProposals(f.authority),req=await request(f),p=(await api.create({...req,draft:{...req.draft,instructions:'i'.repeat(4000)}}))!,v=p.versions[0];await expect(api.approveAndSend(p.proposalId,{operationId:randomUUID(),expectedRevision:p.revision,version:1,planHash:v.planHash})).rejects.toThrow('too large');const retained=await api.read(p.proposalId);expect(retained.approval).toBe(null);expect(retained.dispatchId).toBe(null);expect(retained.status).toBe('PROPOSED');}finally{await f.close();}
 },120000);
 it('recovers approval committed before acknowledgement loss, without a second approval or Dispatch',async()=>{
  const f=await taskDelegationFixture();try{
   let api=new TaskProposals(f.authority);const req=await request(f),p=(await api.create(req))!,v=p.versions[0],approval={operationId:randomUUID(),expectedRevision:p.revision,version:1,planHash:v.planHash};
   const backend=f.authority.backend,commit=backend.commit.bind(backend);let drop=true;backend.commit=async(...args)=>{const r=await commit(...args);if(drop){drop=false;throw Error('synthetic lost approval acknowledgement');}return r;};
   await expect(api.approveAndSend(p.proposalId,approval)).rejects.toThrow('lost approval acknowledgement');
   await f.restart();api=new TaskProposals(f.authority);const recovered=await api.approveAndSend(p.proposalId,approval);expect(recovered.item?.accepted).toBe(true);expect(recovered.proposal.approval?.operationId).toBe(approval.operationId);expect(await f.authority.backend.list('kapelle/dispatch')).toHaveLength(1);
   await expect(api.approveAndSend(p.proposalId,{...approval,planHash:'sha256:'+'a'.repeat(64)})).rejects.toThrow('payload conflict');
  }finally{await f.close();}
 },120000);
});
