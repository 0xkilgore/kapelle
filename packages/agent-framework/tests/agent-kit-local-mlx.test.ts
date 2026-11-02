// local-mlx adapter (LOCAL-MLX-ADAPTER-SPEC), offline: FAKE transport only (no model server is started or contacted); the
// REAL vendored Pi loop; a real durable reservation on disk.
import {describe, it, expect, beforeEach} from 'vitest';
import {mkdtempSync, realpathSync, cpSync, appendFileSync, writeFileSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {claudeProfileFromBinding, profileHash, runtimeProfileSchema, localProfileSchema, localInferenceFor, inferenceFor, claudeInferenceFor} from '../src/agent-kit/runtime-catalog.js';
import {localInferenceInputSchema, sameRuntimeBranch, ProviderRejectedBeforeInference, isRetryablePreInferenceReason, type LocalOutputEvidence, type LocalRuntimeEvidence} from '../src/worker/execution.js';
import {executionReceiptSchema, taskWorkerBindingSchema} from '../src/task-delegation/worker-contract.js';
import {mlxComplete, mlxRequestBody, MlxTransportError, type MlxFetch} from '../src/agent-kit/local-mlx/transport.js';
import {openLocalMlxAdapter, vendoredPiDigest, VENDOR_DIR} from '../src/agent-kit/local-mlx/adapter.js';
import {RuntimeReservation} from '../src/agent-kit/local-mlx/reservation.js';
import {runAgentLoop, UnsolicitedToolCall} from '../src/agent-kit/local-mlx/vendor/pi/agent-loop.js';
import {AssistantMessageEventStream} from '../src/agent-kit/local-mlx/vendor/pi/event-stream.js';
import {failureLabel} from '../src/task-delegation/failure-labels.js';

const MODEL = 'mlx-community/Qwen3.6-27B-4bit', ENDPOINT = 'http://127.0.0.1:8080/v1';
const h = (c: string) => 'sha256:' + c.repeat(64);
const W4 = {model: 'claude-opus-5-5', credentialTeamId: '00000000-0000-4000-8000-000000000001', credentialKind: 'claude-code-oauth' as const, runtime: 'claude-agent-sdk' as const,
  sdkVersion: '0.2.90', cliVersion: '2.1.295', maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: 'isolated' as const, thinking: 'adaptive' as const, effort: 'high' as const};
const localProfile = (over: Record<string, unknown> = {}) => localProfileSchema.parse({
  id: 'local-qwen', contract: 'kapelle.restricted-execution/v2', qualificationRef: 'synthetic:local-mlx',
  runtime: {kind: 'local-mlx', locality: 'local-only', model: MODEL, server: {implementation: 'mlx-lm', version: '0.31.3', service: 'com.kapelle.local-llm', endpoint: ENDPOINT},
    modelManifestHash: h('a'), runnerManifestHash: h('b'), modelStorageRef: '~/Models/huggingface', contextTokens: 8192, sampling: {temperature: 0}, enableThinking: false, tools: [], concurrencyLimit: 1},
  harness: {kind: 'pi-agent-core', source: 'https://github.com/earendil-works/pi', commit: 'b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6', vendoredDigest: vendoredPiDigest(), adapterContract: 'kapelle.local-mlx-adapter/v1'},
  limits: {maxOutputTokens: 4096, maxBudgetUsd: 1, timeoutMs: 120000}, ...over});
const okBody = (text = '# Draft\n\nSummary.', over: Record<string, unknown> = {}) => ({id: 'chatcmpl-1', model: MODEL, choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content: text}}],
  usage: {prompt_tokens: 50, completion_tokens: 10, total_tokens: 60}, ...over});
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {status, headers: {'content-type': 'application/json'}});

type Call = {url: string; init: Parameters<MlxFetch>[1]};
function fakeFetch(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f: MlxFetch = async (url, init) => { const c = {url, init}; calls.push(c); return reply(c); };
  return {f, calls};
}

