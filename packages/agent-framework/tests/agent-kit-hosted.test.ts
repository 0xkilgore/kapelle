// Hosted API runtime (CP agent launch prerequisite 2a). FAKE fetch only: no network, provider, account or key is used. Covers the
// exact request, key custody/redaction, refusals before send (nothing sent, nothing held), every response rejection, settlement
// on provider-returned cost, unsettled holds for unknown outcomes, caps and crash recovery.
import {describe, it, expect} from 'vitest';
import {mkdtempSync, writeFileSync, chmodSync, symlinkSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {hostedProfileSchema, hostedProfileHash, hostedInferenceFor, hostedReservationUsd} from '../src/agent-kit/hosted/profile.js';
import {openHostedAdapter, readSecretFile} from '../src/agent-kit/hosted/adapter.js';
import {HostedLedger} from '../src/agent-kit/hosted/ledger.js';
import {ProviderRejectedAfterInference, ProviderRejectedBeforeInference} from '../src/worker/execution.js';
import {OPENROUTER_PROFILES} from '../src/agent-kit/hosted/openrouter.js';
import {hostedRequestBody} from '../src/agent-kit/hosted/transport.js';

const KEY = 'sk-or-v1-SYNTHETIC-NOT-A-REAL-KEY-0123456789';
const ORIGIN = 'https://openrouter.ai/api/v1';
const profile = hostedProfileSchema.parse({id: 'hosted-sonnet', contract: 'kapelle.restricted-execution/v3', qualificationRef: 'synthetic:hosted',
  runtime: {kind: 'hosted-api', locality: 'remote-provider', model: 'anthropic/claude-sonnet-4.6', origin: ORIGIN, providers: ['Anthropic'],
    dataPolicy: {dataCollection: 'deny', zdr: true}, contextTokens: 200000, reasoning: 'off', tools: [], concurrencyLimit: 1, usage: 'required'},
  harness: {kind: 'hosted-openai-compatible', adapterContract: 'kapelle.hosted-api-adapter/v1'},
  pricing: {version: 'synthetic-2026-10', inputUsdPerMTok: 3, outputUsdPerMTok: 15, reservationMargin: 1.5},
  limits: {maxOutputTokens: 5000, maxBudgetUsd: 1, timeoutMs: 120000}});
const ok = (over: Record<string, unknown> = {}, usage: Record<string, unknown> | null = {prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500, cost: 0.0081}) =>
  ({id: 'gen-synthetic-1', model: 'anthropic/claude-sonnet-4.6', provider: 'Anthropic', choices: [{finish_reason: 'stop', message: {role: 'assistant', content: 'Draft answer [notes.md#L2].'}}],
    ...(usage === null ? {} : {usage}), ...over});
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {status, headers: {'content-type': 'application/json'}});

function world(o: {monthlyUsd?: number; keyMode?: number} = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hosted-'))), secret = join(dir, 'openrouter.key');
  writeFileSync(secret, KEY + '\n'); chmodSync(secret, o.keyMode ?? 0o600);
  const ledger = new HostedLedger(join(dir, 'ledger'), {monthlyUsd: o.monthlyUsd ?? 30}, () => '2026-10-15T12:00:00.000Z');
  const sent: {url: string; init: any}[] = [];
  let reply: (n: number) => Response | Promise<Response> = () => json(ok());
  const adapter = openHostedAdapter({profile, secretFile: secret, ledger, fetch: async (url, init) => { sent.push({url, init}); return reply(sent.length); }});
  const input = (over: Record<string, unknown> = {}) => ({...hostedInferenceFor(profile, {maxOutputTokens: 5000, maxBudgetUsd: 1, timeoutMs: 120000}), system: 'rules', user: 'question + files', ...over});
  const run = async (over: Record<string, unknown> = {}, signal = new AbortController().signal) => {
    const ev: {runtime: any; output: any; uncertain: boolean} = {runtime: null, output: null, uncertain: false}, sessionId = randomUUID();
    let error: unknown = null;
    try { await adapter.run(input(over) as never, sessionId, signal, {runtime: v => { ev.runtime = v; }, output: v => { ev.output = v; }, uncertain: () => { ev.uncertain = true; }}); }
    catch (e) { error = e; }
    return {...ev, error, sessionId, entry: ledger.entries().find(e => e.sessionId === sessionId) ?? null};
  };
  return {dir, secret, ledger, sent, adapter, run, setReply: (f: typeof reply) => { reply = f; }};
}

