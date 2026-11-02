// Hosted API: the ONE controlled request to a pinned OpenAI-compatible origin (Fable CP review §2: the local-MLX transport shape,
// not a multi-provider library). Exactly `POST <pinned https origin>/chat/completions`, stream:false, two text messages, the
// approved max_tokens, temperature 0, reasoning disabled, the provider-routing fields (allowlisted order, allow_fallbacks:false,
// data policy, require_parameters) and usage:{include:true}. Bearer key in a header only; redirects refused; no ambient proxy;
// one deadline covers the body; bounded body. Accepted only as one terminal, non-empty, tool-free, reasoning-free answer from
// the exact model, served by an allowlisted provider, WITH usage and cost. Rejected bodies are never returned (fixed labels).
import {z} from 'zod';

export const HOSTED_RESPONSE_BYTES = 262_144;
export const HOSTED_OUTPUT_CHARS = 32_000;
export type HostedFetch = (url: string, init: {method: 'POST'; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal}) => Promise<Response>;
export type HostedRequest = {origin: string; apiKey: string; model: string; system: string; user: string; maxTokens: number;
  providers: string[]; dataPolicy: {dataCollection: 'deny'; zdr: boolean};
  /** Pinned per profile (absent = providers / [model] / enabled-false): response display names, accepted response models, reasoning-off form. */
  providerNames?: string[]; responseModels?: string[]; reasoningOff?: 'enabled-false' | 'effort-none'};
export type HostedResult = {text: string; responseId: string | null; routedProvider: string; usage: {promptTokens: number; completionTokens: number}; costUsd: number};

export class HostedTransportError extends Error {
  /** costUsd: the provider-returned cost of a complete but rejected response, when it reported one (settled, not held). */
  constructor(readonly reason: string, readonly sent: boolean, readonly costUsd: number | null = null) { super(reason); this.name = 'HostedTransportError'; }
}
export const HOSTED_FAILURE_REASONS = ['hosted_origin_not_admitted', 'hosted_key_missing', 'hosted_max_tokens_invalid', 'hosted_aborted_before_send', 'hosted_ambient_proxy_refused',
  'hosted_http_400', 'hosted_http_401', 'hosted_http_402', 'hosted_http_403', 'hosted_http_404', 'hosted_http_408', 'hosted_http_413', 'hosted_http_422', 'hosted_http_429',
  'hosted_http_4xx', 'hosted_http_5xx', 'hosted_http_unexpected', 'hosted_response_not_json', 'hosted_response_empty', 'hosted_response_too_large', 'hosted_aborted_after_send',
  'hosted_deadline_exceeded', 'hosted_transport_failed', 'hosted_response_malformed', 'hosted_response_unsupported', 'hosted_choices_not_one', 'hosted_model_mismatch',
  'hosted_provider_not_allowed', 'hosted_tool_call_refused', 'hosted_reasoning_refused', 'hosted_output_truncated', 'hosted_not_terminal', 'hosted_output_empty',
  'hosted_output_too_large', 'hosted_usage_missing', 'hosted_usage_invalid'] as const;
/** Refused by the provider before generating (bad request, auth, payment, no matching endpoint, rate limit, other 4xx): nothing
 *  billed, reservation released. Labels are by status (content-free); a `:code=NNN` suffix may carry OpenRouter's numeric code. */
const HTTP_4XX_LABELLED = [400, 401, 402, 403, 404, 408, 413, 422, 429];
export const HOSTED_REFUSED_BEFORE_INFERENCE = new Set<string>([...HTTP_4XX_LABELLED.map((n) => 'hosted_http_' + n), 'hosted_http_4xx']);
/** The base label of a possibly suffixed reason ("hosted_http_404:code=404" -> "hosted_http_404"). */
export const hostedBaseLabel = (reason: string) => reason.split(':')[0];
/** Status label for a non-200 response; for a 4xx, OpenRouter's numeric error.code (only the integer, never the message) from a
 *  small bounded body read is appended as :code=NNN. */
