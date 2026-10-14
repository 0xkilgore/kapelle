'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {validateProposal,type TaskProposal} from '../_lib/taskProposalContract';
import {readableTaskNotes,readyTaskHost,taskHostContextSchema,type TaskHostContext,type TaskHostReadReason} from '../_lib/taskHostContract';
import {delegationOperationId,pipelineRecommendation} from '../_lib/taskDelegationIdentity';
import {deriveDelegationView,type DelegationView} from '../_lib/delegationState';
import {applyStatus,approveAndStart,continueApproved,createStatusPoller,delegationFacts,mergeDiscovery,normalizeDiscovery,selectAssignment,settles,
 type Api,type AssignmentItem,type Discovery,type PendingRequest,type PendingStore,type Verification} from '../_lib/delegationClient';
import {DelegationProposalView,type ProposalPlanView} from './DelegationProposalView';
import {TaskSuppliedSources} from './TaskSuppliedSources';
import {validateTaskHostSources,type TaskHostSources} from '../_lib/taskSourcePacket';
import {TaskActionBar} from './TaskActionBar';
import {READ_REASONS,workReason} from '../_lib/delegationText';

const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))).map(n=>n.toString(16).padStart(2,'0')).join('');
const EFFECT_LIMITS='Prepare the approved work and return a linked Report. External actions and Task completion remain separate decisions.';
const RESULT_DESTINATION='A verified Report linked back to this Task. Any retained work artifact must be identified in the result; creating a Report does not publish a website or complete the Task.';

const reportHref=(taskId:string,reportId:string,operationId:string|null)=>'/ops/library/'+reportId+'?taskId='+encodeURIComponent(taskId)+(operationId?'&taskOperationId='+operationId:'');
const chicago=(iso:string)=>new Date(iso).toLocaleString('en-US',{timeZone:'America/Chicago'});
function historyLabel(i:AssignmentItem){
 const w=i.execution?.worker;
 if(!i.proposal)return 'Details unavailable';
 if(!i.proposal.dispatchId)return 'Saved plan · not approved';
 return w?.status==='REPORT_PUBLISHED'?'Report recorded':w?.status==='EXECUTION_RUNNING'?'Agent working':w?.status==='REPORT_PENDING'?'Output retained · Report not confirmed':w?'Work not completed':'Approved · execution not confirmed';
}

export type DelegationPanelProps={
 taskId:string;view:DelegationView;selected:AssignmentItem|null;earlier:AssignmentItem[];verification:Verification|null;
 agentName:(id:string)=>string;busy:boolean;error:string;stale:boolean;expired:boolean;discoveryReason:TaskHostReadReason|null;canLoadOlder:boolean;
 draft:{instructions:string;summary:string;recipientName:string;includeComments:boolean;includeReferences:boolean}|null;sources:TaskHostSources|null;
 context:TaskHostContext|null;
 /** "Revise or run again" (owner decision Oct 14): a next deterministic slot exists, and the draft is open for it. */
 canStartNew?:boolean;drafting?:boolean;runAgainNote?:string;
 on:{runAgain?:()=>void;cancelRunAgain?:()=>void;check:()=>void;loadOlder:()=>void;save:(d:{instructions:string;includeComments:boolean;includeReferences:boolean})=>void;approveAndStart:()=>Promise<void>;continueApproved:()=>void;revise:(p:ProposalPlanView,comment:string)=>Promise<void>};
};

