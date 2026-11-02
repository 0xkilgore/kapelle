import {it,expect,vi} from 'vitest';
const db=vi.hoisted(()=>({calls:[] as any[],binding:'bound',schema:true,closed:0}));
vi.mock('node:sqlite',()=>({DatabaseSync:class {
 constructor(path:string,options:any){db.calls.push(['open',path,options]);}
 exec(sql:string){db.calls.push(['exec',sql]);}
 prepare(sql:string){db.calls.push(['prepare',sql]);return {all:()=>sql.startsWith('PRAGMA')?(db.schema?(sql.includes('binding')?[{name:'value',type:'TEXT',pk:1}]:[{name:'id',type:'TEXT',pk:1},{name:'body',type:'TEXT',pk:0}]):[]):[{value:db.binding}],run:()=>{throw Error('write');}};}
 close(){db.closed++;}
}}));
import {CommandJournal} from '../src/service/journal.js';
import {FrameworkAuthority} from '../src/service/authority.js';
import {frameworkHandler} from '../src/service/http.js';
import {workerHandler} from '../src/worker/http.js';
function journal(){db.calls=[];db.binding='bound';db.schema=true;db.closed=0;return new CommandJournal('/injected','bound',true);}
it('retains same readonly SQLite connection and validates schema/binding without writes or reopen',()=>{
 const j=journal();expect(db.calls[0]).toEqual(['open','/injected',{readOnly:true}]);expect(db.calls.filter(c=>c[0]==='open')).toHaveLength(1);expect(db.calls.some(c=>c[0]==='exec')).toBe(false);
 const before=db.calls.length;expect(()=>j.save({} as any)).toThrow('observation_only');expect(db.calls.length).toBe(before);j.close();expect(db.closed).toBe(1);
});
it.each(['schema','binding'])('closes readonly journal on wrong %s without initialization',kind=>{
 journal().close();db.calls=[];db.closed=0;if(kind==='schema')db.schema=false;else db.binding='other';expect(()=>new CommandJournal('/injected','bound',true)).toThrow();expect(db.closed).toBe(1);expect(db.calls.some(c=>c[0]==='exec')).toBe(false);
});
it('authority rejects mutation/recovery entrypoints before backend, facts or journal work',async()=>{
 const j=journal(),touch=vi.fn(()=>{throw Error('unexpected domain access');});
 const backend=new Proxy({}, {get:()=>touch}) as any;
 const a=new FrameworkAuthority(backend,j,{ownerId:'human:owner',scopeRef:'kapelle',facts:touch});
 const calls=[()=>a.allocate('id','kapelle/agent-instance','name'),()=>a.receipt('id'),()=>a.command({}),()=>a.claimTaskGeneration('id','op'),()=>a.claimPublicationInvocation('id','op'),()=>a.effectAdmission('id','op'),()=>a.admission({} as any)];
 const before=db.calls.length;for(const call of calls)await expect(async()=>call()).rejects.toThrow('observation_only');expect(touch).not.toHaveBeenCalled();expect(db.calls.length).toBe(before);j.close();
});
it.each(['/commands','/allocate','/operations/pending','/task-proposals','/admission'])('HTTP refuses %s before body/read/recovery calls',async url=>{
 const j=journal(),touch=vi.fn(()=>{throw Error('domain access');}),a=new FrameworkAuthority({} as any,j,{ownerId:'human:owner',scopeRef:'kapelle',facts:touch});
 const res:any={writeHead:vi.fn(),end:vi.fn()};await frameworkHandler(a,()=> 'x'.repeat(32))({url,method:url.startsWith('/operations')?'GET':'POST',headers:{authorization:'Bearer '+'x'.repeat(32)},[Symbol.asyncIterator]:touch} as any,res);
 expect(res.writeHead.mock.calls[0][0]).toBe(403);expect(JSON.parse(res.end.mock.calls[0][0]).error).toBe('observation_only');expect(touch).not.toHaveBeenCalled();j.close();
});
it('legacy worker refuses run before worker or request body is consumed',async()=>{
 const touch=vi.fn(()=>{throw Error('worker access');}),res:any={writeHead:vi.fn(),end:vi.fn()};
 await workerHandler(new Proxy({}, {get:()=>touch}) as any,()=> 'x'.repeat(32),true)({url:'/run',method:'POST',headers:{authorization:'Bearer '+'x'.repeat(32)},[Symbol.asyncIterator]:touch} as any,res);
 expect(res.writeHead.mock.calls[0][0]).toBe(403);expect(touch).not.toHaveBeenCalled();
});
