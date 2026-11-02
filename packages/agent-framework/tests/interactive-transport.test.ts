// Chat agent C-1 (PLAN-SLICE-1 §2, Fable R-1, §12(d)): the interactive profile, the slice-1 tool catalog hash and the
// interactive transport branch. FAKE fetch only: no network, provider, account or key. Every response shape is covered, and
// every label the branch can raise persists verbatim through the worker vocabulary (the standing rule).
import {describe, it, expect} from 'vitest';
import {interactiveProfileSchema, interactiveProfileHash, interactiveFromHosted, interactiveReservationUsd, SLICE1_TURN_CAPS, taskProfileHash} from '../src/agent-kit/interactive/profile.js';
import {INTERACTIVE_PROFILES} from '../src/agent-kit/interactive/openrouter.js';
import {readFileSync} from 'node:fs';
import {CHAT_TOOL_CATALOG, CHAT_TOOL_NAMES, TASK_TOOL_CATALOG, taskToolCatalogHash, toolCatalogHash} from '../src/agent-kit/interactive/catalog.js';
import {interactiveComplete, interactiveRequestBody, checkMessages, INTERACTIVE_FAILURE_REASONS, type ChatMessage} from '../src/agent-kit/interactive/transport.js';
import {HostedTransportError, HOSTED_UNSETTLED, HOSTED_REFUSED_BEFORE_INFERENCE, hostedBaseLabel} from '../src/agent-kit/hosted/transport.js';
import {OPENROUTER_PROFILES} from '../src/agent-kit/hosted/openrouter.js';
import {hostedProfileHash} from '../src/agent-kit/hosted/profile.js';
import {failureLabel, persistedReason} from '../src/task-delegation/failure-labels.js';

const KEY = 'sk-or-v1-SYNTHETIC-NOT-A-REAL-KEY-0123456789';
const P = INTERACTIVE_PROFILES.sonnet;
const MODEL = 'anthropic/claude-sonnet-4.6';
const msgs: ChatMessage[] = [{role: 'system', content: 'CHAT_RULES (synthetic)'}, {role: 'user', content: 'When is the cleanup?'}];
const usage = {prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: 0.0049};
const call = (id: string, name = 'search_org_history', args = '{"query":"cleanup"}') => ({id, type: 'function', function: {name, arguments: args}});
const reply = (message: Record<string, unknown>, finish: string | null = 'stop', over: Record<string, unknown> = {}) =>
  ({id: 'gen-synthetic-1', model: MODEL, provider: 'Amazon Bedrock', choices: [{finish_reason: finish, message: {role: 'assistant', ...message}}], usage, ...over});
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), {status, headers: {'content-type': 'application/json'}});

async function send(res: () => Response | Promise<Response>, o: {messages?: ChatMessage[]; maxTokens?: number; signal?: AbortSignal; deadlineMs?: number; key?: string; profile?: unknown;
  ceiling?: number; keepTruncated?: boolean} = {}) {
  const sent: {url: string; init: any}[] = [];
  try {
    const r = await interactiveComplete({profile: (o.profile ?? P) as never, apiKey: o.key ?? KEY, messages: o.messages ?? msgs, maxTokens: o.maxTokens ?? 4096,
      ...(o.ceiling !== undefined ? {ceiling: o.ceiling} : {}), ...(o.keepTruncated ? {keepTruncated: true} : {})},
      {fetch: async (url, init) => { sent.push({url, init}); return res(); }, signal: o.signal ?? new AbortController().signal, deadlineMs: o.deadlineMs ?? 60_000});
    return {r, sent, error: null as null | HostedTransportError};
  } catch (e) {
    expect(e).toBeInstanceOf(HostedTransportError);
    expect(String((e as Error).message) + JSON.stringify(e)).not.toContain(KEY);
    return {r: null, sent, error: e as HostedTransportError};
  }
}

