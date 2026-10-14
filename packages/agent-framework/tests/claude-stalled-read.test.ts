import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RestrictedClaudeAdapter,type Query,type UserPrompt} from '../src/worker/claude-adapter.js';
import type {InferenceInput} from '../src/worker/execution.js';
import type {ProviderAuthBinding} from '../src/worker/claude-provider-auth.js';

// A stalled SDK read must not keep control from cleanup. No-child fakes: next() never settles after the
// scripted frames, and return() never settles either (it is only a request), so only the abort race + Query.close() can end it.
const CLI='0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70';
async function stalled(opts:{eagerInit:boolean;abortOnPromptRead?:boolean;initTimeoutMs?:number;timeoutMs?:number}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'stalled-read-')));const configDir=join(root,'config');await mkdir(configDir,{mode:0o700});
 const binding={mode:'provider-managed',uid:process.getuid!(),teamId:randomUUID(),configDir,email:'owner@example.invalid',accountBinding:'personal-email-plan',subscriptionType:'max',cliVersion:'2.1.295',cliSha256:CLI,sdkVersion:'0.2.90',sdkSha256:'b'.repeat(64)} as ProviderAuthBinding;
 const input:InferenceInput={system:'S',user:'PROMPT',model:'claude-opus-5-5',credentialTeamId:binding.teamId,credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'0.2.90',cliVersion:'2.1.295',maxOutputTokens:16000,maxBudgetUsd:2,timeoutMs:opts.timeoutMs??60,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'};
 const session=randomUUID(),external=new AbortController();const s={calls:0,closes:0,returns:0,promptRead:false,nexts:0};
 const query:Query=({prompt,options})=>{
  s.calls++;
  void (async()=>{for await(const _ of prompt as AsyncIterable<UserPrompt>){s.promptRead=true;if(opts.abortOnPromptRead)external.abort();}})();
  let initSent=false;
  const it:any={
   next:()=>{s.nexts++;if(opts.eagerInit&&!initSent){initSent=true;return Promise.resolve({done:false,value:{type:'system',subtype:'init',model:'claude-opus-5-5',cwd:options.cwd,claude_code_version:'2.1.295',session_id:session,permissionMode:'dontAsk',tools:[],mcp_servers:[],plugins:[],skills:[],agents:[]}});}
    return new Promise(()=>{});},
   return:()=>{s.returns++;return new Promise(()=>{});},
   [Symbol.asyncIterator](){return it;},
   accountInfo:async()=>({apiProvider:'firstParty',email:binding.email,subscriptionType:'Claude Max'}),
   close:()=>{s.closes++;},
  };
  return it;
 };
 const adapter=new RestrictedClaudeAdapter('0.2.90','2.1.295',{root:join(root,'jobs'),cliPath:'/never-launched',providerAuth:binding,query,initTimeoutMs:opts.initTimeoutMs??5});
 const capture={runtime:vi.fn(),output:vi.fn(),uncertain:vi.fn()};
 const run=async()=>{const t=Date.now();const error=await adapter.run(input,session,external.signal,capture).then(()=>null,(e:unknown)=>e);return {error,ms:Date.now()-t};};
 return {run,s,capture,close:()=>rm(root,{recursive:true,force:true})};
}
const settledPromptly=(r:{error:unknown;ms:number})=>{expect(r.error).toBeInstanceOf(Error);expect(r.ms).toBeLessThan(1500);};
it('(1) deferred init with a pending read that never settles: the timeout reaches cleanup promptly',async()=>{
 const h=await stalled({eagerInit:false});
 try{
  const r=await h.run();settledPromptly(r);
  expect(String((r.error as Error).message)).toMatch(/^claude_(interrupted|completion_unconfirmed)$/);
  expect(h.s.promptRead).toBe(true);          // late-init path released the prompt; the carried read was still raced
  expect(h.capture.uncertain).toHaveBeenCalled();expect(h.capture.output).not.toHaveBeenCalled();
  expect(h.s.calls).toBe(1);expect(h.s.closes).toBeGreaterThanOrEqual(1);expect(h.s.returns).toBeGreaterThanOrEqual(1);
 }finally{await h.close();}
});
it('(2) valid eager init, then a stalled read: the timeout reaches cleanup promptly',async()=>{
 const h=await stalled({eagerInit:true});
 try{
  const r=await h.run();settledPromptly(r);
  expect(h.capture.runtime).toHaveBeenCalledOnce();expect(h.s.promptRead).toBe(true);
  expect(h.capture.uncertain).toHaveBeenCalled();expect(h.capture.output).not.toHaveBeenCalled();
  expect(h.s.calls).toBe(1);expect(h.s.closes).toBeGreaterThanOrEqual(1);
 }finally{await h.close();}
});
it('(3) abort during the gate-to-iteration handoff: the already-aborted state is checked before waiting',async()=>{
 const h=await stalled({eagerInit:true,abortOnPromptRead:true,timeoutMs:60_000});   // only the external abort can end it
 try{
  const r=await h.run();settledPromptly(r);
  expect(String((r.error as Error).message)).toBe('claude_interrupted');
  expect(h.capture.uncertain).toHaveBeenCalled();expect(h.capture.output).not.toHaveBeenCalled();
  expect(h.s.calls).toBe(1);expect(h.s.closes).toBeGreaterThanOrEqual(1);
 }finally{await h.close();}
});
