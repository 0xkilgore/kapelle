import {RestrictedWorker} from '../src/worker/worker.js';
import {fixtureSources,work} from './fixtures/restricted-claude.js';
import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,chmod,rm,realpath,symlink} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {providerContextEnv,providerAuthBindingSchema,providerAuthPath,readProviderAuthBinding,providerAccountMatches,type ProviderAuthBinding} from '../src/worker/claude-provider-auth.js';
import {RestrictedClaudeAdapter,type Query,type UserPrompt} from '../src/worker/claude-adapter.js';
import {loadRestrictedClaudeAdapter} from '../src/worker/claude-host.js';
import {ProviderRejectedBeforeInference,type InferenceInput} from '../src/worker/execution.js';

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(personal=false){
 const root=await realpath(await mkdtemp(join(tmpdir(),'provider-auth-')));
 const configDir=join(root,'owner-context');await mkdir(configDir,{mode:0o700});
 const organizationBinding:ProviderAuthBinding={mode:'provider-managed',uid:process.getuid!(),teamId:randomUUID(),configDir,email:'owner@example.invalid',organization:'Synthetic owner org',subscriptionType:'max',cliVersion:'2.1.295',cliSha256:'0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70' /* pinned CLI2.1.295; built-in plugin list keyed by it */,sdkVersion:'0.2.90',sdkSha256:hash('fake SDK')};
 const {organization,...common}=organizationBinding;
 const binding:ProviderAuthBinding=personal?{...common,accountBinding:'personal-email-plan',subscriptionType:'max',cliVersion:'2.1.295'}:organizationBinding;
 const account={apiProvider:'firstParty',email:binding.email,organization,subscriptionType:personal?'Claude Max':'max'};
 const input:InferenceInput={system:'Synthetic system',user:'Synthetic Task body',model:'claude-fable-5',credentialTeamId:binding.teamId,credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'0.2.90',cliVersion:binding.cliVersion,maxOutputTokens:4096,maxBudgetUsd:2,timeoutMs:500,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'};
 return {root,binding,account,input,close:()=>rm(root,{recursive:true,force:true})};
}
it('requires explicit mode, rejects stale binding in existing mode and unknown modes',()=>{
 expect(providerAuthPath({})).toBeUndefined();expect(providerAuthPath({KAPELLE_CLAUDE_AUTH_MODE:'manager-oauth'})).toBeUndefined();
 for(const env of [{KAPELLE_CLAUDE_AUTH_BINDING_FILE:'/x'},{KAPELLE_CLAUDE_AUTH_MODE:'provider-managed'},{KAPELLE_CLAUDE_AUTH_MODE:'ambient'}])expect(()=>providerAuthPath(env)).toThrow();
 expect(providerAuthPath({KAPELLE_CLAUDE_AUTH_MODE:'provider-managed',KAPELLE_CLAUDE_AUTH_BINDING_FILE:'/x'})).toBe('/x');
});
it('accepts a private explicit binding and rejects permissions, links, unknown fields and wrong uid',async()=>{
 const f=await fixture(),file=join(f.root,'binding.json');
 try{
  await writeFile(file,JSON.stringify(f.binding),{mode:0o600});expect(await readProviderAuthBinding(file)).toEqual(f.binding);
  await chmod(file,0o644);await expect(readProviderAuthBinding(file)).rejects.toThrow();await chmod(file,0o600);
  const alias=join(f.root,'alias');await symlink(file,alias);await expect(readProviderAuthBinding(alias)).rejects.toThrow();
  for(const b of [{...f.binding,uid:f.binding.uid+1},{...f.binding,fallback:'api-key'},{...f.binding,configDir:join(f.root,'missing')}]){
   await writeFile(file,JSON.stringify(b));await expect(readProviderAuthBinding(file)).rejects.toThrow();
  }
 }finally{await f.close();}
});
it('rejects missing/wrong account, Console, cloud, API key and injected-token identities',async()=>{
 const f=await fixture();try{
 expect(providerAccountMatches(f.account,f.binding)).toBe(true);
 for(const a of [null,{}, {...f.account,email:'other@example.invalid'},{...f.account,organization:'other'}, {...f.account,subscriptionType:'enterprise'}, {...f.account,apiProvider:'bedrock'}, {...f.account,apiKeySource:'/login managed key'}, {...f.account,tokenSource:'CLAUDE_CODE_OAUTH_TOKEN'}])expect(providerAccountMatches(a,f.binding)).toBe(false);
 }finally{await f.close();}
});

function queryFixture(f:Awaited<ReturnType<typeof fixture>>,account:()=>Promise<unknown>){
 let promptRead=false,options:Record<string,unknown>={},calls=0,accountChecked=false;
 const query:Query=({prompt,options:o})=>{
  calls++;options=o;
  // Like SDK0.2.90, begin consuming the prompt immediately, before accountInfo.
  const messages:UserPrompt[]=[];
  const inputDone=(async()=>{for await(const message of prompt as AsyncIterable<UserPrompt>){
   expect(accountChecked).toBe(true);expect(message.message.content).toBe(f.input.user);promptRead=true;messages.push(message);
  }})();
  const stream=(async function*(){
   await inputDone;
   for(const message of messages){
    yield {type:'system',subtype:'init',model:f.input.model,cwd:o.cwd,claude_code_version:f.binding.cliVersion,session_id:'a321f6a3-346b-4663-a9d2-9b5685418ba1',permissionMode:'dontAsk',tools:[],mcp_servers:[],plugins:[],skills:[],agents:[]};
    yield {type:'result',subtype:'success',is_error:false,stop_reason:'end_turn',session_id:'a321f6a3-346b-4663-a9d2-9b5685418ba1',result:'Synthetic result',num_turns:1,permission_denials:[],modelUsage:{[f.input.model]:{}},uuid:randomUUID(),total_cost_usd:0};
   }
  })();
  return Object.assign(stream,{accountInfo:async()=>{const a=await account();accountChecked=true;return a;}});
 };
 const credential=vi.fn(async()=>{throw Error('Manager must not be read');});
 const adapter=new RestrictedClaudeAdapter('0.2.90',f.binding.cliVersion,{root:join(f.root,'jobs'),cliPath:'/never-launched',providerAuth:f.binding,initTimeoutMs:20,credential,query});
 return {adapter,credential,read:()=>({promptRead,options,calls})};
}
it.each([false,true])('releases one prompt only after matching the same child account; keeps restrictions and fresh HOME/cwd personal=%s',async(personal)=>{
 const f=await fixture(personal),q=queryFixture(f,async()=>f.account);const captures:unknown[]=[];
 vi.stubEnv('ANTHROPIC_API_KEY','ambient-must-not-leak');vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR','ambient-must-not-leak');
 try{
 await q.adapter.run(f.input,'a321f6a3-346b-4663-a9d2-9b5685418ba1',new AbortController().signal,{runtime:v=>captures.push(v),output:v=>captures.push(v)});
 const {promptRead,options:o,calls}=q.read(),env=o.env as Record<string,string>;
 expect(promptRead).toBe(true);expect(calls).toBe(1);expect(q.credential).not.toHaveBeenCalled();expect(captures).toHaveLength(2);
 expect(env.CLAUDE_CONFIG_DIR).toBe(f.binding.configDir);expect(env.HOME).toBe(o.cwd);expect(env.HOME).not.toBe(f.binding.configDir);expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();expect(env.ANTHROPIC_API_KEY).toBeUndefined();expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
 expect(o.tools).toEqual([]);expect(o.hooks).toEqual({});expect(o.settingSources).toEqual([]);expect(o.plugins).toEqual([]);expect(o.agents).toEqual({});expect(o.extraArgs).toEqual({'safe-mode':null,'disable-slash-commands':null});expect(o.permissionMode).toBe('dontAsk');
 }finally{vi.unstubAllEnvs();await f.close();}
});
it.each([false,true])('withholds prompt on account mismatch and preserves uncertain accounting after query starts personal=%s',async(personal)=>{
 const f=await fixture(personal),q=queryFixture(f,async()=>({...f.account,email:'wrong@example.invalid'}));const uncertain=vi.fn(),output=vi.fn();
 try{
 await expect(q.adapter.run(f.input,'a321f6a3-346b-4663-a9d2-9b5685418ba1',new AbortController().signal,{runtime:vi.fn(),output,uncertain})).rejects.toThrow('claude_provider_account_mismatch');
 expect(q.read().promptRead).toBe(false);expect(q.read().calls).toBe(1);expect(uncertain).toHaveBeenCalledOnce();expect(output).not.toHaveBeenCalled();expect((q.read().options.abortController as AbortController).signal.aborted).toBe(true);
 }finally{await f.close();}
});
it('settles a stalled account check through existing cancellation without releasing prompt',async()=>{
 const f=await fixture(),q=queryFixture(f,()=>new Promise(()=>{}));
 try{
 await expect(q.adapter.run({...f.input,timeoutMs:20},'a321f6a3-346b-4663-a9d2-9b5685418ba1',new AbortController().signal,{runtime:vi.fn(),output:vi.fn()})).rejects.toThrow('claude_provider_account_interrupted');
 expect(q.read().promptRead).toBe(false);
 }finally{await f.close();}
});
it('rejects wrong Task team before query and never enables fallback in existing mode',async()=>{
 const f=await fixture(),q=queryFixture(f,async()=>f.account),query=vi.fn();
 try{
 for(const input of [{...f.input,credentialTeamId:randomUUID()},{...f.input,cliVersion:'2.1.263'},{...f.input,sdkVersion:'wrong'}])await expect(q.adapter.run(input,'x',new AbortController().signal,{runtime:vi.fn(),output:vi.fn()})).rejects.toBeInstanceOf(ProviderRejectedBeforeInference);expect(q.read().calls).toBe(0);
 const existing=new RestrictedClaudeAdapter('0.2.90',f.binding.cliVersion,{root:f.root,cliPath:'/never-launched',query,credential:async()=>null});
 await expect(existing.run(f.input,'x',new AbortController().signal,{runtime:vi.fn(),output:vi.fn()})).rejects.toThrow('claude_oauth_not_available');expect(query).not.toHaveBeenCalled();
 }finally{await f.close();}
});
it('host refuses runtime pin mismatch before SDK import or CLI execution; matched mode never imports Manager auth',async()=>{
 const f=await fixture(),manager=join(f.root,'manager'),sdkDir=join(manager,'node_modules/@anthropic-ai/claude-agent-sdk'),file=join(f.root,'binding.json'),cli=join(f.root,'not-executable');
 try{
 await mkdir(sdkDir,{recursive:true});await writeFile(join(manager,'package.json'),'{}');
 await writeFile(join(sdkDir,'package.json'),JSON.stringify({version:'0.2.90',type:'module',main:'sdk.mjs'}));
 const source='globalThis.__kapelleProviderSdkImported=true;export function query(){throw Error("offline mock must never query")}';
 await writeFile(join(sdkDir,'sdk.mjs'),source);await writeFile(cli,'not executable');
 const b={...f.binding,cliSha256:hash('not executable'),sdkSha256:hash(source)};
 await writeFile(file,JSON.stringify({...b,cliSha256:'0'.repeat(64)}),{mode:0o600});
 const opts={managerRoot:manager,cliPath:cli,runtimeRoot:join(f.root,'jobs'),providerAuthBindingFile:file};
 await expect(loadRestrictedClaudeAdapter(opts)).rejects.toThrow('claude_provider_runtime_pin_mismatch');
 expect((globalThis as any).__kapelleProviderSdkImported).toBeUndefined();
 await writeFile(file,JSON.stringify(b));const adapter=await loadRestrictedClaudeAdapter(opts);expect(adapter.cliVersion).toBe(b.cliVersion);expect(adapter.options.credential).toBeUndefined();expect(adapter.options.providerAuth).toEqual(b);expect((globalThis as any).__kapelleProviderSdkImported).toBe(true);delete (globalThis as any).__kapelleProviderSdkImported;
 }finally{await f.close();}
});

it('rejects context permission drift before querying',async()=>{
 const f=await fixture(),q=queryFixture(f,async()=>f.account);
 try{
  await chmod(f.binding.configDir,0o755);
  await expect(q.adapter.run(f.input,'x',new AbortController().signal,{runtime:vi.fn(),output:vi.fn()})).rejects.toBeInstanceOf(ProviderRejectedBeforeInference);
  expect(q.read().calls).toBe(0);
 }finally{await f.close();}
});

it('personal Max schema requires explicit opt-in, exact pinned version and no organization field',async()=>{
 const f=await fixture(true);try{
  expect(providerAuthBindingSchema.parse(f.binding)).toEqual(f.binding);
  const {accountBinding,...withoutOptIn}=f.binding;
  for(const binding of [withoutOptIn,{...f.binding,accountBinding:'personal'}, {...f.binding,subscriptionType:'pro'}, {...f.binding,subscriptionType:'Claude Max'}, {...f.binding,cliVersion:'2.1.296'}, {...f.binding,organization:'unused'}, {...f.binding,organization:null}, {...f.binding,organizationId:randomUUID()}])
   expect(providerAuthBindingSchema.safeParse(binding).success).toBe(false);
  const file=join(f.root,'binding.json');await writeFile(file,JSON.stringify(f.binding),{mode:0o600});expect(await readProviderAuthBinding(file)).toEqual(f.binding);
 }finally{await f.close();}
});
it('personal Max matches exact email and display label, ignores organization only by explicit choice',async()=>{
 const f=await fixture(true),strict=await fixture();try{
  const {organization,...noOrg}=f.account;
  for(const account of [noOrg,{...noOrg,organization:'unverified display'}, {...noOrg,organization:null}])expect(providerAccountMatches(account,f.binding)).toBe(true);
  for(const change of [{email:'other@example.invalid'},{email:'Owner@example.invalid'}, {email:'owner@example.invalid '}, {email:undefined}, {subscriptionType:'max'}, {subscriptionType:'Claude Pro'}, {subscriptionType:'Claude Max '}, {subscriptionType:undefined}, {subscriptionType:'Claude Enterprise'}, {apiProvider:'bedrock'}, {apiProvider:undefined}, {apiKeySource:'/login managed key'}, {tokenSource:'CLAUDE_CODE_OAUTH_TOKEN'}, {tokenSource:'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR'}])expect(providerAccountMatches({...noOrg,...change},f.binding)).toBe(false);
  expect(providerAccountMatches(null,f.binding)).toBe(false);
  expect(providerAccountMatches(strict.account,strict.binding)).toBe(true);
  for(const account of [{...strict.account,organization:undefined}, {...strict.account,organization:'other'}, {...strict.account,subscriptionType:'Claude Max'}])expect(providerAccountMatches(account,strict.binding)).toBe(false);
 }finally{await f.close();await strict.close();}
});
it.each([undefined,'Different unasserted organization'])('personal Max releases eager prompt with organization=%s only after same-child account check',async(organization)=>{
 const f=await fixture(true),q=queryFixture(f,async()=>({...f.account,organization}));try{
  await q.adapter.run(f.input,'a321f6a3-346b-4663-a9d2-9b5685418ba1',new AbortController().signal,{runtime:vi.fn(),output:vi.fn()});
  expect(q.read().promptRead).toBe(true);expect(q.read().calls).toBe(1);expect(q.credential).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it.each(['email','plan'])('personal Max %s mismatch remains uncertain after reopen with no automatic or explicit replay',async(field)=>{
 const f=await fixture(true),sources=fixtureSources();f.binding={...f.binding,credentialHome:'os-user'};sources.binding.credentialTeamId=f.binding.teamId;
 const q=queryFixture(f,async()=>({...f.account,...(field==='email'?{email:'wrong@example.invalid'}:{subscriptionType:'Claude Pro'})}));
 const root=join(f.root,'worker');let worker=await RestrictedWorker.open(root,sources.authority,sources.sources,fetch,q.adapter);
 try{
  await expect(worker.run(work)).rejects.toThrow('claude_execution_unconfirmed');
  expect(worker.execution(work.dispatchId)?.phase).toBe('uncertain');expect(q.read().promptRead).toBe(false);expect(q.read().calls).toBe(1);
  worker.close();worker=await RestrictedWorker.open(root,sources.authority,sources.sources,fetch,q.adapter);
  await expect(worker.run(work)).rejects.toThrow();expect(worker.execution(work.dispatchId)?.phase).toBe('uncertain');expect(q.read().calls).toBe(1);
 }finally{worker.close();await f.close();}
});

it('OS-user HOME requires exact opt-in and never changes the default provider environment',async()=>{
 const f=await fixture(true);try{
  expect(providerContextEnv(f.binding)).not.toHaveProperty('HOME');
  const binding={...f.binding,credentialHome:'os-user' as const};
  expect(providerAuthBindingSchema.parse(binding)).toEqual(binding);
  for(const credentialHome of ['ambient','/var/someone','',null])expect(providerAuthBindingSchema.safeParse({...f.binding,credentialHome}).success).toBe(false);
  vi.stubEnv('HOME','/never-use-ambient-home');vi.stubEnv('USER','never-use-ambient-user');
  expect(providerContextEnv(binding)).toEqual({HOME:userInfo().homedir,USER:userInfo().username,LOGNAME:userInfo().username,CLAUDE_CONFIG_DIR:f.binding.configDir});
 }finally{vi.unstubAllEnvs();await f.close();}
});
it.each([false,true])('explicit OS HOME preserves private cwd/TMPDIR, account gate and restrictions mismatch=%s',async(mismatch)=>{
 const f=await fixture(true);f.binding={...f.binding,credentialHome:'os-user'};
 const q=queryFixture(f,async()=>({...f.account,...(mismatch?{email:'wrong@example.invalid'}:{})})),uncertain=vi.fn(),output=vi.fn();
 vi.stubEnv('HOME','/never-use-ambient-home');vi.stubEnv('ANTHROPIC_API_KEY','ambient-must-not-leak');
 try{
  const run=q.adapter.run(f.input,'a321f6a3-346b-4663-a9d2-9b5685418ba1',new AbortController().signal,{runtime:vi.fn(),output,uncertain});
  if(mismatch){await expect(run).rejects.toThrow('claude_provider_account_mismatch');expect(uncertain).toHaveBeenCalledOnce();expect(output).not.toHaveBeenCalled();expect((q.read().options.abortController as AbortController).signal.aborted).toBe(true);}else await run;
  const {options:o,calls,promptRead}=q.read(),env=o.env as Record<string,string>;
  expect(calls).toBe(1);expect(promptRead).toBe(!mismatch);expect(q.credential).not.toHaveBeenCalled();
  expect(env.HOME).toBe(userInfo().homedir);expect(o.cwd).not.toBe(env.HOME);expect(env.TMPDIR).toBe(o.cwd);expect(String(o.cwd)).toContain(join(f.root,'jobs','review-'));
  expect(env.CLAUDE_CONFIG_DIR).toBe(f.binding.configDir);expect(env.USER).toBe(userInfo().username);expect(env.LOGNAME).toBe(userInfo().username);
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
  expect(o.settingSources).toEqual([]);expect(o.tools).toEqual([]);expect(o.hooks).toEqual({});expect(o.plugins).toEqual([]);expect(o.agents).toEqual({});expect(o.extraArgs).toEqual({'safe-mode':null,'disable-slash-commands':null});expect(o.permissionMode).toBe('dontAsk');
 }finally{vi.unstubAllEnvs();await f.close();}
});