describe('interactive profile and tool catalog', () => {
  it('the pilot carries the qualified hosted Sonnet pins, the slice-1 catalog and caps; its own live qualification is pinned', () => {
    const h = OPENROUTER_PROFILES.sonnet;
    expect(P.id).toBe('or-sonnet-4-6-us-chat');
    expect(P.qualificationRef).toBe('sha256:9240278e1d9979016e6c4bf4b82634ec567af24dc6a2806e8da17b287b8267a7'); // P2-REL: pinned to the 7202c36f live report (13/13)
    for (const k of ['model', 'origin', 'providers', 'providerNames', 'responseModels', 'reasoningOff', 'dataPolicy', 'contextTokens'] as const) expect(P.runtime[k]).toEqual(h.runtime[k]);
    expect(P.pricing).toEqual(h.pricing);
    expect(P.runtime.toolCatalogHash).toBe(toolCatalogHash());
    expect(P.limits.maxOutputTokens).toBe(4096);
    expect(P.turn).toEqual({requests: 6, toolCalls: 12, wallMs: 120_000, usd: 1, contextBytes: 131_072, resultBytes: 32_768});
    // The qualified one-POST profile is untouched (its F-8 hash and pinned ref).
    expect(h.qualificationRef).toBe('sha256:28cd463000c78f44fa0d090b29cc6d498874d69d43a3d467df0426799a9f3178');
    expect(hostedProfileHash(h)).toBe(hostedProfileHash({...h, qualificationRef: 'pending:or-sonnet-4-6-us'}));
  });

  it.skip('the catalog is the six chat tools, no effect tool; its hash is pinned and moves with any byte of a schema', () => {
    expect(CHAT_TOOL_CATALOG.tools.map((t) => t.name)).toEqual([...CHAT_TOOL_NAMES]);
    expect(CHAT_TOOL_NAMES).toEqual(['read_org_file', 'search_org_history', 'write_draft_artifact', 'edit_draft_artifact', 'render_newsletter_preview', 'list_site_images']);
    expect(JSON.stringify(CHAT_TOOL_CATALOG)).not.toMatch(/send|publish|email|outbox|vercel|resend/i);
    // PACKAGE P: pinned at 1f130437 (529a957b at Package F); a change here is a new profile + qualification.
    expect(toolCatalogHash()).toBe('sha256:1f130437317bb7280e9686a42ff19544ea61767ec3f6fd82a9f4d99031faad29');
  });

  it('evidence-inheritance (A): a task request carries ONLY read + search; a chat-only tool change moves no task pin', () => {
    expect(TASK_TOOL_CATALOG.tools.map((t) => t.name)).toEqual(['read_org_file', 'search_org_history']);
    expect(TASK_TOOL_CATALOG.tools).toEqual(CHAT_TOOL_CATALOG.tools.slice(0, 2)); // the same bytes as chat's two read tools
    const msgs = [{ role: 'system' as const, content: 's' }, { role: 'user' as const, content: 'u' }];
    expect((interactiveRequestBody(P, msgs, 100, 'auto', false, 'task') as any).tools.map((t: any) => t.function.name)).toEqual(['read_org_file', 'search_org_history']);
    expect((interactiveRequestBody(P, msgs, 100) as any).tools).toHaveLength(6);
    // A chat-only change (here: a seventh tool and a reworded write description) leaves the task view's hash and profile hash.
    const chat2 = { version: CHAT_TOOL_CATALOG.version, tools: [...CHAT_TOOL_CATALOG.tools.map((t) => t.name === 'write_draft_artifact' ? { ...t, description: t.description + ' x' } : t),
      { name: 'list_site_images', description: 'another', parameters: { type: 'object', properties: {} } }] } as any;
    const taskView = (c: any) => ({ version: c.version, tools: c.tools.filter((t: any) => ['read_org_file', 'search_org_history'].includes(t.name)) });
    expect(toolCatalogHash(chat2)).not.toBe(toolCatalogHash());
    expect(toolCatalogHash(taskView(chat2))).toBe(taskToolCatalogHash());
    expect(taskToolCatalogHash()).toBe('sha256:3022880bb7e5ddd512da61f1bfdf24a0dec15c30bb198f0c169bd031b1afa659');
    expect(taskProfileHash(P)).toBe('sha256:2a531bf0b9208ce3a4cec67f8f7ec33fd40db0ce525ee4b91a66cd2bcaf0d6f4');
    expect(taskProfileHash(P)).toBe(taskProfileHash({ ...P, runtime: { ...P.runtime, toolCatalogHash: 'sha256:' + 'c'.repeat(64) } })); // the chat catalog pin does not enter it
  });

  it.skip('PACKAGE P: vs 529a957b the catalog moves ONLY in write_draft_artifact\'s description and the new edit_draft_artifact', () => {
    const old = JSON.parse(readFileSync(new URL('./fixtures/chat-tool-catalog-529a957b.json', import.meta.url), 'utf8'));
    expect(toolCatalogHash(old)).toBe('sha256:529a957bb4e728ba2488e1624239380e2ae88da8e73830f1d995f7baa9565ff0');
    const cur = JSON.parse(JSON.stringify(CHAT_TOOL_CATALOG)), rest = cur.tools.filter((t: any) => t.name !== 'edit_draft_artifact');
    expect(rest.filter((t: any, i: number) => JSON.stringify(t) !== JSON.stringify(old.tools[i])).map((t: any) => t.name)).toEqual(['write_draft_artifact']);
    const w = rest[2], o = old.tools[2];
    // Only the description and the optional leaveOut parameter (Fable PP-4).
    const { leaveOut: lo, ...wProps } = w.parameters.properties;
    expect(JSON.stringify({ ...w, description: o.description, parameters: { ...w.parameters, properties: wProps } })).toBe(JSON.stringify(o));
    expect(lo).toEqual({ type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['url', 'reason'],
      properties: { url: { type: 'string', minLength: 1, maxLength: 500 }, reason: { type: 'string', minLength: 1, maxLength: 200 } } } });
    expect(o.description.replace('To change a draft, save a new version with the change.', 'For a NEW draft, or when the member asks for a complete rewrite, save the whole draft. To change a saved draft, use edit_draft_artifact instead. Every https link the member gives in their message must be in the draft; if the member asks to drop or not use a link, list it in leaveOut with a short reason (the member sees it).')).toBe(w.description);
    const e = cur.tools[3];
    expect([e.name, e.parameters.required]).toEqual(['edit_draft_artifact', ['artifactId', 'parentVersion', 'parentSha256', 'edits']]);
    expect(JSON.stringify(e)).not.toMatch(/send|publish|email|outbox|vercel|resend/i);
  });

  it("E-15c + delta A: vs 5253d856 the catalog moves ONLY in write_draft_artifact (description, headerPhotos, section images) and the new read-only list_site_images", () => {
    const old = JSON.parse(readFileSync(new URL('./fixtures/chat-tool-catalog-5253d856.json', import.meta.url), 'utf8'));
    expect(toolCatalogHash(old)).toBe('sha256:5253d8566f51da0c845cec2b874b30c258912d3ee16c1aa27b088e54a4d08fb4');
    // PACKAGE P: the edit tool is checked separately (above); this delta is about the Package F tools.
    const cur = JSON.parse(JSON.stringify({ ...CHAT_TOOL_CATALOG, tools: CHAT_TOOL_CATALOG.tools.filter((t) => t.name !== 'edit_draft_artifact') }));
    expect(cur.tools.slice(0, 4).filter((_t: any, i: number) => JSON.stringify(cur.tools[i]) !== JSON.stringify(old.tools[i])).map((t: any) => t.name)).toEqual(['write_draft_artifact']);
    expect(cur.tools[4]).toEqual({ name: 'list_site_images', description: 'List the website images a newsletter may use: each address with a hint from its file name.',
      parameters: { type: 'object', additionalProperties: false, properties: {} } });
    const w = cur.tools[2], o = old.tools[2];
    expect(w.description).toMatch(/inline links written as \[text\]\(https:\/\/\.\.\.\)/); expect(w.description).toMatch(/call it before placing or swapping photos/);
    const nl = w.parameters.properties.content.anyOf[0], onl = o.parameters.properties.content.anyOf[0];
    expect(nl.properties.headerPhotos).toEqual({ type: 'array', minItems: 4, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 500 } });
    expect(nl.properties.sections.items.properties.images).toEqual({ type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['url', 'alt', 'position'],
      properties: { url: { type: 'string', minLength: 1, maxLength: 500 }, alt: { type: 'string', maxLength: 200 }, caption: { type: 'string', minLength: 1, maxLength: 300 },
        position: { type: 'string', enum: ['above', 'below', 'left', 'right'] } } } });
    const { headerPhotos: _hp, ...rest } = nl.properties, { images: _im, ...secRest } = nl.properties.sections.items.properties;
    expect(JSON.stringify({ ...nl, properties: { ...rest, sections: { ...rest.sections, items: { ...rest.sections.items, properties: secRest } } } })).toBe(JSON.stringify(onl)); // nothing else in the newsletter schema moved
    const { leaveOut: _lo, ...wp } = w.parameters.properties; // PACKAGE P adds the optional leaveOut (checked in the P test)
    expect(JSON.stringify({ ...w, description: o.description, parameters: { ...w.parameters, properties: { ...wp, content: o.parameters.properties.content } } })).toBe(JSON.stringify(o));
  });

  it('identity: excludes only qualificationRef (F-8); a catalog, cap, pin or price change is a different profile', () => {
    const h0 = interactiveProfileHash(P);
    expect(interactiveProfileHash({...P, qualificationRef: 'sha256:' + 'a'.repeat(64)})).toBe(h0);
    expect(interactiveProfileHash({...P, turn: {...P.turn, usd: 0.5}})).not.toBe(h0);
    expect(interactiveProfileHash({...P, runtime: {...P.runtime, toolCatalogHash: 'sha256:' + 'b'.repeat(64)}})).not.toBe(h0);
    expect(interactiveProfileHash({...P, runtime: {...P.runtime, providers: ['amazon-bedrock/us']}})).not.toBe(h0);
    expect(interactiveProfileHash({...P, pricing: {...P.pricing, outputUsdPerMTok: 20}})).not.toBe(h0);
    // Changing a schema changes the catalog hash.
    const t = structuredClone(CHAT_TOOL_CATALOG) as any; t.tools[0].parameters.properties.path.maxLength = 301;
    expect(toolCatalogHash(t)).not.toBe(toolCatalogHash());
    const u = structuredClone(CHAT_TOOL_CATALOG) as any; u.tools[1].description += ' ';
    expect(toolCatalogHash(u)).not.toBe(toolCatalogHash());
  });

  it('the schema refuses caps above the slice-1 limits, latest models, a request timeout over the wall cap, and extra keys', () => {
    const bad = (over: (p: any) => void) => { const p = structuredClone(P) as any; over(p); return interactiveProfileSchema.safeParse(p).success; };
    expect(bad(() => {})).toBe(true);
    expect(bad((p) => { p.turn.requests = 7; })).toBe(false);
    expect(bad((p) => { p.turn.toolCalls = 13; })).toBe(false);
    expect(bad((p) => { p.turn.usd = 1.01; })).toBe(false);
    expect(bad((p) => { p.turn.wallMs = 120_001; })).toBe(false);
    expect(bad((p) => { p.turn.contextBytes = 131_073; })).toBe(false);
    expect(bad((p) => { p.turn.resultBytes = 32_769; })).toBe(false);
    expect(bad((p) => { p.limits.maxOutputTokens = 4097; })).toBe(false);
    expect(bad((p) => { p.turn.wallMs = 30_000; p.limits.timeoutMs = 60_000; })).toBe(false);
    expect(bad((p) => { p.runtime.model = 'anthropic/claude-latest'; })).toBe(false);
    expect(bad((p) => { p.runtime.tools = []; })).toBe(false);
    expect(bad((p) => { p.runtime.allowFallbacks = true; })).toBe(false);
    expect(() => interactiveFromHosted('x-chat', OPENROUTER_PROFILES.sonnet, {caps: {...SLICE1_TURN_CAPS, usd: 2}})).toThrow();
    expect(interactiveReservationUsd(P, 3000)).toBeCloseTo(((1064 * 3.3 + 4096 * 16.5) / 1e6) * 1.5, 10);
  });
});