describe('local-mlx: schema and Claude compatibility', () => {
  it('Claude profile bytes and hash are unchanged (pinned from the pre-change code)', () => {
    const p = claudeProfileFromBinding('claude-current', W4, 'synthetic');
    expect(profileHash(p)).toBe('sha256:c406fad86f58c012ad848bb25f8b32d1f3adbfb62e123d530b7b17686777a25e');
    expect(runtimeProfileSchema.parse(p)).toEqual(p);
    expect(inferenceFor(p, {maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000})).toEqual(claudeInferenceFor(p, {maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000}));
  });
  it('the runtime/harness union is matched: no Claude runtime with Pi, no local runtime with the Claude SDK', () => {
    const claude = claudeProfileFromBinding('claude-current', W4, 'synthetic'), local = localProfile();
    expect(runtimeProfileSchema.safeParse({...claude, harness: local.harness}).success).toBe(false);
    expect(runtimeProfileSchema.safeParse({...local, harness: claude.harness}).success).toBe(false);
    expect(runtimeProfileSchema.safeParse({...local, contract: 'kapelle.restricted-execution/v1'}).success).toBe(false);
  });
  it('local limits: 4096 output ceiling, below the context; loopback endpoint only; thinking off; no tools', () => {
    expect(() => localProfile({limits: {maxOutputTokens: 4097, maxBudgetUsd: 1, timeoutMs: 120000}})).toThrow();
    for (const endpoint of ['http://10.0.0.2:8080/v1', 'https://127.0.0.1:8080/v1', 'http://127.0.0.1:8080/v1/', 'http://localhost:8080/v1'])
      expect(() => localProfile({runtime: {...localProfile().runtime, server: {...localProfile().runtime.server, endpoint}}})).toThrow();
    expect(() => localProfile({runtime: {...localProfile().runtime, enableThinking: true}})).toThrow();
  });
  it('local input: profile pins, no credential/CLI/effort fields; Claude/local branches never mix', () => {
    const p = localProfile(), i = {...localInferenceFor(p, {maxOutputTokens: 2048, maxBudgetUsd: 1, timeoutMs: 60000}), system: 's', user: 'u'};
    expect(localInferenceInputSchema.parse(i)).toEqual(i);
    expect(i.runtimeProfileHash).toBe(profileHash(p));
    for (const extra of [{credentialTeamId: W4.credentialTeamId}, {sdkVersion: '1'}, {cliVersion: '1'}, {effort: 'high'}, {endpoint: ENDPOINT}])
      expect(localInferenceInputSchema.safeParse({...i, ...extra}).success).toBe(false);
    expect(() => localInferenceFor(p, {maxOutputTokens: 5000, maxBudgetUsd: 1, timeoutMs: 60000})).toThrow(/budget_exceeds_runtime_limits/);
    const {system: _s, user: _u, ...inference} = i;
    expect(taskWorkerBindingSchema.shape.inference.safeParse(inference).success).toBe(true);
    const runtime: LocalRuntimeEvidence = {provider: 'local', runtime: 'pi-agent-core', model: MODEL, sessionId: randomUUID(), runtimeProfileHash: i.runtimeProfileHash, harnessDigest: i.harnessDigest, modelManifestHash: i.modelManifestHash, serviceGeneration: 'gen-1', tools: []};
    const claudeRuntime = {provider: 'anthropic', runtime: 'claude-agent-sdk', model: MODEL, sessionId: runtime.sessionId, sdkVersion: '1', cliVersion: '1', tools: []};
    expect(sameRuntimeBranch(i, runtime, null)).toBe(true);
    expect(sameRuntimeBranch(i, claudeRuntime, null)).toBe(false);
    const text = 'x', out: LocalOutputEvidence = {text, contentHash: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881', byteSize: 1, stopReason: 'end_turn', resultId: 'r', resultIdSource: 'server', usage: null, providerCostUsd: 0};
    expect(executionReceiptSchema.safeParse({sessionId: runtime.sessionId, inputHash: h('c'), runtime, output: out}).success).toBe(true);
    expect(executionReceiptSchema.safeParse({sessionId: runtime.sessionId, inputHash: h('c'), runtime: claudeRuntime, output: out}).success).toBe(false);
  });
});

describe('local-mlx: controlled transport (fake fetch)', () => {
  const req = {endpoint: ENDPOINT, model: MODEL, system: 'SYS', user: 'USER', maxTokens: 1024, temperature: 0 as const};
  const opts = (f: MlxFetch, signal = new AbortController().signal, deadlineMs = 2000) => ({fetch: f, signal, deadlineMs, maxOutputTokens: 4096});
  it('sends exactly one POST with the exact body: no auth header, no redirects, thinking off, stream false', async () => {
    const {f, calls} = fakeFetch(() => json(okBody()));
    const r = await mlxComplete(req, opts(f));
    expect(r).toEqual({text: '# Draft\n\nSummary.', responseId: 'chatcmpl-1', usage: {promptTokens: 50, completionTokens: 10}});
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toEqual({'content-type': 'application/json'});
    expect(calls[0].init.redirect).toBe('error');
    expect(JSON.parse(calls[0].init.body)).toEqual({model: MODEL, messages: [{role: 'system', content: 'SYS'}, {role: 'user', content: 'USER'}], stream: false, max_tokens: 1024, temperature: 0, chat_template_kwargs: {enable_thinking: false}});
    expect(Object.keys(mlxRequestBody(req)).sort()).toEqual(['chat_template_kwargs', 'max_tokens', 'messages', 'model', 'stream', 'temperature']);
  });
  it.each([
    ['HTTP 500', () => json({error: 'x'}, 500), 'mlx_http_5xx'],
    ['not JSON', () => new Response('hello', {status: 200, headers: {'content-type': 'text/plain'}}), 'mlx_response_not_json'],
    ['malformed', () => new Response('{"choices":', {status: 200, headers: {'content-type': 'application/json'}}), 'mlx_response_malformed'],
    ['two choices', () => json(okBody('a', {choices: [okBody().choices[0], okBody().choices[0]]})), 'mlx_choices_not_one'],
    ['model mismatch', () => json(okBody('a', {model: 'other/model'})), 'mlx_model_mismatch'],
    ['tool call', () => json(okBody('a', {choices: [{finish_reason: 'tool_calls', message: {role: 'assistant', content: null, tool_calls: [{id: 't', type: 'function', function: {name: 'x', arguments: '{}'}}]}}]})), 'mlx_tool_call_refused'],
    ['reasoning', () => json(okBody('a', {choices: [{finish_reason: 'stop', message: {role: 'assistant', content: 'a', reasoning_content: 'thinking...'}}]})), 'mlx_reasoning_refused'],
    ['length', () => json(okBody('a', {choices: [{finish_reason: 'length', message: {role: 'assistant', content: 'a'}}]})), 'mlx_output_truncated'],
    ['not terminal', () => json(okBody('a', {choices: [{finish_reason: null, message: {role: 'assistant', content: 'a'}}]})), 'mlx_not_terminal'],
    ['empty', () => json(okBody('   ')), 'mlx_output_empty'],
    ['output too large', () => json(okBody('x'.repeat(32001))), 'mlx_output_too_large'],
    ['body too large', () => json(okBody('x', {pad: 'y'.repeat(300000)})), 'mlx_response_too_large'],
    ['usage invalid', () => json(okBody('a', {usage: {prompt_tokens: 5, completion_tokens: 2000, total_tokens: 2005}})), 'mlx_usage_invalid'],
    ['unsupported shape', () => json({result: 'a'}), 'mlx_response_unsupported'],
  ])('rejects %s with a fixed label (and never returns the body)', async (_n, reply, reason) => {
    const {f} = fakeFetch(reply as () => Response);
    const e = await mlxComplete(req, opts(f)).catch(x => x);
    expect(e).toBeInstanceOf(MlxTransportError);
    expect([e.reason, e.sent]).toEqual([reason, true]);
    expect(e.message).toBe(reason);
  });
  it('a deadline during the body read is unsettled-after-send; an abort before send sends nothing; an ambient proxy is refused', async () => {
    const slow = fakeFetch(() => new Response(new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode('{"id":')); }}), {status: 200, headers: {'content-type': 'application/json'}}));
    const e = await mlxComplete(req, opts(slow.f, new AbortController().signal, 50)).catch(x => x);
    expect([e.reason, e.sent]).toEqual(['mlx_deadline_exceeded', true]);
    const ac = new AbortController(); ac.abort();
    const none = fakeFetch(() => json(okBody()));
    expect(await mlxComplete(req, opts(none.f, ac.signal)).catch(x => [x.reason, x.sent])).toEqual(['mlx_aborted_before_send', false]);
    expect(none.calls).toHaveLength(0);
    process.env.NODE_USE_ENV_PROXY = '1';
    try { expect(await mlxComplete(req, opts(none.f)).catch(x => x.reason)).toBe('mlx_ambient_proxy_refused'); } finally { delete process.env.NODE_USE_ENV_PROXY; }
    expect(none.calls).toHaveLength(0);
    expect(await mlxComplete({...req, maxTokens: 4097}, opts(none.f)).catch(x => x.reason)).toBe('mlx_max_tokens_invalid');
  });
});

