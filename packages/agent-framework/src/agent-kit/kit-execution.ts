// Agent launch kit, slice 4b: kit run execution (Fable K1 + K2, FABLE-REVIEW-AGENT-LAUNCH-KIT.md).
// K1: one TaskWorker (journal + claim + the existing writer lock) per approved kit Dispatch, rooted at <root>/kit/<dispatchId>;
//     its binding is DERIVED from native state + the pinned catalog + the approved budget, then asserted equal to the approved
//     pin (kitRunBinding). The existing worker code (claim, uncertainty, publication, readback) runs unchanged inside each root.
//     A durable per-instance lock (counts EXECUTION_UNCERTAIN and REPORT_PENDING) enforces concurrency 1. Host-level pins
//     (catalog sha, harness SDK/CLI, publisher source + model admission via checkHostPins) are checked for every claim.
// K2: after the run's own read grant expired, status is served read-only inside a kit saved-read scope keyed by the Dispatch,
//     only for RESULT_RECORDED or terminal/uncertain attempts, only if that exact grant was never revoked and was live at the
//     native acceptance. It never reconciles, runs, writes or calls the Registry.
import {join} from 'node:path';
import {mkdirSync, openSync, writeSync, closeSync, readFileSync, existsSync, unlinkSync, lstatSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {z} from 'zod';
import {canonical, digest} from '../content.js';
import {assert} from '../validation.js';
import type {FrameworkAuthority} from '../service/authority.js';
import type {DispatchState} from '../../document-models/dispatch/v1/index.js';
import type {AgentInstanceState} from '../../document-models/agent-instance/v1/index.js';
import {parseEnvelope, taskSchema, taskSource, type Task} from '../task-delegation/contract.js';
import {packetNotesSchema, taskWorkerBindingSchema, type TaskWorkerBinding} from '../task-delegation/worker-contract.js';
import {TaskWorker, type TaskWorkerPorts, type TaskWorkerStatus} from '../task-delegation/worker.js';
import {independentlyVerifiedReports, type ReportProbe} from '../task-delegation/runtime.js';
import type {PrivateTaskPublicationPort} from '../task-delegation/private-report-adapter.js';
import type {ClaudeAdapter, LocalAdapter, HostedAdapter} from '../worker/execution.js';
import {withKitSavedRead} from '../task-delegation/recovery.js';
import {releaseOfDocument} from './definition-v2.js';
import {kitRunBinding} from './execution.js';
import {planSourceOf, type PlanSource} from '../task-delegation/contract.js';
import {launchPolicySchema} from './launch-policy.js';
import {resolveRuntime, inferenceFor} from './runtime-catalog.js';
import {kitRuntimeBindingRef} from './host-facts.js';
import type {OwnerPrivateReportStore} from './private-store.js';
import type {KitHost} from './kit-host.js';

export type KitExecutionOptions = {
  root: string; authority: FrameworkAuthority; kit: KitHost; token: () => string;
  /** Production: the installed restricted Claude adapter. Tests/dry run: a fake. Loaded lazily, per run. */
  loadProvider: () => Promise<ClaudeAdapter>;
  /** local-mlx runs: the host's local adapter (vendored Pi + controlled MLX transport + runtime reservation). Absent = refused. */
  loadLocalProvider?: () => Promise<LocalAdapter>;
  /** CP agent launch: the hosted adapter for ONE pinned profile (by its hash). Absent = hosted profiles refuse. */
  loadHostedProvider?: (runtimeProfileHash: string) => Promise<HostedAdapter>;
  publisher: PrivateTaskPublicationPort; reportProbe?: ReportProbe;
  /** Owner-private agents publish ONLY here (never the shared Registry). Absent = their runs stay REPORT_PENDING. */
  privatePublisher?: OwnerPrivateReportStore;
  /** K1-4: host-level pins checked for every claim (publisher source hash, model admission, Framework source). */
  checkHostPins: () => Promise<void>;
  readTask: (id: string) => Promise<Task>;
  recoverExecution?: TaskWorkerPorts['recoverExecution'];
};
const SETTLED = new Set<TaskWorkerStatus['status']>(['REPORT_PUBLISHED', 'EXECUTION_REJECTED']);
const uuid = z.string().uuid();

export function openKitExecution(o: KitExecutionOptions) {
  const base = join(o.root, 'kit'), locks = join(base, 'instance-locks');
  mkdirSync(locks, {recursive: true, mode: 0o700});
  assert((lstatSync(base).mode & 0o077) === 0, 'kit_worker_root_not_private');
  const workers = new Map<string, TaskWorker>();
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const verifiers = new Map<string, ReturnType<typeof independentlyVerifiedReports>>();
  const verified = (instanceId: string, ownerId: string, scopeRef: string, isPrivate: boolean) => {
    const key = (isPrivate ? 'private:' : 'registry:') + instanceId;
    let v = verifiers.get(key);
    if (!v) {
      if (isPrivate && !o.privatePublisher) return null;
      v = isPrivate ? independentlyVerifiedReports(o.privatePublisher!, ownerId, scopeRef, instanceId) // no Registry probe for private Reports
        : independentlyVerifiedReports(o.publisher, ownerId, scopeRef, instanceId, o.reportProbe ? {probe: o.reportProbe} : {});
      verifiers.set(key, v);
    }
    return v;
  };

  /** Everything about one kit Dispatch, from native state (+ the pinned catalog, re-hashed now). */
  async function resolve(dispatchId: string) {
    uuid.parse(dispatchId);
    const a = o.authority, opt = a.options;
    const d = (await a.read(dispatchId, 'kapelle/dispatch')).state.global as DispatchState;
    assert(d.dispatchId === dispatchId && d.ownerId === opt.ownerId && d.scopeRef === opt.scopeRef && d.offer, 'kit_dispatch_scope');
    const e = parseEnvelope(d.offer!);
    assert(e.draft.grantPlan, 'kit_dispatch_not_kit');
    const instance = (await a.read(d.offer!.recipient.instanceId, 'kapelle/agent-instance')).state.global as AgentInstanceState;
    const defs = await a.backend.list('kapelle/agent-definition');
    let release = null;
    for (const id of defs) { const doc = (await a.backend.read(id, 'kapelle/agent-definition')).document; const r = releaseOfDocument(doc as never);
      if (r && r.contentHash === instance.definitionRef?.contentHash) { release = r; break; } }
    assert(release, 'kit_definition_unavailable');
    return {d, e, instance, release: release!, taskId: e.draft.taskId};
  }
  /** K1: the worker for one Dispatch, with its derived-then-asserted binding. Same root + writer lock on every open. */
  async function workerFor(dispatchId: string, forRun = false) {
    assert(!closed, 'kit_execution_closed');
    const {d, e, instance, release, taskId} = await resolve(dispatchId);
    // K1-1: the binding is DERIVED from live native state + catalog + approved budget and ASSERTED against the approved pin at
    // the run's first claim, then persisted create-only in the run's root. Later opens load it and re-assert it against the
    // approved pin and the run's immutable native facts (the live capability hash moves when OTHER runs add grants on the
    // shared Task-delegation permission). run/reconcile also re-check the current catalog (K1-4); a status read does not.
    const root = join(base, dispatchId), file = join(root, 'kit-binding.json');
    let binding: TaskWorkerBinding;
    if (existsSync(file)) {
      binding = taskWorkerBindingSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      const pin = e.draft.recipient;
      assert(binding.instanceId === instance.instanceId && binding.capabilityHash === pin.capabilityHash && binding.taskCapabilityHashes?.[taskId] === pin.capabilityHash &&
        binding.runtimeBindingRef === pin.runtimeBindingRef && binding.definitionHash === pin.definitionHash && binding.definitionHash === instance.definitionRef?.contentHash &&
        binding.budgetPolicyRef === instance.modelPolicy?.budgetPolicyRef && binding.ownerId === instance.ownerId && binding.scopeRef === instance.scopeRef, 'kit_pin_differs');
      if (forRun) {
        // K1-4: the current catalog must still produce exactly this runtime binding and harness/budget inference.
        const catalog = o.kit.catalogNow(), policy = launchPolicySchema.parse(release.launchPolicy);
        const {profile, hash} = resolveRuntime(catalog, binding.modelProfile);
        const b0 = policy.budget.default;
        assert((binding.outputClassification === 'owner-private') === (policy.outputs.classification === 'owner-private'), 'kit_classification_changed');
        assert(kitRuntimeBindingRef(profile.id, hash) === binding.runtimeBindingRef &&
          canonical(inferenceFor(profile, {maxOutputTokens: b0.maxOutputTokens, maxBudgetUsd: b0.maxBudgetUsd, timeoutMs: b0.timeoutMs})) === canonical(binding.inference), 'kit_runtime_binding_changed');
      }
    } else {
      binding = kitRunBinding({instance, release, catalog: o.kit.catalogNow(), taskId, requireReady: forRun, source: planSourceOf(e.draft.grantPlan),
        permissionRef: o.kit.config.permissionRef, approvedPin: e.draft.recipient});
      mkdirSync(root, {recursive: true, mode: 0o700});
      const fd = openSync(file, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify(binding)); } finally { closeSync(fd); }
    }
    // Finances admission (claim time): the Task may have moved into a private project after approval; a private Task never runs
    // on a binding whose outputs are not owner-private (never a cloud runtime).
    if (forRun && o.kit.isPrivateProject(taskSchema.parse(await o.readTask(taskId)).projectId)) assert(binding.outputClassification === 'owner-private', 'kit_private_task_needs_local_agent');
    const existing = workers.get(dispatchId);
    if (existing) return {worker: existing, binding, d, taskId, instance};
    const inference = binding.inference;
    const ports = inference.runtime === 'claude-agent-sdk' ? {provider: {sdkVersion: inference.sdkVersion, cliVersion: inference.cliVersion,
      async run(...args: Parameters<ClaudeAdapter['run']>) {
        // K1-4: host pins + the catalog harness pins, every run; a different installed harness is refused, never used.
        await o.checkHostPins();
        const loaded = await o.loadProvider();
        assert(loaded.sdkVersion === inference.sdkVersion && loaded.cliVersion === inference.cliVersion, 'worker_runtime_version_changed');
        return loaded.run(...args);
      }} satisfies ClaudeAdapter} : inference.runtime === 'hosted-api' ? {hostedProvider: {runtime: 'hosted-api' as const, runtimeProfileHash: inference.runtimeProfileHash,
      async run(...args: Parameters<HostedAdapter['run']>) {
        await o.checkHostPins();
        assert(o.loadHostedProvider, 'kit_hosted_runtime_not_installed');
        const loaded = await o.loadHostedProvider!(inference.runtimeProfileHash);
        assert(loaded.runtimeProfileHash === inference.runtimeProfileHash, 'worker_runtime_version_changed');
        return loaded.run(...args);
      }} satisfies HostedAdapter} : {localProvider: {runtime: 'pi-agent-core' as const, harnessDigest: inference.harnessDigest, runtimeProfileHash: inference.runtimeProfileHash,
      async run(...args: Parameters<LocalAdapter['run']>) {
        await o.checkHostPins();
        assert(o.loadLocalProvider, 'kit_local_runtime_not_installed');
        const loaded = await o.loadLocalProvider!();
        assert(loaded.harnessDigest === inference.harnessDigest && loaded.runtimeProfileHash === inference.runtimeProfileHash, 'worker_runtime_version_changed');
        return loaded.run(...args);
      }} satisfies LocalAdapter};
    const v = verified(instance.instanceId!, instance.ownerId!, instance.scopeRef!, binding.outputClassification === 'owner-private');
    const worker = TaskWorker.open(join(base, dispatchId), o.authority, binding, {...ports, ...(v ? {reports: v.reports} : {}), recoverExecution: o.recoverExecution,
      packet: async (hash) => {
        const frozen = planSourceOf(e.draft.grantPlan);
        // AGENT-MODEL-V2: only the approved frozen snapshot (manifest + bytes); the folder is never reopened.
        if (frozen) { assert(hash === frozen.packetHash, 'task_packet_identity_ambiguous'); return frozenPacket(frozen); }
        // Only the packet named by THIS Dispatch's Task notes, from the host-admitted store (schema/digest/size re-verified).
        const task = taskSchema.parse(await o.readTask(taskId));
        assert(packetNotesSchema.parse(JSON.parse(task.bodyMarkdown)).packetHash === hash, 'task_packet_identity_ambiguous');
        return o.kit.packets.load(hash);
      }});
    workers.set(dispatchId, worker);
    return {worker, binding, d, taskId, instance};
  }

  // ---- K1-3: durable per-instance lock, released only when the holder's attempt is settled ----
  const lockPath = (instanceId: string) => join(locks, digest(instanceId).slice(7, 39) + '.json');
  async function settled(dispatchId: string) {
    try { const {worker} = await workerFor(dispatchId); const s = await worker.inspect(dispatchId); return !!s && SETTLED.has(s.status); }
    catch { return false; } // unknown = not settled (fail closed)
  }
  async function acquire(instanceId: string, dispatchId: string) {
    const p = lockPath(instanceId);
    if (existsSync(p)) {
      const holder = z.object({instanceId: z.string(), dispatchId: z.string()}).strict().parse(JSON.parse(readFileSync(p, 'utf8')));
      assert(holder.instanceId === instanceId, 'kit_instance_lock_corrupt');
      if (holder.dispatchId === dispatchId) return;
      assert(await settled(holder.dispatchId), 'kit_instance_busy');
      unlinkSync(p);
    }
    const fd = openSync(p, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({instanceId, dispatchId})); } finally { closeSync(fd); }
  }
  async function releaseIfSettled(instanceId: string, dispatchId: string) {
    const p = lockPath(instanceId);
    if (!existsSync(p)) return;
    const holder = JSON.parse(readFileSync(p, 'utf8'));
    if (holder.dispatchId === dispatchId && await settled(dispatchId)) unlinkSync(p);
  }

  /** Readiness for a run: live Task, the Task's packet admitted in the store, the Task unchanged across the check. */
  async function admitted(taskId: string, dispatch: DispatchState) {
    const e = parseEnvelope(dispatch.offer!);
    const task = taskSchema.parse(await o.readTask(taskId));
    if (task.id !== taskId || task.ownerId !== o.authority.options.ownerId || taskSource(task).sourceHash !== e.draft.sourceHash) return false;
    const source = planSourceOf(e.draft.grantPlan);
    if (source) frozenPacket(source); // AGENT-MODEL-V2: the approved snapshot (bytes + manifest), never the live folder
    else o.kit.packets.load(packetNotesSchema.parse(JSON.parse(task.bodyMarkdown)).packetHash);
    const after = taskSchema.parse(await o.readTask(taskId));
    return canonical(after) === canonical(task);
  }

  /** The approved frozen source: its manifest names exactly this packet, and the packet's bytes re-verify by digest. */
  function frozenPacket(source: PlanSource) {
    const m = o.kit.sourceManifests.get(source.manifestHash);
    assert(m.packetHash === source.packetHash && canonical(m.scope) === canonical(source.scope), 'kit_source_manifest_differs');
    return o.kit.packets.load(source.packetHash);
  }
  /** Current read authorization (grant live), or K2 (saved, exact plan grant, live at native acceptance, never revoked). */
  async function readable(dispatchId: string, saved: boolean) {
    const {d, e, instance, taskId} = await resolve(dispatchId);
    const now = o.authority.options.now?.() ?? new Date().toISOString();
    const readGrant = e.draft.grantPlan!.grants.find(g => g.actions[0] === 'read')!;
    const g = instance.grants.find(x => x.id === readGrant.id);
    if (!g || g.revokedAt || g.principalId !== instance.instanceId || g.resourceRef !== taskId) return false; // K2-1 exact grant; K2-4 revocation denies
    if (g.expiresAt > now) return !saved;
    if (!saved) return false;
    return !!d.acceptance && g.expiresAt > d.acceptance.occurredAt; // K2-1: live at the NATIVE acceptance
  }

  async function status(dispatchId: string) {
    const {worker} = await workerFor(dispatchId);
    if (await readable(dispatchId, false)) return worker.inspect(dispatchId);
    if (!(await readable(dispatchId, true))) throw Error('kit_saved_read_denied');
    // K2-2/3: read-only projection inside the kit saved-read scope; no port, write, reconcile or run.
    return withKitSavedRead(dispatchId, () => worker.savedStatus(dispatchId));
  }

  async function run(dispatchId: string) {
    const {worker, d, taskId, instance} = await workerFor(dispatchId, true);
    assert(await readable(dispatchId, false), 'kit_read_grant_unavailable');
    assert(await admitted(taskId, d), 'host_not_admitted');
    await o.checkHostPins(); // K1-4 at claim
    await acquire(instance.instanceId!, dispatchId);
    const item = await worker.begin(dispatchId);
    const p = worker.drain().then(() => closed ? undefined : releaseIfSettled(instance.instanceId!, dispatchId)).catch(() => undefined);
    pending.add(p); void p.finally(() => pending.delete(p));
    return item;
  }

  async function reconcile(dispatchId: string) {
    const {worker, instance} = await workerFor(dispatchId);
    assert(await readable(dispatchId, false), 'kit_read_grant_unavailable'); // recovery stays a grant-live operation (K2-3)
    // Non-pilot bindings resume an existing attempt through runLocked (publication/readback/native result), never a new
    // inference: the worker refuses a second invocation for a journaled attempt. The pilot-only reconcile() is not used.
    const item = await worker.begin(dispatchId, false);
    await releaseIfSettled(instance.instanceId!, dispatchId);
    return item;
  }

  /** The Task's kit agent: the ONE available kit agent whose launch policy covers the Task's project (a READY instance of a
   *  kit-qualified definition, planned pin computable). None or several -> no kit agent (never a guess). Read-only. */
  async function agentForTask(taskId: string, chosen?: string) {
    const a = o.authority, task = taskSchema.parse(await o.readTask(taskId));
    if (chosen) {
      // AGENT-MODEL-V2: the owner chose this agent for the Task; it must be a READY instance of a kit-qualified definition.
      const inst = (await a.read(chosen, 'kapelle/agent-instance')).state.global as AgentInstanceState;
      let kitDef = false;
      for (const id of await a.backend.list('kapelle/agent-definition')) {
        const r = releaseOfDocument((await a.backend.read(id, 'kapelle/agent-definition')).document as never);
        if (r?.launchPolicy && r.contentHash === inst.definitionRef?.contentHash) { kitDef = true; break; }
      }
      assert(kitDef && inst.desiredState === 'READY' && inst.ownerId === a.options.ownerId && inst.scopeRef === a.options.scopeRef, 'kit_no_agent_for_task');
      const roster = await a.taskDelegationAgents(taskId);
      return {task, instanceId: chosen, roster, v2: await isV2(chosen)};
    }
    const probe = {operationId: '00000000-0000-4000-8000-000000000000', expiresAt: new Date(Date.parse(a.options.now?.() ?? new Date().toISOString()) + 3600_000).toISOString()};
    const roster = await a.taskDelegationAgents(taskId, probe);
    const candidates = [];
    for (const ag of roster.agents) {
      // Any roster agent (a later run on the same Task may still hold live grants, so no grantPlan is offered): the choice
      // is by kit definition + project + READY, never by availability label or name.
      const inst = (await a.read(ag.id, 'kapelle/agent-instance')).state.global as AgentInstanceState;
      if (inst.desiredState !== 'READY') continue;
      const defs = await a.backend.list('kapelle/agent-definition');
      for (const id of defs) {
        const r = releaseOfDocument((await a.backend.read(id, 'kapelle/agent-definition')).document as never);
        if (r?.launchPolicy && r.contentHash === inst.definitionRef?.contentHash &&
          r.launchPolicy.contract === 'kapelle.agent-launch-policy/v1' && r.launchPolicy.sources.some(src => src.reader === 'task' && (src.project === null || src.project === task.projectId))) { candidates.push(ag.id); break; }
      }
    }
    return {task, instanceId: candidates.length === 1 ? candidates[0] : null, roster, v2: false};
  }
  async function isV2(instanceId: string) {
    const inst = (await o.authority.read(instanceId, 'kapelle/agent-instance')).state.global as AgentInstanceState;
    for (const id of await o.authority.backend.list('kapelle/agent-definition')) {
      const r = releaseOfDocument((await o.authority.backend.read(id, 'kapelle/agent-definition')).document as never);
      if (r?.launchPolicy && r.contentHash === inst.definitionRef?.contentHash) return r.launchPolicy.contract === 'kapelle.agent-launch-policy/v2';
    }
    return false;
  }
  /** Same strict contract as the pilot host's admission (kapelle.task-host/v1), for the Task's kit agent. */
  async function admission(taskId: string, chosen?: string) {
    const {task, instanceId, roster, v2} = await agentForTask(taskId, chosen);
    assert(instanceId, 'kit_no_agent_for_task');
    let ready = false, packetHash: string | null = null, packet: unknown = null;
    if (v2) {
      // AGENT-MODEL-V2: no Task-notes packet; the sources are the snapshot frozen into the plan. Ready = the Task is live,
      // unchanged across the check and open.
      try {
        const after = taskSchema.parse(await o.readTask(taskId));
        ready = canonical(after) === canonical(task) && ['OPEN', 'SNOOZED', 'BLOCKED'].includes(task.status) && canonical(taskSource(task)) === canonical(roster.task);
      } catch { ready = false; }
      return {admission: {ok: true as const, contract: 'kapelle.task-host/v1' as const, instanceId, ready, reason: ready ? null : 'host_not_admitted' as const, packetRequired: true as const,
        taskRevision: roster.task.revision, sourceHash: roster.task.sourceHash, packetHash: null}, snapshot: null, sourceMode: 'snapshot' as const};
    }
    try {
      const notes = packetNotesSchema.parse(JSON.parse(task.bodyMarkdown));
      packet = o.kit.packets.load(notes.packetHash); packetHash = notes.packetHash;
      const after = taskSchema.parse(await o.readTask(taskId));
      ready = canonical(after) === canonical(task) && ['OPEN', 'SNOOZED', 'BLOCKED'].includes(task.status) && canonical(taskSource(task)) === canonical(roster.task);
    } catch { ready = false; }
    return {admission: {ok: true as const, contract: 'kapelle.task-host/v1' as const, instanceId, ready, reason: ready ? null : 'host_not_admitted' as const, packetRequired: true as const,
      taskRevision: roster.task.revision, sourceHash: roster.task.sourceHash, packetHash: ready ? packetHash : null}, snapshot: ready ? {task: taskSource(task), packet} : null};
  }
  /** Verified result facts for the authority (RECORD_DISPATCH_RESULT), from each kit instance's independent reader. */
  async function resultFacts() { const out = []; for (const v of verifiers.values()) out.push(...await v.facts()); return out; }

  const handler = async (req: IncomingMessage, res: ServerResponse, next: () => unknown) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const privateRead = /^\/private-reports\/([0-9a-f-]{36})$/.exec(url.pathname);
    const admissionRoute = url.pathname === '/task-executions/kit/admission' || url.pathname === '/task-executions/kit/sources';
    const m = /^\/task-executions\/kit\/([a-f0-9-]{36})(\/(?:run|reconcile))?$/.exec(url.pathname);
    if (!m && !admissionRoute && !privateRead) return next();
    const reply = (s: number, v: unknown) => { res.writeHead(s, {'content-type': 'application/json', 'cache-control': 'private, no-store'}); res.end(JSON.stringify(v)); };
    const secret = o.token(), actual = Buffer.from(req.headers.authorization ?? ''), expected = Buffer.from('Bearer ' + secret);
    if (secret.length < 32 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(403, {ok: false, error: 'forbidden'});
    try {
      // The private read gateway: owner token only (checked above); GET; one document; 404 when it is not a private Report.
      if (privateRead) {
        if (req.method !== 'GET' || url.search) return reply(404, {ok: false, error: 'not_found'});
        const doc = o.privatePublisher?.readDocument(privateRead[1]) ?? null;
        return doc ? reply(200, {ok: true, contract: 'kapelle.private-report/v1', report: doc}) : reply(404, {ok: false, error: 'not_found'});
      }
      if (admissionRoute) {
        if (req.method !== 'GET' || [...url.searchParams.keys()].some(k => k !== 'taskId' && k !== 'instanceId') || url.searchParams.getAll('taskId').length !== 1 || url.searchParams.getAll('instanceId').length > 1) return reply(400, {ok: false, error: 'invalid_request'});
        const taskId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).parse(url.searchParams.get('taskId'));
        const chosen = url.searchParams.get('instanceId') ?? undefined;
        if (chosen !== undefined) z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).parse(chosen);
        const {admission: adm, snapshot} = await admission(taskId, chosen);
        if (url.pathname.endsWith('/admission')) return reply(200, adm);
        if (!adm.ready || !snapshot) return reply(503, {ok: false, error: 'host_not_admitted'});
        const {ok: _ok, contract: _c, reason: _r, packetRequired: _p, ...current} = adm;
        return reply(200, {ok: true, contract: 'kapelle.task-host-sources/v1', ...current, ...snapshot});
      }
      if (!m) return reply(404, {ok: false, error: 'not_found'});
      if (url.search) return reply(404, {ok: false, error: 'not_found'});
      if (req.method === 'GET' && !m[2]) return reply(200, {ok: true, item: await status(m[1])});
      if (req.method !== 'POST' || !m[2]) return reply(405, {ok: false, error: 'method_not_allowed'});
      if (m[2] === '/reconcile') return reply(200, {ok: true, item: await reconcile(m[1])});
      const item = await run(m[1]);
      return reply(item.status === 'EXECUTION_RUNNING' ? 202 : 200, {ok: true, item});
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'kit_instance_busy') return reply(409, {ok: false, error: 'kit_instance_busy'});
      if (msg === 'kit_saved_read_denied') return reply(403, {ok: false, error: 'saved_read_denied'});
      if (msg === 'kit_no_agent_for_task') return reply(404, {ok: false, error: 'kit_no_agent_for_task'});
      return reply(/^(kit_|worker_|host_not_admitted|Task )/.test(msg) ? 409 : 503, {ok: false, error: /^(kit_|host_not_admitted)/.test(msg) ? msg : 'task_execution_unavailable'});
    }
  };
  return {status, run, reconcile, resultFacts, handler, admission, agentForTask,
    /** Wait for every detached run to settle (never aborts one). */
    async drain() { for (const w of workers.values()) await w.drain(); await Promise.all([...pending]); },
    /** Service stop: abort active provider calls, wait for settlement, then release every root's writer lock. */
    async stop() { for (const w of workers.values()) { w.stop(); await w.drain(); } await Promise.all([...pending]); },
    close() { closed = true; for (const w of workers.values()) w.close(); workers.clear(); }};
}