describe('interactive transport', () => {
  it('sends exactly one pinned request: tools, multi-turn messages, no fallbacks, reasoning off, usage, ZDR; key in the header only', async () => {
    const history: ChatMessage[] = [...msgs, {role: 'assistant', content: null, toolCalls: [{id: 'call_1', name: 'search_org_history', arguments: '{"query":"cleanup"}'}]},
      {role: 'tool', toolCallId: 'call_1', content: 'members/notes/oct.md#L3: The cleanup is on Oct 31.'}];
    const {r, sent} = await send(() => json(reply({content: 'The cleanup is on Oct 31 [members/notes/oct.md#L3].'})), {messages: history, maxTokens: 2000});
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(sent[0].init).toMatchObject({method: 'POST', redirect: 'error', headers: {'content-type': 'application/json', authorization: 'Bearer ' + KEY}});
    const body = JSON.parse(sent[0].init.body);
    expect(body).toEqual(interactiveRequestBody(P, history, 2000));
    // TEAM-TASKS (the 62cea80c requal): a no-tools body carries no catalog and no tool_choice; everything else is the same.
    const bare = interactiveRequestBody(P, history, 2000, "auto", true) as Record<string, unknown>, full = interactiveRequestBody(P, history, 2000) as Record<string, unknown>;
    expect(bare).not.toHaveProperty("tools"); expect(bare).not.toHaveProperty("tool_choice");
    expect(Object.keys(full).filter((k) => !["tools", "tool_choice"].includes(k))).toEqual(Object.keys(bare));
    expect(body).toEqual({model: MODEL, stream: false, max_tokens: 2000, temperature: 0, tool_choice: 'auto', usage: {include: true},
      reasoning: {effort: 'none', exclude: true},
      provider: {order: ['amazon-bedrock/us', 'google-vertex/us-east5'], allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true},
      tools: CHAT_TOOL_CATALOG.tools.map((t) => ({type: 'function', function: {name: t.name, description: t.description, parameters: t.parameters}})),
      messages: [{role: 'system', content: 'CHAT_RULES (synthetic)'}, {role: 'user', content: 'When is the cleanup?'},
        {role: 'assistant', content: null, tool_calls: [{id: 'call_1', type: 'function', function: {name: 'search_org_history', arguments: '{"query":"cleanup"}'}}]},
        {role: 'tool', tool_call_id: 'call_1', content: 'members/notes/oct.md#L3: The cleanup is on Oct 31.'}]});
    expect(sent[0].init.body).not.toContain(KEY);
    expect(r).toEqual({finish: 'stop', text: 'The cleanup is on Oct 31 [members/notes/oct.md#L3].', toolCalls: [], responseId: 'gen-synthetic-1', routedProvider: 'Amazon Bedrock',
      usage: {promptTokens: 900, completionTokens: 120}, costUsd: 0.0049});
  });

  it('accepts tool_calls (with or without text); names are passed through for the runtime to judge (an uncatalogued one included)', async () => {
    const a = await send(() => json(reply({content: null, tool_calls: [call('call_a'), call('call_b', 'read_org_file', '{"path":"members/notes/oct.md"}')]}, 'tool_calls')));
    expect(a.r).toMatchObject({finish: 'tool_calls', text: '', toolCalls: [{id: 'call_a', name: 'search_org_history', arguments: '{"query":"cleanup"}'},
      {id: 'call_b', name: 'read_org_file', arguments: '{"path":"members/notes/oct.md"}'}], costUsd: 0.0049});
    const b = await send(() => json(reply({content: 'Let me look.', tool_calls: [call('call_c', 'send_email', '{"to":"everyone"}')]}, 'tool_calls')));
    expect(b.r).toMatchObject({finish: 'tool_calls', text: 'Let me look.', toolCalls: [{id: 'call_c', name: 'send_email'}]});
    const c = await send(() => json(reply({content: null, tool_calls: [call('call_d', 'read_org_file', 'not json at all')]}, 'tool_calls')));
    expect(c.r?.toolCalls[0].arguments).toBe('not json at all'); // the runtime counts this as a strike (C-4), not the transport
  });

  const reasons: [string, () => Response | Promise<Response>, string, number | null][] = [
    ['length', () => json(reply({content: 'A long'}, 'length')), 'chat_output_truncated', 0.0049],
    ['length with tool calls', () => json(reply({content: null, tool_calls: [call('call_x')]}, 'length')), 'chat_output_truncated', 0.0049],
    ['reasoning field', () => json(reply({content: 'x', reasoning: 'thinking'})), 'hosted_reasoning_refused:field=reasoning', 0.0049],
    ['reasoning_content', () => json(reply({content: 'x', reasoning_content: 'thinking'})), 'hosted_reasoning_refused:field=reasoning_content', 0.0049],
    ['reasoning_details + tokens', () => json(reply({content: 'x', reasoning_details: [{}, {}]}, 'stop', {usage: {...usage, completion_tokens_details: {reasoning_tokens: 12}}})),
      'hosted_reasoning_refused:field=reasoning_details,n=2,tokens=12', 0.0049],
    ['reasoning tokens only', () => json(reply({content: 'x'}, 'tool_calls', {usage: {...usage, completion_tokens_details: {reasoning_tokens: 7}}})), 'hosted_reasoning_refused:tokens=7', 0.0049],
    ['stop with tool calls', () => json(reply({content: 'x', tool_calls: [call('call_x')]})), 'chat_finish_inconsistent', 0.0049],
    ['tool_calls without calls', () => json(reply({content: 'x', tool_calls: []}, 'tool_calls')), 'chat_tool_calls_malformed', 0.0049],
    ['bad call id', () => json(reply({content: null, tool_calls: [call('call 1')]}, 'tool_calls')), 'chat_tool_calls_malformed', 0.0049],
    ['duplicate call id', () => json(reply({content: null, tool_calls: [call('c1'), call('c1')]}, 'tool_calls')), 'chat_tool_calls_malformed', 0.0049],
    ['bad tool name', () => json(reply({content: null, tool_calls: [call('c1', 'Read-File')]}, 'tool_calls')), 'chat_tool_calls_malformed', 0.0049],
    ['not a function call', () => json(reply({content: null, tool_calls: [{id: 'c1', type: 'code', function: {name: 'x', arguments: '{}'}}]}, 'tool_calls')), 'chat_tool_calls_malformed', 0.0049],
    ['arguments not a string', () => json(reply({content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'x', arguments: {a: 1}}}]}, 'tool_calls')), 'chat_tool_calls_malformed', 0.0049],
    ['arguments too large', () => json(reply({content: null, tool_calls: [call('c1', 'read_org_file', '"' + 'a'.repeat(32_767) + '"')]}, 'tool_calls')), 'chat_tool_calls_malformed', 0.0049],
    ['too many calls', () => json(reply({content: null, tool_calls: Array.from({length: 13}, (_, i) => call('c' + i))}, 'tool_calls')), 'chat_tool_calls_too_many', 0.0049],
    ['content_filter', () => json(reply({content: 'x'}, 'content_filter')), 'hosted_not_terminal', 0.0049],
    ['null finish', () => json(reply({content: 'x'}, null)), 'hosted_not_terminal', 0.0049],
    ['empty stop', () => json(reply({content: '  '})), 'hosted_output_empty', 0.0049],
    ['output too large', () => json(reply({content: 'a'.repeat(32_001)})), 'hosted_output_too_large', 0.0049],
    ['model mismatch', () => json(reply({content: 'x'}, 'stop', {model: 'anthropic/claude-opus-5'})), 'hosted_model_mismatch', 0.0049],
    ['provider not allowed', () => json(reply({content: 'x'}, 'stop', {provider: 'Anthropic'})), 'hosted_provider_not_allowed', 0.0049],
    ['two choices', () => json({...reply({content: 'x'}), choices: [reply({content: 'x'}).choices[0], reply({content: 'y'}).choices[0]]}), 'hosted_choices_not_one', 0.0049],
    ['usage missing', () => json(reply({content: 'x'}, 'stop', {usage: undefined})), 'hosted_usage_missing', null],
    ['cost missing', () => json(reply({content: 'x'}, 'stop', {usage: {prompt_tokens: 1, completion_tokens: 1}})), 'hosted_usage_missing', null],
    ['usage over max_tokens', () => json(reply({content: 'x'}, 'stop', {usage: {...usage, completion_tokens: 5000, total_tokens: 5900}})), 'hosted_usage_invalid', 0.0049],
    ['usage total inconsistent', () => json(reply({content: 'x'}, 'stop', {usage: {...usage, total_tokens: 1}})), 'hosted_usage_invalid', 0.0049],
    ['unsupported body', () => json({choices: 'x'}), 'hosted_response_unsupported', null],
    ['malformed json', () => new Response('{', {status: 200, headers: {'content-type': 'application/json'}}), 'hosted_response_malformed', null],
    ['not json', () => new Response('<html>', {status: 200, headers: {'content-type': 'text/html'}}), 'hosted_response_not_json', null],
    ['too large', () => new Response('x'.repeat(262_145), {status: 200, headers: {'content-type': 'application/json'}}), 'hosted_response_too_large', null],
    ['404 with code', () => json({error: {code: 404, message: 'No endpoints found that support tool use'}}, 404), 'hosted_http_404:code=404', null],
    ['429', () => json({error: {code: 429, message: 'rate limited'}}, 429), 'hosted_http_429:code=429', null],
    ['5xx', () => new Response('oops', {status: 502}), 'hosted_http_5xx', null],
    ['redirect status', () => new Response(null, {status: 302}), 'hosted_http_unexpected', null],
    ['transport failure', () => { throw new TypeError('socket hang up'); }, 'hosted_transport_failed', null],
  ];
  it.each(reasons)('refuses %s with a fixed label (sent, cost settled when the provider reported one)', async (_n, res, label, cost) => {
    const {r, sent, error} = await send(res);
    expect(r).toBeNull();
    expect(sent).toHaveLength(1);
    expect(error!.reason).toBe(label);
    expect(error!.sent).toBe(true);
    expect(error!.costUsd).toBe(cost);
    expect(failureLabel(new Error(label))).toBe(label);
    expect(persistedReason(failureLabel(new Error(label)))).toBe(label);
    expect(String(error!.message)).not.toMatch(/No endpoints|rate limited|thinking|oops|socket/);
  });

  it('ledger meaning is the hosted one: unknown outcomes stay unsettled, provider refusals before inference are released', () => {
    for (const l of ['hosted_transport_failed', 'hosted_http_5xx', 'hosted_response_too_large', 'hosted_usage_missing']) expect(HOSTED_UNSETTLED.has(l), l).toBe(true);
    for (const l of ['hosted_http_404:code=404', 'hosted_http_429:code=429']) expect(HOSTED_REFUSED_BEFORE_INFERENCE.has(hostedBaseLabel(l)), l).toBe(true);
    for (const l of INTERACTIVE_FAILURE_REASONS) expect(HOSTED_UNSETTLED.has(l) || HOSTED_REFUSED_BEFORE_INFERENCE.has(l), l).toBe(false);
  });

  it('abort after send and the deadline are distinct unsettled outcomes', async () => {
    const hang = (init: any) => new Promise<Response>((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const ac = new AbortController();
    const sentA: any[] = [];
    const a = interactiveComplete({profile: P, apiKey: KEY, messages: msgs, maxTokens: 100}, {fetch: (u, init) => { sentA.push(u); return hang(init); }, signal: ac.signal, deadlineMs: 60_000})
      .catch((e) => e as HostedTransportError);
    await new Promise((r) => setTimeout(r, 10)); ac.abort();
    expect(await a).toMatchObject({reason: 'hosted_aborted_after_send', sent: true});
    const d = await interactiveComplete({profile: P, apiKey: KEY, messages: msgs, maxTokens: 100}, {fetch: (_u, init) => hang(init), signal: new AbortController().signal, deadlineMs: 20})
      .catch((e) => e as HostedTransportError);
    expect(d).toMatchObject({reason: 'hosted_deadline_exceeded', sent: true});
    for (const l of ['hosted_aborted_after_send', 'hosted_deadline_exceeded']) expect(HOSTED_UNSETTLED.has(l)).toBe(true);
  });

  it('refuses before send (nothing leaves): key, max_tokens, message shape, catalog drift, body size, abort, ambient proxy', async () => {
    const before = async (o: Parameters<typeof send>[1], label: string) => {
      const {sent, error} = await send(() => json(reply({content: 'x'})), o);
      expect(error?.reason).toBe(label); expect(error?.sent).toBe(false); expect(sent).toHaveLength(0);
    };
    await before({key: ''}, 'hosted_key_missing');
    await before({key: 'two words'}, 'hosted_key_missing');
    await before({maxTokens: 4097}, 'hosted_max_tokens_invalid');
    await before({maxTokens: 0}, 'hosted_max_tokens_invalid');
    await before({messages: [{role: 'user', content: 'no system'}]}, 'chat_messages_invalid');
    await before({profile: {...P, runtime: {...P.runtime, toolCatalogHash: 'sha256:' + 'c'.repeat(64)}}}, 'chat_tools_not_catalog');
    await before({messages: [msgs[0], {role: 'user', content: 'x'.repeat(1_048_576)}]}, 'chat_request_too_large');
    const ac = new AbortController(); ac.abort();
    await before({signal: ac.signal}, 'hosted_aborted_before_send');
    process.env.NODE_USE_ENV_PROXY = '1';
    try { await before({}, 'hosted_ambient_proxy_refused'); } finally { delete process.env.NODE_USE_ENV_PROXY; }
    for (const l of ['chat_messages_invalid', 'chat_tools_not_catalog', 'chat_request_too_large']) expect(failureLabel(new Error(l))).toBe(l);
  });

  it('message shape: one leading system; every tool call answered exactly once before the next turn; never ends on the assistant', () => {
    const s = msgs[0], u = msgs[1];
    const asst = (ids: string[]): ChatMessage => ({role: 'assistant', content: null, toolCalls: ids.map((id) => ({id, name: 'read_org_file', arguments: '{}'}))});
    const tool = (id: string): ChatMessage => ({role: 'tool', toolCallId: id, content: 'r'});
    expect(checkMessages([s, u])).toBe(true);
    expect(checkMessages([s, u, asst(['a', 'b']), tool('b'), tool('a')])).toBe(true);
    expect(checkMessages([s, u, {role: 'assistant', content: 'Hi'}, {role: 'user', content: 'Change the headline'}])).toBe(true);
    expect(checkMessages([u])).toBe(false);
    expect(checkMessages([s])).toBe(false);
    expect(checkMessages([s, s, u])).toBe(false);
    expect(checkMessages([s, u, s])).toBe(false);
    expect(checkMessages([s, u, asst(['a'])])).toBe(false);                    // unanswered
    expect(checkMessages([s, u, asst(['a']), u])).toBe(false);                 // turn before the answer
    expect(checkMessages([s, u, asst(['a']), tool('a'), tool('a')])).toBe(false); // answered twice
    expect(checkMessages([s, u, tool('z')])).toBe(false);                      // unknown id
    expect(checkMessages([s, u, asst(['a', 'a']), tool('a'), tool('a')])).toBe(false); // duplicate ids
    expect(checkMessages([s, u, asst(['bad id']), tool('bad id')])).toBe(false);
    expect(checkMessages([s, u, {role: 'assistant', content: 'done'}])).toBe(false);
  });

  it('every interactive label is in the worker vocabulary and the journal format', () => {
    for (const l of INTERACTIVE_FAILURE_REASONS) { expect(failureLabel(new Error(l)), l).toBe(l); expect(persistedReason(l), l).toBe(l); }
  });
});

