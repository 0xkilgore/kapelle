import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RestrictedClaudeAdapter,type Query,type UserPrompt} from '../src/worker/claude-adapter.js';
import type {InferenceInput} from '../src/worker/execution.js';
import type {ProviderAuthBinding} from '../src/worker/claude-provider-auth.js';

// Observed live: CLI2.1.295 yields {type:"system",subtype:"status",status:"requesting"} on
// stream_request_start, ~1.5 s after the prompt. The adapter treated it as unexpected and cancelled the child ~5.2 s
// after spawn, consuming the pilot attempt. This reproduces that timeline (scaled) with a fake SDK.
const CLI='0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function w2Timeline(afterInit:(session:string)=>Record<string,unknown>[]){
 const root=await realpath(await mkdtemp(join(tmpdir(),'status-msg-')));const configDir=join(root,'config');await mkdir(configDir,{mode:0o700});
 const binding={mode:'provider-managed',uid:process.getuid!(),teamId:randomUUID(),configDir,email:'owner@example.invalid',accountBinding:'personal-email-plan',subscriptionType:'max',cliVersion:'2.1.295',cliSha256:CLI,sdkVersion:'0.2.90',sdkSha256:'b'.repeat(64)} as ProviderAuthBinding;
 const input:InferenceInput={system:'S',user:'PROMPT',model:'claude-opus-5-5',credentialTeamId:binding.teamId,credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'0.2.90',cliVersion:'2.1.295',maxOutputTokens:16000,maxBudgetUsd:2,timeoutMs:5000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'};
 const session=randomUUID();const order:string[]=[];
 const query:Query=({prompt,options})=>{
  const consumed=(async()=>{for await(const _ of prompt as AsyncIterable<UserPrompt>)order.push('prompt');})();
  const stream=(async function*(){
   await consumed;                                         // late init: the CLI builds init per query, after the prompt
   yield {type:'system',subtype:'init',model:'claude-opus-5-5',cwd:options.cwd,claude_code_version:'2.1.295',session_id:session,permissionMode:'dontAsk',tools:[],mcp_servers:[],plugins:[],skills:[],agents:[]};
   for(const m of afterInit(session)){await sleep(15);order.push(String(m.type)+'/'+String(m.subtype??''));yield m;}
  })();
  return Object.assign(stream,{accountInfo:async()=>({apiProvider:'firstParty',email:binding.email,subscriptionType:'Claude Max'}),close:()=>{order.push('close');}});
 };
 const adapter=new RestrictedClaudeAdapter('0.2.90','2.1.295',{root:join(root,'jobs'),cliPath:'/never-launched',providerAuth:binding,query,initTimeoutMs:20});
 const capture={runtime:vi.fn(),output:vi.fn(),uncertain:vi.fn()};
 const error=await adapter.run(input,session,new AbortController().signal,capture).then(()=>null,(e:unknown)=>e);
 await rm(root,{recursive:true,force:true});
 return {error,order,capture};
}
const turn=(session:string,before:Record<string,unknown>[])=>[...before,
 {type:'assistant',session_id:session,message:{model:'claude-opus-5-5',content:[{type:'thinking',thinking:'x'},{type:'text',text:'Report'}]}},
 {type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',session_id:session,result:'Report',num_turns:1,permission_denials:[],modelUsage:{'claude-opus-5-5':{}},uuid:randomUUID(),total_cost_usd:0.2}];
const status=(session:string,extra:Record<string,unknown>)=>({type:'system',subtype:'status',uuid:randomUUID(),session_id:session,...extra});

it('timeline: status "requesting" after init no longer cancels the run; the result is captured',async()=>{
 const r=await w2Timeline(s=>turn(s,[status(s,{status:'requesting'})]));
 expect(r.error).toBeNull();expect(r.capture.output).toHaveBeenCalledOnce();expect(r.capture.uncertain).not.toHaveBeenCalled();
 expect(r.order).toEqual(['prompt','system/status','assistant/','result/success']);
});
it('status:null (with or without permissionMode) is also benign',async()=>{
 const r=await w2Timeline(s=>turn(s,[status(s,{status:null}),status(s,{status:null,permissionMode:'dontAsk'}),status(s,{status:'requesting'})]));
 expect(r.error).toBeNull();expect(r.capture.output).toHaveBeenCalledOnce();
});
it.each([
 ['compaction status',{status:'compacting'},'claude_unexpected_status'],
 ['compaction fields on a requesting status',{status:'requesting',compact_result:'x'},'claude_unexpected_status'],
 ['compaction error field',{status:null,compact_error:'x'},'claude_unexpected_status'],
])('refuses %s',async(_name,extra,label)=>{
 const r=await w2Timeline(s=>turn(s,[status(s,extra)]));
 expect((r.error as Error).message).toBe(label);expect(r.capture.output).not.toHaveBeenCalled();expect(r.capture.uncertain).toHaveBeenCalled();
});
it.each(['model_fallback','model_refusal_fallback','compact_boundary'])('still refuses system/%s',async subtype=>{
 const r=await w2Timeline(s=>turn(s,[{type:'system',subtype,uuid:randomUUID(),session_id:s}]));
 expect((r.error as Error).message).toBe('claude_unexpected_message');expect(r.capture.output).not.toHaveBeenCalled();
});
it('a status from another session is refused before its status is considered',async()=>{
 const r=await w2Timeline(s=>turn(s,[status(randomUUID(),{status:'requesting'})]));
 expect((r.error as Error).message).toBe('claude_session_mismatch');
});
const retry=(session:string,extra:Record<string,unknown>={})=>({type:'system',subtype:'api_retry',attempt:1,max_retries:10,retry_delay_ms:500,error_status:429,error:'rate_limit',uuid:randomUUID(),session_id:session,...extra});
const apiError=(session:string,extra:Record<string,unknown>={})=>({type:'system',subtype:'api_error',level:'error',error:{status:529,message:'synthetic'},retryInMs:812.5,retryAttempt:1,maxRetries:10,source:'synthetic',timestamp:new Date().toISOString(),uuid:randomUUID(),session_id:session,...extra});
it('a transient api_retry (429, 529, connection) inside the same request does not burn the attempt',async()=>{
 const r=await w2Timeline(s=>turn(s,[status(s,{status:'requesting'}),apiError(s),retry(s,{error_status:529,error:'overloaded',retry_delay_ms:812.5}),retry(s,{attempt:2,error_status:503,error:'server_error'}),
  retry(s,{attempt:3,error_status:null,error:'unknown',no_response:{waited_ms:30000,retry_wait_ms:60000}}),retry(s,{attempt:4}),status(s,{status:'requesting'})]));
 expect(r.error).toBeNull();expect(r.capture.output).toHaveBeenCalledOnce();expect(r.capture.uncertain).not.toHaveBeenCalled();
});
it.each([
 ['authentication_failed',{error:'authentication_failed',error_status:401}],
 ['billing_error',{error:'billing_error',error_status:402}],
 ['invalid_request',{error:'invalid_request',error_status:400}],
 ['max_output_tokens',{error:'max_output_tokens'}],
 ['a non-transient status',{error_status:404}],
 ['attempt beyond max_retries',{attempt:11}],
 ['a negative delay',{retry_delay_ms:-1}],
 ['an extra field',{message:'x'}],
 ['HTTP 600',{error_status:600,error:'server_error'}],
 ['a no_response with an extra key',{no_response:{waited_ms:1,retry_wait_ms:1,detail:'x'}}],
 ['a no_response missing a field',{no_response:{waited_ms:1}}],
 ['a non-object no_response',{no_response:'x'}],
 ['a missing session',{session_id:undefined}],
])('refuses api_retry with %s',async(_name,extra)=>{
 const r=await w2Timeline(s=>turn(s,[retry(s,extra)]));
 expect((r.error as Error).message).toBe('claude_unexpected_retry');expect(r.capture.output).not.toHaveBeenCalled();expect(r.capture.uncertain).toHaveBeenCalled();
});
it('refuses api_retry after the result',async()=>{
 const r=await w2Timeline(s=>[...turn(s,[]),retry(s)]);
 expect((r.error as Error).message).toBe('claude_unexpected_retry');
});
it.each([
 ['no retry counters (terminal API error)',{retryAttempt:undefined,maxRetries:undefined}],
 ['an extra key',{headers:{}}],
 ['a non-object error',{error:'x'}],
 ['attempt beyond max',{retryAttempt:11}],
 ['another session',{session_id:'other'}],
 ['a level other than error',{level:'info'}],
])('refuses the CLI api_error twin with %s',async(_name,extra)=>{
 const r=await w2Timeline(s=>{const m:Record<string,unknown>=apiError(s,extra);for(const k of Object.keys(m))if(m[k]===undefined)delete m[k];return turn(s,[m]);});
 expect((r.error as Error).message).toMatch(/^claude_(unexpected_retry|session_mismatch)$/);expect(r.capture.output).not.toHaveBeenCalled();
});

// Observed live (the exact input replayed via the real CLI 2.1.295): the ONLY frame the adapter refused was
// system/thinking_tokens (26x, between init and the first assistant message). This replays the census sequence and key sets.
const thinking=(session:string,n:number,extra:Record<string,unknown>={})=>({type:'system',subtype:'thinking_tokens',estimated_tokens:n*120,estimated_tokens_delta:120,session_id:session,uuid:randomUUID(),...extra});
const rateLimit=(session:string,extra:Record<string,unknown>={})=>({type:'rate_limit_event',rate_limit_info:{status:'allowed'},session_id:session,uuid:randomUUID(),...extra});
function censusSequence(s:string){
 const messageExtras={container:null,context_management:null,diagnostics:null,id:'msg',input_transformations:[],role:'assistant',stop_details:null,stop_reason:'end_turn',stop_sequence:null,type:'message',usage:{}};
 return [
  ...Array.from({length:26},(_,i)=>thinking(s,i+1)),
  {type:'assistant',parent_tool_use_id:null,request_id:'req',session_id:s,thinking_duration_ms:29000,timestamp:new Date().toISOString(),uuid:randomUUID(),message:{...messageExtras,model:'claude-opus-5-5',content:[{type:'thinking',thinking:'x'}]}},
  {type:'assistant',parent_tool_use_id:null,request_id:'req',session_id:s,timestamp:new Date().toISOString(),uuid:randomUUID(),message:{...messageExtras,model:'claude-opus-5-5',content:[{type:'text',text:'Report'}]}},
  rateLimit(s),
  {type:'result',subtype:'success',api_error_status:null,duration_api_ms:54000,duration_ms:54600,fast_mode_disabled_reason:null,fast_mode_state:'off',first_content_frame_ms:1400,is_error:false,
   modelUsage:{'claude-opus-5-5':{}},num_turns:1,permission_denials:[],queued_turn_count:0,result:'Report',result_index:0,safety_stops:[],session_id:s,stop_reason:'end_turn',subagent_stats:null,
   terminal_reason:'completed',time_to_request_ms:10,total_cost_usd:0.3,ttft_ms:1400,ttft_stream_ms:1400,usage:{},uuid:randomUUID()},
 ];
}
it('census replay: 26 thinking_tokens + thinking/text assistants + rate_limit_event + result → output captured',async()=>{
 const r=await w2Timeline(censusSequence);
 expect(r.error).toBeNull();expect(r.capture.output).toHaveBeenCalledOnce();expect(r.capture.uncertain).not.toHaveBeenCalled();
 expect(r.order.filter(o=>o==='system/thinking_tokens')).toHaveLength(26);
});
it.each([
 ['a content-bearing extra field',(s:string)=>thinking(s,1,{thinking:'leaked text'}),'claude_unexpected_progress'],
 ['a negative estimate',(s:string)=>thinking(s,1,{estimated_tokens:-1}),'claude_unexpected_progress'],
 ['a non-numeric delta',(s:string)=>thinking(s,1,{estimated_tokens_delta:'12'}),'claude_unexpected_progress'],
 ['another session',(s:string)=>thinking(s,1,{session_id:randomUUID()}),'claude_session_mismatch'],
 ['a rate_limit_event with an extra field',(s:string)=>rateLimit(s,{detail:'x'}),'claude_unexpected_rate_limit'],
 ['a rate_limit_event without rate_limit_info',(s:string)=>rateLimit(s,{rate_limit_info:null}),'claude_unexpected_rate_limit'],
])('refuses %s',async(_name,frame,label)=>{
 const r=await w2Timeline(s=>turn(s,[frame(s)]));
 expect((r.error as Error).message).toBe(label);expect(r.capture.output).not.toHaveBeenCalled();expect(r.capture.uncertain).toHaveBeenCalled();
});
it('refuses thinking_tokens after the result',async()=>{
 const r=await w2Timeline(s=>[...turn(s,[]),thinking(s,1)]);
 expect((r.error as Error).message).toBe('claude_unexpected_progress');
});
