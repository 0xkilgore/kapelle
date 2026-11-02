// Agent launch kit, slice 1: pure validation and migration tests (no service, no network, no native writes).
import {it, expect, describe} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {releaseHash} from '../src/command-boundary.js';
import {launchPolicySchema, policyCatalogProblems, type LaunchPolicy, type LaunchPolicyV1} from '../src/agent-kit/launch-policy.js';
import {runtimeCatalogSchema, claudeProfileFromBinding, claudeInferenceFor, resolveRuntime, loadRuntimeCatalog, profileHash, type RuntimeCatalog} from '../src/agent-kit/runtime-catalog.js';
import {releaseHashV2, upgradeReleaseV1, kitEligibility, type ReleaseV1, type ReleaseV2} from '../src/agent-kit/definition-v2.js';
import {exampleOrgRelease, exampleOrgManifest, EXAMPLE_ORG_POLICY, agentNameSchema} from '../src/agent-kit/templates/example-org.js';

// The admitted W4 binding's inference block (render_w4_live.mts), reused as the catalog's `claude-current` profile.
const W4_INFERENCE = {model: 'claude-opus-5-5', credentialTeamId: '00000000-0000-4000-8000-0000000000aa', credentialKind: 'claude-code-oauth' as const,
  runtime: 'claude-agent-sdk' as const, sdkVersion: '0.2.90', cliVersion: '2.1.295', maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000,
  tools: [] as never[], settings: 'isolated' as const, thinking: 'adaptive' as const, effort: 'high' as const};
const catalog: RuntimeCatalog = runtimeCatalogSchema.parse({contract: 'kapelle.runtime-catalog/v1',
  profiles: [claudeProfileFromBinding('claude-current', W4_INFERENCE, 'w4-d728d10f-20261014T010739Z/qualification')]});

// The published pilot definition (real-pilot-provisioning-20261008/definition.initial-publication.proposed.json).
const PILOT: ReleaseV1 = {definitionId: 'kapelle-task-report-pilot', packageVersion: '1.0.1', schemaVersion: 1, publisherRef: 'human:owner', licenseRef: 'license:private',
  previousVersionRef: null, title: 'Supplied-source Report preparation pilot',
  description: 'Prepare an evidence-grounded Report from one explicitly admitted retained source packet and its existing Task; no tools or external effects.',
  tags: ['pilot', 'supplied-source'], avatarRef: null,
  examples: ['Summarize a retained letter and identify missing information', 'Prepare options and next steps from an approved source packet'],
  instructionTokenCount: null, tokenizerRef: null, purpose: 'Prepare evidence-grounded Reports for owner review',
  responsibilities: ['Summarize supplied evidence', 'Show calculations and uncertainties'],
  instructions: {id: 'task-report-pilot:instructions', version: '1.0.1', contentHash: 'sha256:a35cc1cf74763486218786d8d4bfb7bcb389470777dc14a140a5803a88a16edc'},
  skills: [], capabilities: [
    {id: 'task-read', requirement: 'REQUIRED', resourceType: 'task', actions: ['read'], outputTypes: ['report']},
    {id: 'task-receive', requirement: 'REQUIRED', resourceType: 'task-delegation', actions: ['receive'], outputTypes: ['report']}],
  runtimeContracts: ['kapelle.task-delegation/v1'], modelProfiles: ['fable-reviewer-claude'], documentModels: [{documentType: 'kapelle/dispatch', version: 1}],
  migrations: [], views: [], exportRequirements: ['native-operations', 'referenced-artifacts'],
  qualificationFixtures: [{id: 'task-report-pilot:qualification', version: '1.0.1', contentHash: 'sha256:ac0b56476937a2f415efbdf34be96a70e35f8ea9d5ec870f017df3a8b7f91b38'}],
  contentHash: 'sha256:3bc5742499dfde50286b00c96e70c7020d571a9e98f5e0f99bb56ac935441db8'} as ReleaseV1;

const withPolicy = (p: Partial<LaunchPolicyV1>) => ({...EXAMPLE_ORG_POLICY, ...p});
const rehash = (r: ReleaseV2): ReleaseV2 => ({...r, contentHash: releaseHashV2(r)});

