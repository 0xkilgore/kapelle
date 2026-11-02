// Agent launch kit, slice 3: the host facts a kit agent needs, derived from native state + the pinned host catalog.
// Nothing here is per-agent configuration: definitions are qualified by deterministic kit eligibility, the runtime binding
// and budget refs are pure functions of the approved manifest, and the runtime contract is the Task-delegation contract.
import {digest} from '../content.js';
import type {DefinitionProof} from '../command-boundary.js';
import type {LaunchManifest} from './templates/example-org.js';
import {kitDefinitionProof, KIT_RUNTIME_CONTRACT, type ReleaseV2} from './definition-v2.js';
import {resolveRuntime, type RuntimeCatalog} from './runtime-catalog.js';

/** Runtime binding ref = profile id + its resolved hash: a catalog edit is a NEW binding, never silently inherited. */
export const kitRuntimeBindingRef = (profileId: string, profileHash: string) => `runtime:kit:${profileId}:${profileHash.slice(7, 23)}`;
/** Budget policy ref = the approved budget itself (concurrency, tokens, dollars, time). */
export const kitBudgetPolicyRef = (m: Pick<LaunchManifest, 'definitionRef' | 'budget'>) => `budget:kit:${m.definitionRef.id}:${digest(m.budget).slice(7, 23)}`;

export type KitFacts = {definitions: DefinitionProof[]; runtimeBindingRefs: string[]; runtimeBindingContracts: Record<string, string>; budgetPolicyRefs: string[]};
/** Facts for the kit: one proof per published kit release (qualified only if eligible on THIS host), the catalog's runtime
 *  bindings under the Task-delegation contract, and the budget refs of approved manifests. */
export function kitHostFacts(releases: readonly ReleaseV2[], catalog: RuntimeCatalog, approved: readonly Pick<LaunchManifest, 'definitionRef' | 'budget'>[]): KitFacts {
  const definitions = releases.map(r => { const p = kitDefinitionProof(r, catalog); return {release: p.release as DefinitionProof['release'], qualified: p.qualified}; });
  const runtimeBindingContracts: Record<string, string> = {};
  for (const p of catalog.profiles) runtimeBindingContracts[kitRuntimeBindingRef(p.id, resolveRuntime(catalog, p.id).hash)] = KIT_RUNTIME_CONTRACT;
  return {definitions, runtimeBindingRefs: Object.keys(runtimeBindingContracts), runtimeBindingContracts, budgetPolicyRefs: [...new Set(approved.map(kitBudgetPolicyRef))]};
}

export type Availability = 'available' | 'finishing-setup' | 'paused' | 'retired' | 'runtime-unavailable' | 'definition-not-qualified';
/** Derived, never stored: READY desired state + a qualified definition + a runtime binding this host still offers. A missing
 *  runtime is shown separately from an owner pause; nothing is substituted. */
export function agentAvailability(inst: {desiredState: string; runtimeBindingRef: string | null; definitionRef: {contentHash: string} | null} | null, facts: KitFacts): Availability {
  if (!inst || !inst.definitionRef) return 'finishing-setup';
  if (inst.desiredState === 'RETIRED') return 'retired';
  const proof = facts.definitions.find(d => d.release.contentHash === inst.definitionRef!.contentHash);
  if (!proof?.qualified) return 'definition-not-qualified';
  if (!inst.runtimeBindingRef) return 'finishing-setup';
  if (!facts.runtimeBindingRefs.includes(inst.runtimeBindingRef)) return 'runtime-unavailable';
  return inst.desiredState === 'READY' ? 'available' : 'paused';
}
