// local-mlx: the ONE controlled request to the host's mlx_lm.server (LOCAL-MLX-ADAPTER-SPEC "Pi and the controlled transport").
// Exactly `POST <admitted endpoint>/chat/completions` with the admitted model, two text messages, stream:false, the approved
// max_tokens (<= 4096), thinking off and pinned sampling. No tools, adapters, draft models, URLs from content, Authorization
// header, cookies or ambient proxy; redirects refused; one deadline covers the response body; bounded body. The response is
// accepted only if it is one terminal, non-empty, tool-free assistant answer from the admitted model. Rejected bodies are
// never returned or persisted (only a fixed reason label).
import {z} from 'zod';

export const MLX_RESPONSE_BYTES = 262_144;
export const LOCAL_OUTPUT_CHARS = 32_000;

export type MlxFetch = (url: string, init: {method: 'POST'; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal}) => Promise<Response>;
export type MlxRequest = {endpoint: string; model: string; system: string; user: string; maxTokens: number; temperature: 0};
export type MlxResult = {text: string; responseId: string | null; usage: {promptTokens: number; completionTokens: number} | null};

/** A fixed, content-free failure label. `sent` says whether the request may have reached the server. */
export class MlxTransportError extends Error {
  constructor(readonly reason: string, readonly sent: boolean) { super(reason); this.name = 'MlxTransportError'; }
}

/** Every label mlxComplete can throw (persisted as fixed failure labels). */
export const MLX_FAILURE_REASONS = ['mlx_endpoint_not_admitted', 'mlx_max_tokens_invalid', 'mlx_aborted_before_send', 'mlx_ambient_proxy_refused',
  'mlx_http_5xx', 'mlx_http_4xx', 'mlx_http_unexpected', 'mlx_response_not_json', 'mlx_response_empty', 'mlx_response_too_large', 'mlx_aborted_after_send',
  'mlx_deadline_exceeded', 'mlx_transport_failed', 'mlx_response_malformed', 'mlx_response_unsupported', 'mlx_choices_not_one', 'mlx_model_mismatch',
  'mlx_tool_call_refused', 'mlx_reasoning_refused', 'mlx_output_truncated', 'mlx_not_terminal', 'mlx_output_empty', 'mlx_output_too_large', 'mlx_usage_invalid'] as const;
/** After these the server may still be generating: settlement is unknown (the runtime stays reserved). */
export const MLX_UNSETTLED = new Set<string>(['mlx_aborted_after_send', 'mlx_deadline_exceeded', 'mlx_transport_failed']);
const ENDPOINT = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}\/v1$/;
export function mlxRequestBody(r: MlxRequest) {
  return {
    model: r.model,
    messages: [{role: 'system', content: r.system}, {role: 'user', content: r.user}],
    stream: false,
    max_tokens: r.maxTokens,
    temperature: r.temperature,
    chat_template_kwargs: {enable_thinking: false},
  };
}

const usageSchema = z.object({prompt_tokens: z.number().int().nonnegative().max(1_000_000), completion_tokens: z.number().int().nonnegative().max(1_000_000),
  total_tokens: z.number().int().nonnegative().max(2_000_000).optional()}).loose();
const responseSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  model: z.string(),
  choices: z.array(z.object({
    index: z.number().int().optional(),
    finish_reason: z.string().nullable(),
    message: z.object({
      role: z.literal('assistant'),
      content: z.string().nullable(),
      tool_calls: z.array(z.unknown()).nullable().optional(),
      reasoning: z.string().nullable().optional(),
      reasoning_content: z.string().nullable().optional(),
    }).loose(),
  }).loose()),
  usage: usageSchema.nullable().optional(),
}).loose();