describe('launchPolicy (typed, machine-checked)', () => {
  it('accepts the Example Park policy', () => expect(launchPolicySchema.safeParse(EXAMPLE_ORG_POLICY).success).toBe(true));
  it.each([
    ['approvalMode other than EACH_TASK', {approvalMode: 'ONCE'}],
    ['effectMode other than PREPARE_ONLY', {effectMode: 'APPLY'}],
    ['a fallback', {fallback: 'claude'}],
    ['default runtime outside the allowlist', {runtime: {allow: ['claude-current'], default: 'other-profile'}}],
    ['default budget above the ceiling', {budget: {ceiling: EXAMPLE_ORG_POLICY.budget.ceiling, default: {...EXAMPLE_ORG_POLICY.budget.ceiling, maxBudgetUsd: 3}}}],
    ['an unknown source reader', {sources: [{reader: 'filesystem', project: null, selection: 'task-selected', maxItems: 1}]}],
    ['a reader-wide selection', {sources: [{reader: 'task', project: null, selection: 'search', maxItems: 1}]}],
    ['no Task source', {sources: [{reader: 'report', project: null, selection: 'task-selected', maxItems: 1}]}],
    ['duplicate readers', {sources: [{reader: 'task', project: null, selection: 'task-selected', maxItems: 1}, {reader: 'task', project: null, selection: 'task-selected', maxItems: 1}]}],
    ['more sources than the packet cap', {sources: [{reader: 'task', project: null, selection: 'task-selected', maxItems: 1}, {reader: 'report', project: null, selection: 'task-selected', maxItems: 8}]}],
    ['concurrency above 1', {budget: {ceiling: {...EXAMPLE_ORG_POLICY.budget.ceiling, concurrency: 2}, default: EXAMPLE_ORG_POLICY.budget.default}}],
    ['a non-Report output', {outputs: {types: ['email'], classification: 'project'}}],
  ])('refuses %s', (_label, patch) => expect(launchPolicySchema.safeParse(withPolicy(patch as never)).success).toBe(false));
  it('refuses unknown fields (no prose policy smuggled in)', () =>
    expect(launchPolicySchema.safeParse({...EXAMPLE_ORG_POLICY, operatingPolicy: 'may send email'}).success).toBe(false));
});

describe('runtime catalog (host-owned, hash-pinned)', () => {
  it('derives claude-current from the admitted W4 binding and resolves it with a stable hash', () => {
    const r = resolveRuntime(catalog, 'claude-current');
    expect(r.profile.runtime.model).toBe('claude-opus-5-5');
    expect(r.profile.limits).toEqual({maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000});
    expect(r.hash).toBe(profileHash(resolveRuntime(catalog, 'claude-current').profile));
  });
  it('the harness is explicit and pinned; the adapter input round-trips to the admitted W4 binding', () => {
    const p = resolveRuntime(catalog, 'claude-current').profile;
    expect(p.harness).toEqual({kind: 'claude-agent-sdk', sdkVersion: '0.2.90', cliVersion: '2.1.295'});
    expect(claudeInferenceFor(p, {maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000})).toEqual(W4_INFERENCE);
    expect(() => claudeInferenceFor(p, {maxOutputTokens: 16001, maxBudgetUsd: 2, timeoutMs: 300000})).toThrow(/budget_exceeds_runtime_limits/);
    expect(runtimeCatalogSchema.safeParse({...catalog, profiles: [{...catalog.profiles[0], harness: {kind: 'pi', version: '1'}}]}).success).toBe(false);
    expect(runtimeCatalogSchema.safeParse({...catalog, profiles: [{...catalog.profiles[0], harness: undefined}]}).success).toBe(false);
  });
  it('refuses unknown profiles, duplicate ids, browser-style extras and unsupported kinds', () => {
    expect(() => resolveRuntime(catalog, 'gpt-anything')).toThrow(/runtime_profile_unknown/);
    expect(runtimeCatalogSchema.safeParse({...catalog, profiles: [catalog.profiles[0], catalog.profiles[0]]}).success).toBe(false);
    expect(runtimeCatalogSchema.safeParse({...catalog, profiles: [{...catalog.profiles[0], endpoint: 'http://x'}]}).success).toBe(false);
    expect(runtimeCatalogSchema.safeParse({...catalog, profiles: [{...catalog.profiles[0], runtime: {...catalog.profiles[0].runtime, kind: 'local-mlx'}}]}).success).toBe(false);
  });
  it('loads only the pinned bytes', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'kit-')), 'catalog.json'), bytes = JSON.stringify(catalog);
    writeFileSync(p, bytes);
    expect(loadRuntimeCatalog(p, createHash('sha256').update(bytes).digest('hex'))).toEqual(catalog);
    expect(() => loadRuntimeCatalog(p, '0'.repeat(64))).toThrow(/runtime_catalog_changed/);
  });
  it('a policy ceiling above the profile limits is refused', () =>
    expect(policyCatalogProblems(withPolicy({budget: {ceiling: {...EXAMPLE_ORG_POLICY.budget.ceiling, timeoutMs: 600000}, default: EXAMPLE_ORG_POLICY.budget.default}}), catalog))
      .toEqual(['budget ceiling exceeds the limits of runtime profile claude-current']));
});

