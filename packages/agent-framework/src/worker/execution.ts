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
const retryablePreInferenceReasons = new Set([
  'claude_oauth_not_available', 'claude_private_runtime_required',
  'claude_provider_binding_mismatch', 'claude_provider_context_invalid',
]);
/** Exact local refusals only. Never include provider account/init errors after query starts. */
export function isRetryablePreInferenceReason(reason:string):boolean {
  return retryablePreInferenceReasons.has(reason);
}
/** Local refusal proven before SDK query submission (credential, binding or private context).
 * Never use for system/init or for missing assistant/result after query invocation.
 * The worker additionally checks the exact allowlist and refuses late/aborted/uncertain evidence. */
export class ProviderRejectedBeforeInference extends Error {
  constructor(readonly reason: string) { super(reason); this.name = 'ProviderRejectedBeforeInference'; }
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
