'use client';
// AGENT-MODEL-V2 (1e): shared scope display and the frozen-snapshot view (names, sizes, content-free exclusion counts).
export type Scope={kind:'project';projectId:string}|{kind:'folder';rootId:string;relativeDirectory:string};
export type ScopeRoot={id:string;label:string;projects:string[]};
export type SnapshotView={manifest:{scope:Scope;rootId:string;entries:{relativePath:string;byteSize:number;sha256:string}[];excluded:Record<string,number>;classification:string};
 manifestHash:string;root:{id:string;label:string}};

export const sameScope=(a:Scope,b:Scope)=>a.kind===b.kind&&(a.kind==='project'?a.projectId===(b as typeof a).projectId:a.rootId===(b as typeof a).rootId&&a.relativeDirectory===(b as typeof a).relativeDirectory);
export function scopeText(s:Scope,roots:ScopeRoot[]){
 if(s.kind==='project')return 'Project '+s.projectId;
 const label=roots.find(r=>r.id===s.rootId)?.label??s.rootId;
 return 'Folder '+label+(s.relativeDirectory?' / '+s.relativeDirectory:'');
}
export function ScopeLabel({scope,roots}:{scope:Scope;roots:ScopeRoot[]}){return <span>{scopeText(scope,roots)}</span>;}

const REASONS:Record<string,string>={secret_name:'Credential or key file names',secret_content:'Content that looks like a key or password',hidden:'Hidden files and folders',
 dependency_or_cache:'Dependency, build or cache folders',unsupported_type:'Not plain text (images, binaries, other types)',file_too_large:'Larger than 32 KB',
 not_regular_file:'Links or special files',not_utf8_text:'Not readable text'};
const size=(n:number)=>n<1024?n+' B':(n/1024).toFixed(n<10240?1:0)+' KB';

/** Exactly what the approval binds: the files (relative names + sizes) and what was left out, with reasons. Never contents. */
export function SnapshotFiles({snapshot,heading='Files this Task will use',note='Frozen copy: later edits to these files are not used, and a new copy needs a new approval.'}:{snapshot:SnapshotView;heading?:string;note?:string}){
 const m=snapshot.manifest,ex=Object.entries(m.excluded).filter(([,n])=>n>0),total=m.entries.reduce((a,e)=>a+e.byteSize,0);
 const where=m.scope.kind==='project'?'Project '+m.scope.projectId+' · '+snapshot.root.label:snapshot.root.label+(m.scope.relativeDirectory?' / '+m.scope.relativeDirectory:'');
 return <section aria-label="Frozen files" className="mt-4 border-t border-rule pt-3" data-testid="snapshot-files">
  <h3 className="text-sm font-semibold">{heading}</h3>
  <p className="mt-1 text-xs text-graphite">{where} · {m.entries.length} {m.entries.length===1?'file':'files'} · {size(total)}. {note}</p>
  <ul className="mt-2 divide-y divide-rule border-y border-rule">{m.entries.map(e=><li key={e.relativePath} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
   <span className="break-all font-mono text-xs">{e.relativePath}</span><span className="shrink-0 text-xs text-graphite">{size(e.byteSize)}</span></li>)}</ul>
  {ex.length>0&&<div className="mt-2 text-xs" data-testid="snapshot-excluded"><p className="font-semibold">Left out</p>
   <ul className="mt-1 list-disc pl-5">{ex.map(([k,n])=><li key={k}>{REASONS[k]??k} · {n}</li>)}</ul></div>}
  <p className="mt-2 font-mono text-[11px] text-graphite">Snapshot {snapshot.manifestHash.slice(7,19)}</p>
 </section>;
}

/** The editor's initial choice (first project, else the first root's top folder). */
export const defaultScope=(roots:ScopeRoot[],kinds:('project'|'folder')[]=['project','folder']):Scope|null=>{
 const p=kinds.includes('project')?roots.flatMap(r=>r.projects)[0]:undefined;
 return p?{kind:'project',projectId:p}:roots[0]&&kinds.includes('folder')?{kind:'folder',rootId:roots[0].id,relativeDirectory:''}:null;
};
/** Folder path shape the host accepts (relative, no leading slash, no hidden or '..' segments). */
export const scopeOk=(s:Scope)=>s.kind!=='folder'||s.relativeDirectory===''||/^(?!\/)(?!.*(?:^|\/)\.)(?!.*\/\/)(?!.*\/$)[^\u0000-\u001f]+$/.test(s.relativeDirectory);
/** One project-or-folder choice. Folders are an admitted root plus an optional sub-folder (relative; validated by the host). */
export function ScopeEditor({roots,value,onChange,onAdd,addLabel='Add source',kinds=['project','folder']}:{roots:ScopeRoot[];value:Scope|null;onChange:(s:Scope|null)=>void;onAdd:(s:Scope)=>void;addLabel?:string;kinds?:('project'|'folder')[]}){
 const projects=kinds.includes('project')?[...new Set(roots.flatMap(r=>r.projects))]:[],folders=kinds.includes('folder');
 const s=value??defaultScope(roots,kinds)??{kind:'folder',rootId:roots[0].id,relativeDirectory:''};
 const okFolder=scopeOk(s);
 const cls='mt-1 min-h-11 w-full border border-ink bg-paper px-3 text-base';
 return <div className="mt-3 border border-rule p-3" data-testid="scope-editor">
  <fieldset className="flex flex-wrap gap-4 text-sm"><legend className="sr-only">Source kind</legend>
   {projects.length>0&&<label className="flex min-h-11 items-center gap-2"><input type="radio" name="scope-kind" checked={s.kind==='project'} onChange={()=>onChange({kind:'project',projectId:projects[0]})}/>Project</label>}
   {folders&&<label className="flex min-h-11 items-center gap-2"><input type="radio" name="scope-kind" checked={s.kind==='folder'} onChange={()=>onChange({kind:'folder',rootId:roots[0].id,relativeDirectory:''})}/>Folder</label>}
  </fieldset>
  {s.kind==='project'?<label className="mt-2 block text-sm">Project<select className={cls} value={s.projectId} onChange={e=>onChange({kind:'project',projectId:e.target.value})}>{projects.map(p=><option key={p} value={p}>{p}</option>)}</select></label>
   :<div className="mt-2 grid gap-2 sm:grid-cols-2">
    <label className="block text-sm">Location<select className={cls} value={s.rootId} onChange={e=>onChange({...s,rootId:e.target.value})}>{roots.map(r=><option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
    <label className="block text-sm">Folder inside it <span className="text-graphite">(optional)</span><input className={cls} value={s.relativeDirectory} placeholder="fantasy-basketball" onChange={e=>onChange({...s,relativeDirectory:e.target.value.trim()})}/></label>
   </div>}
  {!okFolder&&<p role="alert" className="mt-1 text-sm">Use a folder name inside the location, like fantasy-basketball/2026. No leading slash, “..” or hidden folders.</p>}
  <button type="button" disabled={!okFolder} onClick={()=>onAdd(s)} className="mt-3 min-h-11 border border-ink px-4 text-sm disabled:opacity-40">{addLabel}</button>
 </div>;
}