describe('AgentDefinition v1 -> v2 (release hash and migration)', () => {
  it.skip('the published pilot release hash is reproduced by the existing formula (regression anchor)', () =>
    expect(releaseHash(PILOT)).toBe(PILOT.contentHash));
  it.skip('an upgraded v1 release keeps its exact hash and is NOT kit-eligible', () => {
    const up = upgradeReleaseV1(PILOT);
    expect(up.launchPolicy).toBeNull();
    expect(releaseHashV2(up)).toBe(PILOT.contentHash);
    const e = kitEligibility(up, catalog);
    expect(e.eligible).toBe(false);
    expect(e.problems).toContain('release has no launch policy (not kit-eligible)');
  });
  it('a policy is inside the hash: the existing PUBLISH_DEFINITION assertion holds for v2, and any policy edit breaks it', () => {
    const r = exampleOrgRelease();
    expect(releaseHash(r as ReleaseV1)).toBe(r.contentHash);
    const edited = {...r, launchPolicy: withPolicy({budget: {ceiling: {...EXAMPLE_ORG_POLICY.budget.ceiling, maxBudgetUsd: 1}, default: {...EXAMPLE_ORG_POLICY.budget.default, maxBudgetUsd: 1}}})};
    expect(releaseHashV2(edited)).not.toBe(r.contentHash);
    expect(kitEligibility(edited, catalog).problems).toContain('release content hash does not match the release');
  });
  it('adding a policy to the old pilot release changes its identity (an old release is never silently re-qualified)', () =>
    expect(releaseHashV2({...upgradeReleaseV1(PILOT), launchPolicy: EXAMPLE_ORG_POLICY})).not.toBe(PILOT.contentHash));
});

describe('kit eligibility (deterministic, no PASS files)', () => {
  it('the Example Park template is eligible against the host catalog', () =>
    expect(kitEligibility(exampleOrgRelease(), catalog)).toEqual({eligible: true, problems: []}));
  it.each([
    ['REQUIRED (not optional at idle) Task capabilities', (r: ReleaseV2) => ({...r, capabilities: r.capabilities.map(c => ({...c, requirement: 'REQUIRED' as const}))}), /must be declared once, OPTIONAL/],
    ['an extra capability', (r: ReleaseV2) => ({...r, capabilities: [...r.capabilities, {id: 'mail', requirement: 'OPTIONAL' as const, resourceType: 'email', actions: ['send'], outputTypes: ['report']}]}), /outside the kit: email/],
    ['a non-Report output type', (r: ReleaseV2) => ({...r, capabilities: r.capabilities.map(c => ({...c, outputTypes: ['email']}))}), /Reports only/],
    ['a policy runtime not declared in modelProfiles', (r: ReleaseV2) => ({...r, modelProfiles: ['fable-reviewer-claude']}), /not declared in modelProfiles/],
    ['no Task-delegation runtime contract', (r: ReleaseV2) => ({...r, runtimeContracts: []}), /runtime contract/],
  ])('refuses %s', (_l, mutate, msg) => {
    const e = kitEligibility(rehash(mutate(exampleOrgRelease())), catalog);
    expect(e.eligible).toBe(false);expect(e.problems.join('\n')).toMatch(msg);
  });
  it('a runtime missing from the host catalog makes the template unavailable, never substituted', () => {
    const empty = runtimeCatalogSchema.parse({contract: 'kapelle.runtime-catalog/v1', profiles: [claudeProfileFromBinding('other-profile', W4_INFERENCE, 'x')]});
    expect(kitEligibility(exampleOrgRelease(), empty).problems).toContain('runtime profile claude-current is not in the host catalog');
  });
});

describe('Example Park launch manifest (what "Create agent" approves)', () => {
  const base = {operationId: randomUUID(), ownerId: 'human:owner', scopeRef: 'kapelle', catalog};
  it('binds the definition hash, resolved runtime profile hash, budget and prepare-only; the name is the only customization', () => {
    const {manifest, manifestHash, release} = exampleOrgManifest({...base, name: '  Example Park  '});
    expect(manifest.name).toBe('Example Park');
    expect(manifest.definitionRef).toEqual({id: 'example-org-preparer', version: '1.0.0', contentHash: release.contentHash});
    expect(manifest.runtime).toEqual({id: 'claude-current', profileHash: resolveRuntime(catalog, 'claude-current').hash});
    expect(manifest.budget).toEqual(EXAMPLE_ORG_POLICY.budget.default);
    expect(manifest.effectMode).toBe('PREPARE_ONLY');
    expect(exampleOrgManifest({...base, name: 'Example Park'}).manifestHash).toBe(manifestHash);
    expect(exampleOrgManifest({...base, name: 'CP helper'}).manifestHash).not.toBe(manifestHash);
  });
  it('a changed runtime profile changes the approval hash (a catalog edit is not silently inherited)', () => {
    const other = runtimeCatalogSchema.parse({contract: 'kapelle.runtime-catalog/v1', profiles: [claudeProfileFromBinding('claude-current', {...W4_INFERENCE, cliVersion: '2.1.296'}, 'x')]});
    expect(exampleOrgManifest({...base, name: 'Example Park', catalog: other}).manifestHash).not.toBe(exampleOrgManifest({...base, name: 'Example Park'}).manifestHash);
  });
  it.each(['', '   ', 'x'.repeat(61), 'bad\u0000name', 'line\nbreak', 'rtl‮override'])('refuses the name %j', n =>
    expect(agentNameSchema.safeParse(n).success).toBe(false));
  it('refuses to build a manifest when the template is not eligible on this host', () =>
    expect(() => exampleOrgManifest({...base, name: 'Example Park', catalog: runtimeCatalogSchema.parse({contract: 'kapelle.runtime-catalog/v1', profiles: [claudeProfileFromBinding('other-profile', W4_INFERENCE, 'x')]})}))
      .toThrow(/template_not_kit_eligible/));
});