describe('local-mlx: vendored Pi loop', () => {
  const model = {id: MODEL, name: MODEL, api: 'openai-completions', provider: 'local-mlx', baseUrl: ENDPOINT, reasoning: false, contextWindow: 8192, maxTokens: 4096};
  const msg = (content: unknown[], stopReason = 'stop') => ({role: 'assistant' as const, content: content as never, api: 'x', provider: 'x', model: MODEL, stopReason: stopReason as never, timestamp: 1,
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}});
  it('runs exactly one turn (one stream call) and refuses an unsolicited tool call instead of executing it', async () => {
    let calls = 0;
    const streamFn = (reply: ReturnType<typeof msg>) => () => { calls++; const s = new AssistantMessageEventStream(); queueMicrotask(() => s.push({type: 'done', reason: 'stop', message: reply})); return s; };
    const prompts = [{role: 'system' as const, content: 'S', timestamp: 0}, {role: 'user' as const, content: 'U', timestamp: 0}];
    const out = await runAgentLoop(prompts, {messages: []}, {model, convertToLlm: m => m as never}, () => {}, undefined, streamFn(msg([{type: 'text', text: 'ok'}])));
    expect(calls).toBe(1); expect(out.at(-1)).toMatchObject({role: 'assistant', stopReason: 'stop'});
    calls = 0;
    await expect(runAgentLoop(prompts, {messages: []}, {model, convertToLlm: m => m as never}, () => {}, undefined, streamFn(msg([{type: 'toolCall', id: 't', name: 'bash', arguments: {}}], 'toolUse'))))
      .rejects.toBeInstanceOf(UnsolicitedToolCall);
    expect(calls).toBe(1); // no tool executed, no follow-up turn
    await expect(runAgentLoop(prompts, {messages: [], tools: [{} as never]}, {model, convertToLlm: m => m as never}, () => {}, undefined, streamFn(msg([])))).rejects.toThrow('pi_tools_not_admitted');
  });
});

