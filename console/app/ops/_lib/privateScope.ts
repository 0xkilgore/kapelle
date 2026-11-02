// Finances admission (items 2–3): ONE rule for what is private on general console surfaces. A Task is private when its project
// is a private project: 'finances' always (fails closed), plus KAPELLE_PRIVATE_PROJECTS (comma-separated project ids, the same
// list the Framework kit host uses). Private Tasks are dropped at the source read of every general surface (Today, library,
// completed history, digests, email, search/index, exports) before any title, snippet, count or link is built. The owner still
// opens a private Task directly; scoped chat-client tokens get a not-found shape for it.
const ID=/^[a-z0-9][a-z0-9-]{1,62}$/;
/** The Framework kit host's list, as last read (Fable N-1). Only ever ADDS to the private set, so a stale or missing read can
 *  never make anything less private. */
const hostPrivate=new Set<string>();
export function rememberHostPrivateProjects(list:readonly string[]){for(const p of list)if(ID.test(p))hostPrivate.add(p);}
export function privateProjects():string[]{
 const extra=(process.env.KAPELLE_PRIVATE_PROJECTS??'').split(',').map(s=>s.trim()).filter(s=>ID.test(s));
 return [...new Set(['finances',...extra,...hostPrivate])];
}
export function isPrivateProject(projectId:string|null|undefined){return !!projectId&&privateProjects().includes(projectId);}
/** Keep only rows outside private projects; also report how many were dropped (never shown to the owner as a number). */
export function withoutPrivate<T extends {projectId:string|null}>(rows:readonly T[]):{rows:T[];dropped:number}{
 const kept=rows.filter(r=>!isPrivateProject(r.projectId));
 return {rows:kept,dropped:rows.length-kept.length};
}
