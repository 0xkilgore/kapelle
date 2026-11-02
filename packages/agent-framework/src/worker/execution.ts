import { z } from 'zod';
import { canonical, digest } from '../command-boundary.js';
import { sha, workSchema } from './contracts.js';

export const inferenceInputSchema = z.object({
  system: z.string(), user: z.string(), model: z.string().min(1),
  credentialTeamId: z.string().uuid(), credentialKind: z.literal('claude-code-oauth'),
  runtime: z.literal('claude-agent-sdk'), sdkVersion: z.string(), cliVersion: z.string(),
  maxOutputTokens: z.number().int().positive(), maxBudgetUsd: z.number().positive(),
  timeoutMs: z.number().int().positive(),
  tools: z.array(z.never()).length(0), settings: z.literal('isolated'),
  thinking:z.literal('adaptive'), effort:z.literal('high'),
}).strict();
export type InferenceInput = z.infer<typeof inferenceInputSchema>;
export const executionInputSchema = inferenceInputSchema.extend({work: workSchema});
export type ExecutionInput = z.infer<typeof executionInputSchema>;
export const runtimeEvidenceSchema = z.object({
  provider: z.literal('anthropic'), runtime: z.literal('claude-agent-sdk'),
  model: z.string(), sessionId: z.string().uuid(), sdkVersion: z.string(), cliVersion: z.string(),
  tools: z.array(z.never()).length(0),
}).strict();
export type RuntimeEvidence = z.infer<typeof runtimeEvidenceSchema>;
export const outputEvidenceSchema = z.object({
  text: z.string().max(32000), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().nonnegative(), stopReason: z.literal('end_turn'),
  resultId: z.string().min(1), costUsd: z.number().nonnegative(),
}).strict().refine(o => sha(o.text) === o.contentHash && Buffer.byteLength(o.text) === o.byteSize, 'output_integrity');
export type OutputEvidence = z.infer<typeof outputEvidenceSchema>;
export const executionSchema = z.object({
  schema: z.literal('kapelle.restricted-execution/v1'),
  phase: z.enum(['started','returned','completed','uncertain']),
  requestHash: z.string(), inputHash: z.string(), input: executionInputSchema,
  sessionId: z.string().uuid(), startedAt: z.iso.datetime(),
  runtime: runtimeEvidenceSchema.nullable(), output: outputEvidenceSchema.nullable(),
}).strict().superRefine((e, c) => {
  if (digest(e.input) !== e.inputHash || digest(e.input.work) !== e.requestHash ||
      (e.runtime && (e.runtime.sessionId !== e.sessionId || e.runtime.model !== e.input.model ||
        e.runtime.sdkVersion !== e.input.sdkVersion || e.runtime.cliVersion !== e.input.cliVersion)) ||
      (e.phase === 'completed' && (!e.runtime || !e.output)))
    c.addIssue({code:'custom',message:'execution_integrity'});
});
export type ExecutionEvidence = z.infer<typeof executionSchema>;
export function serializeExecution(e: ExecutionEvidence) { return canonical(executionSchema.parse(e)); }

