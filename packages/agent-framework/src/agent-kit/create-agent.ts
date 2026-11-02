// Agent launch kit, slice 3: ONE owner approval ("Create agent") and durable, automatic provisioning (AGENT-LAUNCH-KIT §3).
// The approval binds the exact launch manifest hash and is persisted BEFORE any native allocation. Provisioning is a fixed
// sequence of native steps with operation ids derived from the approved operation id, so every step is replay-safe through
// the authority's own journal (same operation id + same request = same result; different request = refused). An allocation
// whose outcome is unknown is resolved by the backend's reservation for the same operation id, never re-allocated.
// Creating an agent authorizes no inference and no standing Task access (Task capabilities are OPTIONAL at idle).
import {mkdirSync, openSync, writeSync, closeSync, readFileSync, renameSync, existsSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {canonical, digest} from '../content.js';
import {assert} from '../validation.js';
import type {ModelType} from '../command-boundary.js';
import {anyLaunchManifestSchema, type AnyLaunchManifest} from './templates/generic.js';
import {releaseHashV2, type ReleaseV2} from './definition-v2.js';
import {kitRuntimeBindingRef, kitBudgetPolicyRef} from './host-facts.js';

/** The narrow authority surface provisioning needs; FrameworkAuthority implements it. */
export interface ProvisionPort {
  allocate(operationId: string, type: ModelType, name: string, modelVersion?: number): Promise<string>;
  read(id: string, type: ModelType): Promise<{state: {document: {version: number}; global: Record<string, any>}}>;
  command(raw: unknown): Promise<unknown>;
}

const approvalSchema = z.object({
  contract: z.literal('kapelle.agent-creation/v1'),
  manifest: anyLaunchManifestSchema, manifestHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  approvedBy: z.string().min(1), approvedAt: z.iso.datetime(),
  definitionId: z.string().nullable(), instanceId: z.string().nullable(),
  /** Set once the instance first reached READY: after that, provisioning never resumes it again (pause is an owner action). */
  readyAt: z.iso.datetime().nullable(),
}).strict();
export type CreationRecord = z.infer<typeof approvalSchema>;

/** Durable creation intents, one owner-only file per operation id, written atomically. */
export class CreationLedger {
  constructor(readonly dir: string) {
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const s = lstatSync(dir);
    assert(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0, 'creation_ledger_not_private');
  }
  private path(op: string) { assert(/^[0-9a-f-]{36}$/.test(op), 'creation_operation_id_invalid'); return join(this.dir, op + '.json'); }
  get(op: string): CreationRecord | null { const p = this.path(op); return existsSync(p) ? approvalSchema.parse(JSON.parse(readFileSync(p, 'utf8'))) : null; }
  put(r: CreationRecord) {
    const p = this.path(r.manifest.operationId), tmp = p + '.' + process.pid + '.tmp';
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify(approvalSchema.parse(r))); } finally { closeSync(fd); }
    renameSync(tmp, p);
  }
}

/** Record the owner's approval of the exact manifest. Idempotent for the same manifest; a different manifest under the same
 *  operation id is refused (a changed review needs a new approval). */
export function approveCreation(ledger: CreationLedger, o: {manifest: AnyLaunchManifest; manifestHash: string; principalId: string; occurredAt: string}): CreationRecord {
  const manifest = anyLaunchManifestSchema.parse(o.manifest);
  assert(digest(manifest) === o.manifestHash, 'creation_manifest_hash_mismatch');
  assert(o.principalId === manifest.ownerId, 'creation_approver_is_not_the_owner');
  const prior = ledger.get(manifest.operationId);
  if (prior) { assert(prior.manifestHash === o.manifestHash, 'creation_operation_reused_for_another_manifest'); return prior; }
  const r: CreationRecord = {contract: 'kapelle.agent-creation/v1', manifest, manifestHash: o.manifestHash, approvedBy: o.principalId, approvedAt: o.occurredAt, definitionId: null, instanceId: null, readyAt: null};
  ledger.put(r);
  return r;
}