async function statusLabel(res: Response, deadline: AbortSignal) {
  const s = res.status;
  if (s >= 500) { await res.body?.cancel().catch(() => {}); return 'hosted_http_5xx'; }
  if (s < 400) { await res.body?.cancel().catch(() => {}); return 'hosted_http_unexpected'; }
  const base = HTTP_4XX_LABELLED.includes(s) ? 'hosted_http_' + s : 'hosted_http_4xx';
  let code: number | null = null;
  try { const v = JSON.parse(await boundedBody(res, 8192, deadline)); const c = v?.error?.code; if (Number.isInteger(c) && c >= 100 && c <= 999) code = c; } catch { /* no code */ }
  return code === null ? base : `${base}:code=${code}`;
}
/** After these the provider may still be generating/billing: the reservation stays held (unsettled), never repeated blindly. */
export const HOSTED_UNSETTLED = new Set<string>(['hosted_aborted_after_send', 'hosted_deadline_exceeded', 'hosted_transport_failed', 'hosted_http_5xx',
  'hosted_response_too_large', 'hosted_usage_missing']);
const ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[1-9][0-9]{1,4})?(\/[a-z0-9._-]+)*$/;

export function hostedRequestBody(r: Omit<HostedRequest, 'apiKey' | 'origin'>) {
  return {
    model: r.model,
    messages: [{role: 'system', content: r.system}, {role: 'user', content: r.user}],
    stream: false,
    max_tokens: r.maxTokens,
    temperature: 0,
    reasoning: r.reasoningOff === 'effort-none' ? {effort: 'none', exclude: true} : {enabled: false, exclude: true},
    provider: {order: [...r.providers], allow_fallbacks: false, require_parameters: true, data_collection: r.dataPolicy.dataCollection, ...(r.dataPolicy.zdr ? {zdr: true} : {})},
    usage: {include: true},
  };
}

const responseSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  model: z.string(),
  provider: z.string().max(100).optional(),
  choices: z.array(z.object({
    finish_reason: z.string().nullable(),
    message: z.object({
      role: z.literal('assistant'), content: z.string().nullable(),
      tool_calls: z.array(z.unknown()).nullable().optional(),
      reasoning: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(), reasoning_details: z.array(z.unknown()).nullable().optional(),
    }).loose(),
  }).loose()),
  usage: z.object({prompt_tokens: z.number().int().nonnegative().max(1_000_000), completion_tokens: z.number().int().nonnegative().max(1_000_000),
    total_tokens: z.number().int().nonnegative().max(2_000_000).optional(), cost: z.number().nonnegative().max(1000).optional(),
    completion_tokens_details: z.object({reasoning_tokens: z.number().int().nonnegative().optional()}).loose().nullable().optional()}).loose().nullable().optional(),
}).loose();