// Team-task long output (owner live run Oct 23): an opt-in per-request ceiling above the profile's 4,096 and a kept cut-off reply.
describe('task-only ceiling and keepTruncated (chat untouched)', () => {
  it('a ceiling allows max_tokens up to it (<= 32,768); without one the profile limit stands', async () => {
    const big = {...usage, completion_tokens: 16000, total_tokens: 16900};
    const ok = await send(() => json(reply({content: 'Long.'}, 'stop', {usage: big})), {maxTokens: 16384, ceiling: 16384});
    expect([ok.error, ok.r?.finish, JSON.parse(ok.sent[0].init.body).max_tokens]).toEqual([null, 'stop', 16384]);
    expect((await send(() => json(reply({content: 'x'})), {maxTokens: 16384})).error?.reason).toBe('hosted_max_tokens_invalid'); // chat: 4,096
    expect((await send(() => json(reply({content: 'x'})), {maxTokens: 40000, ceiling: 40000})).error?.reason).toBe('hosted_max_tokens_invalid');
    expect((await send(() => json(reply({content: 'x'})), {maxTokens: 16384, ceiling: 16384})).sent).toHaveLength(1);
  });
  it('keepTruncated returns a cut-off reply as finish "length" with its text and cost; its tool calls are dropped; without it, the old refusal', async () => {
    const kept = await send(() => json(reply({content: 'Part one,', tool_calls: [call('call_x')]}, 'length')), {keepTruncated: true});
    expect([kept.error, kept.r?.finish, kept.r?.text, kept.r?.toolCalls, kept.r?.costUsd]).toEqual([null, 'length', 'Part one,', [], 0.0049]);
    expect((await send(() => json(reply({content: 'Part one,'}, 'length')))).error?.reason).toBe('chat_output_truncated');
  });
  it('the reply character cap scales with a ceiling only (chat keeps 32,000)', async () => {
    const long = 'x'.repeat(40_000);
    expect((await send(() => json(reply({content: long}))))).toMatchObject({error: {reason: 'hosted_output_too_large'}});
    expect((await send(() => json(reply({content: long})), {maxTokens: 16384, ceiling: 16384})).error).toBeNull();
  });
});