/** Presentation of one derived state. Every control here is either a read or the single mutation the state permits. */
export function DelegationPanel(p:DelegationPanelProps){
 const {view,selected:s,taskId}=p,v=s?.proposal?.versions.at(-1)??null,w=s?.execution?.worker??null;
 const [instructions,setInstructions]=useState(p.draft?.instructions??'');
 const [includeComments,setComments]=useState(p.draft?.includeComments??true),[includeReferences,setReferences]=useState(p.draft?.includeReferences??true);
 const result=w?.status==='REPORT_PUBLISHED'&&w.result?w.result:null;
 const source=v?JSON.parse(v.source.content):p.context?.roster.task;
 const showPlan=(view.state==='approve-and-start'||view.state==='saved-plan')&&!!s?.proposal&&!!v;
 const statusDetail=view.state==='checking'?(view.title==='Saved assignments could not be read'?'Nothing was changed. Use Check status to try again.':'Checking this Task’s saved assignments and the agent…'):
  view.state==='request-unconfirmed'?'Your last request was sent, but its effect is not confirmed. Nothing is sent again automatically; status checks only read.':
  view.state==='approval-saved'?(s&&!s.proposal?'This assignment was found in the Task history, but its plan could not be read. ':'')+'Approval is saved. Execution is not confirmed; a missing answer is not proof that work did not start.'+(s?.executionError?' '+READ_REASONS[s.executionError]:''):
  view.state==='approved-not-started'?'Approval is saved and the connected worker has no record of starting it. You can continue this same assignment once.':
  view.state==='agent-working'?'The agent is working on the approved assignment. This status refreshes on its own; nothing is started again.':
  view.state==='work-not-completed'?workReason(w?.reason??null)||'This assignment’s one run did not complete. It is not started again from here.':
  view.state==='report-pending'?workReason(w?.reason??null)||'The output is retained. The Report is not confirmed yet.':
  view.state==='report-ready'?'The Report was independently read back and matches this assignment'+(p.verification?.verifiedAt?' ('+chicago(p.verification.verifiedAt)+')':'')+'.':
  view.state==='saved-result-unverified'?'A Report was recorded for this assignment. The current check could not verify it'+(p.verification?.verifiedAt?'; last verified '+chicago(p.verification.verifiedAt):'')+'.':
  view.state==='saved-result-changed'?'A Report was recorded for this assignment, but the Report now differs from the saved result. It is not shown as this Task’s result.':'';
 const primary=view.primary==='open-report'&&result?<Link prefetch={false} href={reportHref(taskId,result.reportId,s?.operationId??null)} className="inline-flex min-h-11 items-center bg-ink px-4 text-sm font-semibold text-paper">Open linked Report</Link>
  :view.primary==='continue-approved'?<button disabled={p.busy||!view.mutations.continueApproved} onClick={p.on.continueApproved} className="min-h-11 bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-40">Continue approved assignment</button>:null;
 return <>
  {(p.stale||p.expired||view.stale)&&<p role="status" className="mt-3 text-sm" data-testid="delegation-stale">{p.expired?'Automatic checking stopped. Use Check status to read the latest state.':'Showing the last confirmed state. '+(p.discoveryReason?READ_REASONS[p.discoveryReason]:p.stale?'The latest check did not complete.':'The current check could not verify it.')}</p>}
  {!view.newWork.available&&view.newWork.message&&view.state!=='checking'&&<p className="mt-3 text-sm" data-testid="delegation-new-work">{view.newWork.message}</p>}
  {view.state==='new-work-unavailable'&&view.newWork.reason==='host_not_admitted'&&<Link href="/ops/agents" className="inline-flex min-h-11 items-center text-sm underline">View agent capabilities and access →</Link>}
  {(view.state==='no-plan'||p.drafting&&view.mutations.create)&&p.draft&&<section aria-label="New plan" className="mt-4 border-t border-rule pt-4">
   <h3 className="text-lg font-semibold">{p.drafting?'New plan · builds on the previous Report':'Instructions for '+p.draft.recipientName}</h3>
   {p.drafting&&<p className="mt-2 text-sm" data-testid="run-again-note">{p.runAgainNote??'The previous Report is quoted in the work plan below. Edit it freely; nothing starts until you approve the saved plan.'} The previous assignment and its Report stay unchanged.</p>}
   <p className="mt-2 text-sm">{p.draft.summary}</p>
   <label htmlFor="delegation-instructions" className="mt-3 block text-sm font-semibold">Work plan</label>
   <textarea id="delegation-instructions" disabled={p.busy} className="mt-1 w-full min-h-11 border border-rule bg-paper p-3 text-sm" rows={8} maxLength={4000} value={instructions} onChange={e=>setInstructions(e.target.value)}/>
   <p className="mt-2 text-sm">Included context: Task title and notes (required){includeComments?', activity notes':''}{includeReferences?', connected reference identifiers':''}.</p>
   <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={p.busy} checked={includeComments} onChange={e=>setComments(e.target.checked)}/>Activity notes</label>
   <label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={p.busy} checked={includeReferences} onChange={e=>setReferences(e.target.checked)}/>Connected reference identifiers</label>
   <p className="mt-2 text-xs text-graphite">The recommended action and expected deliverable are set by the task host when the plan is saved. You review the complete saved plan before anything starts. Effect limits: {EFFECT_LIMITS}</p>
   <button disabled={p.busy||!view.mutations.create||!instructions.trim()} onClick={()=>p.on.save({instructions:instructions.trim(),includeComments,includeReferences})} className="mt-3 min-h-11 bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-40">Save plan for review</button>
   {p.drafting&&<button disabled={p.busy} onClick={p.on.cancelRunAgain} className="ml-4 mt-3 min-h-11 text-sm underline">Back to the result</button>}
  </section>}
  {p.sources&&(view.state==='no-plan'||p.drafting&&view.mutations.create||showPlan&&v!.draft.includeNotes)&&<TaskSuppliedSources packet={p.sources.packet}/>}
  {showPlan&&<DelegationProposalView key={s!.proposal!.proposalId+':'+v!.version} approveLabel="Approve and start" editable={view.editable}
   plan={{version:v!.version,action:v!.plan.recommendedAction,instructions:v!.plan.instructions,deliverable:v!.plan.deliverable,effectLimits:EFFECT_LIMITS,recipientId:v!.draft.agentId,includeNotes:v!.draft.includeNotes,includeComments:v!.draft.includeComments,includeReferences:v!.draft.includeReferences}}
   recipients={(p.context?.roster.agents??[]).map(a=>({id:a.id,name:a.name,available:view.mutations.approveAndStart&&a.id===p.context?.admission.instanceId,reason:view.newWork.message??a.reason}))}
   context={{title:source?.title??'',notes:readableTaskNotes(source?.notes??''),comments:source?.comments??[],references:source?.references??[]}}
   resultDestination={RESULT_DESTINATION} sourceDescription={p.sources&&v!.draft.includeNotes?'The supplied source contents above are included with the work. Other linked contents are not fetched.':'The saved plan’s supplied source contents are not currently verified. Other linked contents are not fetched.'}
   provenanceDescription="Original suggestion: capability-based recommendation from the Task's saved context. No AI generation. Approve and start sends exactly this saved version and starts it once."
   history={<ol>{s!.proposal!.versions.map(x=><li key={x.version} className="border-t border-rule py-3 text-sm"><h3 className="font-semibold">Version {x.version}{x.version===1?' · Original suggestion':''}</h3><p className="mt-2 whitespace-pre-wrap">{x.plan.recommendedAction}</p><p className="mt-2 whitespace-pre-wrap">{x.plan.instructions}</p>{x.comment&&<p className="mt-2 whitespace-pre-wrap">Your comment: {x.comment}</p>}</li>)}</ol>}
   busy={p.busy} submitted={false} approvalBlocked={!view.mutations.approveAndStart||!v!.draft.includeNotes} requestError={p.error} onRevise={p.on.revise} onApprove={p.on.approveAndStart}/>}
  {!showPlan&&view.state!=='no-plan'&&view.state!=='new-work-unavailable'&&<>
   {v&&s?.proposal?.dispatchId&&<section className="mt-6 border-t-2 border-ink pt-5" aria-label="Accepted instructions">
    <div className="flex flex-wrap items-baseline justify-between gap-3"><h2 className="font-display text-2xl font-semibold">Accepted instructions</h2><span className="font-mono text-xs">Version {v.version} · approved</span></div>
    <p className="mt-2 text-xs text-graphite">Exactly this version was approved{s.proposal.approval?' on '+chicago(s.proposal.approval.occurredAt):''}.{s.external?' Found in this Task’s assignment history.':''}</p>
    {view.state!=='checking'&&deriveTaskChanged(p)&&<p role="status" className="mt-2 text-sm" data-testid="task-assignment-stale">The Task changed after these instructions were approved. They are kept as saved and are not the current Task.</p>}
    <dl className="mt-4 grid gap-x-8 gap-y-4 sm:grid-cols-[10rem_1fr]">
     <dt className="text-sm font-semibold">Recommended action</dt><dd className="whitespace-pre-wrap text-sm leading-relaxed">{v.plan.recommendedAction}</dd>
     <dt className="text-sm font-semibold">Work plan</dt><dd className="whitespace-pre-wrap text-sm leading-relaxed">{v.plan.instructions}</dd>
     <dt className="text-sm font-semibold">Expected deliverable</dt><dd className="whitespace-pre-wrap text-sm leading-relaxed">{v.plan.deliverable}</dd>
     <dt className="text-sm font-semibold">Agent doing the work</dt><dd className="text-sm">{p.agentName(v.draft.agentId)}</dd>
     <dt className="text-sm font-semibold">Effect limits</dt><dd className="text-sm leading-relaxed">{EFFECT_LIMITS}</dd>
    </dl>
   </section>}
   <section className="mt-6 border-t border-rule pt-4" aria-label="Execution status">
    <h2 className="text-lg font-semibold">Execution status</h2>
    <p role="status" className="mt-2 text-sm font-semibold" data-testid="task-execution-status">{view.title}</p>
    <p className="mt-1 text-sm">{statusDetail} The Task stays open until you complete it.</p>
    {(result&&view.state!=='saved-result-changed')&&<Link prefetch={false} href={reportHref(taskId,result.reportId,s?.operationId??null)} className="mt-3 inline-flex min-h-11 items-center text-sm underline" data-testid="task-result-link">{view.state==='report-ready'?'Open linked Report':'Open the saved Report (verification unavailable)'}</Link>}
    {view.state==='report-ready'&&!p.drafting&&<div className="mt-3">
     <button disabled={p.busy||!view.mutations.create||!p.canStartNew} onClick={p.on.runAgain} className="min-h-11 border border-ink px-4 text-sm disabled:opacity-40">Revise or run again</button>
     {(!view.mutations.create||!p.canStartNew)&&<p className="mt-1 text-xs text-graphite" data-testid="run-again-blocked">{view.newWork.message??'This Task has no free assignment slot left.'}</p>}
     {view.mutations.create&&p.canStartNew&&<p className="mt-1 text-xs text-graphite">Starts a NEW plan with this Report as context. This assignment is never run again.</p>}
    </div>}
    {s?.round!=null&&s.proposal&&<Link prefetch={false} href={'/ops/connect-chat?taskId='+encodeURIComponent(taskId)} className="mt-2 inline-flex min-h-11 items-center text-sm underline">Watch this assignment from a chat client →</Link>}
    {s&&<details className="mt-3 text-sm"><summary className="min-h-11 cursor-pointer underline">Technical details</summary><dl className="grid gap-2 break-all">
     <dt className="font-semibold">Assignment</dt><dd>{s.dispatchId??'Not created'}</dd>
     <dt className="font-semibold">Operation</dt><dd>{s.operationId??'Not linked'}</dd>
     {v&&<><dt className="font-semibold">Plan</dt><dd>{s.proposal!.proposalId} · version {v.version} · {v.planHash}</dd></>}
     <dt className="font-semibold">Assignment state</dt><dd>{s.execution?.item.status??s.phase??'Not confirmed'}</dd>
     {w&&<><dt className="font-semibold">Worker state</dt><dd>{w.status}{w.reason?' · '+w.reason:''}</dd></>}
    </dl></details>}
   </section>
  </>}
  {p.earlier.length>0&&<section aria-label="Earlier assignments" className="mt-6 border-t border-rule pt-4" data-testid="delegation-history">
   <h2 className="text-lg font-semibold">Earlier assignments · {p.earlier.length}</h2>
   <ol>{p.earlier.map(i=>{const x=i.proposal?.versions.at(-1),r=i.execution?.worker?.status==='REPORT_PUBLISHED'?i.execution.worker.result:null;
    return <li key={i.key} className="border-t border-rule py-3 text-sm">
     <p className="font-semibold">{i.round?'Assignment '+i.round:'Assignment from Task history'}{x?' · version '+x.version:''} · {historyLabel(i)}</p>
     {x&&<p className="mt-1 line-clamp-2 whitespace-pre-wrap">{x.plan.recommendedAction}</p>}
     {r?<Link prefetch={false} href={reportHref(taskId,r.reportId,i.operationId)} className="mt-1 inline-flex min-h-11 items-center underline">Open its Report</Link>:null}
    </li>;})}</ol>
  </section>}
  {p.canLoadOlder&&<button disabled={p.busy} onClick={p.on.loadOlder} className="mt-3 min-h-11 text-sm underline">Load older assignments</button>}
  {!showPlan&&<TaskActionBar title={view.title} error={p.error} detail={view.mutations.continueApproved?'Continues this same approved assignment once.':'Status checks only read the saved assignment.'}>
   {primary}
   <button disabled={p.busy} onClick={p.on.check} className="min-h-11 text-sm underline">Check status</button>
  </TaskActionBar>}
 </>;
}
function deriveTaskChanged(p:DelegationPanelProps){
 const v=p.selected?.proposal?.versions.at(-1),t=p.context?.roster.task;
 return !!v&&!!t&&(v.draft.revision!==t.revision||v.draft.sourceHash!==t.sourceHash);
}

