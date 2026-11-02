// Agent launch kit, slice 1: the host-owned runtime catalog (AGENT-LAUNCH-KIT §2).
// One catalog, loaded by the Framework from a host file outside Dropbox and pinned by its sha256. Definitions name catalog
// profile ids; nothing from a browser can supply an executable, endpoint, credential or adapter. A profile is a MATCHED pair:
// `claude` runtime + Claude Agent SDK harness, or `local-mlx` runtime + vendored Pi agent core (never mixed).
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {digest} from '../content.js';
import {inferenceInputSchema, LOCAL_MAX_OUTPUT_TOKENS, type LocalInferenceInput} from '../worker/execution.js';
import {assert} from '../validation.js';

import {profileIdSchema} from './launch-policy.js';
import {hostedProfileSchema, hostedInferenceFor, hostedProfileHash, type HostedProfile} from './hosted/profile.js';
export {profileIdSchema};
/** Hard limits a profile supports; a definition's budget ceiling must fit inside them. */
export const runtimeLimitsSchema = z.object({
  maxOutputTokens: z.number().int().positive().max(64000),
  maxBudgetUsd: z.number().positive().max(50),
  timeoutMs: z.number().int().positive().max(3_600_000),
}).strict();
export type RuntimeLimits = z.infer<typeof runtimeLimitsSchema>;
/** The HARNESS is an explicit part of a runtime (owner, Oct 14): the agent loop/CLI that drives the model, pinned by version.
 *  Today: the Claude Agent SDK + Claude Code CLI. A later harness (e.g. Pi for local-mlx Qwen) is a new union member +
 *  adapter, not a change to profiles that already exist. */
export const harnessSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('claude-agent-sdk'), sdkVersion: z.string().min(1), cliVersion: z.string().min(1)}).strict(),
]);
export type Harness = z.infer<typeof harnessSchema>;
/** The existing Claude adapter's model/credential fields (the admitted binding minus harness pins and per-run budget). */
export const claudeRuntimeSchema = inferenceInputSchema.omit({system: true, user: true, maxOutputTokens: true, maxBudgetUsd: true, timeoutMs: true, runtime: true, sdkVersion: true, cliVersion: true})
  .extend({kind: z.literal('claude'), locality: z.literal('remote-provider')}).strict();
export const claudeProfileSchema = z.object({
  id: profileIdSchema,
  runtime: claudeRuntimeSchema,
  harness: harnessSchema,
  limits: runtimeLimitsSchema,
  contract: z.literal('kapelle.restricted-execution/v1'),
  /** Where this profile's qualification evidence lives (retained; not manufactured per agent). */
  qualificationRef: z.string().min(1).max(300),
}).strict();
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** local-mlx (LOCAL-MLX-ADAPTER-SPEC): host-supplied configuration facts, pinned by the profile hash. The endpoint is fixed by
 *  the host profile (loopback only); Task/browser content can never supply it. */