describe('hosted API transport + adapter (fake provider)', () => {
  it('sends exactly one pinned, policy-carrying request; settles on the provider cost; the key never leaves the header', async () => {
    const w = world(), r = await w.run();
    expect(r.error).toBeNull();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].url).toBe(ORIGIN + '/chat/completions');
    expect(w.sent[0].init.headers).toEqual({'content-type': 'application/json', authorization: 'Bearer ' + KEY});
    expect(w.sent[0].init.redirect).toBe('error');
    expect(JSON.parse(w.sent[0].init.body)).toEqual({model: 'anthropic/claude-sonnet-4.6', messages: [{role: 'system', content: 'rules'}, {role: 'user', content: 'question + files'}],
      stream: false, max_tokens: 5000, temperature: 0, reasoning: {enabled: false, exclude: true},
      provider: {order: ['Anthropic'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true}, usage: {include: true}});
    expect(r.output).toMatchObject({text: 'Draft answer [notes.md#L2].', routedProvider: 'Anthropic', usage: {promptTokens: 1200, completionTokens: 300}, providerCostUsd: 0.0081, resultId: 'gen-synthetic-1'});
    expect(r.runtime).toMatchObject({provider: 'hosted', model: 'anthropic/claude-sonnet-4.6', origin: ORIGIN, runtimeProfileHash: hostedProfileHash(profile), tools: []});
    expect(r.entry).toMatchObject({state: 'settled', costUsd: 0.0081});
    expect(r.entry!.reservedUsd).toBeCloseTo(hostedReservationUsd(profile, Buffer.byteLength('rules') + Buffer.byteLength('question + files'), 5000));
    expect(JSON.stringify([r.output, r.runtime, w.ledger.entries()])).not.toContain(KEY);
  });
  it('refuses before send (nothing sent, nothing held): changed profile, over context, key file not private / a link, run cap, monthly cap', async () => {
    let w = world();
    for (const over of [{runtimeProfileHash: 'sha256:' + '0'.repeat(64)}, {model: 'anthropic/claude-opus-4'}, {maxOutputTokens: 6000}, {user: 'x'.repeat(700000)}]) {
      const r = await w.run(over); expect(r.error).toBeTruthy(); expect(r.entry).toBeNull();
    }
    expect(w.sent).toHaveLength(0);
    w = world({keyMode: 0o644});
    expect(String((await w.run()).error)).toMatch(/hosted_secret_not_private/); expect(w.sent).toHaveLength(0);
    const linked = join(w.dir, 'link.key'); symlinkSync(w.secret, linked); expect(() => readSecretFile(linked)).toThrow('hosted_secret_not_regular_file');
    w = world({monthlyUsd: 0.05});
    expect(String((await w.run()).error)).toMatch(/hosted_monthly_cap_exceeded/); expect(w.sent).toHaveLength(0);
    w = world();
    expect(String((await w.run({maxBudgetUsd: 0.01})).error)).toMatch(/hosted_run_cap_exceeded/); expect(w.sent).toHaveLength(0);
    expect(() => hostedProfileSchema.parse({...profile, runtime: {...profile.runtime, origin: 'http://openrouter.ai/api/v1'}})).toThrow();
    expect(() => hostedProfileSchema.parse({...profile, runtime: {...profile.runtime, model: 'anthropic/claude-latest'}})).toThrow();
    expect(() => hostedProfileSchema.parse({...profile, runtime: {...profile.runtime, dataPolicy: {dataCollection: 'allow', zdr: false}}})).toThrow();
  });
  it('rejects every non-qualifying response; refused-before-inference is released, a returned cost is settled, unknown cost is held; never a second request', async () => {
    const cases: [() => Response, string, string, number | null][] = [
      [() => json(ok({model: 'anthropic/claude-opus-4'})), 'hosted_model_mismatch', 'settled', 0.0081],
      [() => json(ok({provider: 'SomeOtherHost'})), 'hosted_provider_not_allowed', 'settled', 0.0081],
      [() => json(ok({choices: [{finish_reason: 'stop', message: {role: 'assistant', content: 'x', reasoning: 'thinking…'}}]})), 'hosted_reasoning_refused:field=reasoning', 'settled', 0.0081],
      [() => json(ok({}, {prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.001, completion_tokens_details: {reasoning_tokens: 5}})), 'hosted_reasoning_refused:tokens=5', 'settled', 0.001],
      [() => json(ok({choices: [{finish_reason: 'stop', message: {role: 'assistant', content: 'x', reasoning_content: 'hmm'}}]})), 'hosted_reasoning_refused:field=reasoning_content', 'settled', 0.0081],
      [() => json(ok({choices: [{finish_reason: 'stop', message: {role: 'assistant', content: 'x', reasoning_details: [{type: 'reasoning.encrypted', data: 'x'}, {type: 'reasoning.summary'}]}}]},
        {prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.002, completion_tokens_details: {reasoning_tokens: 12}})), 'hosted_reasoning_refused:field=reasoning_details,n=2,tokens=12', 'settled', 0.002],
      [() => json(ok({choices: [{finish_reason: 'tool_calls', message: {role: 'assistant', content: null, tool_calls: [{id: 't'}]}}]})), 'hosted_tool_call_refused', 'settled', 0.0081],
      [() => json(ok({choices: [{finish_reason: 'length', message: {role: 'assistant', content: 'cut'}}]})), 'hosted_output_truncated', 'settled', 0.0081],
      [() => json(ok({model: 'anthropic/claude-opus-4'}, {prompt_tokens: 10, completion_tokens: 20})), 'hosted_model_mismatch', 'unsettled', null],
      [() => json(ok({}, null)), 'hosted_usage_missing', 'unsettled', null],
      [() => json(ok({}, {prompt_tokens: 10, completion_tokens: 20})), 'hosted_usage_missing', 'unsettled', null],
      [() => json({error: {message: 'bad request'}}, 400), 'hosted_http_400', 'released', null],            // F-2: labelled by status
      [() => json({error: {code: 404, message: 'No endpoints found'}}, 404), 'hosted_http_404:code=404', 'released', null], // + OpenRouter's numeric code
      [() => json({error: {message: 'teapot'}}, 418), 'hosted_http_4xx', 'released', null],             // an unlisted 4xx stays the catch-all
      [() => json({error: {message: 'insufficient credits'}}, 402), 'hosted_http_402', 'released', null],
      [() => json({error: {message: 'rate limited'}}, 429), 'hosted_http_429', 'released', null],
      [() => json({error: {message: 'upstream'}}, 502), 'hosted_http_5xx', 'unsettled', null],
      [() => new Response('not json', {status: 200, headers: {'content-type': 'text/html'}}), 'hosted_response_not_json', 'unsettled', null],
    ];
    for (const [resp, reason, state, cost] of cases) {
      const w = world(); w.setReply(() => resp());
      const r = await w.run();
      expect(String(r.error), reason).toContain(reason);
      expect(r.output, reason).toBeNull();
      expect([r.entry!.state, r.entry!.costUsd], reason).toEqual([state, cost]);
      if (state === 'settled') expect(r.entry!.reason, reason).toBe(reason); // the rejection reason is recorded with its cost
      expect(w.sent, reason).toHaveLength(1);
      if (!['hosted_usage_missing', 'hosted_http_5xx'].includes(reason)) expect(r.error instanceof ProviderRejectedAfterInference || state === 'unsettled', reason).toBe(true);
      expect(String(r.error)).not.toContain(KEY);
    }
  });
  it('an abort after send and a deadline are unknown outcomes: held unsettled, uncertain signalled, counted against the cap', async () => {
    const w = world(), ctl = new AbortController();
    w.setReply(() => new Promise((_, reject) => { ctl.signal.addEventListener('abort', () => reject(new Error('aborted'))); setTimeout(() => ctl.abort(), 5); }));
    const r = await w.run({}, ctl.signal);
    expect(String(r.error)).toContain('hosted_aborted_after_send');
    expect(r.entry).toMatchObject({state: 'unsettled', reason: 'hosted_aborted_after_send'});
    expect(r.uncertain).toBe(true);
    expect(w.ledger.committedUsd()).toBeCloseTo(r.entry!.reservedUsd);
  });
  it('ledger: monthly commitment counts settled cost + open/unsettled reservations; crash recovery holds sent and releases never-sent', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-')));
    const l = new HostedLedger(join(dir, 'l'), {monthlyUsd: 1}, () => '2026-10-15T12:00:00.000Z');
    const a = randomUUID(), b = randomUUID(), c = randomUUID();
    l.reserve(a, 'p', 0.2, 1); l.markSent(a); l.settle(a, 0.35); // settled ABOVE the reservation: the provider's cost counts
    l.reserve(b, 'p', 0.3, 1); l.markSent(b);                   // crash after send
    l.reserve(c, 'p', 0.1, 1);                                  // crash before send
    expect(l.committedUsd()).toBeCloseTo(0.35 + 0.3 + 0.1);
    const l2 = new HostedLedger(join(dir, 'l'), {monthlyUsd: 1}, () => '2026-10-15T12:00:00.000Z'); l2.recoverAtStart();
    expect(l2.entries().map(e => [e.sessionId === b ? 'b' : e.sessionId === c ? 'c' : 'a', e.state])).toEqual([['a', 'settled'], ['b', 'unsettled'], ['c', 'released']]);
    expect(l2.committedUsd()).toBeCloseTo(0.65);
    expect(() => l2.reserve(randomUUID(), 'p', 0.4, 1)).toThrow('hosted_monthly_cap_exceeded');
    expect(() => l2.reserve(a, 'p', 0.01, 1)).toThrow('hosted_session_reused');
  });
  it('ledger: unsettled entries carry across month rollover until Ops reconciles; a request sent before midnight settles after it', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ledger-'))); let now = '2026-10-31T23:59:00.000Z';
    const l = new HostedLedger(join(dir, 'l'), {monthlyUsd: 1}, () => now);
    const held = randomUUID(), late = randomUUID(), crashed = randomUUID();
    l.reserve(held, 'p', 0.5, 1); l.markSent(held); l.markUnsettled(held, 'hosted_deadline_exceeded');
    l.reserve(late, 'p', 0.1, 1); l.markSent(late);
    l.reserve(crashed, 'p', 0.05, 1); l.markSent(crashed);
    now = '2026-11-01T00:00:30.000Z';
    l.settle(late, 0.02);                                         // lands in its own (October) file
    expect(l.entries('2026-10').find(e => e.sessionId === late)).toMatchObject({state: 'settled', costUsd: 0.02});
    new HostedLedger(join(dir, 'l'), {monthlyUsd: 1}, () => now).recoverAtStart(); // a restart in November still recovers October
    expect(l.entry(crashed)).toMatchObject({state: 'unsettled', reason: 'hosted_outcome_unknown_after_restart'});
    expect(l.carriedUnsettledUsd()).toBeCloseTo(0.55);              // November still counts October's unknown outcomes
    expect(l.committedUsd()).toBeCloseTo(0.55);
    expect(() => l.reserve(randomUUID(), 'p', 0.5, 1)).toThrow('hosted_monthly_cap_exceeded');
    expect(() => l.reserve(held, 'p', 0.01, 1)).toThrow('hosted_session_reused');
    expect(l.status()).toMatchObject({contract: 'kapelle.hosted-spend-status/v1', month: '2026-11', monthlyCapUsd: 1, settledUsd: 0, openUsd: 0,
      unsettled: [{month: '2026-10', sessionId: held, reservedUsd: 0.5, reason: 'hosted_deadline_exceeded'}, {month: '2026-10', sessionId: crashed, reservedUsd: 0.05}]});
    expect(JSON.stringify(l.status())).not.toContain(KEY);
    l.reconcile('2026-10', held, 0.03);                             // Ops: the provider's records show $0.03
    expect(l.entry(held)).toMatchObject({state: 'settled', costUsd: 0.03, reason: 'reconciled:hosted_deadline_exceeded'});
    expect(() => l.reconcile('2026-10', held, 0)).toThrow('hosted_reconcile_not_unsettled');
    expect(l.carriedUnsettledUsd()).toBeCloseTo(0.05);
    l.reserve(randomUUID(), 'p', 0.5, 1);                         // room again
  });
  it('an ambient proxy setting refuses before send', async () => {
    const w = world(), prev = process.env.NODE_USE_ENV_PROXY; process.env.NODE_USE_ENV_PROXY = '1';
    try { const r = await w.run(); expect(String(r.error)).toContain('hosted_ambient_proxy_refused'); expect(w.sent).toHaveLength(0); expect(r.entry!.state).toBe('released'); }
    finally { if (prev === undefined) delete process.env.NODE_USE_ENV_PROXY; else process.env.NODE_USE_ENV_PROXY = prev; }
  });
  it('spend-cap refusals at reservation are definite (worker: REJECTED, never UNCERTAIN); the run cap is terminal', async () => {
    const w = world({monthlyUsd: 0.05}), r = await w.run();
    expect(r.error).toBeInstanceOf(ProviderRejectedBeforeInference); expect((r.error as ProviderRejectedBeforeInference).reason).toBe('hosted_monthly_cap_exceeded');
    expect(w.sent).toHaveLength(0); expect(r.entry).toBeNull();
    const w2 = world(), r2 = await w2.run({maxBudgetUsd: 0.01}); // run cap below the reservation: terminal, not retried
    expect(r2.error).toBeInstanceOf(ProviderRejectedBeforeInference); expect(r2.error).toMatchObject({reason: 'hosted_run_cap_exceeded', terminal: true});
    expect(w2.sent).toHaveLength(0); expect(r2.entry).toBeNull();
  });

  it('OpenRouter pins: slugs in provider.order, display names and canonical slug accepted in responses, effort none; anything else refused', async () => {
    const p = OPENROUTER_PROFILES.sonnet;
    const body = hostedRequestBody({model: p.runtime.model, system: 's', user: 'u', maxTokens: 100, providers: p.runtime.providers, dataPolicy: p.runtime.dataPolicy, reasoningOff: p.runtime.reasoningOff});
    expect(body.provider).toEqual({order: ['amazon-bedrock/us', 'google-vertex/us-east5'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true});
    expect(body.reasoning).toEqual({effort: 'none', exclude: true});
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hosted-or-'))), secret = join(dir, 'k'); writeFileSync(secret, KEY + '\n'); chmodSync(secret, 0o600);
    const ledger = new HostedLedger(join(dir, 'ledger'), {monthlyUsd: 30}, () => '2026-10-15T12:00:00.000Z');
    let reply: Record<string, unknown> = {};
    const adapter = openHostedAdapter({profile: p, secretFile: secret, ledger, fetch: async () => json(ok(reply))});
    const go = async (over: Record<string, unknown>) => { reply = over; let out: any = null, error: unknown = null;
      try { await adapter.run({...hostedInferenceFor(p, {maxOutputTokens: 1000, maxBudgetUsd: 0.5, timeoutMs: 60000}), system: 's', user: 'u'} as never, randomUUID(), new AbortController().signal,
        {runtime: () => {}, output: (v) => { out = v; }}); } catch (e) { error = e; }
      return {out, error: error instanceof ProviderRejectedAfterInference ? error.reason : error ? String(error) : null}; };
    expect(await go({model: 'anthropic/claude-4.6-sonnet-20260217', provider: 'Amazon Bedrock'})).toMatchObject({error: null, out: {routedProvider: 'Amazon Bedrock'}});
    expect(await go({model: 'anthropic/claude-sonnet-4.6', provider: 'Google'})).toMatchObject({error: null});
    expect((await go({model: 'anthropic/claude-sonnet-4.6', provider: 'Anthropic'})).error).toBe('hosted_provider_not_allowed');     // not ZDR, not pinned
    expect((await go({model: 'anthropic/claude-sonnet-4.6', provider: 'amazon-bedrock/us'})).error).toBe('hosted_provider_not_allowed'); // a slug is not a display name
    expect((await go({model: 'anthropic/claude-4.5-sonnet-20250929', provider: 'Google'})).error).toBe('hosted_model_mismatch');
    expect(() => hostedProfileSchema.parse({...p, runtime: {...p.runtime, responseModels: ['anthropic/claude-4.6-sonnet-20260217']}})).toThrow('hosted_response_models_must_include_model');
    expect(() => hostedProfileSchema.parse({...p, runtime: {...p.runtime, responseModels: [p.runtime.model, 'anthropic/claude-sonnet-latest']}})).toThrow('model_must_be_exact');
    expect(OPENROUTER_PROFILES['flash-lite'].runtime).toMatchObject({model: 'google/gemini-3.1-flash-lite', providers: ['google-vertex/us'], providerNames: ['Google'], reasoningOff: 'effort-none'});
  });
});
