'use client';

import {useState,useEffect,useRef} from 'react';
import {TaskActionBar} from './TaskActionBar';

export type ProposalPlanView = {
  version: number;
  action: string;
  instructions: string;
  deliverable: string;
  effectLimits: string;
  recipientId: string;
  includeNotes: boolean;
  includeComments: boolean;
  includeReferences: boolean;
};
export type ProposalRecipientView = {id:string;name:string;available:boolean;reason:string|null};

/** Presentation only: persistence and exact-version approval belong to the native authority. */
export function DelegationProposalView({approveLabel='Approve and send',editable=true,plan,recipients,context,history,busy,submitted,onRevise,onApprove,onGenerate,revisionPending=false,approvalBlocked=false,recoveryActions,allowRecoveryEdit=false,requestPending=false,requestError,provenanceDescription,sourceDescription,resultDestination}: {
  resultDestination?:string;
  approveLabel?:string;
  /** false = the plan is fixed (pinned pilot): no Edit plan / Add a comment. */
  editable?:boolean;
  provenanceDescription?:string;
  sourceDescription?:string;
  recoveryActions?:React.ReactNode;
  allowRecoveryEdit?:boolean;
  requestPending?:boolean;
  requestError?:string;
  plan:ProposalPlanView;
  recipients:ProposalRecipientView[];
  context:{title:string;notes:string;comments:string[];references:string[]};
  history:React.ReactNode;
  busy:boolean;
  submitted:boolean;
  onRevise:(plan:ProposalPlanView,comment:string)=>Promise<void>;
  onApprove:()=>Promise<void>;
  revisionPending?:boolean;
  approvalBlocked?:boolean;
  onGenerate?:(comment:string)=>Promise<void>;
}) {
  const formRef=useRef<HTMLElement>(null);

  const [editing,setEditing]=useState(false);
  const [commenting,setCommenting]=useState(false);
  useEffect(()=>{if(editing||commenting){const input=formRef.current?.querySelector<HTMLTextAreaElement>('textarea');input?.focus();input?.scrollIntoView({block:'center'});}},[editing,commenting]);
  useEffect(()=>{if(requestPending){setEditing(false);setCommenting(false);}},[requestPending]);
  const [edited,setEdited]=useState(plan);
  const [comment,setComment]=useState('');
  const [error,setError]=useState('');
  const recipient=recipients.find(a=>a.id===plan.recipientId);
  const changed=JSON.stringify(edited)!==JSON.stringify(plan);
  const input='w-full min-h-11 border border-rule bg-paper p-3 text-sm';
  function begin(){setEdited(plan);setComment('');setError('');setEditing(true);}
  async function revise(){
    if(comment.trim()&&!changed){setError(onGenerate?'This form saves explicit edits. Use Add a comment to request a revised recommendation.':'Automatic comment interpretation is unavailable. Explicitly edit the plan, recipient or context to reflect your comment.');return;}
    if(!changed){setError('Edit the plan before saving a new version.');return;}
    try{await onRevise(edited,comment.trim());setEditing(false);setComment('');}catch(e){setError(e instanceof Error?e.message:'The revised proposal was not saved.');}
  }
  async function generate(){
    if(!onGenerate||!comment.trim())return;
    setError('');
    try{await onGenerate(comment.trim());setCommenting(false);setComment('');}
    catch(e){setError(e instanceof Error?e.message:'Revision not confirmed. Your comment is kept.');}
  }
  return <section aria-label="Delegation proposal" className="mt-6 border-t-2 border-ink pt-5">
    <div className="flex flex-wrap items-baseline justify-between gap-3"><h2 className="font-display text-2xl font-semibold">{submitted?'Approved plan':'Proposed work — not started'}</h2><span className="font-mono text-xs">Version {plan.version}</span></div>
    <p className="mt-2 text-xs text-graphite">{provenanceDescription??<>Original suggestion: deterministic preview template from the Task context and qualified roster. {onGenerate?'Comment revisions use a deterministic test producer that copies your comment into the work plan. No LLM interpretation or provider call.':'No AI generation or automatic comment interpretation.'}</>}</p>
    <dl className="mt-6 grid gap-x-8 gap-y-5 sm:grid-cols-[10rem_1fr]">
      <dt className="text-sm font-semibold">Recommended action</dt><dd data-testid="proposal-action" className="whitespace-pre-wrap text-base leading-relaxed">{plan.action}</dd>
      <dt className="text-sm font-semibold">Work plan</dt><dd className="whitespace-pre-wrap text-sm leading-relaxed">{plan.instructions}</dd>
      <dt className="text-sm font-semibold">Agent doing the work</dt><dd>{recipient?.name??plan.recipientId}<p className="mt-1 text-xs text-graphite">{recipient?.available?'Qualified for this Task’s admitted work.':recipient?.reason??'Recipient availability must be checked.'}</p></dd>
      <dt className="text-sm font-semibold">Included context</dt><dd className="text-sm"><p>Task title{plan.includeNotes?', task notes':''}{plan.includeComments?', activity notes':''}{plan.includeReferences?', connected reference identifiers':''}.</p><p className="mt-1 text-xs text-graphite">{sourceDescription??'Linked contents are not fetched.'}</p><details className="mt-2"><summary className="min-h-11 cursor-pointer underline">Inspect included context</summary><div className="max-h-80 overflow-auto whitespace-pre-wrap break-words border border-rule p-3"><strong>{context.title}</strong>{plan.includeNotes&&<p className="mt-3">{context.notes||'No task notes.'}</p>}{plan.includeComments&&<p className="mt-3">{context.comments.join('\n\n')||'No activity notes.'}</p>}{plan.includeReferences&&<p className="mt-3">{context.references.join('\n')||'No connected references.'}</p>}</div></details></dd>
      <dt className="text-sm font-semibold">Expected deliverable</dt><dd data-testid="proposal-deliverable" className="whitespace-pre-wrap text-sm leading-relaxed">{plan.deliverable}</dd>
      {resultDestination&&<><dt className="text-sm font-semibold">Result destination</dt><dd className="text-sm leading-relaxed">{resultDestination}</dd></>}
      <dt className="text-sm font-semibold">Effect limits</dt><dd className="text-sm leading-relaxed">{plan.effectLimits}</dd>
    </dl>
    {!submitted&&<TaskActionBar title={recoveryActions&&!editing&&!commenting?'Revision or send needs confirmation':busy?'Saving your request…':editing?'Editing proposed work':commenting?'Commenting on proposed work':`Proposed work · version ${plan.version} · not started`} detail={editing||commenting?'Saving changes does not approve or start work.':approvalBlocked?'Verify included Task notes and supplied sources before approval.':`${approveLabel} uses exactly version ${plan.version}. No work has started.`} error={requestError||error}>
      {(!editing&&!commenting&&recoveryActions?<>{recoveryActions}{allowRecoveryEdit&&<button disabled={busy} onClick={begin} className="min-h-11 text-sm underline">Edit plan</button>}</>:null)??(editing?<><button disabled={busy||!changed||!edited.action.trim()||!edited.deliverable.trim()} onClick={()=>void revise()} className="min-h-11 bg-ink px-5 text-sm text-paper disabled:opacity-40">Save revised plan</button><button disabled={busy} onClick={()=>setEditing(false)} className="min-h-11 text-sm underline">Cancel edits</button></>:commenting?<><button disabled={busy||!comment.trim()} onClick={()=>void generate()} className="min-h-11 bg-ink px-5 text-sm text-paper disabled:opacity-40">Revise from my comment</button><button disabled={busy} onClick={()=>setCommenting(false)} className="min-h-11 text-sm underline">Cancel comment</button></>:<><button disabled={busy||revisionPending||approvalBlocked||!recipient?.available} onClick={()=>void onApprove()} className="min-h-11 bg-ink px-5 text-sm font-semibold text-paper disabled:opacity-40">{approveLabel}</button>{editable&&<button disabled={busy} onClick={begin} className="min-h-11 text-sm underline">Edit plan</button>}{editable&&onGenerate&&<button disabled={busy||revisionPending} onClick={()=>{setComment('');setError('');setCommenting(true);}} className="min-h-11 text-sm underline">Add a comment</button>}</>)}
    </TaskActionBar>}
    {!submitted&&commenting&&<section ref={formRef} aria-label="Comment on plan" className="mt-6 border-t border-rule pt-5">
      <h3 className="text-lg font-semibold">What should change?</h3><p className="mt-2 text-sm">Your comment requests a new recommendation from saved version {plan.version}. Review the revised plan before approving any work.</p>
      <fieldset disabled={busy} className="mt-4 grid gap-3"><label htmlFor="proposal-generation-comment" className="text-sm font-semibold">Your comment</label><textarea id="proposal-generation-comment" className={input} rows={4} maxLength={4000} value={comment} onChange={e=>setComment(e.target.value)}/>

      </fieldset>
    </section>}
    {!submitted&&editing&&<section ref={formRef} aria-label="Revise proposal" className="mt-6 border-t border-rule pt-5">
      <h3 className="text-lg font-semibold">Revise the plan</h3><p className="mt-2 text-sm">Edit the plan to reflect your comment. Save it, review the new version, then approve.</p>
      <fieldset disabled={busy} className="mt-4 grid gap-3"><label htmlFor="proposal-comment" className="text-sm font-semibold">Your comment</label><textarea id="proposal-comment" className={input} value={comment} maxLength={4000} rows={3} onChange={e=>setComment(e.target.value)}/>
        <label htmlFor="proposal-action-edit" className="text-sm font-semibold">Recommended action</label><textarea id="proposal-action-edit" className={input} value={edited.action} maxLength={2000} rows={4} onChange={e=>setEdited({...edited,action:e.target.value})}/>
        <label htmlFor="proposal-instructions-edit" className="text-sm font-semibold">Work plan</label><textarea id="proposal-instructions-edit" className={input} value={edited.instructions} maxLength={4000} rows={4} onChange={e=>setEdited({...edited,instructions:e.target.value})}/>
        <label htmlFor="proposal-deliverable-edit" className="text-sm font-semibold">Expected deliverable</label><textarea id="proposal-deliverable-edit" className={input} value={edited.deliverable} maxLength={1000} rows={3} onChange={e=>setEdited({...edited,deliverable:e.target.value})}/>
        <label htmlFor="proposal-agent-edit" className="text-sm font-semibold">Agent doing the work</label><select id="proposal-agent-edit" className={input} value={edited.recipientId} onChange={e=>setEdited({...edited,recipientId:e.target.value})}>{recipients.map(a=><option key={a.id} value={a.id} disabled={!a.available}>{a.name}{a.available?'':' — '+a.reason}</option>)}</select>
        {([['includeNotes','Task notes'],['includeComments','Activity notes'],['includeReferences','Connected reference identifiers']] as const).map(([key,label])=><label key={key} className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" checked={edited[key]} onChange={e=>setEdited({...edited,[key]:e.target.checked})}/>{label}</label>)}

      </fieldset>
    </section>}
    <details className="mt-6 border-t border-rule pt-3"><summary className="min-h-11 cursor-pointer text-sm underline">Original suggestion and revision history</summary>{history}</details>
  </section>;
}
