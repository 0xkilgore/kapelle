import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RestrictedClaudeAdapter,claudeInitMismatches,disabledBuiltinPlugins,CLI_BUILTIN_PLUGINS,type Query,type UserPrompt} from '../src/worker/claude-adapter.js';
import {ProviderRejectedBeforeInference,type InferenceInput} from '../src/worker/execution.js';
import type {ProviderAuthBinding} from '../src/worker/claude-provider-auth.js';

const CLI='0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70';
// Exactly the CLI2.1.295 wie() registrations (V_e("<name>",...)) other than the policy-only cc-plugin-sec-default.
const DISABLED=['cc-plugin-agents-md','cc-plugin-telemetry','cc-plugin-plugin-authoring','cc-plugin-mods-guide','cc-plugin-tips',
 'cc-plugin-mermaid','cc-plugin-responsive-mode','cc-plugin-diff','cc-plugin-you-should-know','cc-plugin-claude-test'];
const sec={name:'cc-plugin-sec-default',path:'builtin',source:'cc-plugin-sec-default@builtin',version:'1.0.0'};
const expected={model:'claude-opus-5-5',cwd:'/c',cliVersion:'2.1.295',sessionId:'s',initialized:false,cliSha256:CLI};
const init={type:'system',subtype:'init',model:'claude-opus-5-5',cwd:'/c',claude_code_version:'2.1.295',session_id:'s',permissionMode:'dontAsk',tools:[],mcp_servers:[],plugins:[] as unknown[],skills:[],agents:[]};

it('pins exactly the ten session-controllable built-ins to the CLI hash and refuses any other CLI',()=>{
 expect(disabledBuiltinPlugins(CLI)).toEqual(Object.fromEntries(DISABLED.map(n=>[n+'@builtin',false])));
 expect(Object.keys(CLI_BUILTIN_PLUGINS)).toEqual([CLI]);expect(CLI_BUILTIN_PLUGINS[CLI].policyOnly).toBe('cc-plugin-sec-default');
 for(const other of ['0'.repeat(64),'0116ee2e'])expect(()=>disabledBuiltinPlugins(other)).toThrow(ProviderRejectedBeforeInference);
});
it('tolerates only the exact policy-only built-in, only while every other capability list is empty',()=>{
 expect(claudeInitMismatches({...init,plugins:[sec]},expected)).toEqual([]);
 const {version,...noVersion}=sec;expect(claudeInitMismatches({...init,plugins:[noVersion]},expected)).toEqual([]);
 const {agents,...noAgents}=init;expect(claudeInitMismatches({...noAgents,plugins:[sec]},expected)).toEqual([]);
 expect(claudeInitMismatches({...init,plugins:[sec],skills:['x']},expected)).toEqual(['plugins.nonempty:cc-plugin-sec-default','skills.nonempty']);
 expect(claudeInitMismatches({...init,plugins:[sec],tools:['Read']},expected)).toEqual(['tools.nonempty','plugins.nonempty:cc-plugin-sec-default']);
 expect(claudeInitMismatches({...init,plugins:[sec],agents:['a']},expected)).toEqual(['plugins.nonempty:cc-plugin-sec-default','agents.nonempty']);
 for(const bad of [{...sec,path:'/x'},{...sec,source:'cc-plugin-sec-default@market'},{...sec,version:1},{...sec,hooks:{}}])
  expect(claudeInitMismatches({...init,plugins:[bad]},expected)).toEqual(['plugins.nonempty:cc-plugin-sec-default']);
 expect(claudeInitMismatches({...init,plugins:[sec,{name:'cc-plugin-tips',path:'builtin',source:'cc-plugin-tips@builtin'}]},expected)).toEqual(['plugins.nonempty:cc-plugin-sec-default+cc-plugin-tips']);
 // Without a pinned CLI (legacy manager mode) nothing is tolerated and no plugin is named.
 const {cliSha256,...legacy}=expected;expect(claudeInitMismatches({...init,plugins:[sec]},legacy)).toEqual(['plugins.nonempty:count=1']);
});
it('refuses every other plugin and never names a non-built-in one',()=>{
 for(const p of [{name:'stripe',path:'/opt/plugins/x/.claude/plugins/stripe',source:'stripe@claude-plugins-official'},{name:'PRIVATE_SENTINEL',path:'/p'},'not-an-object',null])
  expect(claudeInitMismatches({...init,plugins:[p]},expected)).toEqual(['plugins.nonempty:count=1']);
 expect(claudeInitMismatches({...init,plugins:[sec,{name:'stripe',path:'/p',source:'stripe@m'}]},expected)).toEqual(['plugins.nonempty:count=2']);
});

