// Agent launch kit, slice 4b (pure parts): the content-addressed packet store and the per-run binding from native state.
import {it, expect, describe, beforeEach} from 'vitest';
import {mkdtempSync, chmodSync, writeFileSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {digest, type ResourceFact} from '../src/command-boundary.js';
import {taskCapabilityHash, packetSchema} from '../src/task-delegation/worker-contract.js';
import {CreationLedger, approveCreation, provision} from '../src/agent-kit/create-agent.js';
import {exampleOrgManifest} from '../src/agent-kit/templates/example-org.js';
import {taskGrantPlan, plannedRecipient, materializeGrantPlan} from '../src/agent-kit/grant-plan.js';
import {qualifiedRecipient} from '../src/task-delegation/contract.js';
import {KitPacketStore, kitRunBinding} from '../src/agent-kit/execution.js';
import {FakeAuthority, catalogOf, OWNER, SCOPE} from './agent-kit-double.js';
import type {ReleaseV2} from '../src/agent-kit/definition-v2.js';

const packet = () => packetSchema.parse({contract: 'kapelle.task-source-packet/v1', sources: [{
  document: {id: 'c9202605-dc37-5686-bbd6-085b118ffaad', version: 1, hash: createHash('sha256').update('block partyIVAL (synthetic)').digest('hex'), title: 'DERIVED: synthetic flyer transcription', project: 'example-org', mimeType: 'text/markdown', content: 'block partyIVAL (synthetic)'},
  reference: 'kapelle:synthetic:flyer', capturedAt: '2026-10-13T17:14:59.000Z'}]});

describe('kit packet store (content-addressed, host-admitted)', () => {
  const store = () => new KitPacketStore(join(mkdtempSync(join(tmpdir(), 'kit-packets-')), 'packets'));
  it('admits idempotently by digest and loads the exact packet', () => {
    const s = store(), p = packet(), h = s.admit(p);
    expect(h).toBe(digest(p));
    expect(s.admit(p)).toBe(h);
    expect(s.load(h)).toEqual(p);
  });
  it('refuses an unknown hash, a tampered file, a non-private file and a malformed hash', () => {
    const s = store(), h = s.admit(packet()), file = join(s.dir, h.slice(7) + '.json');
    expect(() => s.load('sha256:' + 'b'.repeat(64))).toThrow(/task_packet_not_admitted/);
    expect(() => s.load('../x')).toThrow(/kit_packet_hash_invalid/);
    writeFileSync(file, JSON.stringify({...packet(), sources: [{...packet().sources[0], reference: 'kapelle:changed'}]}), {mode: 0o600});
    expect(() => s.load(h)).toThrow(/task_packet_changed/);
    chmodSync(file, 0o644);
    expect(() => s.load(h)).toThrow(/kit_packet_file_invalid/);
  });
  it('refuses a store directory others can read', () => {
    const d = join(mkdtempSync(join(tmpdir(), 'kit-packets-')), 'open'); mkdirSync(d, {mode: 0o755}); chmodSync(d, 0o755);
    expect(() => new KitPacketStore(d)).toThrow(/kit_packet_store_not_private/);
  });
});

const PERMISSION = 'task-delegation:human:owner:kit:v1', TASK = 'task-block-party-volunteers';
let port: FakeAuthority, instanceId: string, release: ReleaseV2;
const state = () => port.docs.get(instanceId)!.state.global as any;
const ctx = () => port.ctxFor(port.docs.get(instanceId)! as never);
beforeEach(async () => {
  const ledger = new CreationLedger(join(mkdtempSync(join(tmpdir(), 'kit-exec-')), 'creations'));
  port = new FakeAuthority(catalogOf(), ledger);
  const operationId = randomUUID();
  const m = exampleOrgManifest({operationId, ownerId: OWNER, scopeRef: SCOPE, name: 'Example Park', catalog: port.catalog});
  release = m.release;
  approveCreation(ledger, {manifest: m.manifest, manifestHash: m.manifestHash, principalId: OWNER, occurredAt: '2026-10-15T00:00:00.000Z'});
  port.approvedManifests.push(m.manifest as never);
  instanceId = (await provision(port, ledger, operationId, release)).instanceId;
  port.resources = [{id: PERMISSION, resourceType: 'task-delegation', revision: 1, contentHash: digest('permission'), allowedActions: ['receive', 'dispatch']} as ResourceFact];
  port.admittedTaskReads = [{instanceId, resource: {id: TASK, resourceType: 'task', revision: 3, contentHash: digest('task'), allowedActions: ['read']}}];
});
async function approvedRun() {
  const plan = taskGrantPlan({instanceId, taskId: TASK, permissionRef: PERMISSION, operationId: randomUUID(), expiresAt: '2026-10-16T00:00:00.000Z'});
  const pin = plannedRecipient(state(), ctx(), TASK, PERMISSION, plan);
  await materializeGrantPlan(port, {instanceId, plan, approvedPin: pin, livePin: async () => qualifiedRecipient(state(), ctx(), TASK, PERMISSION)});
  return pin;
}

describe('per-run binding from native state (K1)', () => {
  it('derives a binding that passes the worker\'s own recipient-pin check, with the catalog harness and the approved budget', async () => {
    const pin = await approvedRun();
    const b = kitRunBinding({instance: state(), release, catalog: port.catalog, taskId: TASK, permissionRef: PERMISSION, approvedPin: pin});
    expect(taskCapabilityHash(b, TASK)).toBe(pin.capabilityHash); // == worker.ts:136
    expect(b).toMatchObject({instanceId, runtimeBindingRef: pin.runtimeBindingRef, definitionHash: pin.definitionHash, modelProfile: 'claude-current'});
    expect(b.inference).toMatchObject({runtime: 'claude-agent-sdk', sdkVersion: '0.2.90', cliVersion: '2.1.295', maxOutputTokens: 8000, maxBudgetUsd: 2, timeoutMs: 300000});
    expect(() => taskCapabilityHash(b, 'another-task')).toThrow(/not_admitted/);
  });
  it('an owner-private launch policy never runs on a remote provider: refused on the Claude profile; project policies carry no classification', async () => {
    const pin = await approvedRun();
    const lp = release.launchPolicy as any, priv = {...release, launchPolicy: {...lp, outputs: {...lp.outputs, classification: 'owner-private'}}} as ReleaseV2;
    expect(() => kitRunBinding({instance: state(), release: priv, catalog: port.catalog, taskId: TASK, permissionRef: PERMISSION, approvedPin: pin})).toThrow(/kit_private_requires_local_runtime/);
    expect(kitRunBinding({instance: state(), release, catalog: port.catalog, taskId: TASK, permissionRef: PERMISSION, approvedPin: pin}).outputClassification).toBeUndefined();
  });
  it('refuses when the agent is paused, the catalog changed, or the pin names another instance/definition', async () => {
    const pin = await approvedRun();
    expect(() => kitRunBinding({instance: {...state(), desiredState: 'PAUSED'}, release, catalog: port.catalog, taskId: TASK, permissionRef: PERMISSION, approvedPin: pin})).toThrow(/kit_instance_not_ready/);
    expect(() => kitRunBinding({instance: state(), release, catalog: catalogOf('2.1.296'), taskId: TASK, permissionRef: PERMISSION, approvedPin: pin})).toThrow(/kit_runtime_binding_changed/);
    expect(() => kitRunBinding({instance: state(), release, catalog: port.catalog, taskId: TASK, permissionRef: PERMISSION, approvedPin: {...pin, instanceId: 'other'}})).toThrow(/kit_pin_differs/);
    expect(() => kitRunBinding({instance: state(), release: {...release, launchPolicy: null}, catalog: port.catalog, taskId: TASK, permissionRef: PERMISSION, approvedPin: pin})).toThrow(/kit_definition_differs/);
  });
  it('F-K1-1: a pin whose capability hash differs from live native state is refused (the hash is derived, never copied)', async () => {
    const pin = await approvedRun();
    expect(() => kitRunBinding({instance: state(), release, catalog: port.catalog, taskId: TASK, permissionRef: PERMISSION, approvedPin: {...pin, capabilityHash: 'f'.repeat(64)}})).toThrow(/kit_pin_differs/);
    // A grant removed after approval also changes the live hash: refused.
    expect(() => kitRunBinding({instance: {...state(), grants: state().grants.slice(0, 1)}, release, catalog: port.catalog, taskId: TASK, permissionRef: PERMISSION, approvedPin: pin})).toThrow(/kit_pin_differs/);
  });
  it('F-K1-2: an instance whose budget ref does not match the approved budget is refused', async () => {
    const pin = await approvedRun();
    expect(() => kitRunBinding({instance: {...state(), modelPolicy: {...state().modelPolicy, budgetPolicyRef: 'budget:kit:other'}}, release, catalog: port.catalog, taskId: TASK, permissionRef: PERMISSION, approvedPin: pin})).toThrow(/kit_budget_differs_from_approval/);
  });
});