async function boundedBody(res: Response, limit: number, deadline: AbortSignal): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new HostedTransportError('hosted_response_empty', true);
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
    if (size > limit) { await reader.cancel().catch(() => {}); throw new HostedTransportError('hosted_response_too_large', true); }
    chunks.push(p.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One request. Throws HostedTransportError with a fixed label (never the key or a response body); sent=false only when nothing left. */
export async function hostedComplete(r: HostedRequest, o: {fetch: HostedFetch; signal: AbortSignal; deadlineMs: number; maxOutputTokens: number; pinnedOrigin: string}): Promise<HostedResult> {
  if (!ORIGIN.test(r.origin) || r.origin !== o.pinnedOrigin) throw new HostedTransportError('hosted_origin_not_admitted', false);
  if (!r.apiKey || /\s/.test(r.apiKey)) throw new HostedTransportError('hosted_key_missing', false);
  if (!Number.isInteger(r.maxTokens) || r.maxTokens < 1 || r.maxTokens > o.maxOutputTokens) throw new HostedTransportError('hosted_max_tokens_invalid', false);
  if (o.signal.aborted) throw new HostedTransportError('hosted_aborted_before_send', false);
  if (process.env.NODE_USE_ENV_PROXY) throw new HostedTransportError('hosted_ambient_proxy_refused', false);
  const deadline = AbortSignal.any([o.signal, AbortSignal.timeout(o.deadlineMs)]);
  let res: Response, text: string;
  try {
    res = await o.fetch(r.origin + '/chat/completions', {method: 'POST', headers: {'content-type': 'application/json', authorization: 'Bearer ' + r.apiKey},
      body: JSON.stringify(hostedRequestBody(r)), redirect: 'error', signal: deadline});
    if (res.status !== 200) throw new HostedTransportError(await statusLabel(res, deadline), true);
    if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) { await res.body?.cancel().catch(() => {}); throw new HostedTransportError('hosted_response_not_json', true); }
    text = await boundedBody(res, HOSTED_RESPONSE_BYTES, deadline);
  } catch (e) {
    if (e instanceof HostedTransportError) throw e;
    throw new HostedTransportError(o.signal.aborted ? 'hosted_aborted_after_send' : deadline.aborted ? 'hosted_deadline_exceeded' : 'hosted_transport_failed', true);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new HostedTransportError('hosted_response_malformed', true); }
  const p = responseSchema.safeParse(raw);
  if (!p.success) throw new HostedTransportError('hosted_response_unsupported', true);
  const v = p.data, billed = v.usage?.cost ?? null;
  const reject = (reason: string) => new HostedTransportError(reason, true, billed);
  if (v.choices.length !== 1) throw reject('hosted_choices_not_one');
  const c = v.choices[0];
  if (!(r.responseModels ?? [r.model]).includes(v.model)) throw reject('hosted_model_mismatch');
  if (!v.provider || !(r.providerNames ?? r.providers).includes(v.provider)) throw reject('hosted_provider_not_allowed');
  if (c.message.tool_calls && c.message.tool_calls.length) throw reject('hosted_tool_call_refused');
  // Which reasoning signal fired is recorded as a content-free sub-tag (Ops, Flash-Lite attempt 5): a non-empty field name,
  // the reasoning_details count, or the billed reasoning token count. Empty strings, null and [] never fire.
  const rt = v.usage?.completion_tokens_details?.reasoning_tokens ?? 0, rd = c.message.reasoning_details?.length ?? 0;
  const why = c.message.reasoning ? 'field=reasoning' : c.message.reasoning_content ? 'field=reasoning_content' : rd ? `field=reasoning_details,n=${Math.min(rd, 9999)}` : rt > 0 ? `tokens=${Math.min(rt, 9_999_999)}` : null;
  if (why) throw reject(`hosted_reasoning_refused:${why}${rt > 0 && !why.startsWith('tokens') ? `,tokens=${Math.min(rt, 9_999_999)}` : ''}`);
  if (c.finish_reason === 'length') throw reject('hosted_output_truncated');
  if (c.finish_reason !== 'stop') throw reject('hosted_not_terminal');
  const out = c.message.content ?? '';
  if (!out.trim()) throw reject('hosted_output_empty');
  if (out.length > HOSTED_OUTPUT_CHARS || Buffer.byteLength(out) > HOSTED_OUTPUT_CHARS) throw reject('hosted_output_too_large');
  const u = v.usage;
  if (!u || u.cost === undefined) throw new HostedTransportError('hosted_usage_missing', true);
  if (u.completion_tokens > r.maxTokens || (u.total_tokens !== undefined && u.total_tokens !== u.prompt_tokens + u.completion_tokens)) throw reject('hosted_usage_invalid');
  return {text: out, responseId: v.id ?? null, routedProvider: v.provider, usage: {promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens}, costUsd: u.cost};
}
