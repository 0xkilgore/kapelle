'use client';
import {useState} from 'react';
import {SnapshotFiles,sameScope,scopeText,type Scope,type ScopeRoot,type SnapshotView} from './ScopePicker';

// AGENT-MODEL-V2 (1e): choose the agent and, for a task-selected agent, ONE of its OWN folders/projects (owner decision, Oct 15:
// an agent reads only its own folders, set at creation; the host refuses anything else). "Show files"
// freezes a read-only snapshot on the host (nothing runs, no grant); "Use these files" makes it this Task's sources. The plan
// that follows binds exactly that snapshot, and approval shows the same file list again.
export type AgentChoice={id:string;name:string;scope:{kinds:('project'|'folder')[];defaults:Scope[]}|null};
export type TaskChoice={agent:string;manifestHash?:string};

async function snapshotFor(instanceId:string,scope:Scope):Promise<SnapshotView>{
 const r=await fetch('/api/ops/agents/kit',{method:'POST',headers:{'content-type':'application/json','x-kapelle-csrf':'agent-kit'},body:JSON.stringify({action:'snapshot',instanceId,scope})});
 const v=await r.json().catch(()=>({}));if(!r.ok||!v.ok)throw Error(typeof v.error==='string'?v.error:'The files could not be read.');return v as SnapshotView;
}
const REFUSALS:[RegExp,string][]=[[/scope_has_no_admissible_files/,'No usable text files were found there (everything was left out or the folder is empty).'],
 [/scope_file_too_large/,'One file there is too large for an agent to read. Move that file out of the folder, or pick a sub-folder without it.'],
 [/scope_line_too_long/,'One file there has a line too long to read (often a data export). Move that file out of the folder, or pick a sub-folder without it.'],
 [/scope_overflow|too_many|too_deep|packet/,'That location has too many or too large files for one Task. Pick a smaller folder.'],
 [/directory_missing/,'That folder does not exist in this location.'],[/not_admitted|outside_workspace|alias|symlink/,'That location is not connected for agents on this Mac.'],
 [/private_scope_needs_local_agent/,'That location is private: only an agent that runs on this Mac can use it.'],[/scope_not_allowed/,'This agent cannot use that kind of source.'],[/not_agents_own/,'This agent can read only its own folders.']];
const plain=(m:string)=>REFUSALS.find(([r])=>r.test(m))?.[1]??m;

/** With no choice and no Task default, a single task-selected agent is preselected. */
export const soleAgent=(agents:AgentChoice[])=>{const v2=agents.filter(a=>a.scope);return v2.length===1?v2[0].id:null;};

export function TaskAgentPicker({agents,defaultAgentId,choice,roots,snapshot,busy,onChoose}:{agents:AgentChoice[];defaultAgentId:string|null;choice:TaskChoice|null;roots:ScopeRoot[];
 snapshot:SnapshotView|null;busy:boolean;onChoose:(c:TaskChoice|null)=>void}){
 const current=choice?.agent??defaultAgentId??soleAgent(agents);
 const [agentId,setAgentId]=useState<string|null>(current);
 const agent=agents.find(a=>a.id===agentId)??null;
 const [scope,setScope]=useState<Scope|null>(snapshot?.manifest.scope??agent?.scope?.defaults[0]??null);
 const [preview,setPreview]=useState<SnapshotView|null>(null),[reading,setReading]=useState(false),[error,setError]=useState('');
 const pickAgent=(id:string)=>{setAgentId(id);setPreview(null);setError('');const a=agents.find(x=>x.id===id);setScope(a?.scope?.defaults[0]??null);
  onChoose(!a?.scope&&id===defaultAgentId?null:{agent:id});};
 async function show(s:Scope){if(!agent)return;setScope(s);setReading(true);setError('');setPreview(null);
  try{setPreview(await snapshotFor(agent.id,s));}catch(e){setError(plain((e as Error).message));}finally{setReading(false);}}
 const using=!!snapshot&&choice?.agent===agentId&&choice?.manifestHash===snapshot.manifestHash;
 return <section aria-label="Agent and files" className="mt-3 border-t border-rule pt-3" data-testid="task-agent-picker">
  <h3 className="text-sm font-semibold">Agent</h3>
  <div className="mt-1 grid gap-1">{agents.map(a=><label key={a.id} className={`flex min-h-11 cursor-pointer items-center gap-3 border px-3 text-sm ${agentId===a.id?'border-ink':'border-rule'}`}>
   <input type="radio" name="task-agent" checked={agentId===a.id} disabled={busy} onChange={()=>pickAgent(a.id)}/>
   <span><span className="font-semibold">{a.name}</span>{a.scope?'':<span className="text-graphite"> · this Task&rsquo;s project agent</span>}</span></label>)}</div>
  {agent?.scope&&<>
   <h3 className="mt-4 text-sm font-semibold">Files for this Task</h3>
   {using&&!preview?<>
    <SnapshotFiles snapshot={snapshot!} heading="Using these files"/>
    <button type="button" disabled={busy} onClick={()=>{setPreview(null);onChoose({agent:agent.id});}} className="mt-2 min-h-11 text-sm underline">Check the files again</button>
   </>:agent.scope.defaults.length===0?<p className="mt-1 text-sm" data-testid="agent-no-folder">This agent has no folder of its own, so it can&rsquo;t read files. Create an agent with its folder.</p>:<>
    <p className="mt-1 text-xs text-graphite">This agent reads only its own {agent.scope.defaults.length===1?'folder':'folders'}. You see the exact files before anything is planned; nothing is read by the agent until you approve.</p>
    {agent.scope.defaults.length>1&&<div className="mt-2 grid gap-1">{agent.scope.defaults.map((d,i)=><label key={i} className={`flex min-h-11 cursor-pointer items-center gap-3 border px-3 text-sm ${scope&&sameScope(scope,d)?'border-ink':'border-rule'}`}>
     <input type="radio" name="task-scope" checked={!!scope&&sameScope(scope,d)} disabled={busy||reading} onChange={()=>{setScope(d);setPreview(null);}}/>{scopeText(d,roots)}</label>)}</div>}
    {agent.scope.defaults.length===1&&<p className="mt-2 text-sm" data-testid="agent-own-folder">{scopeText(agent.scope.defaults[0],roots)}</p>}
    {scope&&<button type="button" disabled={busy||reading} onClick={()=>void show(scope)} className="mt-2 block min-h-11 border border-ink px-4 text-sm disabled:opacity-40">{reading?'Reading files…':'Show files'}</button>}
    {error&&<p role="alert" className="mt-2 text-sm" data-testid="snapshot-error">{error}</p>}
    {preview&&<>
     <SnapshotFiles snapshot={preview}/>
     <button type="button" disabled={busy} onClick={()=>onChoose({agent:agent.id,manifestHash:preview.manifestHash})} className="mt-3 min-h-11 bg-ink px-4 text-sm font-semibold text-paper disabled:opacity-40">Use these files</button>
     <p className="mt-1 text-xs text-graphite">Next you review the plan. Nothing is sent or run until you approve it.</p>
    </>}
   </>}
  </>}
 </section>;
}
