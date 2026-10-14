import {it,expect} from 'vitest';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RestrictedClaudeAdapter} from '../src/worker/claude-adapter.js';
import type {InferenceInput} from '../src/worker/execution.js';
for(const mode of ['preaborted','during','timeout'] as const)it(`restricted provider abort: ${mode}; no completion or fallback`,async()=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'claude-abort-'))),team=randomUUID();let calls=0,captured=0,credentials=0;
 const controller=new AbortController();if(mode==='preaborted')controller.abort();
 const input:InferenceInput={system:'Fixture',user:'Fixture',model:'fixture',credentialTeamId:team,credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'fixture',cliVersion:'fixture',maxOutputTokens:1000,maxBudgetUsd:1,timeoutMs:20,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'};
 const adapter=new RestrictedClaudeAdapter('fixture','fixture',{root,cliPath:'/unused',credential:async()=>{credentials++;return {kind:'claude-code-oauth',secret:'fixture-only',team_id:team};},credentialEnv:()=>({CLAUDE_CODE_OAUTH_TOKEN:'fixture-only-not-real'}),query:async function*({options}){
  calls++;const sdkController=options.abortController as AbortController;
  expect(options.tools).toEqual([]);expect(options.mcpServers).toEqual({});
  if(mode==='during')controller.abort();
  if(!sdkController.signal.aborted)await new Promise<void>(r=>sdkController.signal.addEventListener('abort',()=>r(),{once:true}));
  throw Error('fixture SDK observed abort');yield undefined;
 }});
 try{await expect(adapter.run(input,randomUUID(),controller.signal,{runtime:()=>{captured++;},output:()=>{captured++;}})).rejects.toThrow();
  expect(calls).toBe(mode==='preaborted'?0:1);expect(credentials).toBe(mode==='preaborted'?0:1);expect(captured).toBe(0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