describe('local-mlx: adapter (real Pi path, fake transport, durable reservation)', () => {
  let dir: string;
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'local-mlx-'))); chmodSync(dir, 0o700); });
  const input = (p = localProfile(), over: Record<string, unknown> = {}) => ({...localInferenceFor(p, {maxOutputTokens: 2048, maxBudgetUsd: 1, timeoutMs: 60000}), system: 'Prepare a Report.', user: '{"task":"x"}', ...over}) as never;
  function capture() {
    const got: {runtime: unknown[]; output: unknown[]} = {runtime: [], output: []};
    return {got, cap: {runtime: (v: unknown) => got.runtime.push(v), output: (v: unknown) => got.output.push(v)} as never};
  }
  const open = (f: MlxFetch, over: Record<string, unknown> = {}) => openLocalMlxAdapter({profile: localProfile(), serviceGeneration: 'gen-1', reservationDir: dir, fetch: f, ...over});

  it('success: one request through the real Pi loop; runtime + output evidence; the reservation is released', async () => {
    let stateAtSend: unknown = null;
    const {f, calls} = fakeFetch(() => { stateAtSend = new RuntimeReservation(dir, 'com.kapelle.local-llm').read()?.state; return json(okBody('# Volunteers\n\nDraft only.')); });
    const a = open(f), {got, cap} = capture(), sessionId = randomUUID();
    await a.run(input(), sessionId, new AbortController().signal, cap);
    expect(calls).toHaveLength(1); expect(a.transportCalls()).toBe(1);
    expect(stateAtSend).toBe('sent'); // durable "sent" BEFORE the request leaves
    expect(got.runtime).toEqual([{provider: 'local', runtime: 'pi-agent-core', model: MODEL, sessionId, runtimeProfileHash: profileHash(localProfile()), harnessDigest: vendoredPiDigest(), modelManifestHash: h('a'), serviceGeneration: 'gen-1', tools: []}]);
    expect(got.output).toEqual([expect.objectContaining({text: '# Volunteers\n\nDraft only.', stopReason: 'end_turn', resultId: 'chatcmpl-1', resultIdSource: 'server', usage: {promptTokens: 50, completionTokens: 10}, providerCostUsd: 0})]);
    expect(a.reservation.read()).toBeNull();
  });
  it('refusals before send send nothing and take no reservation: abort, context ceiling, profile drift, harness drift', async () => {
    const {f, calls} = fakeFetch(() => json(okBody()));
    const a = open(f);
    const ac = new AbortController(); ac.abort();
    await expect(a.run(input(), randomUUID(), ac.signal, capture().cap)).rejects.toThrow('local_aborted_before_send');
    const big = await a.run(input(localProfile(), {user: 'x'.repeat(7000)}), randomUUID(), new AbortController().signal, capture().cap).catch(e => e);
    expect(big).toBeInstanceOf(ProviderRejectedBeforeInference); expect(big.reason).toBe('local_context_exceeded');
    await expect(a.run(input(localProfile(), {runtimeProfileHash: h('f')}), randomUUID(), new AbortController().signal, capture().cap)).rejects.toThrow('local_profile_changed');
    const vendor = join(dir, 'vendor-copy'); cpSync(VENDOR_DIR, vendor, {recursive: true}); appendFileSync(join(vendor, 'agent-loop.ts'), '\n// drift\n');
    const drifted = open(f, {vendorDir: vendor});
    await expect(drifted.run(input(), randomUUID(), new AbortController().signal, capture().cap)).rejects.toThrow('local_harness_changed');
    expect(calls).toHaveLength(0); expect(a.reservation.read()).toBeNull();
    for (const r of ['local_context_exceeded', 'local_runtime_busy', 'local_runtime_unsettled', 'local_harness_changed', 'local_profile_changed']) expect(isRetryablePreInferenceReason(r)).toBe(true);
  });
  it('abort during inference: uncertain, no Report output; the runtime stays unavailable until a NEW service generation', async () => {
    const ac = new AbortController();
    const {f, calls} = fakeFetch(({init}) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))); queueMicrotask(() => ac.abort()); }));
    const a = open(f), {got, cap} = capture(), sessionId = randomUUID();
    await expect(a.run(input(), sessionId, ac.signal, cap)).rejects.toThrow('mlx_aborted_after_send');
    expect(got.output).toEqual([]); expect(calls).toHaveLength(1);
    expect(a.reservation.read()).toMatchObject({state: 'uncertain', sessionId, reason: 'mlx_aborted_after_send'});
    const next = await a.run(input(), randomUUID(), new AbortController().signal, capture().cap).catch(e => e);
    expect(next.reason).toBe('local_runtime_unsettled'); expect(calls).toHaveLength(1); // never auto-resent
    expect(() => a.reservation.settleByServiceRecovery(sessionId, 'gen-1')).toThrow('local_service_recovery_unproven');
    a.reservation.settleByServiceRecovery(sessionId, 'gen-2');
    expect(a.reservation.read()).toBeNull();
  });
  it('crash after send: the next process start finds "sent" -> uncertain; nothing is resent; the reservation is runtime-wide', async () => {
    const r = new RuntimeReservation(dir, 'com.kapelle.local-llm'), crashed = randomUUID();
    r.acquire(crashed, 'gen-1'); r.markSent(crashed); // the process died here
    const {f, calls} = fakeFetch(() => json(okBody()));
    const a = open(f); // a different instance/process, same host service
    expect(a.reservation.read()).toMatchObject({state: 'uncertain', sessionId: crashed, reason: 'restart_after_send'});
    expect((await a.run(input(), randomUUID(), new AbortController().signal, capture().cap).catch(e => e)).reason).toBe('local_runtime_unsettled');
    expect(calls).toHaveLength(0);
    const r2 = new RuntimeReservation(join(dir, 'b'), 'com.kapelle.local-llm'), never = randomUUID();
    r2.acquire(never, 'gen-1'); // reserved but never sent before a crash: cleared at start
    expect(openLocalMlxAdapter({profile: localProfile(), serviceGeneration: 'gen-1', reservationDir: join(dir, 'b'), fetch: f}).reservation.read()).toBeNull();
  });
  it('one generation at a time across instances: a held reservation refuses with local_runtime_busy, sending nothing', async () => {
    let release!: (r: Response) => void;
    const {f, calls} = fakeFetch(() => new Promise<Response>(res => { release = res; }));
    const a = open(f), b = open(f);
    const first = a.run(input(), randomUUID(), new AbortController().signal, capture().cap);
    await new Promise(r => setTimeout(r, 10));
    expect((await b.run(input(), randomUUID(), new AbortController().signal, capture().cap).catch(e => e)).reason).toBe('local_runtime_busy');
    expect(calls).toHaveLength(1);
    release(json(okBody())); await first;
    expect(a.reservation.read()).toBeNull();
  });
  it('a complete but rejected response: settled (reservation released), no output, fixed label persisted', async () => {
    const {f, calls} = fakeFetch(() => json(okBody('a', {model: 'other/model'})));
    const a = open(f), {got, cap} = capture();
    const e = await a.run(input(), randomUUID(), new AbortController().signal, cap).catch(x => x);
    expect(e.message).toBe('mlx_model_mismatch'); expect(failureLabel(e)).toBe('mlx_model_mismatch');
    expect(got.output).toEqual([]); expect(calls).toHaveLength(1); expect(a.reservation.read()).toBeNull();
  });
  it('the reservation directory must be private and outside Dropbox', () => {
    const open777 = join(dir, 'open'); writeFileSync(join(dir, 'x'), ''); cpSync(join(dir, 'x'), join(dir, 'y'));
    expect(() => new RuntimeReservation(join(dir, 'Dropbox-not'), 'com.kapelle.local-llm')).not.toThrow();
    expect(() => new RuntimeReservation('/tmp/x/Dropbox/y', 'com.kapelle.local-llm')).toThrow();
    expect(() => new RuntimeReservation(open777, 'Bad Service')).toThrow('local_reservation_service_invalid');
  });
});
