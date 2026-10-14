import { describe,it,expect } from 'vitest';
import { mkdtempSync,realpathSync,rmSync,readFileSync,writeFileSync,unlinkSync,readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RestrictedWorker } from '../src/worker/worker.js';
import { RestrictedClaudeAdapter,type Query } from '../src/worker/claude-adapter.js';
import { recoverDeadWriterLock } from '../src/worker/writer-lock.js';
import { workerHandler } from '../src/worker/http.js';
import { fixtureSources,work } from './fixtures/restricted-claude.js';

const token='synthetic-oauth-not-for-a-provider';
const text='  # Unchanged café 🐦\n\nReview.\n';
async function setup(mode='normal') {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'claude-execution-'))),f=fixtureSources();
  let calls=0,worker:RestrictedWorker,adapterFailure:unknown;
  const emitted:string[]=[];
  const query:Query=async function*({prompt,options:o}){
    calls++;
    const saved=worker.execution(work.dispatchId)!;
    expect(saved.phase).toBe('started');expect(saved.input.user).toBe(prompt);expect(saved.input.system).toBe(o.systemPrompt);
    expect(o.tools).toEqual([]);expect(o.mcpServers).toEqual({});expect(o.plugins).toEqual([]);expect(o.settingSources).toEqual([]);
    expect(o.permissionMode).toBe('dontAsk');expect(o).not.toHaveProperty('resume');expect(o).not.toHaveProperty('fallbackModel');
    expect(o.disallowedTools).toEqual(['*']);expect(o.extraArgs).toEqual({'safe-mode':null,'disable-slash-commands':null});
    expect(o.settings).toEqual({disableAllHooks:true,switchModelsOnFlag:false,availableModels:['synthetic-claude'],fallbackModel:[]});
    expect(Object.keys(o.env as object).sort()).toEqual(['CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS','CLAUDE_CODE_DISABLE_TERMINAL_TITLE','CLAUDE_CODE_MAX_OUTPUT_TOKENS','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CONFIG_DIR','DISABLE_ERROR_REPORTING','DISABLE_TELEMETRY','HOME','PATH','TMPDIR'].sort());
    expect((o.env as Record<string,string>).CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBe('1');
    expect((o.env as Record<string,string>).CLAUDE_CODE_DISABLE_TERMINAL_TITLE).toBe('1');
    const init={type:'system',subtype:'init',model:o.model,cwd:o.cwd,session_id:o.sessionId,claude_code_version:'fake-cli',permissionMode:'dontAsk',tools:[],mcp_servers:[],plugins:[],skills:[],agents:[]};
    emitted.push('init');
    yield {...init,...(mode==='tools'?{tools:['Bash']}:mode==='model'?{model:'wrong-model'}:mode==='session'?{session_id:crypto.randomUUID()}: {})};
    emitted.push('assistant');
    yield {type:'assistant',session_id:o.sessionId,message:{model:o.model,content:[{type:'thinking',thinking:'Synthetic reasoning must not be stored.'},{type:'text',text}]}};
    emitted.push('result');
    yield {type:'result',subtype:'success',is_error:false,session_id:o.sessionId,result:mode==='large'?'x'.repeat(32001):text,
      stop_reason:mode==='incomplete'?'max_tokens':'end_turn',num_turns:1,permission_denials:[],modelUsage:{'synthetic-claude':{},...(['extra-model','extra-zero'].includes(mode)?{'claude-haiku-4-5-20251001':{inputTokens:mode==='extra-zero'?0:926,outputTokens:mode==='extra-zero'?0:12,costUSD:mode==='extra-zero'?0:0.000986}}:{})},uuid:'synthetic-result',total_cost_usd:0};
    if(mode==='after-output')throw Error('synthetic transport failure '+token);
  };
  const adapter=new RestrictedClaudeAdapter('fake-sdk','fake-cli',{query,
    credential:async(team_id)=>({kind:mode==='api-key'?'anthropic-api-key':'claude-code-oauth',secret:token,team_id}),
    credentialEnv:()=>({CLAUDE_CODE_OAUTH_TOKEN:token}),root:join(root,'runtime'),cliPath:'/synthetic/claude'});
  const run=adapter.run.bind(adapter);
  adapter.run=async(...args:Parameters<typeof run>)=>{
    try {await run(...args);} catch(error) {adapterFailure=error;throw error;}
  };
  worker=await RestrictedWorker.open(join(root,'worker'),f.authority,f.sources,fetch,adapter);
  return {root,f,adapter,emitted,get adapterFailure(){return adapterFailure;},get worker(){return worker;},get calls(){return calls;},
    async restart(){worker.close();worker=await RestrictedWorker.open(join(root,'worker'),f.authority,f.sources,fetch,adapter);},
    close(){worker.close();rmSync(root,{recursive:true,force:true});}};
}
describe('restricted Claude execution with fake SDK',()=>{
  it('captures exact inputs before inference, actual init and unchanged output; replays after reopen without reinference',async()=>{
    const f=await setup();try{
      const result=await f.worker.run(work);expect(result.markdown).toBe(text);expect(result.execution!.output!.text).toBe(text);
      expect(JSON.stringify(result)).not.toContain('Synthetic reasoning must not be stored.');
      expect(result.execution!.runtime!.model).toBe('synthetic-claude');expect(JSON.stringify(result)).not.toContain(token);
      const saved=f.worker.execution(work.dispatchId)!;expect(saved.phase).toBe('completed');
      expect(saved.input.work).toEqual(work);expect(saved.input.user).toBe(JSON.stringify({instructions:work.request.comment,reference:work.request.document}));
      await f.restart();expect(await f.worker.run(work)).toEqual(result);expect(f.calls).toBe(1);
      await expect(f.worker.run({...work,queryId:'changed'})).rejects.toThrow('worker_request_conflict');
    }finally{f.close();}
  });
  it.each(['tools','model','session','large','incomplete','extra-model','extra-zero','after-output','api-key'])('does not retry an uncertain %s attempt or persist credential/error text',async(mode)=>{
    const f=await setup(mode);try{
      await expect(f.worker.run(work)).rejects.toThrow('claude_execution_unconfirmed');
      const saved=f.worker.execution(work.dispatchId)!;expect(saved.phase).toBe('uncertain');expect(JSON.stringify(saved)).not.toContain(token);
      // Assert the real adapter guard, not just the worker's catch-all error.
      const initField=({tools:'tools.nonempty',model:'model',session:'session_id'} as Record<string,string>)[mode];
      if(initField){
        expect(f.emitted).toEqual(['init']);
        expect(f.adapterFailure).toMatchObject({message:'claude_runtime_mismatch:fields='+initField});
        expect(saved.runtime).toBeNull();expect(saved.output).toBeNull();
      } else if(['large','incomplete','extra-model','extra-zero'].includes(mode)){
        expect(f.emitted).toEqual(['init','assistant','result']);
        expect(saved.runtime?.model).toBe('synthetic-claude');expect(saved.output).toBeNull();
        if(mode==='large')expect(f.adapterFailure).toMatchObject({name:'ZodError',issues:[{code:'too_big',path:['text'],maximum:32000}]});
        else expect(f.adapterFailure).toMatchObject({message:'claude_incomplete_result'});
      } else if(mode==='after-output'){
        expect(f.emitted).toEqual(['init','assistant','result']);expect(saved.output!.text).toBe(text);
        expect(f.adapterFailure).toMatchObject({message:'synthetic transport failure '+token});
      } else {
        expect(f.emitted).toEqual([]);expect(f.adapterFailure).toMatchObject({message:'claude_oauth_not_available'});
      }
      await f.restart();await expect(f.worker.run(work)).rejects.toThrow('worker_execution_uncertain');expect(f.calls).toBe(mode==='api-key'?0:1);
    }finally{f.close();}
  });
  it('exposes saved evidence only through the authenticated read endpoint',async()=>{
    const f=await setup();const auth='synthetic-worker-credential-0123456789';
    const s=createServer(workerHandler(f.worker,()=>auth));s.listen(0,'127.0.0.1');await once(s,'listening');
    const url=`http://127.0.0.1:${(s.address() as any).port}/executions/${work.dispatchId}`;
    try{await f.worker.run(work);expect((await fetch(url)).status).toBe(403);
      const r=await fetch(url,{headers:{authorization:'Bearer '+auth}});expect(r.status).toBe(200);expect((await r.json()).execution.phase).toBe('completed');expect(f.calls).toBe(1);
    }finally{await new Promise<void>(r=>s.close(()=>r()));f.close();}
  });
  it('refuses recovery of a live owner and never removes a replaced writer lock on close',async()=>{
    const f=await setup(),path=join(f.root,'worker','writer.lock');
    expect(()=>recoverDeadWriterLock(join(f.root,'worker'),process.pid)).toThrow('worker_writer_not_proven_dead');
    const value=readFileSync(path,'utf8');unlinkSync(path);writeFileSync(path,'replacement',{mode:0o600});
    expect(()=>f.worker.close()).toThrow('worker_lock_ownership_changed');expect(readFileSync(path,'utf8')).toBe('replacement');expect(value.split('\n')[0]).toBe(String(process.pid));rmSync(f.root,{recursive:true,force:true});
  });
  // Contract change (2026-10-07): a lock whose owner is provably dead is reclaimed automatically and
  // its bytes quarantined; a live owner is still refused and the explicit recovery path still works.
  it.each(['started','returned'])('retains %s evidence after SIGKILL, refuses a duplicate writer while alive, then self-heals the dead-owner lock',async(phase)=>{
    const root=realpathSync(mkdtempSync(join(tmpdir(),'claude-crash-'))),workerRoot=join(root,'worker');
    const child=spawn(process.execPath,['--import',process.env.KAPELLE_WORKER_HOST_TSX!,join(import.meta.dirname,'fixtures/claude-crash-child.ts'),workerRoot,phase],{stdio:['ignore','pipe','pipe']});
    let stderr='';child.stderr.on('data',b=>{stderr+=b;});
    const exit=once(child,'exit');
    try{
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child readiness timeout '+stderr)),15000);child.stdout.on('data',b=>{if(String(b).includes('DURABLE')){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(Error('child exited '+stderr));});});
      const {authority,sources}=fixtureSources();await expect(RestrictedWorker.open(workerRoot,authority,sources)).rejects.toThrow('worker_lock_held');
      const staleBytes=readFileSync(join(workerRoot,'writer.lock'),'utf8');expect(staleBytes.split('\n')[0]).toBe(String(child.pid));
      expect(()=>recoverDeadWriterLock(workerRoot,child.pid!)).toThrow('worker_writer_not_proven_dead');
      child.kill('SIGKILL');await exit;
      expect(()=>recoverDeadWriterLock(workerRoot,child.pid!+1)).toThrow('worker_recovery_lock_mismatch');
      const worker=await RestrictedWorker.open(workerRoot,authority,sources);
      const quarantined=readdirSync(workerRoot).filter(n=>n.startsWith('writer.lock.stale-'));
      expect(quarantined).toHaveLength(1);expect(readFileSync(join(workerRoot,quarantined[0]),'utf8')).toBe(staleBytes);
      try{expect(worker.execution(work.dispatchId)!.phase).toBe(phase);await expect(worker.run(work)).rejects.toThrow('worker_execution_uncertain');if(phase==='returned')expect(worker.execution(work.dispatchId)!.output!.text).toBe('Unchanged completed output\n');}
      finally{worker.close();}
    }finally{if(child.exitCode===null && child.signalCode===null){child.kill('SIGKILL');await exit;}rmSync(root,{recursive:true,force:true});}
  },30000);
});