// ---- Local runtime (local-mlx via the vendored Pi agent core). Separate strict branch; the Claude schemas above are unchanged
// so existing receipts, bindings and hashes keep their exact bytes. No credential, CLI or Claude-effort field exists here. ----
const prefixedSha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const LOCAL_MAX_OUTPUT_TOKENS = 4096;
export const localInferenceInputSchema = z.object({
  system: z.string(), user: z.string(),
  runtime: z.literal('pi-agent-core'), locality: z.literal('local-only'), model: z.string().min(1).max(200),
  runtimeProfileHash: prefixedSha, harnessDigest: prefixedSha, modelManifestHash: prefixedSha, serverVersion: z.literal('0.31.3'),
  tools: z.array(z.never()).length(0), enableThinking: z.literal(false),
  maxOutputTokens: z.number().int().positive().max(LOCAL_MAX_OUTPUT_TOKENS),
  contextTokens: z.number().int().positive().max(131072),
  timeoutMs: z.number().int().positive().max(600_000),
}).strict(); // output < context is enforced by the catalog profile and re-checked by the adapter before send
export type LocalInferenceInput = z.infer<typeof localInferenceInputSchema>;
export const localRuntimeEvidenceSchema = z.object({
  provider: z.literal('local'), runtime: z.literal('pi-agent-core'), model: z.string().min(1).max(200), sessionId: z.string().uuid(),
  runtimeProfileHash: prefixedSha, harnessDigest: prefixedSha, modelManifestHash: prefixedSha,
  /** The admitted host service generation (deployment identity); the response's model string is corroboration only. */
  serviceGeneration: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  tools: z.array(z.never()).length(0),
}).strict();
export type LocalRuntimeEvidence = z.infer<typeof localRuntimeEvidenceSchema>;
export const localOutputEvidenceSchema = z.object({
  text: z.string().max(32000), contentHash: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().nonnegative().max(32000),
  stopReason: z.literal('end_turn'), resultId: z.string().min(1).max(200), resultIdSource: z.enum(['server', 'host']),
  usage: z.object({promptTokens: z.number().int().nonnegative().max(1_000_000), completionTokens: z.number().int().nonnegative().max(LOCAL_MAX_OUTPUT_TOKENS)}).strict().nullable(),
  /** 0 = no billed provider charge (not zero resource cost). */
  providerCostUsd: z.literal(0),
}).strict().refine(o => sha(o.text) === o.contentHash && Buffer.byteLength(o.text) === o.byteSize, 'output_integrity');
export type LocalOutputEvidence = z.infer<typeof localOutputEvidenceSchema>;
/** The local adapter port (same run/capture shape as Claude; no process-ownership evidence: the shared server is not ours). */
export interface LocalAdapter {
  readonly runtime: 'pi-agent-core';
  readonly harnessDigest: string;
  readonly runtimeProfileHash: string;
  run(input: LocalInferenceInput, sessionId: string, signal: AbortSignal, capture: {
    runtime(value: LocalRuntimeEvidence): void;
    output(value: LocalOutputEvidence): void;
    uncertain?(): void;
  }): Promise<void>;
}


// ---- Hosted API runtime (CP agent launch, Fable review §2): ONE POST /chat/completions to a pinned OpenAI-compatible HTTPS
// origin, server-only bearer key, provider allowlist + allow_fallbacks:false + data policy, max_tokens, usage required,
// reasoning off, no tools, no streaming, no agent loop. A separate strict branch; Claude and local schemas are unchanged. ----
export const HOSTED_MAX_OUTPUT_TOKENS = 16000;
export const hostedInferenceInputSchema = z.object({
  system: z.string(), user: z.string(),
  runtime: z.literal('hosted-api'), locality: z.literal('remote-provider'),
  model: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,127}$/).refine(m => !/latest/i.test(m), 'model_must_be_exact'),
  runtimeProfileHash: prefixedSha,
  maxOutputTokens: z.number().int().positive().max(HOSTED_MAX_OUTPUT_TOKENS),
  contextTokens: z.number().int().positive().max(1_000_000),
  maxBudgetUsd: z.number().positive().max(50),
  timeoutMs: z.number().int().positive().max(600_000),
  tools: z.array(z.never()).length(0), reasoning: z.literal('off'),
}).strict();
export type HostedInferenceInput = z.infer<typeof hostedInferenceInputSchema>;
export const hostedRuntimeEvidenceSchema = z.object({
  provider: z.literal('hosted'), runtime: z.literal('hosted-api'), model: z.string().min(1).max(200), sessionId: z.string().uuid(),
  runtimeProfileHash: prefixedSha, origin: z.string().url(), tools: z.array(z.never()).length(0),
}).strict();
export type HostedRuntimeEvidence = z.infer<typeof hostedRuntimeEvidenceSchema>;
export const hostedOutputEvidenceSchema = z.object({
  text: z.string().max(32000), contentHash: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().nonnegative().max(32000),
  stopReason: z.literal('end_turn'), resultId: z.string().min(1).max(200),
  /** The upstream provider that served the request (must be in the profile's allowlist). */
  routedProvider: z.string().min(1).max(100),
  usage: z.object({promptTokens: z.number().int().nonnegative().max(1_000_000), completionTokens: z.number().int().nonnegative().max(HOSTED_MAX_OUTPUT_TOKENS)}).strict(),
  /** The provider-returned cost of THIS request (settlement evidence; never an estimate). */
  providerCostUsd: z.number().nonnegative().max(50),
}).strict().refine(o => sha(o.text) === o.contentHash && Buffer.byteLength(o.text) === o.byteSize, 'output_integrity');
export type HostedOutputEvidence = z.infer<typeof hostedOutputEvidenceSchema>;
/** The hosted adapter port (same run/capture shape as the other runtimes). */
export interface HostedAdapter {
  readonly runtime: 'hosted-api';
  readonly runtimeProfileHash: string;
  run(input: HostedInferenceInput, sessionId: string, signal: AbortSignal, capture: {
    runtime(value: HostedRuntimeEvidence): void;
    output(value: HostedOutputEvidence): void;
    uncertain?(): void;
  }): Promise<void>;
}

