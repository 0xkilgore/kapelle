// IMAGES-V1 I2 (design of record IMAGES-V1.md a5160d58 §2): the IMAGE-EXTRACTION profile and its one-request transport. A NEW
// pinned profile, derived from the qualified interactive text profile's pins (exact model, pinned origin, providers without
// fallbacks, require_parameters, data policy, reasoning off, usage required, pricing) so the two cannot drift; the text profile
// itself is untouched (its hash and qualificationRef stay). Its identity adds the image caps and the extraction rules' hash, so
// a new prompt or cap is a new profile and needs its own qualification. Exactly ONE request per extraction: `POST <origin>/
// chat/completions`, stream:false, one system message + one user message carrying the fixed instruction text and ONE inline
// JPEG (data: URL, base64), NO tools; accepted only as finish "stop" with non-empty text. No retries, fallback or streaming.
import {z} from 'zod';
import {digest} from '../../content.js';
import {profileIdSchema} from '../launch-policy.js';
import {hostedPricingSchema, type HostedProfile} from '../hosted/profile.js';
import {HostedTransportError, HOSTED_RESPONSE_BYTES, HOSTED_OUTPUT_CHARS, type HostedFetch} from '../hosted/transport.js';
import {boundedBody, statusLabel} from './transport.js';

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const modelId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/).refine((m) => !/latest/i.test(m), 'model_must_be_exact');
export const IMAGE_REQUEST_CAPS = Object.freeze({imageBytes: 1024 * 1024, requestBytes: 2 * 1024 * 1024, longEdge: 1600});
export const imageProfileSchema = z.object({
  id: profileIdSchema,
  contract: z.literal('kapelle.image-extraction/v1'),
  runtime: z.object({
    kind: z.literal('image-extraction-api'), locality: z.literal('remote-provider'), model: modelId,
    origin: z.string().regex(/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[1-9][0-9]{1,4})?(\/[a-z0-9._-]+)*$/),
    providers: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/)).min(1).max(8),
    providerNames: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/)).min(1).max(8).optional(),
    responseModels: z.array(modelId).min(1).max(4).optional(),
    reasoningOff: z.enum(['enabled-false', 'effort-none']).optional(),
    dataPolicy: z.object({dataCollection: z.literal('deny'), zdr: z.boolean()}).strict(),
    contextTokens: z.number().int().positive().max(1_000_000),
    reasoning: z.literal('off'), concurrencyLimit: z.literal(1), usage: z.literal('required'),
    /** The input admitted: ONE sanitized JPEG inline (no URL, no hosting), bounded bytes and edge, and the request bound. */
    image: z.object({input: z.literal('jpeg-inline-base64'), maxImageBytes: z.number().int().positive().max(IMAGE_REQUEST_CAPS.imageBytes),
      maxLongEdge: z.number().int().positive().max(IMAGE_REQUEST_CAPS.longEdge), maxRequestBytes: z.number().int().positive().max(IMAGE_REQUEST_CAPS.requestBytes)}).strict(),
    /** digest of the fixed instructions + output schema (org/images/extract.ts): a prompt change is a new profile. */
    rulesHash: sha,
  }).strict(),
  pricing: hostedPricingSchema,
  limits: z.object({maxOutputTokens: z.number().int().positive().max(2048), timeoutMs: z.number().int().positive().max(90_000), usdPerExtraction: z.number().positive().max(0.5)}).strict(),
  qualificationRef: z.string().min(1).max(300),
}).strict();
export type ImageProfile = z.infer<typeof imageProfileSchema>;
/** F-8 rule: the identity excludes only qualificationRef. */
export const imageProfileHash = (p: ImageProfile) => { const {qualificationRef: _r, ...rest} = imageProfileSchema.parse(p); return digest(rest); };
/** Derived from a QUALIFIED hosted profile's pins; qualified separately (its ref starts `pending:` until a live report is pinned). */
export function imageProfileFromHosted(id: string, h: HostedProfile, rulesHash: string): ImageProfile {
  const {kind: _k, tools: _t, ...pins} = h.runtime;
  return imageProfileSchema.parse({id, contract: 'kapelle.image-extraction/v1', qualificationRef: 'pending:' + id,
    runtime: {...pins, kind: 'image-extraction-api', image: {input: 'jpeg-inline-base64', maxImageBytes: IMAGE_REQUEST_CAPS.imageBytes, maxLongEdge: IMAGE_REQUEST_CAPS.longEdge,
      maxRequestBytes: IMAGE_REQUEST_CAPS.requestBytes}, rulesHash},
    pricing: h.pricing, limits: {maxOutputTokens: 1500, timeoutMs: 60_000, usdPerExtraction: 0.25}});
}
/** Worst case of one extraction at the pinned rate with the margin (base64 bytes / 3 as tokens is a deliberate overestimate). */
export function imageReservationUsd(p: ImageProfile, requestBytes: number) {
  const inTok = Math.ceil(requestBytes / 3) + 64, r = p.pricing;
  return Math.min(p.limits.usdPerExtraction, ((inTok * r.inputUsdPerMTok + p.limits.maxOutputTokens * r.outputUsdPerMTok) / 1e6) * r.reservationMargin);
}