async function harness(opts:{eagerInit:boolean;plugins:unknown[];cliSha256?:string}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'builtin-plugins-')));const configDir=join(root,'config');await mkdir(configDir,{mode:0o700});
 const binding:ProviderAuthBinding={mode:'provider-managed',uid:process.getuid!(),teamId:randomUUID(),configDir,email:'owner@example.invalid',accountBinding:'personal-email-plan',subscriptionType:'max',cliVersion:'2.1.295',cliSha256:opts.cliSha256??CLI,sdkVersion:'0.2.90',sdkSha256:'b'.repeat(64)} as ProviderAuthBinding;
 const input:InferenceInput={system:'S',user:'PROMPT',model:'claude-opus-5-5',credentialTeamId:binding.teamId,credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'0.2.90',cliVersion:'2.1.295',maxOutputTokens:16000,maxBudgetUsd:2,timeoutMs:2000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'};
 const session=randomUUID();const order:string[]=[];let options:Record<string,unknown>={},calls=0;
 const query:Query=({prompt,options:o})=>{
  calls++;options=o;
  const consumed=(async()=>{for await(const m of prompt as AsyncIterable<UserPrompt>){order.push('prompt-read');expect(m.message.content).toBe('PROMPT');}})();
  const initFrame=()=>({...init,cwd:o.cwd,session_id:session,plugins:opts.plugins});
  const stream=(async function*(){
   if(opts.eagerInit){order.push('init-emitted');yield initFrame();await consumed;}
   else{await consumed;order.push('init-emitted');yield initFrame();}
   yield {type:'assistant',session_id:session,message:{model:'claude-opus-5-5',content:[{type:'text',text:'OK'}]}};
   yield {type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',session_id:session,result:'OK',num_turns:1,permission_denials:[],modelUsage:{'claude-opus-5-5':{}},uuid:randomUUID(),total_cost_usd:0};
  })();
  return Object.assign(stream,{accountInfo:async()=>{order.push('account');return {apiProvider:'firstParty',email:binding.email,subscriptionType:'Claude Max'};}});
 };
 const adapter=new RestrictedClaudeAdapter('0.2.90','2.1.295',{root:join(root,'jobs'),cliPath:'/never-launched',providerAuth:binding,query,initTimeoutMs:200});
 const run=()=>adapter.run(input,session,new AbortController().signal,{runtime:()=>order.push('runtime'),output:()=>order.push('output'),uncertain:vi.fn()});
 return {run,order,read:()=>({options,calls}),close:()=>rm(root,{recursive:true,force:true})};
}
it('eager init: a plugin mismatch refuses before the prompt is ever read, and enabledPlugins is rendered exactly',async()=>{
 const h=await harness({eagerInit:true,plugins:[{name:'stripe',path:'/p',source:'stripe@m'}]});
 try{
  await expect(h.run()).rejects.toThrow(/^claude_runtime_mismatch:fields=plugins\.nonempty:count=1$/);
  expect(h.order).toEqual(['account','init-emitted']);expect(h.order).not.toContain('prompt-read');
  expect((h.read().options.settings as any).enabledPlugins).toEqual(Object.fromEntries(DISABLED.map(n=>[n+'@builtin',false])));
  expect(h.read().options.plugins).toEqual([]);expect(h.read().calls).toBe(1);
 }finally{await h.close();}
});
it('eager init: the exact policy-only built-in passes, and the prompt is released only after init is verified',async()=>{
 const h=await harness({eagerInit:true,plugins:[sec]});
 try{await h.run();expect(h.order).toEqual(['account','init-emitted','runtime','prompt-read','output']);}finally{await h.close();}
});
it('late init (init only after the prompt, as the Oct 8 CLI behaved): bounded wait, then the same strict check on arrival',async()=>{
 const ok=await harness({eagerInit:false,plugins:[]});
 try{await ok.run();expect(ok.order).toEqual(['account','prompt-read','init-emitted','runtime','output']);}finally{await ok.close();}
 const bad=await harness({eagerInit:false,plugins:[{name:'cc-plugin-tips',path:'builtin',source:'cc-plugin-tips@builtin'}]});
 try{await expect(bad.run()).rejects.toThrow(/^claude_runtime_mismatch:fields=plugins\.nonempty:cc-plugin-tips$/);expect(bad.order).not.toContain('output');}finally{await bad.close();}
});
it('an unpinned CLI hash refuses before the CLI is launched',async()=>{
 const h=await harness({eagerInit:true,plugins:[],cliSha256:'0'.repeat(64)});
 try{await expect(h.run()).rejects.toThrow('claude_cli_builtin_plugins_unpinned');expect(h.read().calls).toBe(0);expect(h.order).toEqual([]);}finally{await h.close();}
});
