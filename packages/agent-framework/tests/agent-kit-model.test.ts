// Agent launch kit, slice 2: the native AgentDefinition v2 model through the real command boundary (prepare + apply).
import {it, expect, describe} from 'vitest';
import * as D2 from '../document-models/agent-definition/v2/index.js';
import {canonical, releaseHash, nativeModel, type TrustedContext} from '../src/command-boundary.js';
import {apply, context, release as v1Fixture, D} from './fixtures.js';
import {exampleOrgRelease, EXAMPLE_ORG_POLICY} from '../src/agent-kit/templates/example-org.js';
import {releaseOfDocument, kitDefinitionProof, releaseHashV2, kitEligibility, type ReleaseV1} from '../src/agent-kit/definition-v2.js';
import {runtimeCatalogSchema, claudeProfileFromBinding} from '../src/agent-kit/runtime-catalog.js';

const W4 = {model: 'claude-opus-5-5', credentialTeamId: '00000000-0000-4000-8000-0000000000aa', credentialKind: 'claude-code-oauth' as const, runtime: 'claude-agent-sdk' as const,
  sdkVersion: '0.2.90', cliVersion: '2.1.295', maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: 'isolated' as const, thinking: 'adaptive' as const, effort: 'high' as const};
const catalog = runtimeCatalogSchema.parse({contract: 'kapelle.runtime-catalog/v1', profiles: [claudeProfileFromBinding('claude-current', W4, 'x')]});
const ctx = (): TrustedContext => ({...context(), principalId: 'human:owner', ownerId: 'human:owner'});
const parts = () => { const {launchPolicy, ...rel} = exampleOrgRelease(); return {rel: rel as ReleaseV1, launchPolicyJson: canonical(launchPolicy)}; };
const publish = (input: Record<string, unknown>) => apply(D2.utils.createDocument() as never, 'PUBLISH_DEFINITION', input, ctx()) as unknown as D2.AgentDefinitionDocument;

describe('AgentDefinition v2 (authored extension, fresh allocations only)', () => {
  it('is registered as version 2 next to the unchanged v1', () => {
    expect(nativeModel('kapelle/agent-definition', 2).version).toBe(2);
    expect(nativeModel('kapelle/agent-definition', 1).version).toBe(1);
    expect(D2.utils.createDocument().state.document.version).toBe(2);
    expect(D2.utils.createDocument().state.global.launchPolicyJson).toBeNull();
  });
  it('publishes the Example Park release with its launch policy; the stored release round-trips to the template', () => {
    const {rel, launchPolicyJson} = parts();
    const d = publish({release: rel, launchPolicyJson});
    expect(d.state.global.launchPolicyJson).toBe(launchPolicyJson);
    expect(d.state.global.release?.contentHash).toBe(exampleOrgRelease().contentHash);
    const back = releaseOfDocument(d)!;
    expect(back).toEqual(exampleOrgRelease());
    expect(kitEligibility(back, catalog)).toEqual({eligible: true, problems: []});
  });
  it('the release hash covers the policy: a different policy under the same contentHash is refused', () => {
    const {rel} = parts();
    const other = canonical({...EXAMPLE_ORG_POLICY, budget: {ceiling: {...EXAMPLE_ORG_POLICY.budget.ceiling, maxBudgetUsd: 1}, default: {...EXAMPLE_ORG_POLICY.budget.default, maxBudgetUsd: 1}}});
    expect(() => publish({release: rel, launchPolicyJson: other})).toThrow(/hash mismatch/);
  });
  it.each([
    ['an invalid policy (fallback)', () => canonical({...EXAMPLE_ORG_POLICY, fallback: 'claude'})],
    ['non-canonical policy JSON', () => JSON.stringify(EXAMPLE_ORG_POLICY, null, 1)],
    ['non-JSON policy text', () => 'not json'],
  ])('refuses %s', (_l, policy) => { const {rel} = parts(); expect(() => publish({release: rel, launchPolicyJson: policy()})).toThrow(); });
  it('requires the policy and refuses unknown fields', () => {
    const {rel, launchPolicyJson} = parts();
    expect(() => publish({release: rel})).toThrow();
    expect(() => publish({release: rel, launchPolicyJson, operatingPolicy: 'x'})).toThrow(/Unknown or unsupported input field|unrecognized_keys/);
  });
  it('keeps the unchanged v1 release validation (publisher = owner, once only, qualification fixture required)', () => {
    const {rel, launchPolicyJson} = parts();
    const d = publish({release: rel, launchPolicyJson});
    expect(() => apply(d as never, 'PUBLISH_DEFINITION', {release: rel, launchPolicyJson}, ctx())).toThrow(/initialized/);
    expect(() => apply(D2.utils.createDocument() as never, 'PUBLISH_DEFINITION', {release: rel, launchPolicyJson}, context())).toThrow(/Publisher must match/);
    const noFixture = {...exampleOrgRelease(), qualificationFixtures: []};
    const {launchPolicy: _p, ...nf} = {...noFixture, contentHash: releaseHashV2(noFixture)};
    expect(() => publish({release: nf, launchPolicyJson})).toThrow(/Qualification fixture required/);
  });
  it('v1 documents are untouched: a v1 publish works as before and refuses a launch policy field', () => {
    const r = v1Fixture();
    const d = apply(D.utils.createDocument(), 'PUBLISH_DEFINITION', {release: r}, context());
    expect(d.state.document.version).toBe(1);
    expect(releaseOfDocument(d as never)!.launchPolicy).toBeNull();
    expect(kitEligibility(releaseOfDocument(d as never)!, catalog).eligible).toBe(false);
    expect(() => apply(D.utils.createDocument(), 'PUBLISH_DEFINITION', {release: r, launchPolicyJson: canonical(EXAMPLE_ORG_POLICY)}, context())).toThrow(/Unknown or unsupported input field/);
  });
});

describe('kit definition proof (what the host hands to command-boundary)', () => {
  it('a published v2 definition yields a qualified proof whose release hash matches the stored contentHash', () => {
    const {rel, launchPolicyJson} = parts();
    const proof = kitDefinitionProof(releaseOfDocument(publish({release: rel, launchPolicyJson}))!, catalog);
    expect(proof.qualified).toBe(true);
    expect(releaseHash(proof.release)).toBe(rel.contentHash); // exactly command-boundary's qualified() assertion
  });
  it('a v1 release yields an unqualified proof (never re-qualified by the kit) with its old hash intact', () => {
    const r = v1Fixture();
    const proof = kitDefinitionProof({...r, launchPolicy: null}, catalog);
    expect(proof.qualified).toBe(false);
    expect(releaseHash(proof.release)).toBe(r.contentHash);
  });
});