export function imageRequestBody(p: ImageProfile, system: string, text: string, jpeg: Buffer) {
  const r = p.runtime;
  return {
    model: r.model,
    messages: [{role: 'system', content: system},
      {role: 'user', content: [{type: 'text', text}, {type: 'image_url', image_url: {url: 'data:image/jpeg;base64,' + jpeg.toString('base64')}}]}],
    stream: false, max_tokens: p.limits.maxOutputTokens, temperature: 0,
    reasoning: r.reasoningOff === 'effort-none' ? {effort: 'none', exclude: true} : {enabled: false, exclude: true},
    provider: {order: [...r.providers], allow_fallbacks: false, require_parameters: true, data_collection: r.dataPolicy.dataCollection, ...(r.dataPolicy.zdr ? {zdr: true} : {})},
    usage: {include: true},
  };
}

const responseSchema = z.object({
  id: z.string().min(1).max(200).optional(), model: z.string(), provider: z.string().max(100).optional(),
  choices: z.array(z.object({finish_reason: z.string().nullable(), message: z.object({role: z.literal('assistant'), content: z.string().nullable().optional(),
    tool_calls: z.array(z.unknown()).nullable().optional(), reasoning: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(),
    reasoning_details: z.array(z.unknown()).nullable().optional()}).loose()}).loose()),
  usage: z.object({prompt_tokens: z.number().int().nonnegative().max(1_000_000), completion_tokens: z.number().int().nonnegative().max(1_000_000),
    total_tokens: z.number().int().nonnegative().max(2_000_000).optional(), cost: z.number().nonnegative().max(1000).optional(),
    prompt_tokens_details: z.object({image_tokens: z.number().int().nonnegative().optional()}).loose().nullable().optional(),
    completion_tokens_details: z.object({reasoning_tokens: z.number().int().nonnegative().optional()}).loose().nullable().optional()}).loose().nullable().optional(),
}).loose();
export type ImageExtractResult = {text: string; responseId: string | null; routedProvider: string; usage: {promptTokens: number; completionTokens: number; imageTokens: number | null}; costUsd: number};
const fail = (reason: string, sent: boolean, cost: number | null = null) => new HostedTransportError(reason, sent, cost);

/** The ONE extraction request. Throws HostedTransportError with a fixed label (never the key or a body); sent=false only when
 *  nothing left the process; a rejection's costUsd is the provider-reported cost of a complete response (settle at it). */
export async function imageExtractComplete(r: {profile: ImageProfile; apiKey: string; system: string; text: string; jpeg: Buffer},
  o: {fetch: HostedFetch; signal: AbortSignal; deadlineMs: number}): Promise<ImageExtractResult> {
  const p = imageProfileSchema.parse(r.profile), rt = p.runtime;
  if (!r.apiKey || /\s/.test(r.apiKey)) throw fail('hosted_key_missing', false);
  if (!(r.jpeg.length > 3 && r.jpeg[0] === 0xff && r.jpeg[1] === 0xd8 && r.jpeg[2] === 0xff) || r.jpeg.length > rt.image.maxImageBytes) throw fail('image_request_invalid', false);
  const body = JSON.stringify(imageRequestBody(p, r.system, r.text, r.jpeg));
  if (Buffer.byteLength(body) > rt.image.maxRequestBytes) throw fail('image_request_too_large', false);
  if (o.signal.aborted) throw fail('hosted_aborted_before_send', false);
  if (process.env.NODE_USE_ENV_PROXY) throw fail('hosted_ambient_proxy_refused', false);
  const deadline = AbortSignal.any([o.signal, AbortSignal.timeout(Math.min(o.deadlineMs, p.limits.timeoutMs))]);
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
  const v = parsed.data, billed = v.usage?.cost ?? null, reject = (reason: string) => fail(reason, true, billed);
  if (v.choices.length !== 1) throw reject('hosted_choices_not_one');
  const c = v.choices[0];
  if (!(rt.responseModels ?? [rt.model]).includes(v.model)) throw reject('hosted_model_mismatch');
  if (!v.provider || !(rt.providerNames ?? rt.providers).includes(v.provider)) throw reject('hosted_provider_not_allowed');
  // Lifted from the interactive transport: any reasoning signal refuses, content-free.
  const rtok = v.usage?.completion_tokens_details?.reasoning_tokens ?? 0, rd = c.message.reasoning_details?.length ?? 0;
  if (c.message.reasoning || c.message.reasoning_content || rd || rtok > 0) throw reject('hosted_reasoning_refused');
  if (c.finish_reason === 'length') throw reject('chat_output_truncated');
  if (c.message.tool_calls?.length) throw reject('image_tool_calls_refused'); // no tools exist on this request
  if (c.finish_reason !== 'stop') throw reject('hosted_not_terminal');
  const out = c.message.content ?? '';
  if (!out.trim()) throw reject('hosted_output_empty');
  if (out.length > HOSTED_OUTPUT_CHARS || Buffer.byteLength(out) > HOSTED_OUTPUT_CHARS) throw reject('hosted_output_too_large');
  const u = v.usage;
  if (!u || u.cost === undefined) throw fail('hosted_usage_missing', true);
  if (u.completion_tokens > p.limits.maxOutputTokens || (u.total_tokens !== undefined && u.total_tokens !== u.prompt_tokens + u.completion_tokens)) throw reject('hosted_usage_invalid');
  return {text: out, responseId: v.id ?? null, routedProvider: v.provider,
    usage: {promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens, imageTokens: u.prompt_tokens_details?.image_tokens ?? null}, costUsd: u.cost};
}
