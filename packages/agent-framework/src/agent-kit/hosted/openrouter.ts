// OpenRouter hosted profiles (Director decisions 2026-10-15; owner may override). Facts verified 2026-10-15 from OpenRouter's
// public model, endpoint and ZDR catalogs (GET /api/v1/models, /models/<id>/endpoints, /endpoints/zdr; read-only, no key):
//   anthropic/claude-sonnet-4.6  canonical anthropic/claude-4.6-sonnet-20260217. ZDR only on Amazon Bedrock and Google Vertex
//     (first-party Anthropic is not ZDR). US regional: amazon-bedrock/us + google-vertex/us-east5 at $3.30 / $16.50 per M tokens.
//     Reasoning not mandatory (default effort medium): sent as effort "none".
//   google/gemini-3.1-flash-lite canonical google/gemini-3.1-flash-lite-20260507. ZDR on Google Vertex; US: google-vertex/us at
//     $0.275 / $1.65 per M. Reasoning not mandatory (effort "none" supported). (gemini-2.5-flash expires 2026-10-20; every newer
//     Flash has mandatory reasoning, which the reasoning-off invariant refuses.)
// Responses report provider DISPLAY names ("Amazon Bedrock", "Google"); provider.order takes endpoint SLUGS. A price change at
// OpenRouter is an Ops re-pin (pricing.version), never a silent change. A qualificationRef is "pending:" until a qualification
// run (tests/hosted-qualification.test.ts, live mode) passes and its report hash is pinned here (Sonnet: pinned 2026-10-16).
import {hostedProfileSchema, type HostedProfile} from './profile.js';

/** Where the pinned facts came from and when (Fable E N-3): re-read these to check a price or route before re-pinning. */
export const OPENROUTER_CATALOG = {retrievedAt: '2026-10-15T21:50:00Z', pricingVersion: 'openrouter-2026-10-15', sources: [
  'https://openrouter.ai/api/v1/models', 'https://openrouter.ai/api/v1/endpoints/zdr',
  'https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-4.6/endpoints', 'https://openrouter.ai/api/v1/models/google/gemini-3.1-flash-lite/endpoints',
  'https://openrouter.ai/docs/features/provider-routing', 'https://openrouter.ai/docs/features/zdr', 'https://openrouter.ai/docs/use-cases/reasoning-tokens']} as const;

export const OPENROUTER_ORIGIN = 'https://openrouter.ai/api/v1';
const common = {contract: 'kapelle.restricted-execution/v3' as const, harness: {kind: 'hosted-openai-compatible' as const, adapterContract: 'kapelle.hosted-api-adapter/v1' as const}};
const runtime = {kind: 'hosted-api' as const, locality: 'remote-provider' as const, origin: OPENROUTER_ORIGIN, dataPolicy: {dataCollection: 'deny' as const, zdr: true},
  contextTokens: 200_000, reasoning: 'off' as const, tools: [], concurrencyLimit: 1 as const, usage: 'required' as const, reasoningOff: 'effort-none' as const};

export const OPENROUTER_PROFILES: Record<'sonnet' | 'flash-lite', HostedProfile> = {
  // QUALIFIED (Fable attempt-5 read-back a9539c17): the qualificationRef is the sha256 of the passing live report
  // qualification-or-sonnet-4-6-us-live-20261016T150526909Z.json (run id run-1792163073-38080-29137, commit c9e3b0bd, 2026-10-16;
  // 10/10, 14 requests all routed Amazon Bedrock, citationsDropped 2). TRACKED copy (with the probe and the flash-lite refusal, and
  // SHA256SUMS; hashes, labels and costs only): agent-framework/qualification/openrouter/2026-10-16-c9e3b0bd/. Caveat: every live request across attempts 2-5 routed Amazon Bedrock; google-vertex/us-east5 stays
  // in the pinned provider list on catalog ZDR evidence only (no live request has exercised it). Pinning changes this profile's
  // hash (the report recorded the pre-pin hash sha256:ae09b2be...): re-render catalogs and re-approve reply policies that pin it.
  sonnet: hostedProfileSchema.parse({...common, id: 'or-sonnet-4-6-us', qualificationRef: 'sha256:28cd463000c78f44fa0d090b29cc6d498874d69d43a3d467df0426799a9f3178',
    runtime: {...runtime, model: 'anthropic/claude-sonnet-4.6', responseModels: ['anthropic/claude-sonnet-4.6', 'anthropic/claude-4.6-sonnet-20260217'],
      providers: ['amazon-bedrock/us', 'google-vertex/us-east5'], providerNames: ['Amazon Bedrock', 'Google']},
    pricing: {version: 'openrouter-2026-10-15', inputUsdPerMTok: 3.3, outputUsdPerMTok: 16.5, reservationMargin: 1.5},
    limits: {maxOutputTokens: 4000, maxBudgetUsd: 0.5, timeoutMs: 120_000}}),
  'flash-lite': hostedProfileSchema.parse({...common, id: 'or-gemini-3-1-flash-lite-us', qualificationRef: 'pending:or-gemini-3-1-flash-lite-us',
    runtime: {...runtime, model: 'google/gemini-3.1-flash-lite', responseModels: ['google/gemini-3.1-flash-lite', 'google/gemini-3.1-flash-lite-20260507'],
      providers: ['google-vertex/us'], providerNames: ['Google']},
    pricing: {version: 'openrouter-2026-10-15', inputUsdPerMTok: 0.275, outputUsdPerMTok: 1.65, reservationMargin: 1.5},
    limits: {maxOutputTokens: 4000, maxBudgetUsd: 0.2, timeoutMs: 120_000}}), // 0.2: room for a large meeting intake (Fable E N-2)
};
