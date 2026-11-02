// Chat agent slice 1 (PLAN-SLICE-1 §2, Fable R-1): the interactive transport branch, BESIDE the hosted one-POST transport
// (hosted/transport.ts stays byte-for-byte; its bounded-body and status-label helpers are lifted here, not edited there).
// One request = exactly `POST <pinned origin>/chat/completions`, stream:false, the profile's pins (model, provider order without
// fallbacks, require_parameters, data policy, reasoning off, usage) plus the slice-1 tool catalog and multi-turn messages.
// Accepted: finish_reason "tool_calls" with well-formed tool calls, or "stop" with non-empty text; "length" ->
// chat_output_truncated; any reasoning -> hosted_reasoning_refused with the content-free sub-tag. Whether a named tool exists
// or its arguments fit its schema is the runtime's decision per step (C-4), never this transport's. Labels shared with the
// hosted branch keep their hosted_ spelling and ledger meaning (HOSTED_UNSETTLED / HOSTED_REFUSED_BEFORE_INFERENCE); loop-
// specific outcomes are chat_. No retries, no fallback, no streaming, no compaction. Rejected bodies are never returned.
import {z} from 'zod';
import {HostedTransportError, HOSTED_RESPONSE_BYTES, HOSTED_OUTPUT_CHARS, type HostedFetch} from '../hosted/transport.js';
import {interactiveProfileSchema, type InteractiveProfile} from './profile.js';
import {CHAT_TOOL_CATALOG, TASK_TOOL_CATALOG, catalogRequestTools, toolCatalogHash} from './catalog.js';

export const INTERACTIVE_FAILURE_REASONS = ['chat_output_truncated', 'chat_messages_invalid', 'chat_request_too_large', 'chat_tools_not_catalog',
  'chat_tool_calls_malformed', 'chat_tool_calls_too_many', 'chat_finish_inconsistent'] as const;
export const CHAT_REQUEST_BYTES = 1_048_576;
export const CHAT_TOOL_CALLS_PER_RESPONSE = 12;
export const CHAT_TOOL_ARGUMENT_BYTES = 32_768;

export type ChatToolCall = {id: string; name: string; arguments: string};
export type ChatMessage =
  | {role: 'system'; content: string}
  | {role: 'user'; content: string}
  | {role: 'assistant'; content: string | null; toolCalls?: ChatToolCall[]}
  | {role: 'tool'; toolCallId: string; content: string};
export type InteractiveResult = {finish: 'stop' | 'tool_calls' | 'length'; text: string; toolCalls: ChatToolCall[]; responseId: string | null; routedProvider: string;
  usage: {promptTokens: number; completionTokens: number}; costUsd: number};

const ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[1-9][0-9]{1,4})?(\/[a-z0-9._-]+)*$/;
const CALL_ID = /^[A-Za-z0-9_-]{1,200}$/, TOOL_NAME = /^[a-z_][a-z0-9_]{0,63}$/;
const HTTP_4XX_LABELLED = [400, 401, 402, 403, 404, 408, 413, 422, 429];
const fail = (reason: string, sent: boolean, cost: number | null = null) => new HostedTransportError(reason, sent, cost);

/** Messages must be one leading system message, then user/assistant/tool turns where every assistant tool call is answered by
 *  exactly one tool message before the next user or assistant message (the shape the scheduler builds; anything else is a bug). */
export function checkMessages(messages: ChatMessage[]) {
  if (!Array.isArray(messages) || messages.length < 2 || messages.length > 400 || messages[0]?.role !== 'system') return false;
  let open = new Set<string>(), users = 0;
  for (const [i, m] of messages.entries()) {
    if (i > 0 && m.role === 'system') return false;
    if (m.role === 'tool') { if (!open.delete(m.toolCallId)) return false; continue; }
    if (open.size) return false;
    if (m.role === 'user') users++;
    if (m.role === 'assistant' && m.toolCalls?.length) {
      for (const c of m.toolCalls) { if (!CALL_ID.test(c.id) || !TOOL_NAME.test(c.name) || open.has(c.id)) return false; open.add(c.id); }
    }
  }
  return users > 0 && open.size === 0 && messages.at(-1)!.role !== 'assistant';
}

