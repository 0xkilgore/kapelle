// Agent launch kit, slice 3: one "Create agent" approval + durable provisioning, through the REAL command boundary and native
// reducers (prepareCommand/applyNative). The fake authority adds only what FrameworkAuthority provides: allocation reserved by
// operation id, a per-operation journal (same request -> same result, different request -> refused) and fault injection.
import {it, expect, describe, beforeEach} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from '../src/command-boundary.js';
import {FakeAuthority, catalogOf, OWNER, SCOPE} from './agent-kit-double.js';
import {CreationLedger, approveCreation, provision, stepOperationId} from '../src/agent-kit/create-agent.js';
import {kitHostFacts, kitRuntimeBindingRef, agentAvailability} from '../src/agent-kit/host-facts.js';
import {releaseOfDocument} from '../src/agent-kit/definition-v2.js';
import {exampleOrgManifest, exampleOrgRelease} from '../src/agent-kit/templates/example-org.js';
import {type RuntimeCatalog} from '../src/agent-kit/runtime-catalog.js';


let ledger: CreationLedger, catalog: RuntimeCatalog, port: FakeAuthority;
const setup = (name = 'Example Park') => {
  const operationId = randomUUID();
  const {manifest, manifestHash, release} = exampleOrgManifest({operationId, ownerId: OWNER, scopeRef: SCOPE, name, catalog});
  approveCreation(ledger, {manifest, manifestHash, principalId: OWNER, occurredAt: '2026-10-15T00:00:00.000Z'});
  port.approvedManifests.push(manifest as never);
  return {operationId, manifest, manifestHash, release};
};
beforeEach(() => {
  ledger = new CreationLedger(join(mkdtempSync(join(tmpdir(), 'kit-ledger-')), 'creations'));
  catalog = catalogOf(); port = new FakeAuthority(catalog, ledger);
});

describe('Create agent: one approval, then automatic provisioning', () => {
  it('provisions a READY Example Park agent from the approved manifest, with no Task grant and no inference', async () => {
    const {operationId, manifest, release} = setup();
    const r = await provision(port, ledger, operationId, release);
    const def = port.docs.get(r.definitionId)!, inst = port.docs.get(r.instanceId)!.state.global as any;
    expect(def.state.document.version).toBe(2);
    expect(releaseOfDocument(def as never)).toEqual(exampleOrgRelease());
    expect(inst).toMatchObject({desiredState: 'READY', name: 'Example Park', definitionRef: manifest.definitionRef,
      runtimeBindingRef: kitRuntimeBindingRef('claude-current', manifest.runtime.profileHash)});
    expect(inst.modelPolicy).toMatchObject({preferredProfile: 'claude-current', concurrencyLimit: 1, paidFallback: false});
    expect(inst.grants).toEqual([]); // Task capabilities are OPTIONAL at idle: READY without any standing Task access
    expect(port.calls.filter(c => c.startsWith('command:'))).toEqual(['command:PUBLISH_DEFINITION', 'command:CREATE_INSTANCE', 'command:SET_RUNTIME_BINDING', 'command:REQUEST_RESUME']);
    expect(ledger.get(operationId)).toMatchObject({definitionId: r.definitionId, instanceId: r.instanceId});
    expect(ledger.get(operationId)!.readyAt).not.toBeNull();
  });
  it('the approval binds the exact manifest: hash mismatch, a non-owner approver and a reused operation id are refused', () => {
    const {operationId, manifest, manifestHash} = setup();
    expect(() => approveCreation(ledger, {manifest, manifestHash: digest('other'), principalId: OWNER, occurredAt: '2026-10-15T00:00:00.000Z'})).toThrow(/manifest_hash_mismatch/);
    expect(() => approveCreation(ledger, {manifest, manifestHash, principalId: 'agent:x', occurredAt: '2026-10-15T00:00:00.000Z'})).toThrow(/not_the_owner/);
    const other = exampleOrgManifest({operationId, ownerId: OWNER, scopeRef: SCOPE, name: 'Other name', catalog});
    expect(() => approveCreation(ledger, {...other, principalId: OWNER, occurredAt: '2026-10-15T00:00:00.000Z'})).toThrow(/reused_for_another_manifest/);
    expect(approveCreation(ledger, {manifest, manifestHash, principalId: OWNER, occurredAt: '2026-10-15T00:00:09.000Z'}).approvedAt).toBe('2026-10-15T00:00:00.000Z');
  });
  it('nothing is provisioned without an approval, or for a release other than the approved one', async () => {
    await expect(provision(port, ledger, randomUUID(), exampleOrgRelease())).rejects.toThrow(/creation_not_approved/);
    const {operationId, release} = setup();
    await expect(provision(port, ledger, operationId, {...release, title: 'changed'})).rejects.toThrow(/release_differs/);
    expect(port.docs.size).toBe(0);
  });
});