type Model={discovery:Discovery|null;discoveryFailed:boolean;context:TaskHostContext|null;contextFailed:boolean;sources:TaskHostSources|null;
 verification:Record<string,Verification>;pending:PendingRequest|null;stale:boolean;expired:boolean;error:string;busy:boolean};
const INITIAL:Model={discovery:null,discoveryFailed:false,context:null,contextFailed:false,sources:null,verification:{},pending:null,stale:false,expired:false,error:'',busy:false};

function deriveAll(m:Model){
 const selected=m.discovery?selectAssignment(m.discovery.items,m.pending):null;
 const verification=selected?.operationId?m.verification[selected.operationId]??null:null;
 const view=deriveDelegationView(delegationFacts({discovery:m.discovery,discoveryFailed:m.discoveryFailed,context:m.context,contextFailed:m.contextFailed,sourcesReady:!!m.sources,selected,pending:m.pending,verification}));
 return {selected,verification,view};
}

export function TaskHostDelegation({taskId}:{taskId:string}){
 const [open,setOpen]=useState(false),[model,setModel]=useState<Model>(INITIAL);
 const [runAgain,setRunAgain]=useState<{instructions:string;note:string}|null>(null);
 // Async reads use the ref mirror; render uses the state snapshot.
 const m=useRef<Model>(INITIAL),mutating=useRef(false),fullRead=useRef(true);
 const update=(patch:Partial<Model>)=>{m.current={...m.current,...patch};setModel(m.current);};
 const storageKey='kapelle:task-host:v2:'+taskId;
 const store:PendingStore={
  read:()=>{try{const v=JSON.parse(localStorage.getItem(storageKey)??'null');return v&&typeof v.operationId==='string'&&['create','approval','start'].includes(v.kind)?v as PendingRequest:null;}catch{return null;}},
  write:p=>{if(p)localStorage.setItem(storageKey,JSON.stringify(p));else localStorage.removeItem(storageKey);update({pending:p});},
  // Stable per exact plan version, so a repeated tap or a reload repeats the SAME approval, never a second one.
  approvalId:(proposalId,version)=>{const k=storageKey+':approval:'+proposalId+':'+version;const v=localStorage.getItem(k)??crypto.randomUUID();localStorage.setItem(k,v);return v;},
 };
 const api:Api={
  get:query=>call(query),
  post:body=>call('',body),
 };
 async function call(query:string,body?:unknown){
  const r=await fetch('/api/ops/tasks/host-delegation?taskId='+encodeURIComponent(taskId)+query,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json','x-kapelle-csrf':'task-host'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
  const v=await r.json().catch(()=>({}));
  if(!r.ok||!v.ok)throw Object.assign(Error(typeof v.error==='string'?v.error:'The saved work could not be confirmed.'),{status:r.status});
  return v;
 }
 /** One read pass: discovery (or status only for an approved selected assignment) plus current availability. GET only. */
 async function read(full:boolean):Promise<number|null>{
  let discovery=m.current.discovery,failed=false;
  const sel=discovery?selectAssignment(discovery.items,m.current.pending):null;
  const statusOnly=!full&&!!discovery&&!!sel?.operationId&&!!sel.dispatchId&&!!sel.proposal;
  const contextRead=full?api.get('').then(async raw=>{const c=taskHostContextSchema.parse(raw);
   const sources=readyTaskHost(c)?await validateTaskHostSources(await api.get('&sources=1'),c,hash).catch(()=>null):null;return {c,sources};}).then(x=>x,()=>null):null;
  if(!statusOnly){
   try{discovery=await normalizeDiscovery(await api.get('&delegations=2'),taskId,hash);
    const link=new URL(location.href).searchParams.get('delegation');
    if(link&&/^[0-9a-f-]{36}$/.test(link)&&!discovery.items.some(i=>i.operationId===link))discovery=await withDeepLink(discovery,link).catch(()=>discovery!);
   }catch(e){failed=true;if((e as {status?:number}).status===403){discovery=null;update({error:'Access to this Task’s assignments was denied.',verification:{}});}
    // No history at all yet: say why (fixed server labels only), instead of a silent "checking".
    else if(!discovery)update({error:e instanceof Error?e.message:'Saved assignments could not be read.'});}
  }
  const verification={...m.current.verification};
  const target=discovery?selectAssignment(discovery.items,m.current.pending):null;
  if(discovery&&target?.operationId&&target.proposal?.dispatchId&&!(failed&&!statusOnly)){
   try{const r=applyStatus(discovery,target.operationId,await api.get('&operationId='+target.operationId+'&status=2'),taskId);discovery=r.discovery;
    const rb=r.status.readback,prior=verification[target.operationId];
    if(rb.state!=='not_applicable')verification[target.operationId]=rb.state==='verified'?{readback:'verified',verifiedAt:rb.checkedAt}:{readback:rb.state,verifiedAt:rb.state==='changed'?null:prior?.verifiedAt??null};
   }catch{failed=true;if(verification[target.operationId]?.readback==='verified')verification[target.operationId]={...verification[target.operationId],readback:'unavailable'};}
  }
  const ctx=contextRead?await contextRead:undefined;
  const pending=m.current.pending&&discovery&&settles(m.current.pending,discovery,failed)?null:m.current.pending;
  if(pending===null&&m.current.pending)localStorage.removeItem(storageKey);
  update({discovery,discoveryFailed:!discovery&&failed,verification,pending,stale:failed&&!!discovery,
   ...(ctx!==undefined?{context:ctx?.c??null,contextFailed:ctx===null,sources:ctx?.sources??null}:{})});
  return deriveAll(m.current).view.pollMs;
 }
 async function withDeepLink(d:Discovery,operationId:string):Promise<Discovery>{
  // A random unapproved plan has no Dispatch: only its own Task-bound operation read finds it (?delegation=<operationId>).
  const proposal=await validateProposal((await api.get('&proposalOperationId='+operationId) as {item:unknown}).item,hash);
  if(proposal.versions.some(v=>v.draft.taskId!==taskId||v.draft.operationId!==operationId)||proposal.dispatchId)return d;
  return {...d,items:[...d.items,{key:operationId,round:null,operationId,dispatchId:null,external:false,blocking:false,phase:null,proposal,execution:null,executionError:null}]};
 }
 const poller=useRef<ReturnType<typeof createStatusPoller>|null>(null);
 // ONE status controller for the collapsed summary and the expanded panel: started with the Task page, finite, reads only.
 useEffect(()=>{
  update({...INITIAL,pending:store.read()});
  fullRead.current=true;
  // Owner actions read everything; automatic ticks read only the selected assignment's status when it has one.
  const p=createStatusPoller({read:()=>{const full=fullRead.current;fullRead.current=false;return read(full);},timer:{set:(fn,ms)=>setTimeout(fn,ms),clear:h=>clearTimeout(h as ReturnType<typeof setTimeout>)},now:Date.now,hidden:()=>document.hidden,onExpired:expired=>update({expired})});
  poller.current=p;void p.check();
  const vis=()=>p.visibility();document.addEventListener('visibilitychange',vis);
  return ()=>{p.stop();poller.current=null;document.removeEventListener('visibilitychange',vis);};
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[taskId]);
 const {selected,verification,view}=deriveAll(model);
 useEffect(()=>{poller.current?.follow(view.pollMs);},[view.pollMs]);

 /** One busy phase per owner action. Afterwards one fresh read; nothing is retried. */
 async function mutate(work:()=>Promise<string|null>){
  if(mutating.current)return;mutating.current=true;update({busy:true,error:''});
  try{const message=await work();update({error:message??''});}
  catch(e){update({error:e instanceof Error?e.message:'Request not confirmed. Check status.'});}
  finally{mutating.current=false;update({busy:false});await refresh();}
 }
 /** One full read now (an in-flight automatic read is never overlapped; a full read follows it). */
 async function refresh(){fullRead.current=true;await poller.current?.check();if(fullRead.current)await poller.current?.check();}
 const outcomeText=(o:{outcome:string;message:string|null})=>o.outcome==='unconfirmed'?'Request not confirmed. Nothing is sent again automatically; check status.':o.outcome==='refused'?o.message??'The request was refused. Nothing was started.':null;
 const ctx=model.context,admitted=ctx?.roster.agents.find(a=>a.id===ctx.admission.instanceId)??null;
 const recommendation=ctx&&admitted?pipelineRecommendation({task:{title:ctx.roster.task.title,projectId:ctx.roster.task.projectId,notes:readableTaskNotes(ctx.roster.task.notes),comments:ctx.roster.task.comments,references:ctx.roster.task.references},recipientName:admitted.name}):null;
 const earlier=(model.discovery?.items??[]).filter(i=>i!==selected);

 const on:DelegationPanelProps['on']={
  // "Revise or run again": quote the VERIFIED prior Report (bounded excerpt) into an editable draft for the next slot.
  runAgain:()=>void (async()=>{
   const prior=selected,base=recommendation?.instructions??'';
   if(!prior?.operationId||!view.mutations.create)return;
   const cap=(t:string)=>t.length>4000?t.slice(0,3990)+'\n[…]':t;
   try{
    const r=await api.get('&priorResult='+prior.operationId) as {reportId:string;excerpt:string;truncated:boolean};
    setRunAgain({instructions:cap(base+'\n\nBuild on the previous result (Report '+r.reportId+'). Excerpt:\n'+r.excerpt+(r.truncated?'\n[excerpt shortened; the full Report is in Kapelle]':'')),
     note:'The verified previous Report is quoted (shortened if long) in the work plan below. Edit it freely; nothing starts until you approve the saved plan.'});
   }catch{
    const reportId=prior.execution?.worker?.result?.reportId;
    setRunAgain({instructions:cap(base+(reportId?'\n\nBuild on the previous result (Report '+reportId+').':'')),note:'The previous Report could not be read right now, so only its reference is included. You can paste what matters into the work plan.'});
   }
  })(),
  cancelRunAgain:()=>setRunAgain(null),
  check:()=>{update({error:''});void refresh();},
  loadOlder:()=>void mutateRead(),
  save:d=>void mutate(async()=>{
   const c=m.current.context,next=m.current.discovery?.next;
   if(!c||!readyTaskHost(c)||!next||!view.mutations.create)return 'New work is not available right now.';
   const agent=c.roster.agents.find(a=>a.id===c.admission.instanceId)!,task=c.roster.task;
   if(await delegationOperationId(taskId,agent.id,next.round,hash)!==next.operationId)return 'Assignment identity differs from the host.';
   store.write({kind:'create',operationId:next.operationId});
   try{await api.post({action:'createProposal',payload:{operationId:next.operationId,draft:{operationId:next.operationId,taskId,revision:task.revision,sourceHash:task.sourceHash,agentId:agent.id,recipient:agent.recipient,instructions:d.instructions,includeNotes:true,includeComments:d.includeComments,includeReferences:d.includeReferences}}});}
   catch(e){const s=(e as {status?:number}).status;if(s!==undefined&&s>=400&&s<500){store.write(null);return e instanceof Error?e.message:'The plan was not saved.';}return 'Saving the plan was not confirmed. Check status before trying again.';}
   store.write(null);setRunAgain(null);return null;
  }),
  approveAndStart:()=>mutate(async()=>{const p=selected?.proposal;if(!p||!view.mutations.approveAndStart)return null;return outcomeText(await approveAndStart(api,store,p));}),
  continueApproved:()=>void mutate(async()=>{if(!selected?.operationId||!selected.dispatchId||!view.mutations.continueApproved)return null;return outcomeText(await continueApproved(api,store,selected.operationId,selected.dispatchId));}),
  revise:async(edited,comment)=>{
   const p=selected?.proposal,c=m.current.context;if(!p||!c)throw Error('Check status first.');
   if(!readyTaskHost(c)||edited.recipientId!==c.admission.instanceId)throw Error('This recipient is not admitted for the task.');
   const agent=c.roster.agents.find(a=>a.id===edited.recipientId)!,v=p.versions.at(-1)!;
   if(mutating.current)throw Error('Another request is in progress.');mutating.current=true;update({busy:true,error:''});
   try{await api.post({action:'reviseProposal',proposalId:p.proposalId,payload:{operationId:crypto.randomUUID(),expectedRevision:p.revision,baseVersion:v.version,basePlanHash:v.planHash,comment,plan:{recommendedAction:edited.action,instructions:edited.instructions,deliverable:edited.deliverable,effectLimit:'PREPARE_ONLY'},draft:{...v.draft,revision:c.roster.task.revision,sourceHash:c.roster.task.sourceHash,agentId:agent.id,recipient:agent.recipient,instructions:edited.instructions,includeNotes:edited.includeNotes,includeComments:edited.includeComments,includeReferences:edited.includeReferences}}});}
   finally{mutating.current=false;update({busy:false});void refresh();}
  },
 };
 async function mutateRead(){
  const d=m.current.discovery;if(!d?.nextCursor||mutating.current)return;mutating.current=true;update({busy:true});
  try{update({discovery:mergeDiscovery(d,await normalizeDiscovery(await api.get('&delegations=2&cursor='+encodeURIComponent(d.nextCursor)),taskId,hash))});}
  catch{update({stale:true});}finally{mutating.current=false;update({busy:false});}
 }

 return <section aria-label="Delegate task to agent" className="mt-5 border-y border-rule py-3" style={open?{paddingBottom:'var(--task-action-clearance, 0px)'}:undefined}>
  <button type="button" aria-expanded={open} onClick={()=>setOpen(!open)} className="min-h-11 text-sm font-semibold underline">Delegate to agent</button>
  {!open&&selected&&<p role="status" className="text-sm" data-testid="delegation-summary">{view.title}{model.stale||view.stale?' · last confirmed state':''}</p>}
  {open&&<>
   <p className="mt-2 text-sm">Send this Task&apos;s saved context to a qualified agent. You see the complete plan first and approve the exact version that starts. The Task keeps its identity and stays open.</p>
   <DelegationPanel key={(selected?.key??'none')+(recommendation?':draft':'')+(runAgain?':again':'')} taskId={taskId} view={view} selected={selected} earlier={earlier} verification={verification}
    agentName={id=>ctx?.roster.agents.find(a=>a.id===id)?.name??'Agent '+id.slice(0,8)} busy={model.busy} error={model.error} stale={model.stale} expired={model.expired}
    discoveryReason={model.discovery?.reason??null} canLoadOlder={!!model.discovery?.nextCursor}
    canStartNew={!!model.discovery?.next} drafting={!!runAgain} runAgainNote={runAgain?.note}
    draft={recommendation&&admitted?{instructions:runAgain?.instructions??recommendation.instructions,summary:recommendation.summary,recipientName:admitted.name,includeComments:true,includeReferences:true}:null}
    sources={model.sources} context={ctx} on={on}/>
  </>}
 </section>;
}