export const localMlxRuntimeSchema = z.object({
  kind: z.literal('local-mlx'), locality: z.literal('local-only'),
  model: z.string().min(1).max(200),
  server: z.object({implementation: z.literal('mlx-lm'), version: z.literal('0.31.3'), service: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,99}$/),
    endpoint: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{1,4}\/v1$/)}).strict(),
  /** Resolved at installation admission (snapshot path + file hashes); the storage directory is not an identity. */
  modelManifestHash: sha, runnerManifestHash: sha, modelStorageRef: z.string().min(1).max(300),
  contextTokens: z.number().int().positive().max(131072),
  sampling: z.object({temperature: z.literal(0)}).strict(),
  enableThinking: z.literal(false), tools: z.array(z.never()).length(0), concurrencyLimit: z.literal(1),
}).strict();
/** The vendored Pi agent core (vendor/pi/SOURCES.md): upstream commit + digest of the vendored files. */
export const piHarnessSchema = z.object({
  kind: z.literal('pi-agent-core'), source: z.literal('https://github.com/earendil-works/pi'),
  commit: z.string().regex(/^[a-f0-9]{40}$/), vendoredDigest: sha, adapterContract: z.literal('kapelle.local-mlx-adapter/v1'),
}).strict();
export const localProfileSchema = z.object({
  id: profileIdSchema,
  runtime: localMlxRuntimeSchema,
  harness: piHarnessSchema,
  limits: runtimeLimitsSchema,
  contract: z.literal('kapelle.restricted-execution/v2'),
  qualificationRef: z.string().min(1).max(300),
}).strict().superRefine((p, ctx) => {
  if (p.limits.maxOutputTokens > LOCAL_MAX_OUTPUT_TOKENS || p.limits.maxOutputTokens >= p.runtime.contextTokens) ctx.addIssue({code: 'custom', message: 'local_output_limit'});
});
// CP agent launch: a third, matched branch (hosted-api runtime + hosted-openai-compatible harness). Existing pins are unchanged.
export const runtimeProfileSchema = z.union([claudeProfileSchema, localProfileSchema, hostedProfileSchema]);
export type ClaudeProfile = z.infer<typeof claudeProfileSchema>;
export type LocalProfile = z.infer<typeof localProfileSchema>;
export type {HostedProfile};
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
export const runtimeCatalogSchema = z.object({
  contract: z.literal('kapelle.runtime-catalog/v1'),
  profiles: z.array(runtimeProfileSchema).min(1).max(16),
}).strict().superRefine((c, ctx) => {
  if (new Set(c.profiles.map(p => p.id)).size !== c.profiles.length) ctx.addIssue({code: 'custom', message: 'duplicate_runtime_profile'});
});
export type RuntimeCatalog = z.infer<typeof runtimeCatalogSchema>;

/** The hash a launch manifest and owner approval bind: the resolved profile, not its id. */
/** Fable F-8: a HOSTED profile's hash excludes its qualificationRef (hostedProfileHash, the one hosted rule), so pinning a
 *  qualification report never changes it. Claude and local profiles keep their original hash byte-for-byte (personal-stack
 *  stores pin them; their refs are not qualification report hashes). */
export const profileHash = (p: RuntimeProfile) => p.runtime.kind === 'hosted-api' ? hostedProfileHash(p as never) : digest(p);
/** Owner-facing model name; never a host path (a local model's runtime.model is a snapshot path). Deterministic from the profile:
 *  claude-opus-5-5 -> "Claude Opus 5.5"; .../models--mlx-community--Qwen3.6-27B-4bit/... -> "Local Qwen 3.6 27B (4-bit)". */