const STEPS = ['allocate', 'PUBLISH_DEFINITION', 'CREATE_INSTANCE', 'SET_RUNTIME_BINDING', 'REQUEST_RESUME'];
describe('recovery: crash or lost reply at every step resumes the SAME agent (no second definition or instance)', () => {
  it.each(STEPS.flatMap(call => (['before', 'after'] as const).map(when => [when, call] as const)))('%s %s', async (when, call) => {
    const {operationId, release} = setup();
    port.faults.push({when, call, times: 1});
    await expect(provision(port, ledger, operationId, release)).rejects.toThrow(/injected/);
    const r = await provision(port, ledger, operationId, release);
    expect(port.count('kapelle/agent-definition')).toBe(1);
    expect(port.count('kapelle/agent-instance')).toBe(1);
    expect((port.docs.get(r.instanceId)!.state.global as any).desiredState).toBe('READY');
    expect(port.calls.filter(c => c === 'command:REQUEST_RESUME').length).toBeLessThanOrEqual(2); // a lost-reply replay hits the journal
  });
  it('a crash after the ledger lost the instance id still resolves the same reservation', async () => {
    const {operationId, release} = setup();
    port.faults.push({when: 'before', call: 'CREATE_INSTANCE', times: 1});
    await expect(provision(port, ledger, operationId, release)).rejects.toThrow();
    const rec = ledger.get(operationId)!; ledger.put({...rec, instanceId: null}); // simulate the save never landing
    const r = await provision(port, ledger, operationId, release);
    expect(port.count('kapelle/agent-instance')).toBe(1);
    expect(r.instanceId).toBe(port.reservations.get(stepOperationId(operationId, 'instance-allocate')));
  });
  it('duplicate clicks (two concurrent runs) create one agent', async () => {
    const {operationId, release} = setup();
    const [a, b] = await Promise.allSettled([provision(port, ledger, operationId, release), provision(port, ledger, operationId, release)]);
    const r = await provision(port, ledger, operationId, release);
    expect(port.count('kapelle/agent-definition')).toBe(1);
    expect(port.count('kapelle/agent-instance')).toBe(1);
    for (const x of [a, b]) if (x.status === 'fulfilled') expect(x.value.instanceId).toBe(r.instanceId);
  });
  it('after READY, an owner pause is respected: provisioning again never resumes the agent', async () => {
    const {operationId, release} = setup();
    const r = await provision(port, ledger, operationId, release);
    const cur = port.docs.get(r.instanceId)!.state.global;
    await port.command({operationId: randomUUID(), documentId: r.instanceId, documentType: 'kapelle/agent-instance', expectedRevision: cur.revision, type: 'REQUEST_PAUSE', input: {}});
    await provision(port, ledger, operationId, release);
    expect((port.docs.get(r.instanceId)!.state.global as any).desiredState).toBe('PAUSED');
  });
});

describe('host facts: what qualifies, and what a catalog change does', () => {
  it('a runtime profile change after approval is a new binding: the approved (old) binding is refused, nothing substituted', async () => {
    const {operationId, release} = setup();
    port.catalog = catalogOf('2.1.296'); // host catalog changed after the owner approved
    await expect(provision(port, ledger, operationId, release)).rejects.toThrow(/Runtime binding not authorized/);
    const inst = [...port.docs.values()].find(d => d.header.documentType === 'kapelle/agent-instance')!.state.global as any;
    expect(inst.desiredState).toBe('PAUSED');expect(inst.runtimeBindingRef).toBeNull();
  });
  it('v1 definitions are never qualified by the kit; the kit release is', () => {
    const f = kitHostFacts([exampleOrgRelease(), {...exampleOrgRelease(), launchPolicy: null}], catalog, []);
    expect(f.definitions.map(d => d.qualified)).toEqual([true, false]);
    expect(f.runtimeBindingContracts).toEqual({[f.runtimeBindingRefs[0]]: 'kapelle.task-delegation/v1'});
  });
});

describe('availability (derived from native state + host facts, never stored)', () => {
  it('finishing setup -> available -> paused; a catalog change shows runtime unavailable, not paused or substituted', async () => {
    const {operationId, release} = setup();
    port.faults.push({when: 'before', call: 'SET_RUNTIME_BINDING', times: 1});
    await expect(provision(port, ledger, operationId, release)).rejects.toThrow();
    const facts = () => kitHostFacts([exampleOrgRelease()], port.catalog, port.approvedManifests);
    const inst = () => [...port.docs.values()].find(d => d.header.documentType === 'kapelle/agent-instance')!.state.global as any;
    expect(agentAvailability(inst(), facts())).toBe('finishing-setup');
    const r = await provision(port, ledger, operationId, release);
    expect(agentAvailability(inst(), facts())).toBe('available');
    await port.command({operationId: randomUUID(), documentId: r.instanceId, documentType: 'kapelle/agent-instance', expectedRevision: inst().revision, type: 'REQUEST_PAUSE', input: {}});
    expect(agentAvailability(inst(), facts())).toBe('paused');
    port.catalog = catalogOf('2.1.296');
    expect(agentAvailability(inst(), facts())).toBe('runtime-unavailable');
    expect(agentAvailability(inst(), kitHostFacts([{...exampleOrgRelease(), launchPolicy: null}], catalog, []))).toBe('definition-not-qualified');
  });
});