const retryablePreInferenceReasons = new Set([
  'claude_oauth_not_available', 'claude_private_runtime_required',
  'claude_provider_binding_mismatch', 'claude_provider_context_invalid',
  // local-mlx: refused before any request is sent (busy/unsettled runtime, context ceiling, harness/profile pin drift).
  'local_runtime_busy', 'local_runtime_unsettled', 'local_context_exceeded', 'local_harness_changed', 'local_profile_changed',
  // hosted-api: the monthly spend cap refused the reservation; nothing was sent. (A run-cap mismatch is terminal instead.)
  'hosted_monthly_cap_exceeded',
]);
/** Exact local refusals only. Never include provider account/init errors after query starts. */
export function isRetryablePreInferenceReason(reason:string):boolean {
  return retryablePreInferenceReasons.has(reason);
}
/** Local refusal proven before SDK query submission (credential, binding or private context).
 * Never use for system/init or for missing assistant/result after query invocation.
 * The worker additionally checks the exact allowlist and refuses late/aborted/uncertain evidence. */
export class ProviderRejectedBeforeInference extends Error {
  /** terminal: refused before send for a reason a retry cannot fix (e.g. a run cap below the reservation). The worker records a
   *  terminal rejection (never retried, never uncertain); otherwise the exact allowlist decides whether a fresh attempt is allowed. */
  constructor(readonly reason: string, readonly terminal = false) { super(reason); this.name = 'ProviderRejectedBeforeInference'; }
}
/** Fable F-L1: a COMPLETE answer the runtime refused (e.g. truncated at the output ceiling, tool call, wrong model). The
 *  server settled and the invocation right is consumed: the outcome is a definite, terminal rejection (never uncertain,
 *  never re-invoked). Only for fully received responses; aborts, deadlines and transport failures stay uncertain. */
export class ProviderRejectedAfterInference extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'ProviderRejectedAfterInference'; }
}
export interface ClaudeAdapter {
  readonly sdkVersion: string;
  readonly cliVersion: string;
  run(input: InferenceInput, sessionId: string, signal: AbortSignal, capture: {
    runtime(value: RuntimeEvidence): void;
    output(value: OutputEvidence): void;
    /** Persist consumed uncertainty while child cleanup still owns the worker. */
    uncertain?(): void;
    ownership?(record:import('./claude-process.js').TerminationRecord):void;
  }): Promise<void>;
}

// ---- Runtime unions (after every branch is declared). Old receipts parse unchanged; the discriminator is `runtime`. ----
export const anyInferenceInputSchema = z.union([inferenceInputSchema, localInferenceInputSchema, hostedInferenceInputSchema]);
export type AnyInferenceInput = z.infer<typeof anyInferenceInputSchema>;
export const anyRuntimeEvidenceSchema = z.union([runtimeEvidenceSchema, localRuntimeEvidenceSchema, hostedRuntimeEvidenceSchema]);
export const anyOutputEvidenceSchema = z.union([outputEvidenceSchema, localOutputEvidenceSchema, hostedOutputEvidenceSchema]);
/** The runtime/output evidence schemas of an input's branch. */
export function evidenceSchemasFor(runtime: AnyInferenceInput['runtime']) {
  return runtime === 'claude-agent-sdk' ? {runtime: runtimeEvidenceSchema, output: outputEvidenceSchema}
    : runtime === 'pi-agent-core' ? {runtime: localRuntimeEvidenceSchema, output: localOutputEvidenceSchema}
    : {runtime: hostedRuntimeEvidenceSchema, output: hostedOutputEvidenceSchema};
}
/** Branch consistency: an input pairs only with its own branch's runtime/output evidence. */
export function sameRuntimeBranch(input: AnyInferenceInput, runtime: unknown, output: unknown): boolean {
  const s = evidenceSchemasFor(input.runtime);
  return (runtime === null || (s.runtime as z.ZodTypeAny).safeParse(runtime).success) && (output === null || (s.output as z.ZodTypeAny).safeParse(output).success);
}
export type InferenceAdapter = ClaudeAdapter | LocalAdapter | HostedAdapter;
