// Agent launch kit, slice 1: the typed launchPolicy carried by the next AgentDefinition release (AGENT-LAUNCH-KIT §1).
// Machine-checked, covered by the release hash, never inferred from prose (`operatingPolicy`) and never assumed for old
// releases: an absent policy means "not kit-eligible", not "default policy".
import {z} from 'zod';
import type {RuntimeCatalog} from './runtime-catalog.js';
// Kept here (no runtime imports) so the native v2 model can import this file without a cycle into the worker.
export const profileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);

/** Host-implemented source readers. Selectors name a reader and a scope, never a path, URL or query. */
export const SOURCE_READERS = ['task', 'inbox-item', 'website-content', 'report'] as const;
/** The existing packet caps (TASK-PACKET: 8 sources, 128 KiB serialized). */
export const PACKET_LIMITS = {maxSources: 8, maxBytes: 131072} as const;

const projectSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
export const sourceSelectorSchema = z.object({
  reader: z.enum(SOURCE_READERS),
  /** Owner scope is always the Task owner; a project narrows it further (null = any project of that owner). */
  project: projectSchema.nullable(),
  /** Each item must be explicitly selected for the Task (no reader-wide search). */
  selection: z.literal('task-selected'),
  maxItems: z.number().int().min(1).max(PACKET_LIMITS.maxSources),
}).strict();
export const budgetSchema = z.object({
  maxOutputTokens: z.number().int().positive(),
  maxBudgetUsd: z.number().positive(),
  timeoutMs: z.number().int().positive(),
  concurrency: z.literal(1),
}).strict();
export type Budget = z.infer<typeof budgetSchema>;

export const launchPolicyV1Schema = z.object({
  contract: z.literal('kapelle.agent-launch-policy/v1'),
  sources: z.array(sourceSelectorSchema).min(1).max(SOURCE_READERS.length),
  outputs: z.object({types: z.array(z.literal('report')).length(1), classification: z.enum(['owner-private', 'project'])}).strict(),
  runtime: z.object({allow: z.array(profileIdSchema).min(1).max(8), default: profileIdSchema}).strict(),
  budget: z.object({ceiling: budgetSchema, default: budgetSchema}).strict(),
  approvalMode: z.literal('EACH_TASK'),
  effectMode: z.literal('PREPARE_ONLY'),
  fallback: z.literal('NONE'),
}).strict().superRefine((p, ctx) => {
  const issue = (message: string) => ctx.addIssue({code: 'custom', message});
  if (new Set(p.sources.map(s => s.reader)).size !== p.sources.length) issue('duplicate_source_reader');
  if (!p.sources.some(s => s.reader === 'task')) issue('task_source_required');
  if (p.sources.reduce((n, s) => n + s.maxItems, 0) > PACKET_LIMITS.maxSources) issue('sources_exceed_packet_cap');
  if (new Set(p.runtime.allow).size !== p.runtime.allow.length) issue('duplicate_runtime_profile');
  if (!p.runtime.allow.includes(p.runtime.default)) issue('default_runtime_not_allowed');
  const c = p.budget.ceiling, d = p.budget.default;
  if (d.maxOutputTokens > c.maxOutputTokens || d.maxBudgetUsd > c.maxBudgetUsd || d.timeoutMs > c.timeoutMs) issue('default_budget_exceeds_ceiling');
});
export type LaunchPolicyV1 = z.infer<typeof launchPolicyV1Schema>;

// ---- AGENT-MODEL-V2 slice 1: owner-authored generic agents with a per-Task scope (project OR folder) ----
/** A Task's source scope. Folder roots are opaque ids from the host's admitted root catalog (never a path from a browser);
 *  relativeDirectory is validated by path components (no '..', no absolute path, no hidden or empty segments). */
export const SCOPE_LIMITS = {defaultScopes: 4, nameChars: 80, purposeChars: 500, instructionsBytes: 8192, relativeDirectoryChars: 256} as const;
const rootIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/);
export const relativeDirectorySchema = z.string().max(SCOPE_LIMITS.relativeDirectoryChars).refine(
  d => d === '' || d.split('/').every(seg => /^[A-Za-z0-9][A-Za-z0-9 ._()+-]{0,127}$/.test(seg) && seg !== '..' && !seg.endsWith('.')), 'relative_directory_invalid');
