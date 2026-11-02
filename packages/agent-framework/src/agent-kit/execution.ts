// Agent launch kit, slice 4b (pure parts): the content-addressed packet store and the per-run worker binding derived from
// native state. No per-agent profile, launcher or eligibility file. See KIT-4B-DESIGN.md (K1: one worker per approved run).
import {mkdirSync, openSync, writeSync, closeSync, readFileSync, renameSync, existsSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest} from '../content.js';
import {assert} from '../validation.js';
import {packetSchema, taskWorkerBindingSchema, type TaskSourcePacket, type TaskWorkerBinding} from '../task-delegation/worker-contract.js';
import {pinSchema, capabilityHashOf, type PlanSource} from '../task-delegation/contract.js';
import type {AgentInstanceState} from '../../document-models/agent-instance/v1/index.js';
import {launchPolicySchema} from './launch-policy.js';
import {resolveRuntime, inferenceFor, type RuntimeCatalog} from './runtime-catalog.js';
import {kitRuntimeBindingRef, kitBudgetPolicyRef} from './host-facts.js';
import type {ReleaseV2} from './definition-v2.js';
import {manifestSchema, type SourceManifest} from './scope-assembler.js';

/** Packets admitted by the host's source assembler, keyed by their digest. Owner-only directory; create-only files. */
export class KitPacketStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const s = lstatSync(dir);
    assert(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0, 'kit_packet_store_not_private');
  }
  private path(hash: string) { assert(/^sha256:[a-f0-9]{64}$/.test(hash), 'kit_packet_hash_invalid'); return join(this.dir, hash.slice(7) + '.json'); }
  /** Admit a packet (idempotent). Returns its hash, which the Task notes carry. */
  admit(packet: TaskSourcePacket): string {
    const p = packetSchema.parse(packet), hash = digest(p), file = this.path(hash);
    if (existsSync(file)) { assert(digest(packetSchema.parse(JSON.parse(readFileSync(file, 'utf8')))) === hash, 'kit_packet_store_corrupt'); return hash; }
    const tmp = file + '.' + randomUUID() + '.tmp', fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify(p)); } finally { closeSync(fd); }
    renameSync(tmp, file);
    return hash;
  }
  /** Load by hash; re-verifies schema, size caps and digest every time. */
  load(hash: string): TaskSourcePacket {
    const file = this.path(hash);
    assert(existsSync(file), 'task_packet_not_admitted');
    const s = lstatSync(file);
    assert(s.isFile() && !s.isSymbolicLink() && (s.mode & 0o077) === 0 && s.size <= 131072, 'kit_packet_file_invalid');
    const p = packetSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    assert(digest(p) === hash, 'task_packet_changed');
    return p;
  }
}

/** AGENT-MODEL-V2: frozen source manifests, keyed by their digest (the value bound into the plan). Owner-only, create-only. */
export class KitManifestStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const s = lstatSync(dir);
    assert(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0, 'kit_manifest_store_not_private');
  }
  private path(hash: string) { assert(/^sha256:[a-f0-9]{64}$/.test(hash), 'kit_manifest_hash_invalid'); return join(this.dir, hash.slice(7) + '.json'); }
  put(manifest: SourceManifest): string {
    const m = manifestSchema.parse(manifest), hash = digest(m), file = this.path(hash);
    if (existsSync(file)) { assert(digest(manifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')))) === hash, 'kit_manifest_store_corrupt'); return hash; }
    const tmp = file + '.' + randomUUID() + '.tmp', fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify(m)); } finally { closeSync(fd); }
    renameSync(tmp, file);
    return hash;
  }
  get(hash: string): SourceManifest {
    const file = this.path(hash);
    assert(existsSync(file), 'kit_manifest_not_found');
    const m = manifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    assert(digest(m) === hash, 'kit_manifest_changed');
    return m;
  }
}

/** The immutable binding for ONE approved kit run (K1), derived from native state: the instance, its kit definition, the
 *  approved recipient pin (from the Dispatch envelope) and the host catalog. Refuses anything that differs from approval. */
/** requireReady (default true) is for a CLAIM; status/reconcile of an existing run derive the same binding without it. */
export function kitRunBinding(o: {instance: AgentInstanceState; release: ReleaseV2; catalog: RuntimeCatalog; taskId: string; permissionRef: string; approvedPin: unknown; taskSourceOwnerId?: string; requireReady?: boolean; source?: PlanSource}): TaskWorkerBinding {
  const i = o.instance, pin = pinSchema.parse(o.approvedPin);
  assert(i.instanceId && i.ownerId && i.scopeRef && i.runtimeBindingRef && i.definitionRef && i.modelPolicy, 'kit_instance_incomplete');
  if (o.requireReady !== false) assert(i.desiredState === 'READY', 'kit_instance_not_ready');
  assert(o.release.launchPolicy !== null && o.release.contentHash === i.definitionRef!.contentHash, 'kit_definition_differs');
  const policy = launchPolicySchema.parse(o.release.launchPolicy);
  const profileId = i.modelPolicy!.preferredProfile;
  assert(policy.runtime.allow.includes(profileId), 'kit_runtime_not_allowed');
  const {profile, hash} = resolveRuntime(o.catalog, profileId);
  assert(i.runtimeBindingRef === kitRuntimeBindingRef(profile.id, hash), 'kit_runtime_binding_changed');
  assert(pin.instanceId === i.instanceId && pin.definitionHash === i.definitionRef!.contentHash && pin.runtimeBindingRef === i.runtimeBindingRef, 'kit_pin_differs');
  // F-K1-2: the run's budget is the APPROVED one (the creation's budget ref), never a silent fallback to a default.
  const b = policy.budget.default;
  assert(kitBudgetPolicyRef({definitionRef: i.definitionRef!, budget: b}) === i.modelPolicy!.budgetPolicyRef, 'kit_budget_differs_from_approval');
  // F-K1-1: DERIVE the capability hash from live native state (same formula as qualifiedRecipient), then ASSERT it equals the
  // approved pin, so the worker's own pin check (worker.ts:136) still verifies something.
  // Private outputs never go to a remote model provider: an owner-private policy runs only on a local-only runtime.
  const privateOutputs = policy.outputs.classification === 'owner-private';
  assert(!privateOutputs || profile.runtime.locality === 'local-only', 'kit_private_requires_local_runtime');
  const capabilityHash = capabilityHashOf({ref: i.definitionRef, runtimeBindingRef: i.runtimeBindingRef, capabilities: o.release.capabilities,
    grants: i.grants.filter(g => [o.taskId, o.permissionRef].includes(g.resourceRef)), modelPolicy: i.modelPolicy, source: o.source});
  assert(capabilityHash === pin.capabilityHash, 'kit_pin_differs');
  return taskWorkerBindingSchema.parse({
    ownerId: i.ownerId, scopeRef: i.scopeRef, instanceId: i.instanceId, runtimeBindingRef: i.runtimeBindingRef,
    definitionHash: i.definitionRef!.contentHash, capabilityHash,
    modelProfile: profileId, budgetPolicyRef: i.modelPolicy!.budgetPolicyRef,
    taskCapabilityHashes: {[o.taskId]: capabilityHash},
    ...(o.taskSourceOwnerId ? {taskSourceOwnerId: o.taskSourceOwnerId} : {}),
    ...(privateOutputs ? {outputClassification: 'owner-private' as const} : {}),
    inference: inferenceFor(profile, {maxOutputTokens: b.maxOutputTokens, maxBudgetUsd: b.maxBudgetUsd, timeoutMs: b.timeoutMs}),
  });
}