/** Bounded body read under the SAME deadline: each read races the deadline, so a stalled stream cannot outlive it. */
async function boundedBody(res: Response, limit: number, deadline: AbortSignal): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new MlxTransportError('mlx_response_empty', true);
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => { reader.cancel().catch(() => {}); reject(new Error('deadline')); };
    if (deadline.aborted) stop(); else deadline.addEventListener('abort', stop, {once: true});
  });
  aborted.catch(() => {});
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const p = await Promise.race([reader.read(), aborted]);
    if (deadline.aborted) throw new Error('deadline'); // a body cut by the deadline is never parsed as complete
    if (p.done) break;
    size += p.value.length;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new MlxTransportError('mlx_response_too_large', true); }
    chunks.push(p.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** One request. Throws MlxTransportError with a fixed label; `sent=false` only when nothing was transmitted. */
export async function mlxComplete(r: MlxRequest, o: {fetch: MlxFetch; signal: AbortSignal; deadlineMs: number; maxOutputTokens: number}): Promise<MlxResult> {
  if (!ENDPOINT.test(r.endpoint)) throw new MlxTransportError('mlx_endpoint_not_admitted', false);
  if (!Number.isInteger(r.maxTokens) || r.maxTokens < 1 || r.maxTokens > Math.min(4096, o.maxOutputTokens)) throw new MlxTransportError('mlx_max_tokens_invalid', false);
  if (o.signal.aborted) throw new MlxTransportError('mlx_aborted_before_send', false);
  // Node's fetch only honours proxy env when NODE_USE_ENV_PROXY is set; refuse rather than route through an ambient proxy.
  if (process.env.NODE_USE_ENV_PROXY) throw new MlxTransportError('mlx_ambient_proxy_refused', false);
  const deadline = AbortSignal.any([o.signal, AbortSignal.timeout(o.deadlineMs)]);
  let res: Response, text: string;
  try {
    res = await o.fetch(r.endpoint + '/chat/completions', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(mlxRequestBody(r)), redirect: 'error', signal: deadline});
    if (res.status !== 200) { await res.body?.cancel().catch(() => {}); throw new MlxTransportError('mlx_http_' + (res.status >= 500 ? '5xx' : res.status >= 400 ? '4xx' : 'unexpected'), true); }
    if (!/^application\/json\b/i.test(res.headers.get('content-type') ?? '')) { await res.body?.cancel().catch(() => {}); throw new MlxTransportError('mlx_response_not_json', true); }
    text = await boundedBody(res, MLX_RESPONSE_BYTES, deadline);
  } catch (e) {
    if (e instanceof MlxTransportError) throw e;
    // Abort, timeout, reset or redirect after the request left: the server may still be generating.
    throw new MlxTransportError(o.signal.aborted ? 'mlx_aborted_after_send' : deadline.aborted ? 'mlx_deadline_exceeded' : 'mlx_transport_failed', true);
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new MlxTransportError('mlx_response_malformed', true); }
  const p = responseSchema.safeParse(raw);
  if (!p.success) throw new MlxTransportError('mlx_response_unsupported', true);
  const v = p.data;
  if (v.choices.length !== 1) throw new MlxTransportError('mlx_choices_not_one', true);
  const c = v.choices[0];
  if (v.model !== r.model) throw new MlxTransportError('mlx_model_mismatch', true);
  if (c.message.tool_calls && c.message.tool_calls.length) throw new MlxTransportError('mlx_tool_call_refused', true);
  if (c.message.reasoning || c.message.reasoning_content) throw new MlxTransportError('mlx_reasoning_refused', true);
  if (c.finish_reason === 'length') throw new MlxTransportError('mlx_output_truncated', true);
  if (c.finish_reason !== 'stop') throw new MlxTransportError('mlx_not_terminal', true);
  const out = c.message.content ?? '';
  if (!out.trim()) throw new MlxTransportError('mlx_output_empty', true);
  if (out.length > LOCAL_OUTPUT_CHARS || Buffer.byteLength(out) > LOCAL_OUTPUT_CHARS) throw new MlxTransportError('mlx_output_too_large', true);
  const u = v.usage ?? null;
  if (u && (u.completion_tokens > r.maxTokens || (u.total_tokens !== undefined && u.total_tokens !== u.prompt_tokens + u.completion_tokens))) throw new MlxTransportError('mlx_usage_invalid', true);
  return {text: out, responseId: v.id ?? null, usage: u ? {promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens} : null};
}