export function runtimeLabel(p: RuntimeProfile): string {
  const m = p.runtime.model;
  if (p.runtime.kind === 'claude') {
    const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
    return x ? `Claude ${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : 'Claude';
  }
  if (p.runtime.kind === 'hosted-api') {
    // 'anthropic/claude-sonnet-4.6' -> 'Claude Sonnet 4.6'; 'google/gemini-2.5-flash' -> 'Gemini 2.5 Flash'
    const name = (m.split('/')[1] ?? m).split('-').map(w => /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)).join(' ').replace(/[^A-Za-z0-9 .]/g, '').trim().slice(0, 40);
    return name || 'Hosted model';
  }
  const seg = /models--[^/]+--([^/]+)/.exec(m)?.[1] ?? m.split('/').filter(Boolean).at(-1) ?? 'model';
  const bits = /-(\d+)bit$/i.exec(seg)?.[1], base = seg.replace(/-(\d+)bit$/i, '');
  const name = base.replace(/^([A-Za-z]+)(\d)/, '$1 $2').replace(/-/g, ' ').replace(/[^A-Za-z0-9 .]/g, '').trim().slice(0, 40);
  return `Local ${name || 'model'}${bits ? ` (${bits}-bit)` : ''}`;
}

export function resolveRuntime(catalog: RuntimeCatalog, id: string): {profile: RuntimeProfile; hash: string} {
  const profile = catalog.profiles.find(p => p.id === id);
  assert(profile, 'runtime_profile_unknown');
  return {profile: profile!, hash: profileHash(profile!)};
}

/** Load the host catalog file, refusing any byte drift from the pinned sha256 (installed once by Ops). */
export function loadRuntimeCatalog(path: string, expectedSha256: string): RuntimeCatalog {
  const bytes = readFileSync(path);
  assert(createHash('sha256').update(bytes).digest('hex') === expectedSha256, 'runtime_catalog_changed');
  return runtimeCatalogSchema.parse(JSON.parse(bytes.toString('utf8')));
}

/** Derive a `claude` profile from an ADMITTED binding's inference block (e.g. W4's), so the catalog reuses reviewed values
 *  instead of inventing new ones. The binding's own budget becomes the profile's limits. */
export function claudeProfileFromBinding(id: string, inference: z.infer<typeof inferenceInputSchema> | Omit<z.infer<typeof inferenceInputSchema>, 'system' | 'user'>, qualificationRef: string): ClaudeProfile {
  const {maxOutputTokens, maxBudgetUsd, timeoutMs, runtime, sdkVersion, cliVersion, ...rest} = inference as Omit<z.infer<typeof inferenceInputSchema>, 'system' | 'user'>;
  assert(runtime === 'claude-agent-sdk', 'unsupported_harness');
  return claudeProfileSchema.parse({id, runtime: {...rest, kind: 'claude', locality: 'remote-provider'}, harness: {kind: 'claude-agent-sdk', sdkVersion, cliVersion},
    limits: {maxOutputTokens, maxBudgetUsd, timeoutMs}, contract: 'kapelle.restricted-execution/v1', qualificationRef});
}

/** The adapter input for one run: the profile's model + harness pins and the APPROVED budget (never above the profile limits). */
export function claudeInferenceFor(p: RuntimeProfile, budget: {maxOutputTokens: number; maxBudgetUsd: number; timeoutMs: number}): Omit<z.infer<typeof inferenceInputSchema>, 'system' | 'user'> {
  if (p.runtime.kind !== 'claude' || p.harness.kind !== 'claude-agent-sdk') throw Error('unsupported_harness');
  assert(budget.maxOutputTokens <= p.limits.maxOutputTokens && budget.maxBudgetUsd <= p.limits.maxBudgetUsd && budget.timeoutMs <= p.limits.timeoutMs, 'budget_exceeds_runtime_limits');
  const {kind: _k, locality: _l, ...model} = p.runtime;
  return {...model, runtime: p.harness.kind, sdkVersion: p.harness.sdkVersion, cliVersion: p.harness.cliVersion,
    maxOutputTokens: budget.maxOutputTokens, maxBudgetUsd: budget.maxBudgetUsd, timeoutMs: budget.timeoutMs};
}

type Budget = {maxOutputTokens: number; maxBudgetUsd: number; timeoutMs: number};
/** The local adapter input for one run: profile pins (hash, harness digest, model manifest) + the APPROVED budget. */
export function localInferenceFor(p: RuntimeProfile, budget: Budget): Omit<LocalInferenceInput, 'system' | 'user'> {
  if (p.runtime.kind !== 'local-mlx' || p.harness.kind !== 'pi-agent-core') throw Error('unsupported_harness');
  assert(budget.maxOutputTokens <= p.limits.maxOutputTokens && budget.maxBudgetUsd <= p.limits.maxBudgetUsd && budget.timeoutMs <= p.limits.timeoutMs, 'budget_exceeds_runtime_limits');
  return {runtime: 'pi-agent-core', locality: 'local-only', model: p.runtime.model, runtimeProfileHash: profileHash(p), harnessDigest: p.harness.vendoredDigest,
    modelManifestHash: p.runtime.modelManifestHash, serverVersion: p.runtime.server.version, tools: [], enableThinking: false,
    maxOutputTokens: budget.maxOutputTokens, contextTokens: p.runtime.contextTokens, timeoutMs: budget.timeoutMs};
}
/** Either runtime's per-run inference block, chosen by the profile's (matched) runtime kind. */
export function inferenceFor(p: RuntimeProfile, budget: Budget) {
  return p.runtime.kind === 'claude' ? claudeInferenceFor(p, budget) : p.runtime.kind === 'local-mlx' ? localInferenceFor(p, budget) : hostedInferenceFor(p as HostedProfile, budget);
}