/** toolChoice 'none' (TEAM-TASKS, owner Oct 23): a final no-tool request; the catalog is still sent (earlier messages hold tool calls).
 *  noTools (TEAM-TASKS, the 62cea80c requal): a request with NO catalog and no tool_choice, for a task whose sources are all in the
 *  prompt; the conversation then never holds a tool call. The pinned catalog (toolCatalogHash) is unchanged; it is simply not sent. */
export function interactiveRequestBody(p: InteractiveProfile, messages: ChatMessage[], maxTokens: number, toolChoice: 'auto' | 'none' = 'auto', noTools = false,
  toolSet: 'chat' | 'task' = 'chat') {
  const r = p.runtime;
  const body = {
    model: r.model,
    messages: messages.map((m) => m.role === 'tool' ? {role: 'tool', tool_call_id: m.toolCallId, content: m.content}
      : m.role === 'assistant' ? {role: 'assistant', content: m.content, ...(m.toolCalls?.length ? {tool_calls: m.toolCalls.map((c) => ({id: c.id, type: 'function', function: {name: c.name, arguments: c.arguments}}))} : {})}
      : {role: m.role, content: m.content}),
    tools: catalogRequestTools(toolSet === 'task' ? TASK_TOOL_CATALOG : CHAT_TOOL_CATALOG), // evidence-inheritance (A): a task gets only its two tools
    tool_choice: toolChoice,
    stream: false,
    max_tokens: maxTokens,
    temperature: 0,
    reasoning: r.reasoningOff === 'effort-none' ? {effort: 'none', exclude: true} : {enabled: false, exclude: true},
    provider: {order: [...r.providers], allow_fallbacks: false, require_parameters: true, data_collection: r.dataPolicy.dataCollection, ...(r.dataPolicy.zdr ? {zdr: true} : {})},
    usage: {include: true},
  };
  if (!noTools) return body;
  const {tools: _tools, tool_choice: _choice, ...bare} = body;
  return bare;
}

const toolCallSchema = z.object({id: z.string(), type: z.literal('function'), function: z.object({name: z.string(), arguments: z.string()}).loose()}).loose();
const responseSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  model: z.string(),
  provider: z.string().max(100).optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable(),
    message: z.object({
      role: z.literal('assistant'), content: z.string().nullable().optional(),
      tool_calls: z.array(z.unknown()).nullable().optional(),
      reasoning: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(), reasoning_details: z.array(z.unknown()).nullable().optional(),
    }).loose(),
  }).loose()),
  usage: z.object({prompt_tokens: z.number().int().nonnegative().max(1_000_000), completion_tokens: z.number().int().nonnegative().max(1_000_000),
    total_tokens: z.number().int().nonnegative().max(2_000_000).optional(), cost: z.number().nonnegative().max(1000).optional(),
    completion_tokens_details: z.object({reasoning_tokens: z.number().int().nonnegative().optional()}).loose().nullable().optional()}).loose().nullable().optional(),
}).loose();