export const sourceScopeSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('project'), projectId: projectSchema}).strict(),
  z.object({kind: z.literal('folder'), rootId: rootIdSchema, relativeDirectory: relativeDirectorySchema}).strict(),
]);
export type SourceScope = z.infer<typeof sourceScopeSchema>;
export const launchPolicyV2Schema = z.object({
  contract: z.literal('kapelle.agent-launch-policy/v2'),
  /** Owner-authored, bounded, plain text; hashed into the release. Defaults, never grants. */
  brief: z.object({
    purpose: z.string().min(1).max(SCOPE_LIMITS.purposeChars).regex(/^[^\p{Cc}]+$/u),
    instructions: z.string().max(SCOPE_LIMITS.instructionsBytes * 4).refine(t => Buffer.byteLength(t) <= SCOPE_LIMITS.instructionsBytes, 'instructions_too_large'),
  }).strict(),
  /** The scope is chosen per Task (defaulting to these); it is bound into that Task's exact plan, never a standing grant. */
  scope: z.object({mode: z.literal('task-selected'), kinds: z.array(z.enum(['project', 'folder'])).min(1).max(2),
    defaults: z.array(sourceScopeSchema).max(SCOPE_LIMITS.defaultScopes)}).strict(),
  outputs: z.object({types: z.array(z.literal('report')).length(1), classification: z.enum(['owner-private', 'project'])}).strict(),
  runtime: z.object({allow: z.array(profileIdSchema).min(1).max(8), default: profileIdSchema}).strict(),
  budget: z.object({ceiling: budgetSchema, default: budgetSchema}).strict(),
  approvalMode: z.literal('EACH_TASK'),
  effectMode: z.literal('PREPARE_ONLY'),
  fallback: z.literal('NONE'),
}).strict().superRefine((p, ctx) => {
  const issue = (message: string) => ctx.addIssue({code: 'custom', message});
  if (new Set(p.scope.kinds).size !== p.scope.kinds.length) issue('duplicate_scope_kind');
  if (p.scope.defaults.some(d => !p.scope.kinds.includes(d.kind))) issue('default_scope_kind_not_allowed');
  if (new Set(p.scope.defaults.map(d => JSON.stringify(d))).size !== p.scope.defaults.length) issue('duplicate_default_scope');
  if (new Set(p.runtime.allow).size !== p.runtime.allow.length) issue('duplicate_runtime_profile');
  if (!p.runtime.allow.includes(p.runtime.default)) issue('default_runtime_not_allowed');
  const c = p.budget.ceiling, d = p.budget.default;
  if (d.maxOutputTokens > c.maxOutputTokens || d.maxBudgetUsd > c.maxBudgetUsd || d.timeoutMs > c.timeoutMs) issue('default_budget_exceeds_ceiling');
});
export type LaunchPolicyV2 = z.infer<typeof launchPolicyV2Schema>;
/** Either policy version; v1 (template, fixed project) releases keep their exact parse and hash. */
export const launchPolicySchema = z.union([launchPolicyV1Schema, launchPolicyV2Schema]);
export type LaunchPolicy = z.infer<typeof launchPolicySchema>;
export const isPolicyV2 = (p: LaunchPolicy): p is LaunchPolicyV2 => p.contract === 'kapelle.agent-launch-policy/v2';

/** Policy vs the host catalog: every allowed profile exists and the ceiling fits every allowed profile's limits. */
export function policyCatalogProblems(p: LaunchPolicy, catalog: RuntimeCatalog): string[] {
  const out: string[] = [];
  for (const id of p.runtime.allow) {
    const prof = catalog.profiles.find(x => x.id === id);
    if (!prof) { out.push(`runtime profile ${id} is not in the host catalog`); continue; }
    const c = p.budget.ceiling, l = prof.limits;
    if (c.maxOutputTokens > l.maxOutputTokens || c.maxBudgetUsd > l.maxBudgetUsd || c.timeoutMs > l.timeoutMs)
      out.push(`budget ceiling exceeds the limits of runtime profile ${id}`);
  }
  return out;
}