/** Deterministic step operation ids (UUID-shaped, derived from the approved operation id). */
export function stepOperationId(op: string, step: string): string {
  const h = digest(['kapelle.agent-creation-step/v1', op, step]).slice(7);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export type ProvisionResult = {definitionId: string; instanceId: string; stage: 'READY'};
/** Run (or resume) provisioning for an approved creation. Safe to call any number of times, including after a crash at any
 *  point or a lost reply: each step either observes its effect in native state or replays the same journaled operation. */
export async function provision(port: ProvisionPort, ledger: CreationLedger, operationId: string, release: ReleaseV2, now: () => string = () => new Date().toISOString()): Promise<ProvisionResult> {
  const rec = ledger.get(operationId);
  assert(rec, 'creation_not_approved');
  const m = rec!.manifest;
  assert(release.contentHash === m.definitionRef.contentHash && releaseHashV2(release) === release.contentHash
    && release.definitionId === m.definitionRef.id && release.packageVersion === m.definitionRef.version, 'creation_release_differs_from_approval');
  const step = (s: string) => stepOperationId(operationId, s);
  const save = (patch: Partial<CreationRecord>) => { Object.assign(rec!, patch); ledger.put(rec!); };

  // 1. Definition: publish this exact release once (v2 document). The allocation is reserved under a deterministic id.
  const definitionId = rec!.definitionId ?? await port.allocate(step('definition-allocate'), 'kapelle/agent-definition', release.title, 2);
  if (!rec!.definitionId) save({definitionId});
  const def = await port.read(definitionId, 'kapelle/agent-definition');
  if (!def.state.global.release) {
    const {launchPolicy, ...v1} = release;
    await port.command({operationId: step('definition-publish'), documentId: definitionId, documentType: 'kapelle/agent-definition', expectedRevision: 0,
      type: 'PUBLISH_DEFINITION', input: {release: v1, launchPolicyJson: canonical(launchPolicy)}});
  }
  const published = await port.read(definitionId, 'kapelle/agent-definition');
  assert(published.state.document.version === 2 && published.state.global.release?.contentHash === release.contentHash, 'creation_definition_differs');

  // 2. Instance: allocate once, CREATE_INSTANCE (PAUSED), runtime binding, then REQUEST_RESUME (READY).
  const instanceId = rec!.instanceId ?? await port.allocate(step('instance-allocate'), 'kapelle/agent-instance', m.name, 1);
  if (!rec!.instanceId) save({instanceId});
  const cmd = async (s: string, type: string, input: Record<string, unknown>) => {
    const cur = (await port.read(instanceId, 'kapelle/agent-instance')).state.global;
    await port.command({operationId: step(s), documentId: instanceId, documentType: 'kapelle/agent-instance', expectedRevision: cur.revision, type, input});
  };
  let inst = (await port.read(instanceId, 'kapelle/agent-instance')).state.global;
  if (inst.revision === 0)
    await cmd('instance-create', 'CREATE_INSTANCE', {instanceId, scopeRef: m.scopeRef, definitionRef: m.definitionRef, name: m.name,
      responsibilities: release.responsibilities, operatingPolicy: 'Prepare-only. Every Task needs its own exact-plan approval.',
      modelPolicy: {preferredProfile: m.runtime.id, concurrencyLimit: m.budget.concurrency, budgetPolicyRef: kitBudgetPolicyRef(m), paidFallback: false,
        fallbackProvider: null, fallbackScopeRef: null, fallbackBudgetRef: null}});
  inst = (await port.read(instanceId, 'kapelle/agent-instance')).state.global;
  assert(inst.instanceId === instanceId && canonical(inst.definitionRef) === canonical(m.definitionRef) && inst.name === m.name, 'creation_instance_differs');
  const runtimeBindingRef = kitRuntimeBindingRef(m.runtime.id, m.runtime.profileHash);
  if (inst.runtimeBindingRef !== runtimeBindingRef) {
    assert(inst.desiredState === 'PAUSED' && inst.runtimeBindingRef === null, 'creation_instance_runtime_differs');
    await cmd('instance-runtime', 'SET_RUNTIME_BINDING', {runtimeBindingRef});
  }
  if (rec!.readyAt) return {definitionId, instanceId, stage: 'READY'}; // set up before; current state is the owner's
  inst = (await port.read(instanceId, 'kapelle/agent-instance')).state.global;
  if (inst.desiredState === 'PAUSED') await cmd('instance-resume', 'REQUEST_RESUME', {});
  inst = (await port.read(instanceId, 'kapelle/agent-instance')).state.global;
  assert(inst.desiredState === 'READY', 'creation_instance_not_ready');
  save({readyAt: now()});
  return {definitionId, instanceId, stage: 'READY'};
}