// Lifted from hosted/transport.ts (same behaviour): a bounded body read under the deadline, and the content-free status label.
export async function boundedBody(res: Response, limit: number, deadline: AbortSignal): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw fail('hosted_response_empty', true);
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => { reader.cancel().catch(() => {}); reject(new Error('deadline')); };
    if (deadline.aborted) stop(); else deadline.addEventListener('abort', stop, {once: true});
  });
  aborted.catch(() => {});
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const p = await Promise.race([reader.read(), aborted]);
    if (deadline.aborted) throw new Error('deadline');
    if (p.done) break;
    size += p.value.length;
    if (size > limit) { await reader.cancel().catch(() => {}); throw fail('hosted_response_too_large', true); }
    chunks.push(p.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
export async function statusLabel(res: Response, deadline: AbortSignal) {
  const s = res.status;
  if (s >= 500) { await res.body?.cancel().catch(() => {}); return 'hosted_http_5xx'; }
  if (s < 400) { await res.body?.cancel().catch(() => {}); return 'hosted_http_unexpected'; }
  const base = HTTP_4XX_LABELLED.includes(s) ? 'hosted_http_' + s : 'hosted_http_4xx';
  let code: number | null = null;
  try { const v = JSON.parse(await boundedBody(res, 8192, deadline)); const c = v?.error?.code; if (Number.isInteger(c) && c >= 100 && c <= 999) code = c; } catch { /* no code */ }
  return code === null ? base : `${base}:code=${code}`;
}

/** One model request of a turn. Throws HostedTransportError with a fixed label (never the key or a body); sent=false only when
 *  nothing left the process. `costUsd` on a rejection is the provider-reported cost of a complete response (settle at it). */
/** Team tasks (owner live run, Oct 23; design 41e8b518): `ceiling` raises the output limit for THIS request above the profile's
 *  (the profile, its hash and chat stay at theirs); `keepTruncated` returns a reply cut off at the limit as finish 'length' with
 *  its text (settled at the reported cost) instead of rejecting it as chat_output_truncated. Chat sets neither. */
export const TASK_OUTPUT_CEILING_MAX = 32_768;
/** Fable R-1: a team-task request may run longer than the profile's timeout (a 16k reply takes minutes); never above this. */
export const TASK_REQUEST_TIMEOUT_MAX = 600_000;
export async function interactiveComplete(r: {profile: InteractiveProfile; apiKey: string; messages: ChatMessage[]; maxTokens: number; toolChoice?: 'auto' | 'none';
  ceiling?: number; keepTruncated?: boolean; timeoutMs?: number; noTools?: boolean; toolSet?: 'chat' | 'task'},
  o: {fetch: HostedFetch; signal: AbortSignal; deadlineMs: number}): Promise<InteractiveResult> {
  const p = interactiveProfileSchema.parse(r.profile), rt = p.runtime;
  if (!ORIGIN.test(rt.origin)) throw fail('hosted_origin_not_admitted', false);
  if (rt.toolCatalogHash !== toolCatalogHash()) throw fail('chat_tools_not_catalog', false);
  if (!r.apiKey || /\s/.test(r.apiKey)) throw fail('hosted_key_missing', false);
  const ceiling = r.ceiling === undefined ? p.limits.maxOutputTokens : r.ceiling;
  if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > TASK_OUTPUT_CEILING_MAX || ceiling >= rt.contextTokens) throw fail('hosted_max_tokens_invalid', false);
  if (!Number.isInteger(r.maxTokens) || r.maxTokens < 1 || r.maxTokens > ceiling) throw fail('hosted_max_tokens_invalid', false);
  if (!checkMessages(r.messages)) throw fail('chat_messages_invalid', false);
  if (r.noTools && r.messages.some((m) => m.role === 'tool' || (m.role === 'assistant' && m.toolCalls?.length))) throw fail('chat_messages_invalid', false); // no catalog, no tool history
  const body = JSON.stringify(interactiveRequestBody(p, r.messages, r.maxTokens, r.toolChoice ?? 'auto', !!r.noTools, r.toolSet ?? 'chat'));
  if (Buffer.byteLength(body) > CHAT_REQUEST_BYTES) throw fail('chat_request_too_large', false);
  if (o.signal.aborted) throw fail('hosted_aborted_before_send', false);
  if (process.env.NODE_USE_ENV_PROXY) throw fail('hosted_ambient_proxy_refused', false);
  if (r.timeoutMs !== undefined && (!Number.isInteger(r.timeoutMs) || r.timeoutMs < 1 || r.timeoutMs > TASK_REQUEST_TIMEOUT_MAX)) throw fail('hosted_max_tokens_invalid', false);
  const deadline = AbortSignal.any([o.signal, AbortSignal.timeout(Math.min(o.deadlineMs, r.timeoutMs ?? p.limits.timeoutMs))]); // chat: the profile's
  let res: Response, text: string;
  try {
    res = await o.fetch(rt.origin + '/chat/completions', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + r.apiKey},
      body, redirect: 'error', signal: deadline});
    if (res.status !== 200) throw fail(await statusLabel(res, deadline), true);
    if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) { await res.body?.cancel().catch(() => {}); throw fail('hosted_response_not_json', true); }
    text = await boundedBody(res, HOSTED_RESPONSE_BYTES, deadline);
  } catch (e) {
    if (e instanceof HostedTransportError) throw e;
    throw fail(o.signal.aborted ? 'hosted_aborted_after_send' : deadline.aborted ? 'hosted_deadline_exceeded' : 'hosted_transport_failed', true);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw fail('hosted_response_malformed', true); }
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw fail('hosted_response_unsupported', true);
  const v = parsed.data, billed = v.usage?.cost ?? null;
  const reject = (reason: string) => fail(reason, true, billed);
  if (v.choices.length !== 1) throw reject('hosted_choices_not_one');
  const c = v.choices[0];
  if (!(rt.responseModels ?? [rt.model]).includes(v.model)) throw reject('hosted_model_mismatch');
  if (!v.provider || !(rt.providerNames ?? rt.providers).includes(v.provider)) throw reject('hosted_provider_not_allowed');
  // The hosted sub-tag rule, unchanged: which reasoning signal fired, content-free; empty strings, null and [] never fire.
  const rtok = v.usage?.completion_tokens_details?.reasoning_tokens ?? 0, rd = c.message.reasoning_details?.length ?? 0;
  const why = c.message.reasoning ? 'field=reasoning' : c.message.reasoning_content ? 'field=reasoning_content' : rd ? `field=reasoning_details,n=${Math.min(rd, 9999)}` : rtok > 0 ? `tokens=${Math.min(rtok, 9_999_999)}` : null;
  if (why) throw reject(`hosted_reasoning_refused:${why}${rtok > 0 && !why.startsWith('tokens') ? `,tokens=${Math.min(rtok, 9_999_999)}` : ''}`);
  const cut = c.finish_reason === 'length';
  if (cut && !r.keepTruncated) throw reject('chat_output_truncated');
  if (!cut && c.finish_reason !== 'stop' && c.finish_reason !== 'tool_calls') throw reject('hosted_not_terminal');
  const out = c.message.content ?? '';
  const charCap = r.ceiling === undefined ? HOSTED_OUTPUT_CHARS : Math.max(HOSTED_OUTPUT_CHARS, ceiling * 5);
  if (out.length > charCap || Buffer.byteLength(out) > charCap) throw reject('hosted_output_too_large');
  const rawCalls = cut ? [] : c.message.tool_calls ?? []; // a cut-off reply's tool calls are incomplete: never run
  if (rawCalls.length > CHAT_TOOL_CALLS_PER_RESPONSE) throw reject('chat_tool_calls_too_many');
  if ((r.toolChoice === 'none' || r.noTools) && rawCalls.length) throw reject('chat_finish_inconsistent'); // a final / no-tools request must answer in text
  const toolCalls: ChatToolCall[] = [], ids = new Set<string>();
  for (const x of rawCalls) {
    const t = toolCallSchema.safeParse(x);
    if (!t.success || !CALL_ID.test(t.data.id) || ids.has(t.data.id) || !TOOL_NAME.test(t.data.function.name) || Buffer.byteLength(t.data.function.arguments) > CHAT_TOOL_ARGUMENT_BYTES) throw reject('chat_tool_calls_malformed');
    ids.add(t.data.id); toolCalls.push({id: t.data.id, name: t.data.function.name, arguments: t.data.function.arguments});
  }
  if (c.finish_reason === 'tool_calls' && !toolCalls.length) throw reject('chat_tool_calls_malformed');
  if (c.finish_reason === 'stop' && toolCalls.length) throw reject('chat_finish_inconsistent');
  if (c.finish_reason === 'stop' && !out.trim()) throw reject('hosted_output_empty');
  const u = v.usage;
  if (!u || u.cost === undefined) throw fail('hosted_usage_missing', true);
  if (u.completion_tokens > r.maxTokens || (u.total_tokens !== undefined && u.total_tokens !== u.prompt_tokens + u.completion_tokens)) throw reject('hosted_usage_invalid');
  return {finish: cut ? 'length' : c.finish_reason as 'stop' | 'tool_calls', text: out, toolCalls, responseId: v.id ?? null, routedProvider: v.provider, usage: {promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens}, costUsd: u.cost};
}
