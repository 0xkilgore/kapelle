// Hosted API runtime profile (CP agent launch). Host-owned catalog facts pinned by the profile hash: the exact model id (never
// "latest"), the pinned HTTPS origin, the upstream provider allowlist, the data policy, context/output ceilings, the pinned
// reservation rate (for RESERVING only; settlement uses the provider's returned cost) and the qualification reference.
// Nothing from a Task, browser or model can supply an origin, route, key or price.
import {z} from 'zod';
import {digest} from '../../content.js';
import {HOSTED_MAX_OUTPUT_TOKENS, type HostedInferenceInput} from '../../worker/execution.js';
import {profileIdSchema} from '../launch-policy.js';
import {assert} from '../../validation.js';

const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const hostedRuntimeSchema = z.object({
  kind: z.literal('hosted-api'), locality: z.literal('remote-provider'),
  model: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/).refine(m => !/latest/i.test(m), 'model_must_be_exact'),
  /** The ONLY origin requests go to (https, no query/fragment/credentials), e.g. https://openrouter.ai/api/v1. */
  origin: z.string().regex(/^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[1-9][0-9]{1,4})?(\/[a-z0-9._-]+)*$/),
  /** Upstream providers allowed to serve (provider.order); fallbacks to others are refused. OpenRouter takes endpoint SLUGS
   *  here (e.g. amazon-bedrock/us, google-vertex/us-east5). */
  providers: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,63}$/)).min(1).max(8),
  /** The provider DISPLAY names a response may report (e.g. "Amazon Bedrock", "Google"). Absent: the `providers` list itself. */
  providerNames: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/)).min(1).max(8).optional(),
  /** Model ids a response may report: the requested id and its pinned canonical dated slug. Absent: exactly `model`. */
  responseModels: z.array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/)).min(1).max(4).optional(),
  /** How "reasoning off" is expressed for this model (pinned per profile; the response is still refused on any reasoning). */
  reasoningOff: z.enum(['enabled-false', 'effort-none']).optional(),
  /** Owner-approved data policy, sent with every request (provider labels are not independent proof). */
  dataPolicy: z.object({dataCollection: z.literal('deny'), zdr: z.boolean()}).strict(),
  contextTokens: z.number().int().positive().max(1_000_000),
  reasoning: z.literal('off'), tools: z.array(z.never()).length(0), concurrencyLimit: z.literal(1),
  /** A profile whose provider does not return usage/cost is unqualified. */
  usage: z.literal('required'),
}).strict();
export const hostedHarnessSchema = z.object({kind: z.literal('hosted-openai-compatible'), adapterContract: z.literal('kapelle.hosted-api-adapter/v1')}).strict();
/** USD per million tokens, pinned by Ops; reservation = worst case x margin. A price change is an Ops re-pin, not a refusal. */
export const hostedPricingSchema = z.object({version: z.string().min(1).max(60), inputUsdPerMTok: z.number().nonnegative().max(1000),
  outputUsdPerMTok: z.number().nonnegative().max(1000), reservationMargin: z.number().min(1).max(3)}).strict();
export const hostedProfileSchema = z.object({
  id: profileIdSchema,
  runtime: hostedRuntimeSchema,
  harness: hostedHarnessSchema,
  pricing: hostedPricingSchema,
  limits: z.object({maxOutputTokens: z.number().int().positive().max(HOSTED_MAX_OUTPUT_TOKENS), maxBudgetUsd: z.number().positive().max(50),
    timeoutMs: z.number().int().positive().max(600_000)}).strict(),
  contract: z.literal('kapelle.restricted-execution/v3'),
  qualificationRef: z.string().min(1).max(300),
}).strict().superRefine((p, ctx) => {
  if (p.limits.maxOutputTokens >= p.runtime.contextTokens) ctx.addIssue({code: 'custom', message: 'hosted_output_limit'});
  if (p.runtime.responseModels && !p.runtime.responseModels.includes(p.runtime.model)) ctx.addIssue({code: 'custom', message: 'hosted_response_models_must_include_model'});
  if ([p.runtime.model, ...(p.runtime.responseModels ?? [])].some(m => /latest/i.test(m))) ctx.addIssue({code: 'custom', message: 'model_must_be_exact'});
});
export type HostedProfile = z.infer<typeof hostedProfileSchema>;
/** Fable F-8: a hosted profile's identity EXCLUDES its qualificationRef, so pinning the report (whose own profileHash is this
 *  value) never changes the hash: the report attests exactly the profile the runtime runs. The ONE hosted hash rule. */
export const hostedProfileHash = (p: HostedProfile) => { const {qualificationRef: _ref, ...rest} = hostedProfileSchema.parse(p); return digest(rest); };
/** The per-run inference block for an approved budget (never above the profile's limits). */
export function hostedInferenceFor(p: HostedProfile, budget: {maxOutputTokens: number; maxBudgetUsd: number; timeoutMs: number}): Omit<HostedInferenceInput, 'system' | 'user'> {
  assert(budget.maxOutputTokens <= p.limits.maxOutputTokens && budget.maxBudgetUsd <= p.limits.maxBudgetUsd && budget.timeoutMs <= p.limits.timeoutMs, 'budget_exceeds_runtime_limits');
  return {runtime: 'hosted-api', locality: 'remote-provider', model: p.runtime.model, runtimeProfileHash: hostedProfileHash(p),
    maxOutputTokens: budget.maxOutputTokens, contextTokens: p.runtime.contextTokens, maxBudgetUsd: budget.maxBudgetUsd, timeoutMs: budget.timeoutMs, tools: [], reasoning: 'off'};
}
/** Worst-case cost for one request, at the pinned rate, with the margin (planning-grade token estimate: UTF-8 bytes / 3). */
export function hostedReservationUsd(p: HostedProfile, promptBytes: number, maxOutputTokens: number) {
  const inTok = Math.ceil(promptBytes / 3) + 64, r = p.pricing;
  return ((inTok * r.inputUsdPerMTok + maxOutputTokens * r.outputUsdPerMTok) / 1e6) * r.reservationMargin;
}
