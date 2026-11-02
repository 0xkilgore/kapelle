// Chat agent slice 1 (PLAN-SLICE-1 §2, Fable R-1): the INTERACTIVE runtime profile. It sits beside the qualified one-POST
// hosted profile, which stays byte-for-byte (its qualificationRef, its F-8 hash and its hosted_tool_call_refused). Same
// per-request pins as hosted (exact model, pinned origin, provider order without fallbacks, require_parameters, data policy,
// reasoning off, usage required), plus the tool catalog hash and the per-turn caps. All of it is the profile's identity:
// interactiveProfileHash excludes ONLY qualificationRef (the F-8 rule), so a new catalog or a new cap is a new profile and a
// new qualification (R-8). Nothing from a conversation, browser or model can supply an origin, route, key, price or cap.
import {z} from 'zod';
import {digest} from '../../content.js';
import {profileIdSchema} from '../launch-policy.js';
import {hostedPricingSchema, type HostedProfile} from '../hosted/profile.js';
import {taskToolCatalogHash, toolCatalogHash} from './catalog.js';

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const modelId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/).refine(m => !/latest/i.test(m), 'model_must_be_exact');
export const INTERACTIVE_MAX_OUTPUT_TOKENS = 4096;
export const interactiveRuntimeSchema = z.object({
  kind: z.literal('interactive-api'), locality: z.literal('remote-provider'),
  model: modelId,
  origin: z.string().regex(/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[1-9][0-9]{1,4})?(\/[a-z0-9._-]+)*$/),
  providers: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/)).min(1).max(8),
  providerNames: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/)).min(1).max(8).optional(),
  responseModels: z.array(modelId).min(1).max(4).optional(),
  reasoningOff: z.enum(['enabled-false', 'effort-none']).optional(),
  dataPolicy: z.object({dataCollection: z.literal('deny'), zdr: z.boolean()}).strict(),
  contextTokens: z.number().int().positive().max(1_000_000),
  reasoning: z.literal('off'), concurrencyLimit: z.literal(1), usage: z.literal('required'),
  /** The slice-1 catalog's identity (catalog.ts). A profile naming another catalog is refused when the transport opens. */
  toolCatalogHash: sha,
}).strict();
export const interactiveHarnessSchema = z.object({kind: z.literal('interactive-openai-compatible'), adapterContract: z.literal('kapelle.interactive-adapter/v1')}).strict();
/** Per-turn caps (PLAN §5, D-2): the first to arrive ends the turn with its fixed label. */
export const turnCapsSchema = z.object({
  requests: z.number().int().min(1).max(6), toolCalls: z.number().int().min(0).max(12), wallMs: z.number().int().positive().max(120_000),
  usd: z.number().positive().max(1), contextBytes: z.number().int().positive().max(131_072), resultBytes: z.number().int().positive().max(32_768),
}).strict();
export const interactiveProfileSchema = z.object({
  id: profileIdSchema,
  runtime: interactiveRuntimeSchema,
  harness: interactiveHarnessSchema,
  pricing: hostedPricingSchema,
  limits: z.object({maxOutputTokens: z.number().int().positive().max(INTERACTIVE_MAX_OUTPUT_TOKENS), timeoutMs: z.number().int().positive().max(120_000)}).strict(),
  turn: turnCapsSchema,
  contract: z.literal('kapelle.interactive-execution/v1'),
  qualificationRef: z.string().min(1).max(300),
}).strict().superRefine((p, ctx) => {
  if (p.limits.maxOutputTokens >= p.runtime.contextTokens) ctx.addIssue({code: 'custom', message: 'interactive_output_limit'});
  if (p.limits.timeoutMs > p.turn.wallMs) ctx.addIssue({code: 'custom', message: 'interactive_request_timeout_over_wall'});
  if (p.runtime.responseModels && !p.runtime.responseModels.includes(p.runtime.model)) ctx.addIssue({code: 'custom', message: 'interactive_response_models_must_include_model'});
});
export type InteractiveProfile = z.infer<typeof interactiveProfileSchema>;
export type TurnCaps = z.infer<typeof turnCapsSchema>;
/** F-8 rule: the identity excludes only qualificationRef, so pinning the report never changes the hash it attests. */
export const interactiveProfileHash = (p: InteractiveProfile) => { const {qualificationRef: _ref, ...rest} = interactiveProfileSchema.parse(p); return digest(rest); };
/** Evidence-inheritance (A): the profile AS A TEAM TASK RECEIVES IT: the same pins with the task tool view's catalog hash. Task plans,
 *  schedules and the task qualification report bind this, so a chat-only catalog change does not move them. */
export const taskProfileHash = (p: InteractiveProfile) => interactiveProfileHash({...p, runtime: {...p.runtime, toolCatalogHash: taskToolCatalogHash()}});
/** Worst-case cost of one request at the pinned rate with the margin (the hosted planning estimate: UTF-8 bytes / 3). */
export function interactiveReservationUsd(p: InteractiveProfile, promptBytes: number, maxOutputTokens = p.limits.maxOutputTokens) {
  const inTok = Math.ceil(promptBytes / 3) + 64, r = p.pricing;
  return ((inTok * r.inputUsdPerMTok + maxOutputTokens * r.outputUsdPerMTok) / 1e6) * r.reservationMargin;
}

export const SLICE1_TURN_CAPS: TurnCaps = Object.freeze({requests: 6, toolCalls: 12, wallMs: 120_000, usd: 1, contextBytes: 131_072, resultBytes: 32_768});
/** Derive the interactive profile from a QUALIFIED hosted profile's pins (model, origin, providers, data policy, pricing), so the
 *  two cannot drift silently. The interactive profile is qualified separately (R-8): its ref starts `pending:`. */
export function interactiveFromHosted(id: string, h: HostedProfile, o: {caps?: TurnCaps; maxOutputTokens?: number; timeoutMs?: number} = {}): InteractiveProfile {
  const {kind: _k, tools: _t, ...pins} = h.runtime;
  return interactiveProfileSchema.parse({id, contract: 'kapelle.interactive-execution/v1', qualificationRef: 'pending:' + id,
    runtime: {...pins, kind: 'interactive-api', toolCatalogHash: toolCatalogHash()},
    harness: {kind: 'interactive-openai-compatible', adapterContract: 'kapelle.interactive-adapter/v1'},
    pricing: h.pricing, limits: {maxOutputTokens: o.maxOutputTokens ?? INTERACTIVE_MAX_OUTPUT_TOKENS, timeoutMs: o.timeoutMs ?? 60_000}, turn: o.caps ?? SLICE1_TURN_CAPS});
}
