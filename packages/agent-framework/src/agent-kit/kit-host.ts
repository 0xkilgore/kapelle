// Agent launch kit, slice 3b: host wiring, installed ONCE (no per-agent files).
// One host config: the runtime catalog (path + pinned sha256), the kit state dir (creation ledger, packet store) and the
// host-owned Task-delegation permission. KitHost merges kit facts into the service facts, serves the owner's preview ->
// create flow (the manifest is recomputed server-side; the owner's approval must name its exact hash) and resumes any
// unfinished creation at start.
import {readFileSync, existsSync, readdirSync, mkdirSync, realpathSync, writeFileSync, renameSync} from 'node:fs';
import {createHash, randomUUID} from 'node:crypto';
import {join, isAbsolute} from 'node:path';
import {z} from 'zod';
import {digest, canonical} from '../content.js';
import {assert} from '../validation.js';
import type {FrameworkAuthority, Facts} from '../service/authority.js';
import type {ModelType} from '../command-boundary.js';
import {loadRuntimeCatalog, resolveRuntime, runtimeLabel, type RuntimeCatalog} from './runtime-catalog.js';
import {releaseOfDocument, type ReleaseV2} from './definition-v2.js';
import {launchPolicySchema} from './launch-policy.js';
import {kitHostFacts, agentAvailability, type Availability} from './host-facts.js';
import {CreationLedger, approveCreation, provision, type ProvisionPort} from './create-agent.js';
import {KitPacketStore, KitManifestStore} from './execution.js';
import {assembleScope, ScopeRefused} from './scope-assembler.js';
import {sourceScopeSchema} from './launch-policy.js';
import {exampleOrgManifest, EXAMPLE_ORG_TEMPLATE_ID} from './templates/example-org.js';
import {genericRequestSchema, genericManifest, releaseOfGenericManifest} from './templates/generic.js';
import type {SourceScope} from './launch-policy.js';

const abs = z.string().refine(isAbsolute, 'absolute_path_required');
export const kitHostConfigSchema = z.object({
  contract: z.literal('kapelle.kit-host/v1'),
  catalogPath: abs, catalogSha256: z.string().regex(/^[a-f0-9]{64}$/),
  stateDir: abs,
  /** The host-owned Task-delegation receive resource (the same one the Task host admits). */
  permissionRef: z.string().min(1).max(200),
  /** AGENT-MODEL-V2: the owner-admitted source roots (folders under ~/Workspace, never Dropbox). A project scope resolves to
   *  the root that lists it; a folder scope names a root id + a relative directory. Absent = no scopes can be selected. */
  scopeRoots: z.array(z.object({id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), path: abs, label: z.string().min(1).max(80),
    projects: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/)).max(32).default([]),
    /** owner-private roots (e.g. finance) are refused for agents whose outputs go to a remote provider. */
    classification: z.enum(['project', 'owner-private']).default('project')}).strict()).max(64).default([]),
  /** The tree every root must sit in (default ~/Workspace). */
  workspaceRoot: abs.optional(),
  /** Finances admission: projects whose Tasks are private (plus every owner-private root's projects). Fails closed: default
   *  ['finances']. A private Task can only go to an agent whose outputs are owner-private (a local-only runtime). */
  privateProjects: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/)).max(32).default(['finances']),
}).strict().superRefine((c, ctx) => {
  if (new Set(c.scopeRoots.map(r => r.id)).size !== c.scopeRoots.length) ctx.addIssue({code: 'custom', message: 'duplicate_scope_root'});
  const projects = c.scopeRoots.flatMap(r => r.projects);
  if (new Set(projects).size !== projects.length) ctx.addIssue({code: 'custom', message: 'project_mapped_to_two_roots'});
  if (c.scopeRoots.some(r => r.path.includes('/Dropbox/'))) ctx.addIssue({code: 'custom', message: 'scope_root_in_dropbox'});
});
export type KitHostConfig = z.infer<typeof kitHostConfigSchema>;

