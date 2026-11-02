import {it,expect,vi,afterEach} from 'vitest';
const state=vi.hoisted(()=>({calls:[] as string[],profile:{} as any}));
vi.mock('../src/worker/sources.js',()=>({ReportSourceClient:class{},ProductionSources:class{async profile(){state.calls.push('profile');return state.profile;}}}));
vi.mock('../src/worker/claude-provider-auth.js',()=>({providerAuthPath:()=>'/fixture'}));
vi.mock('../src/worker/claude-host.js',()=>({loadRestrictedClaudeAdapter:async()=>{state.calls.push('adapter');return {};}}));
vi.mock('../src/service/runtime.js',()=>({openFrameworkRuntime:async(options:any)=>{state.calls.push('native:'+options.requireExistingAuthority);return {authority:{},close:async()=>{}};}}));
vi.mock('../src/task-delegation/launcher.js',()=>({prepareTaskLauncher:async()=>{state.calls.push('task-prepare');return {};}}));
vi.mock('../src/task-delegation/runtime.js',()=>({openTaskRuntime:async()=>{state.calls.push('task-open');return {authority:{},handler:()=>{},close:async()=>{},stop:()=>{}};}}));
vi.mock('../src/worker/worker.js',()=>({RestrictedWorker:{open:async()=>{state.calls.push('worker');return {stop:()=>{},close:async()=>{}};}}}));
vi.mock('../src/service/http.js',()=>({frameworkHandler:()=>()=>{}}));
vi.mock('../src/worker/http.js',()=>({workerHandler:(_w:any,_t:any,observation:boolean)=>{state.calls.push('worker-gate:'+observation);return ()=>{};}}));
vi.mock('../src/worker/service-stop.js',()=>({createServiceStop:()=>async()=>{},closeStoresInOrder:()=>async()=>{}}));
vi.mock('node:http',()=>({createServer:()=>({once(){return this;},listen(_p:any,_h:any,cb:any){state.calls.push('listen');cb();}})}));
vi.mock('node:fs',()=>({constants:{O_RDONLY:0,O_NOFOLLOW:0},openSync:()=>{state.calls.push('token');return 1;},fstatSync:()=>({isFile:()=>true,mode:0o600,uid:process.getuid?.(),size:32}),readFileSync:()=> 'x'.repeat(32),closeSync:()=>{}}));
function setup(flag:string|undefined,task:string|undefined=undefined){
 vi.resetModules();state.calls=[];state.profile={documentIds:[],inboxDocumentIds:[],inboxAgents:[],releases:[],bindings:[]};
 const env:Record<string,string|undefined>={KAPELLE_FRAMEWORK_REQUIRE_EXISTING_AUTHORITY:flag,KAPELLE_TASK_LAUNCHER_CONFIG:task};
 for(const name of ['OWNER','SCOPE','STATE_ROOT','PROFILE','SOURCE_URL','SOURCE_TOKEN_FILE','AUTHORITY_TOKEN_FILE','WORKER_TOKEN_FILE'])env['KAPELLE_FRAMEWORK_'+name]='fixture';
 env.KAPELLE_FRAMEWORK_AUTHORITY_PORT='12345';env.KAPELLE_FRAMEWORK_WORKER_PORT='12346';env.KAPELLE_SCOPED_REACTOR_ROOT='fixture';env.KAPELLE_CLAUDE_MANAGER_ROOT='fixture';env.KAPELLE_CLAUDE_CLI_PATH='fixture';
 for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
 vi.spyOn(process,'on').mockReturnValue(process);
}
afterEach(()=>{vi.unstubAllEnvs();vi.restoreAllMocks();});
it.each(['','0','true'])('rejects invalid observation flag %j before profile/adapter/domain init',async flag=>{
 setup(flag);await expect(import('../src/worker/serve.js')).rejects.toThrow('Invalid existing-authority option');expect(state.calls).toEqual([]);
});
it.each(['','/task.json'])('rejects even present-empty Task config %j before profile/init',async task=>{
 setup('1',task);await expect(import('../src/worker/serve.js')).rejects.toThrow('observation_task_launcher_forbidden');expect(state.calls).toEqual([]);
});
it.each(['documentIds','inboxDocumentIds','inboxAgents','releases','bindings','claude-binding'])('rejects nonempty %s before adapter/tokens/native/worker init',async field=>{
 setup('1');state.profile[field==='claude-binding'?'bindings':field]=[field==='claude-binding'?{runtime:'claude-agent-sdk'}:'fixture'];
 await expect(import('../src/worker/serve.js')).rejects.toThrow('observation_empty_profile_required');expect(state.calls).toEqual(['profile']);
});
it('empty observation profile reaches only injected existing-native/worker startup with refusal handler',async()=>{
 setup('1');await import('../src/worker/serve.js');expect(state.calls).not.toContain('adapter');expect(state.calls).not.toContain('task-open');expect(state.calls).toContain('native:true');expect(state.calls).toContain('worker-gate:true');
});
it.each(['ordinary','claude','task','claude-task'])('absent flag preserves %s startup selection',async kind=>{
 setup(undefined,kind.includes('task')?'/task.json':undefined);if(kind.includes('claude'))state.profile.bindings=[{runtime:'claude-agent-sdk'}];
 await import('../src/worker/serve.js');expect(state.calls.includes('adapter')).toBe(kind.includes('claude'));expect(state.calls.includes('task-open')).toBe(kind.includes('task'));expect(state.calls).toContain('worker-gate:false');
});
