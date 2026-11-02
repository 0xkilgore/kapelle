import { mkdtemp, mkdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { outputEvidenceSchema, runtimeEvidenceSchema, ProviderRejectedBeforeInference, type ClaudeAdapter, type InferenceInput } from './execution.js';
import { sha } from './contracts.js';
import { checkProviderContext, providerAccountMatches, providerContextEnv, type ProviderAuthBinding } from './claude-provider-auth.js';
import { ownedClaudeProcesses } from './claude-process.js';

export type UserPrompt = {type:'user';session_id:string;message:{role:'user';content:string};parent_tool_use_id:null};
export type Query = (args: {prompt:string|AsyncIterable<UserPrompt>;options:Record<string,unknown>}) => AsyncIterable<unknown> & {accountInfo?:()=>Promise<unknown>; /** SDK0.2.90 Query.close(): ends the query and its subprocess. */ close?:()=>void};
export type OAuthCredential = {kind:string;secret:string;team_id:string};
/** Built-in plugins bundled in the pinned CLI binary, registered by its wie() (V_e("<name>",...)):
 * cc-plugin-sec-default, cc-plugin-agents-md, cc-plugin-telemetry, cc-plugin-plugin-authoring, cc-plugin-mods-guide,
 * cc-plugin-tips, cc-plugin-mermaid, cc-plugin-responsive-mode, cc-plugin-diff, cc-plugin-you-should-know, cc-plugin-claude-test.
 * Enablement is settings.enabledPlugins["<name>@builtin"] (default on), except cc-plugin-sec-default, which is
 * enabledFromPolicyOnly/enabledFromTrustedSettingsOnly and cannot be turned off by session settings. Keyed by CLI SHA256. */
export const CLI_BUILTIN_PLUGINS: Readonly<Record<string,{disabled:readonly string[];policyOnly:string}>> = Object.freeze({
  '0116ee2e0a513900b633d9951367f18747686478e2b462805b8c31609f047f70': Object.freeze({
    disabled: Object.freeze(['cc-plugin-agents-md','cc-plugin-telemetry','cc-plugin-plugin-authoring','cc-plugin-mods-guide','cc-plugin-tips',
      'cc-plugin-mermaid','cc-plugin-responsive-mode','cc-plugin-diff','cc-plugin-you-should-know','cc-plugin-claude-test']),
    policyOnly: 'cc-plugin-sec-default',
  }),
});
export function disabledBuiltinPlugins(cliSha256:string):Record<string,false> {
  const pin=CLI_BUILTIN_PLUGINS[cliSha256];
  if(!pin) throw new ProviderRejectedBeforeInference('claude_cli_builtin_plugins_unpinned');
  return Object.fromEntries(pin.disabled.map(n=>[n+'@builtin',false])) as Record<string,false>;
}
const builtinName=/^cc-plugin-[a-z-]{1,40}$/;
function pluginLabel(value: unknown[], known: ReadonlySet<string>) {
  const names=value.map(v=>(v&&typeof v==='object'&&typeof (v as any).name==='string'&&builtinName.test((v as any).name)&&known.has((v as any).name))?(v as any).name as string:null);
  return names.every(n=>n!==null)?'plugins.nonempty:'+names.join('+'):'plugins.nonempty:count='+value.length;
}
/** The only plugin ever tolerated: the pinned CLI's policy-only built-in, exactly as the CLI reports a built-in
 * ({name, path:"builtin", source:"<name>@builtin", version?}), and only while every other capability list is empty. */
function onlyPolicyBuiltin(message: Record<string, unknown>, policyOnly: string|undefined) {
  const p=message.plugins;
  if(!policyOnly||!Array.isArray(p)||p.length!==1)return false;
  const e=p[0] as Record<string,unknown>;
  if(!e||typeof e!=='object'||Object.keys(e).some(k=>!['name','path','source','version'].includes(k)))return false;
  if(e.name!==policyOnly||e.path!=='builtin'||e.source!==policyOnly+'@builtin'||(e.version!==undefined&&typeof e.version!=='string'))return false;
  return ['tools','mcp_servers','skills'].every(f=>Array.isArray(message[f])&&!(message[f] as unknown[]).length)&&
    (message.agents===undefined||(Array.isArray(message.agents)&&!(message.agents as unknown[]).length));
}
/** Fixed labels only: never include provider values, paths, IDs or message content. Plugin names appear only when
 * they are the pinned CLI's own built-in names; otherwise a count. */
export function claudeInitMismatches(message: Record<string, unknown>, expected: {
  model: string; cwd: string; cliVersion: string; sessionId: string; initialized: boolean; cliSha256?: string;
}): string[] {
  const fields: string[] = [];
  if (expected.initialized) fields.push('duplicate_init');
  for (const [field, value] of [
    ['model', expected.model], ['cwd', expected.cwd],
    ['claude_code_version', expected.cliVersion], ['session_id', expected.sessionId],
    ['permissionMode', 'dontAsk'],
  ] as const) if (message[field] !== value) fields.push(field);
  const pin=expected.cliSha256===undefined?undefined:CLI_BUILTIN_PLUGINS[expected.cliSha256];
  const known=new Set(pin?[...pin.disabled,pin.policyOnly]:[]);
  for (const field of ['tools', 'mcp_servers', 'plugins', 'skills', 'agents'] as const) {
    const value = message[field];
    // SDK0.2.90 declares agents optional; all other capability lists are required.
    if (field === 'agents' && value === undefined) continue;
    if (!Array.isArray(value)) fields.push(field + '.invalid_array');
    else if (value.length && field === 'plugins') { if (!onlyPolicyBuiltin(message, pin?.policyOnly)) fields.push(pluginLabel(value, known)); }
    else if (value.length) fields.push(field + '.nonempty');
  }
  return fields;
}

export class RestrictedClaudeAdapter implements ClaudeAdapter {
  constructor(readonly sdkVersion:string, readonly cliVersion:string, readonly options:{
    query:Query; providerAuth?:ProviderAuthBinding; credential?:(teamId:string)=>Promise<OAuthCredential|null>;
    credentialEnv?:(credential:OAuthCredential)=>Record<string,string>;
    root:string; cliPath:string; processPins?:import('./claude-process.js').ProcessPin[];
    /** Bound on waiting for an init frame before releasing the prompt (provider-binding mode); default 3 s. */
    initTimeoutMs?:number;
  }) {}
  async run(input:InferenceInput, sessionId:string, signal:AbortSignal, capture:Parameters<ClaudeAdapter['run']>[3]) {
    signal.throwIfAborted();
    const binding=this.options.providerAuth;
    let authEnv:Record<string,string>;
    if(binding) {
      if(binding.teamId!==input.credentialTeamId || input.credentialKind!=='claude-code-oauth' ||
         binding.cliVersion!==this.cliVersion || binding.sdkVersion!==this.sdkVersion ||
         input.cliVersion!==this.cliVersion || input.sdkVersion!==this.sdkVersion)
        throw new ProviderRejectedBeforeInference('claude_provider_binding_mismatch');
      disabledBuiltinPlugins(binding.cliSha256); // refuses an unpinned CLI before launch
      try{await checkProviderContext(binding);}catch{throw new ProviderRejectedBeforeInference('claude_provider_context_invalid');}
      authEnv=providerContextEnv(binding);
    } else {
      // Existing mode stays fail-closed; never fall through to provider login.
      const credential=await this.options.credential?.(input.credentialTeamId);
      if(!credential || credential.kind!=='claude-code-oauth' || credential.team_id!==input.credentialTeamId)
        throw new ProviderRejectedBeforeInference('claude_oauth_not_available');
      const oauth=this.options.credentialEnv?.(credential).CLAUDE_CODE_OAUTH_TOKEN;
      if(!oauth || oauth.length<8)throw new ProviderRejectedBeforeInference('claude_oauth_not_available');
      authEnv={CLAUDE_CODE_OAUTH_TOKEN:oauth};
    }
    await mkdir(this.options.root,{recursive:true,mode:0o700});
    const s = await lstat(this.options.root);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077) || await realpath(this.options.root) !== resolve(this.options.root))
      throw new ProviderRejectedBeforeInference('claude_private_runtime_required');
    const cwd = await mkdtemp(join(this.options.root,'review-'));
    const controller = new AbortController();
    let queryStarted=false,uncertain=false,captureFailed=false;
    const markUncertain=()=>{
      if(captureFailed)throw Error('claude_uncertainty_persistence_failed');
      if(!queryStarted||uncertain)return;
      uncertain=true;
      try{capture.uncertain?.();}catch{captureFailed=true;throw Error('claude_uncertainty_persistence_failed');}
    };
    const processes=ownedClaudeProcesses({auditPath:join(cwd,'termination-audit.json'),record:capture.ownership,uncertain:markUncertain,pins:this.options.processPins});
    const abort = () => {try{markUncertain();}catch{/* Durable ownership fence prevents restart. */}processes.cancel();controller.abort();};
    signal.addEventListener('abort',abort,{once:true});
    if (signal.aborted) controller.abort();
    const timer = setTimeout(abort,input.timeoutMs);
    let initialized = false, returned = false,success=false;
    let releasePrompt:((allowed:boolean)=>void)|undefined;
    let activeQuery:{close?:()=>void}|undefined;
    try {
      const options:Record<string,unknown> = {
        cwd, systemPrompt:input.system, model:input.model, sessionId,
        tools:[], allowedTools:[], disallowedTools:['*'], mcpServers:{}, strictMcpConfig:true,
        extraArgs:{'safe-mode':null,'disable-slash-commands':null},
        plugins:[], agents:{}, hooks:{}, settingSources:[],
        settings:{disableAllHooks:true,switchModelsOnFlag:false,availableModels:[input.model],fallbackModel:[],
          ...(binding?{enabledPlugins:disabledBuiltinPlugins(binding.cliSha256)}:{})},
        permissionMode:'dontAsk', allowDangerouslySkipPermissions:false,
        canUseTool:async()=>({behavior:'deny',message:'This reviewer has no tools.'}),
        maxTurns:1, maxBudgetUsd:input.maxBudgetUsd, abortController:controller,
        thinking:{type:input.thinking}, effort:input.effort, agentProgressSummaries:false,
        persistSession:true, pathToClaudeCodeExecutable:this.options.cliPath,
        // SDK uses this map as the child environment; never spread process.env here.
        env:{HOME:cwd,CLAUDE_CONFIG_DIR:join(cwd,'.claude'),TMPDIR:cwd,
          PATH:'/usr/bin:/bin',...authEnv,
          CLAUDE_CODE_MAX_OUTPUT_TOKENS:String(input.maxOutputTokens),
          CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS:'1',
          // Pinned CLI otherwise generates a Haiku session title in headless mode.
          CLAUDE_CODE_DISABLE_TERMINAL_TITLE:'1',
          DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'},
        executable:process.execPath,
        spawnClaudeCodeProcess:processes.spawn,
      };
      controller.signal.throwIfAborted();
      queryStarted=true;
      let prompt:string|AsyncIterable<UserPrompt>=input.user;
      if(binding) {
        const ready=new Promise<boolean>(resolve=>{releasePrompt=resolve;});
        prompt=(async function*(){if(await ready && !controller.signal.aborted)yield {type:'user' as const,session_id:sessionId,message:{role:'user' as const,content:input.user},parent_tool_use_id:null};})();
      }
      const query=this.options.query({prompt,options});activeQuery=query;
      const handle=(raw:unknown)=>{
        if (controller.signal.aborted||uncertain) throw Error('claude_interrupted');
        processes.assertIdentified();
        const m = raw as any;
        if (!m || typeof m !== 'object') throw Error('claude_invalid_message');
        if (!(m.type === 'system' && m.subtype === 'init') && m.session_id && m.session_id !== sessionId) throw Error('claude_session_mismatch');
        if (m.type === 'system' && m.subtype === 'init') {
          const mismatches = claudeInitMismatches(m, {model:input.model,cwd,cliVersion:this.cliVersion,sessionId,initialized,cliSha256:binding?.cliSha256});
          // Eager init (binding mode): the prompt is still withheld, so a mismatch refuses before user content is sent.
          // Late init, or no binding: the prompt was already released, so a mismatch may follow a provider request
          // and is not zero-spend. Either way the attempt is not released and no output is captured. Labels only.
          if (mismatches.length) throw new Error('claude_runtime_mismatch:fields=' + mismatches.join(','));
          capture.runtime(runtimeEvidenceSchema.parse({provider:'anthropic',runtime:'claude-agent-sdk',model:m.model,
            sessionId:m.session_id,sdkVersion:this.sdkVersion,cliVersion:m.claude_code_version,tools:[]}));
          initialized = true;
        } else if (m.type === 'assistant') {
          if (!initialized || returned || m.message?.model !== input.model ||
              !Array.isArray(m.message?.content) || m.message.content.some((b:any)=>!['text','thinking','redacted_thinking'].includes(b.type))) throw Error('claude_unexpected_assistant');
        } else if (m.type === 'result') {
          if (!initialized || returned || m.subtype !== 'success' || m.is_error !== false || m.stop_reason !== 'end_turn' ||
              m.session_id !== sessionId || typeof m.result !== 'string' || !m.result.trim() ||
              m.num_turns !== 1 || !Array.isArray(m.permission_denials) || m.permission_denials.length ||
              m.deferred_tool_use || m.structured_output !== undefined ||
              !m.modelUsage || Object.keys(m.modelUsage).length!==1 || Object.keys(m.modelUsage).some(k=>k !== input.model)) throw Error('claude_incomplete_result');
          capture.output(outputEvidenceSchema.parse({text:m.result,contentHash:sha(m.result),byteSize:Buffer.byteLength(m.result),
            stopReason:'end_turn',resultId:m.uuid,costUsd:m.total_cost_usd}));
          returned = true;
        } else if (m.type === 'system' && m.subtype === 'status') {
          // CLI2.1.295 yields {subtype:"status",status:"requesting"} on stream_request_start and status:null after
          // sdk_status; both carry no content. Compaction ("compacting" or any compact_* field) stays refused.
          if ((m.status !== 'requesting' && m.status !== null) || 'compact_result' in m || 'compact_error' in m || 'compact_output_chars' in m)
            throw Error('claude_unexpected_status');
        } else if (m.type === 'system' && m.subtype === 'api_retry') {
          // The CLI's own bounded retry of the same request in the same session (SDK0.2.90 SDKAPIRetryMessage; CLI2.1.295 adds
          // optional no_response:{waited_ms,retry_wait_ms} for a first-byte timeout). No content, no new attempt. Only transient
          // causes (CLI ukn(): 529 overloaded, 429 rate_limit, >=408 server_error, connection unknown); auth, billing, invalid
          // request and max_output_tokens stay refused.
          const keys=['type','subtype','attempt','max_retries','retry_delay_ms','error_status','error','no_response','uuid','session_id'];
          const nr=m.no_response;
          if (returned || m.session_id !== sessionId || Object.keys(m).some(k=>!keys.includes(k)) ||
              !['rate_limit','overloaded','server_error','unknown'].includes(m.error) ||
              !Number.isSafeInteger(m.attempt) || !Number.isSafeInteger(m.max_retries) || m.attempt < 1 || m.attempt > m.max_retries ||
              !Number.isFinite(m.retry_delay_ms) || m.retry_delay_ms < 0 ||
              (m.error_status !== null && !(Number.isSafeInteger(m.error_status) && (m.error_status === 408 || m.error_status === 429 || (m.error_status >= 500 && m.error_status < 600)))) ||
              (nr !== undefined && (!nr || typeof nr !== 'object' || Array.isArray(nr) || Object.keys(nr).length !== 2 ||
                !Number.isFinite(nr.waited_ms) || nr.waited_ms < 0 || !Number.isFinite(nr.retry_wait_ms) || nr.retry_wait_ms < 0)))
            throw Error('claude_unexpected_retry');
        } else if (m.type === 'system' && m.subtype === 'api_error') {
          // CLI2.1.295 passes its internal retry record (s1()) through before the api_retry twin. Accepted only as that exact
          // record of a retry in progress; its error object is never read, stored or forwarded. A terminal API error has no
          // retry counters and is still refused; the final result checks are unchanged.
          const keys=['type','subtype','level','error','retryInMs','retryAttempt','maxRetries','source','timestamp','uuid','session_id'];
          if (returned || m.session_id !== sessionId || Object.keys(m).some(k=>!keys.includes(k)) || m.level !== 'error' ||
              !m.error || typeof m.error !== 'object' || !Number.isSafeInteger(m.retryAttempt) || !Number.isSafeInteger(m.maxRetries) ||
              m.retryAttempt < 1 || m.retryAttempt > m.maxRetries || !Number.isFinite(m.retryInMs) || m.retryInMs < 0)
            throw Error('claude_unexpected_retry');
        } else if (m.type === 'system' && m.subtype === 'thinking_tokens') {
          // CLI2.1.295 engine twin of each thinking/signature stream delta (census 2026-10-14: 26 frames, exactly these keys).
          // A token-count estimate only: no content, never stored. Allowed only after init and before the result, same session.
          const keys=['type','subtype','estimated_tokens','estimated_tokens_delta','session_id','uuid'];
          if (!initialized || returned || m.session_id !== sessionId || Object.keys(m).some(k=>!keys.includes(k)) ||
              !Number.isFinite(m.estimated_tokens) || m.estimated_tokens < 0 || !Number.isFinite(m.estimated_tokens_delta) || m.estimated_tokens_delta < 0)
            throw Error('claude_unexpected_progress');
        } else if (m.type === 'rate_limit_event') {
          // Census shape: {type, rate_limit_info, session_id, uuid}; rate_limit_info is never read or stored.
          const keys=['type','rate_limit_info','session_id','uuid'];
          if (m.session_id !== sessionId || Object.keys(m).some(k=>!keys.includes(k)) || !m.rate_limit_info || typeof m.rate_limit_info !== 'object')
            throw Error('claude_unexpected_rate_limit');
        } else {
          throw Error('claude_unexpected_message');
        }
      };
      const messages=(query as AsyncIterable<unknown>)[Symbol.asyncIterator]();
      let carried:Promise<IteratorResult<unknown>>|undefined;
      // Every read after the gate (including a carried one) races the abort: a stalled SDK read must not keep
      // control from reaching cleanup. Losing promises keep a rejection handler; awaiting them still throws.
      let stopRead:()=>void=()=>{};
      const stopped=new Promise<never>((_,reject)=>{stopRead=()=>reject(Error('claude_interrupted'));controller.signal.addEventListener('abort',stopRead,{once:true});});
      stopped.catch(()=>{});
      const read=(pending?:Promise<IteratorResult<unknown>>)=>{
        if(controller.signal.aborted)throw Error('claude_interrupted');
        const next=pending??messages.next();next.catch(()=>{});
        return Promise.race([next,stopped]);
      };
      // Manual iteration must still close the SDK stream on every exit, as for-await did. Not awaited: a stalled
      // pending next() must not block teardown; the abort controller below still ends the child.
      try {
      if(binding) {
        // SDK0.2.90 initializes independently of async prompt consumption. Withhold the user message until
        // this same child's account is verified, and verify init first if the CLI emits it before reading the prompt.
        // No second CLI. The late-init fallback below can release the prompt before init is checked (not zero-spend).
        if(!query.accountInfo)throw Error('claude_provider_account_unavailable');
        let abortGate:()=>void=()=>{};
        const aborted=new Promise<never>((_,reject)=>{abortGate=()=>reject(Error('claude_provider_account_interrupted'));controller.signal.addEventListener('abort',abortGate,{once:true});});
        let initTimer:ReturnType<typeof setTimeout>|undefined;
        try {
          controller.signal.throwIfAborted();
          const account=await Promise.race([query.accountInfo(),aborted]);
          processes.assertIdentified();
          controller.signal.throwIfAborted();
          if(!providerAccountMatches(account,binding))throw Error('claude_provider_account_mismatch');
          // If the CLI emits init before consuming the prompt, verify it now: a mismatch then refuses with no
          // user content sent. CLI2.1.295 builds init per query, so it may only arrive after the prompt; after a
          // short bound the prompt is released and the identical check runs on arrival (nothing is skipped).
          const initDeadline=new Promise<'deferred'>(resolve=>{initTimer=setTimeout(()=>resolve('deferred'),this.options.initTimeoutMs??3_000);});
          while(!initialized) {
            const pending=carried??messages.next();carried=undefined;
            pending.catch(()=>{}); // a losing race must not leave an unhandled rejection; awaiting it still throws
            const next=await Promise.race([pending,aborted,initDeadline]);
            if(next==='deferred'){carried=pending;break;}
            if(next.done)throw Error('claude_init_unavailable');
            handle(next.value);
          }
          releasePrompt!(true);
        } finally {clearTimeout(initTimer);controller.signal.removeEventListener('abort',abortGate);}
      }
      for(;;) {
        const pending=carried;carried=undefined;
        const next=await read(pending);
        if(next.done)break;
        handle(next.value);
      }
      } finally {
        controller.signal.removeEventListener('abort',stopRead);
        const closing=messages.return?.();closing?.catch(()=>{}); // a request only; not proof the generator closed
      }
      if (!initialized || !returned || controller.signal.aborted) throw Error('claude_completion_unconfirmed');
      success=true;
    } catch(error) {
      try{markUncertain();}finally{
        // SDK0.2.90 Query.close() ends the query and its subprocess; the subprocess is ours (processes.spawn), so
        // any signal it requests is reduced to graceful SIGTERM and the ownership fence below still waits for close.
        try{activeQuery?.close?.();}catch{/* cleanup request only */}
        processes.cancel();controller.abort();
      }throw error;
    } finally {
      releasePrompt?.(false);
      // A valid result gets two seconds for natural exit. Cancellation is graceful-only.
      // Never abort normal success solely to tear down SDK bookkeeping.
      try{await processes.drain(success);}finally{
        clearTimeout(timer);signal.removeEventListener('abort',abort);
      }
    }
    if(uncertain||captureFailed)throw Error('claude_completion_unconfirmed');
  }
}