/** FrameworkAuthority as the provisioning port. */
export function authorityPort(a: FrameworkAuthority): ProvisionPort {
  return {
    allocate: async (op, type, name, v) => (await a.allocate(op, type as ModelType, name, v)).documentId,
    read: (id, type) => a.read(id, type as ModelType) as never,
    command: raw => a.command(raw),
  };
}

const templateRequestSchema = z.object({template: z.literal(EXAMPLE_ORG_TEMPLATE_ID), name: z.string(), operationId: z.string().uuid()}).strict();
/** Template (existing agents) or generic (AGENT-MODEL-V2: owner-authored). */
export const createRequestSchema = z.union([templateRequestSchema, genericRequestSchema]);
const manifestHashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const createApprovalSchema = z.union([templateRequestSchema.extend({manifestHash: manifestHashSchema}).strict(), genericRequestSchema.extend({manifestHash: manifestHashSchema}).strict()]);

export class KitHost {
  readonly ledger: CreationLedger; readonly packets: KitPacketStore; readonly sourceManifests: KitManifestStore;
  private constructor(readonly config: KitHostConfig, readonly catalog: RuntimeCatalog, readonly authority: FrameworkAuthority) {
    this.ledger = new CreationLedger(join(config.stateDir, 'creations'));
    this.packets = new KitPacketStore(join(config.stateDir, 'packets'));
    this.sourceManifests = new KitManifestStore(join(config.stateDir, 'source-manifests'));
  }
  static open(config: unknown, authority: FrameworkAuthority) {
    const c = kitHostConfigSchema.parse(config);
    // Kit state (creation ledger, packet store) never lives in Dropbox (slice-3 condition 2).
    mkdirSync(c.stateDir, {recursive: true, mode: 0o700});
    assert(!realpathSync(c.stateDir).includes('/Dropbox/'), 'kit_state_in_dropbox');
    return new KitHost(c, loadRuntimeCatalog(c.catalogPath, c.catalogSha256), authority);
  }
  /** Re-checked on every facts() call: a changed catalog file stops kit facts (fail closed), it is never silently used. */
  private currentCatalog() { return loadRuntimeCatalog(this.config.catalogPath, this.config.catalogSha256); }
  /** The pinned catalog, re-hashed now (K1-4): a changed file refuses every derivation. */
  catalogNow() { return this.currentCatalog(); }
  private manifests() {
    const dir = this.ledger.dir;
    return existsSync(dir) ? readdirSync(dir).filter(f => /^[0-9a-f-]{36}\.json$/.test(f)).map(f => this.ledger.get(f.slice(0, 36))!).filter(Boolean) : [];
  }
  /** Kit facts merged into the service facts. Reads the native backend directly (facts() runs inside the authority lock). */
  async facts(base: Facts): Promise<Facts> {
    const catalog = this.currentCatalog(), b = this.authority.backend;
    const releases: ReleaseV2[] = [];
    for (const id of await b.list('kapelle/agent-definition')) {
      const d = (await b.read(id, 'kapelle/agent-definition')).document;
      const r = d.state.document?.version === 2 ? releaseOfDocument(d as never) : null;
      if (r?.launchPolicy) releases.push(r);
    }
    const kit = kitHostFacts(releases, catalog, this.manifests().map(r => r.manifest));
    const permission = {id: this.config.permissionRef, resourceType: 'task-delegation', revision: 1, contentHash: digest({permission: this.config.permissionRef, kit: 'kapelle.kit-host/v1'}), allowedActions: ['receive', 'dispatch']};
    return {...base,
      definitions: [...base.definitions.filter(d => !kit.definitions.some(k => k.release.contentHash === d.release.contentHash)), ...kit.definitions],
      runtimeBindingRefs: [...new Set([...base.runtimeBindingRefs, ...kit.runtimeBindingRefs])],
      runtimeBindingContracts: {...base.runtimeBindingContracts, ...kit.runtimeBindingContracts},
      budgetPolicyRefs: [...new Set([...base.budgetPolicyRefs, ...kit.budgetPolicyRefs])],
      resources: base.resources.some(r => r.id === permission.id) ? base.resources : [...base.resources, permission],
      privateProjects: this.privateProjects(),
      frozenSource: (hash: string) => { try { const m = this.sourceManifests.get(hash); return {scope: m.scope, packetHash: m.packetHash}; } catch { return null; } }};
  }
  /** AGENT-MODEL-V2: freeze a Task's chosen scope for one agent BEFORE planning. Read-only on the owner's files; admits the
   *  exact packet and manifest to the private stores and returns the plan source. Refuses: a non-kit or not-READY agent, a
   *  scope kind the agent's policy does not allow, an owner-private root for an agent whose outputs leave this Mac, and every
   *  assembler refusal (traversal, symlink, secrets-only, overflow, ...). Creates no grant and calls no model. */
  async snapshot(raw: unknown) {
    const r = z.object({instanceId: z.string().min(1).max(200), scope: sourceScopeSchema, select: z.array(z.string().min(1).max(512)).max(64).optional()}).strict().parse(raw);
    const inst = (await this.authority.read(r.instanceId, 'kapelle/agent-instance')).state.global as {instanceId: string; ownerId: string; scopeRef: string; desiredState: string; definitionRef: {contentHash: string} | null};
    const o = this.authority.options;
    assert(inst.instanceId === r.instanceId && inst.ownerId === o.ownerId && inst.scopeRef === o.scopeRef && inst.desiredState === 'READY', 'kit_snapshot_agent_not_ready');
    let release: ReleaseV2 | null = null;
    for (const id of await this.authority.backend.list('kapelle/agent-definition')) {
      const rel = releaseOfDocument((await this.authority.backend.read(id, 'kapelle/agent-definition')).document as never);
      if (rel?.launchPolicy && rel.contentHash === inst.definitionRef?.contentHash) { release = rel; break; }
    }
    const policy = release?.launchPolicy;
    assert(policy && policy.contract === 'kapelle.agent-launch-policy/v2' && policy.scope.kinds.includes(r.scope.kind), 'kit_snapshot_scope_not_allowed');
    // Owner decision (Oct 15): an agent reads only its OWN folders/projects, set when it was created (its policy's scopes).
    assert(policy!.scope.defaults.some(d => canonical(d) === canonical(r.scope)), 'kit_snapshot_scope_not_agents_own');
    const sc = r.scope;
    const root = sc.kind === 'folder' ? this.config.scopeRoots.find(x => x.id === sc.rootId) : this.config.scopeRoots.find(x => x.projects.includes(sc.projectId));
    assert(!(root?.classification === 'owner-private' && policy!.outputs.classification !== 'owner-private'), 'kit_snapshot_private_scope_needs_local_agent');
    let assembled;
    try { assembled = assembleScope({scope: r.scope, roots: this.config.scopeRoots, capturedAt: (o.now ?? (() => new Date().toISOString()))(), select: r.select,
      ...(this.config.workspaceRoot ? {workspace: this.config.workspaceRoot} : {})}); }
    catch (e) { if (e instanceof ScopeRefused) throw Error('kit_scope_' + e.reason); throw e; }
    this.packets.admit(assembled.packet);
    const manifestHash = this.sourceManifests.put(assembled.manifest);
    this.recordLatestSnapshot(r.instanceId, manifestHash);
    return {manifest: assembled.manifest, manifestHash, source: {scope: r.scope, manifestHash, packetHash: assembled.manifest.packetHash}, root: this.rootLabel(assembled.manifest.rootId)};
  }
  /** AGENT-MODEL-V2 slice 1d: owner lifecycle for kit agents. Pause stops new admission (history kept). Retire requires a
   *  PAUSED kit agent with no unsettled Dispatch (offered, accepted, cancel-requested): nothing is deleted, no grant, Dispatch
   *  or Report is rewritten. Deterministic operation ids from the caller's id make a retry replay the same native command. */
  async lifecycle(instanceId: string, action: 'pause' | 'resume' | 'retire', raw: unknown) {
    const {operationId} = z.object({operationId: z.string().uuid()}).strict().parse(raw);
    const a = this.authority, o = a.options;
    const inst = (await a.read(instanceId, 'kapelle/agent-instance')).state.global as {instanceId: string; ownerId: string; scopeRef: string; desiredState: string; revision: number; definitionRef: {contentHash: string} | null};
    assert(inst.instanceId === instanceId && inst.ownerId === o.ownerId && inst.scopeRef === o.scopeRef, 'kit_lifecycle_scope');
    let kitDef = false;
    for (const id of await a.backend.list('kapelle/agent-definition')) {
      const r = releaseOfDocument((await a.backend.read(id, 'kapelle/agent-definition')).document as never);
      if (r?.launchPolicy && r.contentHash === inst.definitionRef?.contentHash) { kitDef = true; break; }
    }
    assert(kitDef, 'kit_lifecycle_not_a_kit_agent');
    if (action === 'resume') {
      // Paused -> READY again (native REQUEST_RESUME, the same admission as at creation). A retired agent never comes back.
      if (inst.desiredState !== 'READY') { assert(inst.desiredState === 'PAUSED', 'kit_lifecycle_not_paused');
        await a.command({operationId, documentId: instanceId, documentType: 'kapelle/agent-instance', expectedRevision: inst.revision, type: 'REQUEST_RESUME', input: {}}); }
    } else if (action === 'pause') {
      if (inst.desiredState !== 'PAUSED') { assert(inst.desiredState === 'READY', 'kit_lifecycle_not_ready');
        await a.command({operationId, documentId: instanceId, documentType: 'kapelle/agent-instance', expectedRevision: inst.revision, type: 'REQUEST_PAUSE', input: {}}); }
    } else {
      if (inst.desiredState !== 'RETIRED') {
        assert(inst.desiredState === 'PAUSED', 'kit_retire_requires_pause_first');
        // Page to completion (bounded): any unsettled Dispatch, or a list that cannot be read completely, refuses.
        let cursor: string | null = null, pages = 0, complete = false;
        do {
          const page: {items: unknown[]; complete: boolean; nextCursor: string | null} = await a.listDispatches({recipient: instanceId, phases: ['OFFERED', 'ACCEPTED', 'CANCEL_REQUESTED'], limit: 50, cursor});
          assert(page.items.length === 0, 'kit_retire_unsettled_dispatch');
          complete = page.complete; cursor = page.nextCursor; pages++;
        } while (!complete && cursor && pages < 40);
        assert(complete, 'kit_retire_unsettled_dispatch');
        await a.command({operationId, documentId: instanceId, documentType: 'kapelle/agent-instance', expectedRevision: inst.revision, type: 'RETIRE_INSTANCE', input: {}});
      }
    }
    return {instanceId, desiredState: ((await a.read(instanceId, 'kapelle/agent-instance')).state.global as {desiredState: string}).desiredState};
  }
  /** The agent's most recent snapshot (any Task plan preview or chat turn), for its page's Files section. Owner-only file. */
  private latestFile(instanceId: string) { const d = join(this.config.stateDir, 'latest-snapshots'); mkdirSync(d, {recursive: true, mode: 0o700});
    return join(d, createHash('sha256').update(instanceId).digest('hex').slice(0, 32) + '.json'); }
  private recordLatestSnapshot(instanceId: string, manifestHash: string) {
    const f = this.latestFile(instanceId), tmp = f + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, JSON.stringify({instanceId, manifestHash, at: (this.authority.options.now ?? (() => new Date().toISOString()))()}), {mode: 0o600, flag: 'wx'});
    renameSync(tmp, f);
  }
  /** Files in the agent's own folder from its latest snapshot: top level only (files with sizes; sub-folders with file counts and
   *  total sizes), plus what was left out. Names and sizes only, never contents. null = no snapshot yet. */
  latestFiles(instanceId: string) {
    const f = this.latestFile(instanceId);
    if (!existsSync(f)) return null;
    const rec = z.object({instanceId: z.literal(instanceId), manifestHash: z.string(), at: z.string()}).strict().parse(JSON.parse(readFileSync(f, 'utf8')));
    const {manifest, root} = this.readSnapshot(rec.manifestHash);
    const top = new Map<string, {name: string; kind: 'file' | 'folder'; byteSize: number; files: number}>();
    for (const e of manifest.entries) {
      const [head, ...rest] = e.relativePath.split('/'), kind = rest.length ? 'folder' : 'file';
      const cur = top.get(head) ?? {name: head, kind, byteSize: 0, files: 0};
      cur.byteSize += e.byteSize; cur.files += 1; top.set(head, cur);
    }
    return {capturedAt: rec.at, manifestHash: rec.manifestHash, scope: manifest.scope, root, excluded: manifest.excluded,
      items: [...top.values()].sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1)};
  }
  /** Finances admission: every private project (configured + owner-private roots' projects). */
  privateProjects() { return [...new Set([...this.config.privateProjects, ...this.config.scopeRoots.filter(r => r.classification === 'owner-private').flatMap(r => r.projects)])]; }
  isPrivateProject(projectId: string | null | undefined) { return !!projectId && this.privateProjects().includes(projectId); }
  /** Owner-facing label of an admitted root (never its host path). */
  private rootLabel(rootId: string) { const r = this.config.scopeRoots.find(x => x.id === rootId); return {id: rootId, label: r?.label ?? rootId}; }
  /** A stored snapshot manifest by hash (digest re-verified), for the approval screen: names, sizes, hashes, exclusion counts. */
  readSnapshot(manifestHash: string) {
    const manifest = this.sourceManifests.get(manifestHash);
    return {manifest, manifestHash, root: this.rootLabel(manifest.rootId)};
  }
  /** The plan source of a stored manifest (for roster planning). */
  sourceOf(manifestHash: string) {
    const m = this.sourceManifests.get(manifestHash);
    return {scope: m.scope, manifestHash, packetHash: m.packetHash};
  }
  /** New-agent form options: qualified runtimes and admitted scope roots (ids/labels/projects only, never host paths). */
  options() {
    const catalog = this.currentCatalog();
    // model is the owner-facing label (runtimeLabel), never the host path of a local model snapshot.
    return {runtimes: catalog.profiles.map(p => ({id: p.id, model: runtimeLabel(p), harness: p.harness.kind, locality: p.runtime.locality})),
      scopeRoots: this.config.scopeRoots.map(r => ({id: r.id, label: r.label, projects: r.projects})),
      // Finances admission (Fable N-1): the host's private projects, so the console uses the same list (ids only).
      privateProjects: this.privateProjects()};
  }
  /** What the owner reviews: the closed manifest and its hash. No write. */
  /** Default scopes must name an admitted root (folder) or a project mapped to one, so an agent can't carry an unusable scope. */
  scopeProblems(scopes: readonly SourceScope[]): string[] {
    const roots = this.config.scopeRoots, out: string[] = [];
    for (const s of scopes) {
      if (s.kind === 'folder' && !roots.some(r => r.id === s.rootId)) out.push(`folder root ${s.rootId} is not admitted on this host`);
      if (s.kind === 'project' && !roots.some(r => r.projects.includes(s.projectId))) out.push(`project ${s.projectId} has no admitted source root`);
    }
    return out;
  }
  /** The manifest for a create request: the template path (unchanged) or the owner-authored generic path. */
  private manifestFor(r: z.infer<typeof createRequestSchema>) {
    const o = this.authority.options, catalog = this.currentCatalog();
    if ('template' in r) return exampleOrgManifest({operationId: r.operationId, ownerId: o.ownerId, scopeRef: o.scopeRef, name: r.name, catalog});
    const problems = this.scopeProblems(r.defaultScopes);
    assert(!problems.length, 'kit_agent_scope_not_admitted: ' + problems.join('; '));
    return genericManifest({request: r, ownerId: o.ownerId, scopeRef: o.scopeRef, catalog});
  }
  preview(raw: unknown) {
    const r = createRequestSchema.parse(raw), catalog = this.currentCatalog();
    const {manifest, manifestHash, release} = this.manifestFor(r);
    const policy = release.launchPolicy!, profile = catalog.profiles.find(p => p.id === manifest.runtime.id)!;
    return {manifest, manifestHash,
      // What the owner reviews in plain terms; all of it is derived from the hashed definition policy + catalog entry.
      reads: policy.contract === 'kapelle.agent-launch-policy/v1' ? policy.sources.map(s => ({reader: s.reader, project: s.project, maxItems: s.maxItems})) : [],
      returns: {type: 'report' as const, classification: policy.outputs.classification},
      runtime: {id: profile.id, model: runtimeLabel(profile), harness: profile.harness.kind, locality: profile.runtime.locality},
      ...(policy.contract === 'kapelle.agent-launch-policy/v2' ? {scopes: {defaults: policy.scope.defaults, kinds: policy.scope.kinds,
        note: 'Defaults only: each Task shows the exact files from its chosen project or folder before you approve it.'}} : {}),
      effects: ['Creates one agent definition (if new) and one agent', 'No Task access and no model call until you approve a Task', 'Never sends, deploys or changes source records']};
  }
  /** The one owner approval: the manifest is recomputed here and must equal the hash the owner approved. */
  async create(raw: unknown) {
    const {manifestHash: approved, ...request} = createApprovalSchema.parse(raw), o = this.authority.options;
    const {manifest, manifestHash, release} = this.manifestFor(request as z.infer<typeof createRequestSchema>);
    assert(manifestHash === approved, 'creation_review_changed');
    approveCreation(this.ledger, {manifest, manifestHash, principalId: o.ownerId, occurredAt: (o.now ?? (() => new Date().toISOString()))()});
    const result = await provision(authorityPort(this.authority), this.ledger, manifest.operationId, release);
    return {...result, availability: await this.availability(result.instanceId)};
  }
  /** Resume creations approved but not finished (crash, lost reply). Each is independent; failures stay pending. */
  async resumeAll() {
    const out: {operationId: string; ok: boolean; error?: string}[] = [];
    for (const rec of this.manifests()) {
      if (rec.readyAt) continue;
      const o = this.authority.options;
      try {
        const m = rec.manifest;
        const release = m.contract === 'kapelle.agent-launch-manifest/v2' ? releaseOfGenericManifest(m)
          : exampleOrgManifest({operationId: m.operationId, ownerId: o.ownerId, scopeRef: o.scopeRef, name: m.name, catalog: this.currentCatalog()}).release;
        await provision(authorityPort(this.authority), this.ledger, rec.manifest.operationId, release);
        out.push({operationId: rec.manifest.operationId, ok: true});
      } catch (e) { out.push({operationId: rec.manifest.operationId, ok: false, error: e instanceof Error ? e.message : 'unknown'}); }
    }
    return out;
  }
  /** Stable kit identity for a set of native instances (one pass over the definitions): whether each runs a kit definition
   *  and that definition's launch-policy output classification. Read-only; for the /instances projection. */
  async identities(instances: readonly {definitionRef?: {contentHash?: string} | null}[]) {
    const b = this.authority.backend, byHash = new Map<string, ReleaseV2>();
    for (const id of await b.list('kapelle/agent-definition')) {
      const d = (await b.read(id, 'kapelle/agent-definition')).document;
      const r = d.state.document?.version === 2 ? releaseOfDocument(d as never) : null;
      if (r?.launchPolicy) byHash.set(r.contentHash, r);
    }
    return instances.map(i => {
      const r = i.definitionRef?.contentHash ? byHash.get(i.definitionRef.contentHash) : undefined;
      return {kitDefinition: !!r, outputClassification: r ? launchPolicySchema.parse(r.launchPolicy).outputs.classification : null};
    });
  }
  /** Read-only identity for views (Work page): availability plus whether the instance runs a kit definition and that
   *  definition's launch-policy output classification. Derived from native state; creates nothing. */
  async describe(instanceId: string): Promise<{availability: Availability; kitDefinition: boolean; outputClassification: 'owner-private' | 'project' | null; scope: {kinds: string[]; defaults: SourceScope[]} | null}> {
    const inst = (await this.authority.read(instanceId, 'kapelle/agent-instance')).state.global as {definitionRef: {contentHash: string} | null} | null;
    const b = this.authority.backend;
    let release: ReleaseV2 | null = null;
    if (inst?.definitionRef) for (const id of await b.list('kapelle/agent-definition')) {
      const d = (await b.read(id, 'kapelle/agent-definition')).document;
      const r = d.state.document?.version === 2 ? releaseOfDocument(d as never) : null;
      if (r?.launchPolicy && r.contentHash === inst.definitionRef.contentHash) { release = r; break; }
    }
    return {availability: await this.availability(instanceId), kitDefinition: !!release,
      outputClassification: release?.launchPolicy ? launchPolicySchema.parse(release.launchPolicy).outputs.classification : null,
      // AGENT-MODEL-V2: a task-selected agent's allowed scope kinds and its owner-set defaults (suggestions, never grants).
      scope: (() => { const p = release?.launchPolicy ? launchPolicySchema.parse(release.launchPolicy) : null;
        return p && p.contract === 'kapelle.agent-launch-policy/v2' ? {kinds: [...p.scope.kinds], defaults: [...p.scope.defaults]} : null; })()};
  }
  /** The agent page's "About" facts, all from the hashed release + the host catalog: purpose, the owner's instructions (v2), its
   *  own scopes with root labels (v2) or fixed readers (v1), model + where it runs, per-Task limits. Read-only; no host paths. */
  async profile(instanceId: string) {
    const inst = (await this.authority.read(instanceId, 'kapelle/agent-instance')).state.global as {name?: string; desiredState: string; definitionRef: {contentHash: string} | null};
    let release: ReleaseV2 | null = null;
    if (inst?.definitionRef) for (const id of await this.authority.backend.list('kapelle/agent-definition')) {
      const r = releaseOfDocument((await this.authority.backend.read(id, 'kapelle/agent-definition')).document as never);
      if (r?.launchPolicy && r.contentHash === inst.definitionRef.contentHash) { release = r; break; }
    }
    assert(release, 'kit_profile_not_a_kit_agent');
    const p = launchPolicySchema.parse(release!.launchPolicy);
    let runtime: {id: string; model: string; harness: string; locality: string} | null = null;
    try { const {profile} = resolveRuntime(this.currentCatalog(), p.runtime.default); runtime = {id: profile.id, model: runtimeLabel(profile), harness: profile.harness.kind, locality: profile.runtime.locality}; } catch { runtime = null; }
    const label = (rootId: string) => this.config.scopeRoots.find(r => r.id === rootId)?.label ?? rootId;
    return {instanceId, purpose: release!.purpose, instructions: p.contract === 'kapelle.agent-launch-policy/v2' ? p.brief.instructions : null,
      scopes: p.contract === 'kapelle.agent-launch-policy/v2' ? p.scope.defaults.map(sc => sc.kind === 'folder' ? {...sc, rootLabel: label(sc.rootId)} : {...sc, rootLabel: label(this.config.scopeRoots.find(r => r.projects.includes(sc.projectId))?.id ?? sc.projectId)}) : null,
      readers: p.contract === 'kapelle.agent-launch-policy/v1' ? p.sources.map(src => ({reader: src.reader, project: src.project})) : null,
      runtime, budget: p.budget.default, classification: p.outputs.classification, effectMode: p.effectMode, approvalMode: p.approvalMode};
  }
  async availability(instanceId: string): Promise<Availability> {
    const inst = (await this.authority.read(instanceId, 'kapelle/agent-instance')).state.global as never;
    const base = await this.authority.options.facts();
    const merged = await this.facts(base);
    return agentAvailability(inst, {definitions: merged.definitions as never, runtimeBindingRefs: [...merged.runtimeBindingRefs], runtimeBindingContracts: {...merged.runtimeBindingContracts}, budgetPolicyRefs: [...merged.budgetPolicyRefs]});
  }
}

/** Compose service facts with the kit (the service's facts option = this). */
export const withKitFacts = (base: () => Promise<Facts>, kit: () => KitHost | null) => async () => { const f = await base(), k = kit(); return k ? k.facts(f) : f; };
export const catalogSha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
