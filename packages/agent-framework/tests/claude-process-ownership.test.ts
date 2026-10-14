import {describe,it,expect} from 'vitest';
import {mkdtempSync,realpathSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RestrictedClaudeAdapter,type Query} from '../src/worker/claude-adapter.js';
import {RestrictedWorker} from '../src/worker/worker.js';
import {fixtureSources,work} from './fixtures/restricted-claude.js';
import type {ClaudeSpawnOptions} from '../src/worker/claude-process.js';
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(test:()=>boolean){for(let n=0;n<500;n++){if(test())return;await delay(10);}throw Error('fixture deadline');}
async function setup(mode:string){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'claude-owner-'))),f=fixtureSources();
 f.binding.timeoutMs=['success','lingering-success'].includes(mode)?5000:600;
 if(mode==='spawn-failure')writeFileSync(join(root,'not-executable'),'fixture',{mode:0o600});
 let calls=0,outputSeen=false,childClosed=false;
 const query:Query=async function*({options:o}){
  calls++;
  const child=(o.spawnClaudeCodeProcess as (o:ClaudeSpawnOptions)=>any)({
   command:mode==='spawn-failure'?join(root,'not-executable'):process.execPath,
   args:[join(import.meta.dirname,'fixtures/claude-owned-child.mjs'),root,mode],
   cwd:root,env:{PATH:'/usr/bin:/bin'},signal:(o.abortController as AbortController).signal});
  const closed=new Promise<void>(r=>child.once('close',()=>{childClosed=true;r();}));
  if(mode==='spawn-failure'){await closed;return;}
  await until(()=>existsSync(join(root,'ready')));
  yield {type:'system',subtype:'init',model:o.model,cwd:o.cwd,session_id:o.sessionId,claude_code_version:'fake-cli',permissionMode:'dontAsk',tools:[],agents:[],mcp_servers:[],plugins:[],skills:[]};
  if(mode==='query-error')throw Error('synthetic transport error');
  if(['success','late-output','sdk-late-output','lingering-success'].includes(mode)){
   if(mode==='sdk-late-output')child.kill('SIGTERM');
   if(mode==='late-output')await until(()=>existsSync(join(root,'aborted')));
   yield {type:'result',subtype:'success',is_error:false,session_id:o.sessionId,result:'Synthetic result',stop_reason:'end_turn',num_turns:1,permission_denials:[],modelUsage:{[String(o.model)]:{}},uuid:'synthetic-result',total_cost_usd:0};
   outputSeen=true;return;
  }
  // Simulate the SDK's iterator ending on stdout closure, even if its child is alive.
  for await(const _ of child.stdout){};
 };
 const adapter=new RestrictedClaudeAdapter('fake-sdk','fake-cli',{query,root:join(root,'runtime'),cliPath:'/never-a-provider',credential:async(team_id)=>({kind:'claude-code-oauth',secret:'synthetic-oauth',team_id}),credentialEnv:()=>({CLAUDE_CODE_OAUTH_TOKEN:'synthetic-oauth'})});
 let worker=await RestrictedWorker.open(join(root,'worker'),f.authority,f.sources,fetch,adapter);
 return {root,f,adapter,get worker(){return worker;},get calls(){return calls;},get outputSeen(){return outputSeen;},get childClosed(){return childClosed;},release(){writeFileSync(join(root,'release'),'yes');},async restart(){worker.close();worker=await RestrictedWorker.open(join(root,'worker'),f.authority,f.sources,fetch,adapter);},close(){worker.close();rmSync(root,{recursive:true,force:true});}};
}
describe('Claude owned child lifetime',()=>{
 it.each(['hold-output','close-output','late-output','sdk-late-output','lingering-success','query-error'])('holds the writer after %s and never accepts late output or replays',async mode=>{
  const f=await setup(mode);let settled=false;
  const run=f.worker.run(work).then(()=>{throw Error('unexpected success');},e=>e).finally(()=>{settled=true;});
  try{
   await until(()=>existsSync(join(f.root,'aborted')));
   await until(()=>f.worker.execution(work.dispatchId)?.phase==='uncertain');
   await delay(60);
   expect(settled).toBe(false);expect(f.childClosed).toBe(false);if(mode!=='lingering-success')expect(f.worker.execution(work.dispatchId)?.output).toBeNull();
   expect(()=>f.worker.close()).toThrow('worker_busy');
   await expect(RestrictedWorker.open(join(f.root,'worker'),f.f.authority,f.f.sources,fetch,f.adapter)).rejects.toThrow('worker_invocation_reconciliation_required');
   await expect(f.worker.run(work)).rejects.toThrow('worker_execution_uncertain');expect(f.calls).toBe(1);
   f.release();expect((await run).message).toBe('claude_execution_unconfirmed');expect(f.childClosed).toBe(true);
   await f.restart();await expect(f.worker.run(work)).rejects.toThrow('worker_execution_uncertain');expect(f.calls).toBe(1);
  }finally{f.release();await run;f.close();}
 });
 it('does not complete a valid result until the child and streams close',async()=>{
  const f=await setup('success');let settled=false;const run=f.worker.run(work).finally(()=>{settled=true;});
  try{await until(()=>f.outputSeen);await delay(60);expect(settled).toBe(false);expect(f.childClosed).toBe(false);expect(()=>f.worker.close()).toThrow('worker_busy');
   f.release();expect((await run).markdown).toBe('Synthetic result');expect(f.childClosed).toBe(true);expect(f.worker.execution(work.dispatchId)?.phase).toBe('completed');
   await f.restart();expect((await f.worker.run(work)).markdown).toBe('Synthetic result');expect(f.calls).toBe(1);
  }finally{f.release();await run;f.close();}
 });
 it.each(['cooperative','spawn-failure'])('settles %s only after close and retains the consumed attempt',async mode=>{
  const f=await setup(mode);try{await expect(f.worker.run(work)).rejects.toThrow('claude_execution_unconfirmed');expect(f.childClosed).toBe(true);expect(f.worker.execution(work.dispatchId)?.phase).toBe('uncertain');
   await f.restart();await expect(f.worker.run(work)).rejects.toThrow('worker_execution_uncertain');expect(f.calls).toBe(1);
  }finally{f.release();f.close();}
 });
});
