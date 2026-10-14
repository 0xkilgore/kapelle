import {it,expect} from 'vitest';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RestrictedClaudeAdapter,claudeInitMismatches} from '../src/worker/claude-adapter.js';
import {ProviderRejectedBeforeInference,type InferenceInput} from '../src/worker/execution.js';

// Synthetic values in the SDK0.2.90/CLI2.1.263 init shape, inspected offline.
// This is NOT the lost provider init event or evidence of live qualification.
const expected={model:'claude-fable-5',cwd:'/synthetic/private',cliVersion:'2.1.263',sessionId:'synthetic-session',initialized:false};
const init={type:'system',subtype:'init',model:expected.model,cwd:expected.cwd,claude_code_version:expected.cliVersion,session_id:expected.sessionId,permissionMode:'dontAsk',tools:[],mcp_servers:[],plugins:[],skills:[],agents:[],apiKeySource:'none',betas:[],slash_commands:[],output_style:'default',uuid:'synthetic-message',analytics_disabled:true};
it('accepts exact pinned init shape and SDK-optional agents omission',()=>{
 expect(claudeInitMismatches(init,expected)).toEqual([]);
 const {agents,...withoutAgents}=init;expect(claudeInitMismatches(withoutAgents,expected)).toEqual([]);
});
for(const field of ['model','cwd','claude_code_version','session_id','permissionMode'])it(`labels ${field} mismatch without values`,()=>{
 expect(claudeInitMismatches({...init,[field]:'PRIVATE_SENTINEL'},expected)).toEqual([field]);
});
for(const field of ['tools','mcp_servers','plugins','skills','agents'])it(`preserves strict ${field} emptiness and shape`,()=>{
 expect(claudeInitMismatches({...init,[field]:[{name:'PRIVATE_SENTINEL',path:'/private/path'}]},expected)).toEqual([field==='plugins'?'plugins.nonempty:count=1':field+'.nonempty']); // never names a non-built-in plugin
 expect(claudeInitMismatches({...init,[field]:'PRIVATE_SENTINEL'},expected)).toEqual([field+'.invalid_array']);
 expect(claudeInitMismatches({...init,[field]:null},expected)).toEqual([field+'.invalid_array']);
 if(field!=='agents')expect(claudeInitMismatches({...init,[field]:undefined},expected)).toEqual([field+'.invalid_array']);
});
it('does not accept a model alias or advertised agents just because tools are empty',()=>{
 expect(claudeInitMismatches({...init,model:'claude-fable-5-canonical',agents:['built-in-advertised-agent']},expected)).toEqual(['model','agents.nonempty']);
 expect(claudeInitMismatches(init,{...expected,initialized:true})).toEqual(['duplicate_init']);
});
it('rejects actual-shaped init before evidence and aborts once with redacted error fields',async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'claude-init-')));let calls=0,advanced=false,closed=false;let controller:AbortController|undefined;
 const team=randomUUID(),session=randomUUID();const captures:unknown[]=[];
 const input:InferenceInput={system:'PRIVATE_SENTINEL',user:'PRIVATE_SENTINEL',model:'claude-fable-5',credentialTeamId:team,credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'0.2.90',cliVersion:'2.1.263',maxOutputTokens:4096,maxBudgetUsd:2,timeoutMs:1000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'};
 const adapter=new RestrictedClaudeAdapter('0.2.90','2.1.263',{root,cliPath:'/not-invoked',credential:async()=>({kind:'claude-code-oauth',secret:'PRIVATE_SENTINEL',team_id:team}),credentialEnv:()=>({CLAUDE_CODE_OAUTH_TOKEN:'PRIVATE_SENTINEL'}),query:async function*({options}){
  calls++;controller=options.abortController as AbortController;
  expect((options.env as Record<string,string>).CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS).toBe('1');
  expect(options.tools).toEqual([]);expect(options.allowedTools).toEqual([]);expect(options.disallowedTools).toEqual(['*']);expect(options.strictMcpConfig).toBe(true);expect(options.mcpServers).toEqual({});expect(options.plugins).toEqual([]);expect(options.agents).toEqual({});expect(options.settingSources).toEqual([]);
  try{yield {...init,cwd:options.cwd,session_id:session,model:'PRIVATE_SENTINEL',plugins:[{name:'PRIVATE_SENTINEL',path:root}],agents:['PRIVATE_SENTINEL']};advanced=true;}finally{closed=true;}
 }});
 try{
  const failure=await adapter.run(input,session,new AbortController().signal,{runtime:v=>captures.push(v),output:v=>captures.push(v)}).then(()=>null,(e:unknown)=>e);
  // query was invoked; absence of runtime/output does not make a retry safe.
  expect(failure).not.toBeInstanceOf(ProviderRejectedBeforeInference);
  expect(String((failure as Error).message)).toMatch(/^claude_runtime_mismatch:fields=model,plugins\.nonempty:count=1,agents\.nonempty$/);
  expect(calls).toBe(1);expect(advanced).toBe(false);expect(closed).toBe(true);expect(controller?.signal.aborted).toBe(true);expect(captures).toEqual([]);
 }finally{rmSync(root,{recursive:true,force:true});}
});