// Fable R-1 (ab150875 / d771169f): a long task reply takes minutes; the task path carries its own request deadline above the
// profile's timeout, chat keeps the profile's. Scaled down: profile timeout 100 ms, a reply taking 300 ms (stands for 200 s vs 120 s).
describe('task-only request deadline (R-1)', () => {
  const slowFetch = (ms: number) => async (_u: string, init: any) => new Promise<Response>((resolve, reject) => {
    const t = setTimeout(() => resolve(json(reply({content: 'Done.'}))), ms);
    init.signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, {once: true});
  });
  const quick = interactiveProfileSchema.parse({...P, limits: {...P.limits, timeoutMs: 100}});
  const go = (o: {timeoutMs?: number}) => interactiveComplete({profile: quick, apiKey: KEY, messages: msgs, maxTokens: 4096, ...(o.timeoutMs ? {ceiling: 16384, keepTruncated: true, timeoutMs: o.timeoutMs} : {})},
    {fetch: slowFetch(300) as never, signal: new AbortController().signal, deadlineMs: 60_000}).then((r) => ({finish: r.finish, error: null}), (e) => ({finish: null, error: (e as HostedTransportError).reason}));
  it('the chat path is aborted at the profile timeout', async () => { expect(await go({})).toEqual({finish: null, error: 'hosted_deadline_exceeded'}); });
  it('the task path with its own deadline is not', async () => { expect(await go({timeoutMs: 2000})).toEqual({finish: 'stop', error: null}); });
  it('a task deadline is bounded (<= 10 min)', async () => { expect((await go({timeoutMs: 700_000})).error).toBe('hosted_max_tokens_invalid'); });
});
