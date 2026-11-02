// Agent launch kit, slice 1: the AgentDefinition release evolution (v2 = v1 release + typed launchPolicy) and kit eligibility.
// The release hash stays the existing `releaseHash` formula over the whole release, so:
//   - a v1 release upgraded to v2 carries launchPolicy:null, keeps its EXACT contentHash, and is NOT kit-eligible;
//   - a v2 release with a policy has the policy inside its hash, and the existing PUBLISH_DEFINITION hash assertion
//     (command-boundary `releaseHash(input.release) === contentHash`) holds unchanged.
// The native document-model v2 (schema/reducer/upgrade) is slice 2; this module is its pure contract.
import {releaseHash} from '../command-boundary.js';
import type * as definition from '../../document-models/agent-definition/v1/index.js';
import {launchPolicySchema, policyCatalogProblems, type LaunchPolicy} from './launch-policy.js';
import type {RuntimeCatalog} from './runtime-catalog.js';

export type ReleaseV1 = definition.DefinitionReleaseInput;
export type ReleaseV2 = ReleaseV1 & {launchPolicy: LaunchPolicy | null};

/** The v2 release hash: the v1 formula, with an absent (null) policy omitted so old releases keep their identity. */
export function releaseHashV2(r: ReleaseV2): string {
  const {launchPolicy, ...v1} = r;
  return launchPolicy === null ? releaseHash(v1) : releaseHash({...v1, launchPolicy} as ReleaseV1);
}

/** v1 → v2 migration: no policy, same hash. Never silently qualifies an old release for the kit. */
export function upgradeReleaseV1(r: ReleaseV1): ReleaseV2 {
  return {...r, launchPolicy: null};
}

/** Capabilities a kit definition must declare: Task read and Task-delegation receive, OPTIONAL at idle (the instance can be
 *  READY without a dummy Task grant). Optional here never relaxes execution: the exact grants are still required at claim. */
export const KIT_CAPABILITIES = [
  {resourceType: 'task', actions: ['read']},
  {resourceType: 'task-delegation', actions: ['receive']},
] as const;
export const KIT_RUNTIME_CONTRACT = 'kapelle.task-delegation/v1';

export type Eligibility = {eligible: boolean; problems: string[]};
/** Deterministic template-policy compatibility. No PASS files: the same checked code admits every template instance. */
export function kitEligibility(r: ReleaseV2, catalog: RuntimeCatalog): Eligibility {
  const problems: string[] = [];
  if (releaseHashV2(r) !== r.contentHash) problems.push('release content hash does not match the release');
  if (r.launchPolicy === null) return {eligible: false, problems: [...problems, 'release has no launch policy (not kit-eligible)']};
  const parsed = launchPolicySchema.safeParse(r.launchPolicy);
  if (!parsed.success) return {eligible: false, problems: [...problems, ...parsed.error.issues.map(i => 'launch policy: ' + i.message)]};
  const p = parsed.data;
  problems.push(...policyCatalogProblems(p, catalog));
  for (const id of p.runtime.allow) if (!r.modelProfiles.includes(id)) problems.push(`runtime profile ${id} is not declared in modelProfiles`);
  if (!r.runtimeContracts.includes(KIT_RUNTIME_CONTRACT)) problems.push('release does not declare the Task-delegation runtime contract');
  for (const need of KIT_CAPABILITIES) {
    const c = r.capabilities.filter(x => x.resourceType === need.resourceType);
    if (c.length !== 1 || JSON.stringify([...c[0].actions].sort()) !== JSON.stringify([...need.actions]) || c[0].requirement !== 'OPTIONAL')
      problems.push(`capability ${need.resourceType}/${need.actions.join(',')} must be declared once, OPTIONAL`);
  }
  const extra = r.capabilities.filter(x => !KIT_CAPABILITIES.some(k => k.resourceType === x.resourceType));
  if (extra.length) problems.push('release declares capabilities outside the kit: ' + extra.map(x => x.resourceType).join(', '));
  if (r.capabilities.some(x => x.outputTypes.some(t => t !== 'report'))) problems.push('kit outputs are Reports only');
  return {eligible: problems.length === 0, problems};
}

/** A definition document (v1 or v2) as a v2 release: the stored release plus its launch policy (null for v1 / no policy). */
export function releaseOfDocument(doc: {state: {document?: {version?: number}; global: {release?: unknown; launchPolicyJson?: string | null}}}): ReleaseV2 | null {
  const g = doc.state.global;
  if (!g.release) return null;
  // Only a v2 document carries a policy; a document without a version block is a plain v1 release.
  const launchPolicy = doc.state.document?.version === 2 && g.launchPolicyJson ? launchPolicySchema.parse(JSON.parse(g.launchPolicyJson)) : null;
  return {...(g.release as ReleaseV1), launchPolicy};
}
/** The host's DefinitionProof for a kit definition: qualified only by deterministic kit eligibility on this host. The proof's
 *  release carries the policy (when present) so command-boundary's `releaseHash(proof.release) === ref.contentHash` holds. */
export function kitDefinitionProof(r: ReleaseV2, catalog: RuntimeCatalog): {release: ReleaseV1; qualified: boolean; problems: string[]} {
  const {launchPolicy, ...v1} = r;
  const e = kitEligibility(r, catalog);
  return {release: (launchPolicy === null ? v1 : {...v1, launchPolicy}) as ReleaseV1, qualified: e.eligible, problems: e.problems};
}

/** The release object the authority projects for a definition document: v1 as stored; v2 with its launch policy, so
 *  `releaseHash(release) === contentHash` holds and the host's kit proof (same canonical release) can qualify it. */
export function projectedRelease(doc: {state: {document?: {version?: number}; global: {release?: unknown; launchPolicyJson?: string | null}}}): ReleaseV1 | null {
  const r = releaseOfDocument(doc);
  if (!r) return null;
  const {launchPolicy, ...v1} = r;
  return (launchPolicy === null ? v1 : {...v1, launchPolicy}) as ReleaseV1;
}
