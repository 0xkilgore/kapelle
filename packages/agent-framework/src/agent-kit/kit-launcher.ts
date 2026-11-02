// Agent kit, Fable R-4b-1: the production composition of the kit runtime (openKitRuntime) with the REAL host pins, the real
// restricted Claude adapter, and the shared Registry publisher with the deploy lock. Installed once by Ops (owner-only config
// file, pinned paths); nothing here is selected by a browser. Mirrors the pilot launcher (task-delegation/launcher.ts):
//   checkHostPins (at every claim and inside every provider run, via openKitExecution) re-verifies, fresh each time:
//     the launcher config itself (unchanged, not expired), the publisher source tree hash, the QUALIFIED_LIVE model admission
//     file (re-read + re-hashed; missing = refused), the Framework source tree hash and every dependency pin (sha256).
//   The publisher's Registry client refuses inside the kit saved-read scope (R-4b-2) and re-checks the pins on every send.
//   The publisher's authorize() derives the author from the native instance + its kit release, never from the request.
import {z} from 'zod';
import {isAbsolute, resolve, join} from 'node:path';
import {realpath, lstat, readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {canonical} from '../content.js';
import {assert} from '../validation.js';
import {privateText} from '../worker/sources.js';
import {sha} from '../worker/contracts.js';
import {loadRestrictedClaudeAdapter} from '../worker/claude-host.js';
import {publisherSourceHash, privateToken} from '../task-delegation/launcher.js';
import {kitSavedRead} from '../task-delegation/recovery.js';
import {TaskSourceClient} from '../task-delegation/task-client.js';
import type {TaskReportRequest} from '../task-delegation/worker-contract.js';
import type {PrivateTaskPublicationPort} from '../task-delegation/private-report-adapter.js';
import type {FrameworkAuthority} from '../service/authority.js';
import type {AgentInstanceState} from '../../document-models/agent-instance/v1/index.js';
import {releaseOfDocument} from './definition-v2.js';
import {OwnerPrivateReportStore} from './private-store.js';
import {localMlxProvider, localMlxHostSchema} from './local-mlx/host.js';
import {openHostedAdapter} from './hosted/adapter.js';
import {HostedLedger} from './hosted/ledger.js';
import {profileHash} from './runtime-catalog.js';
import type {HostedAdapter} from '../worker/execution.js';
import type {KitRuntimeOptions} from './kit-runtime.js';
import type {KitHost} from './kit-host.js';

const id = z.string().min(1).max(200), hash = z.string().regex(/^sha256:[a-f0-9]{64}$/), path = z.string().refine(isAbsolute, 'absolute_path_required');
const servicePublisher = z.object({id: id.regex(/^service:[A-Za-z0-9][A-Za-z0-9._:-]*$/), label: z.string().min(1), instanceId: z.null(), definitionId: z.null(), definitionVersion: z.null(), definitionHash: z.null()}).strict();
const pin = z.object({path, sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const kitLauncherSchema = z.object({
  contract: z.literal('kapelle.kit-launcher/v1'), enabled: z.literal(true), expiresAt: z.iso.datetime(),
  kitHost: z.unknown(), permissionRef: id,
  taskAuthorityUrl: z.string().url(), taskTokenFile: path,
  /** Host-approved Task Authority owner alias (as the pilot binding's taskSourceOwnerId): the Task Authority owns the owner's
   *  Tasks under this id (e.g. 'taskowner') while the Framework owner is admission.ownerId (e.g. 'human:owner'). Absent = same id. */
  taskSourceOwnerId: id.optional(),
  publisherRoot: path, publisherSourceHash: hash, receiptDir: path, lockDir: path,
  publisherUrl: z.string().url(), publisherTokenFile: path, readerUrl: z.string().url(), readerTokenFile: path,
  admission: z.object({bindingRef: id, ownerId: id, scopeRef: id, driveId: id, actorId: id, authorizationRef: id, libraryOrigin: z.string().url(), publisher: servicePublisher}).strict(),
  /** Required for the kit (a publisher without admission refuses to publish; the kit refuses to claim). */
  modelAdmission: z.object({path, sha256: hash}).strict(),
  registryDeployLock: z.object({path, timeoutMs: z.number().int().min(0).max(120000).optional()}).strict(),
  /** The deployed Framework release's own source tree (src/) and its runtime dependencies (loader, reactor entry, ...). */
  framework: z.object({root: path, sourceHash: hash}).strict(),
  dependencyPins: z.array(pin).min(1).max(64),
  /** Owner-private agents publish here (withheld from the Registry); absent = their runs stay REPORT_PENDING. */
  privateStoreDir: path.optional(),
  /** The qualified local model service (local-mlx). Absent = local-only agents refuse (kit_local_runtime_not_installed). */
  localMlx: localMlxHostSchema.optional(),
  /** CP agent launch: hosted-api runtime. The bearer key is FILE custody (owner-only, not a link); the spend ledger lives in
   *  ledgerDir with a monthly cap. Absent = hosted profiles refuse (kit_hosted_runtime_not_installed). */
  hosted: z.object({secretFile: path, ledgerDir: path, monthlyUsd: z.number().positive().max(10_000)}).strict().optional(),
}).strict();
export type KitLauncherConfig = z.infer<typeof kitLauncherSchema>;

/** The host pins, re-verified fresh on every call (K1-4). Fixed failure labels only. */
export function kitHostPins(configPath: string, c: KitLauncherConfig, now: () => string) {
  return async function checkHostPins() {
    const current = kitLauncherSchema.parse(JSON.parse(await privateText(configPath)));
    if (canonical(current) !== canonical(c) || c.expiresAt <= now()) throw Error('kit_launcher_revoked');
    if (await publisherSourceHash(c.publisherRoot) !== c.publisherSourceHash) throw Error('kit_launcher_publisher_code_changed');
    let admission: string;
    try { admission = await privateText(c.modelAdmission.path, 65536); } catch { throw Error('kit_launcher_model_admission_missing'); }
    if ('sha256:' + sha(admission) !== c.modelAdmission.sha256) throw Error('kit_launcher_model_admission_changed');
    if (await publisherSourceHash(c.framework.root) !== c.framework.sourceHash) throw Error('kit_launcher_framework_source_changed');
    for (const p of c.dependencyPins) {
      let ok = false;
      try { ok = await realpath(p.path) === resolve(p.path) && !(await lstat(p.path)).isSymbolicLink() && createHash('sha256').update(await readFile(p.path)).digest('hex') === p.sha256; } catch { ok = false; }
      if (!ok) throw Error('kit_launcher_dependency_changed');
    }
  };
}

/** claudeHost is optional (CP launch prereq 3): a hosted-only Linux host has no Claude manager/CLI or Keychain; its Claude
 *  profiles refuse at load, never at start-up. */
type Base = {runtime: KitRuntimeOptions['runtime']; workerRoot: string; token: () => string; claudeHost?: Parameters<typeof loadRestrictedClaudeAdapter>[0]};

/** Builds the kit runtime options. `attach` must be called with the opened kit runtime before any publication. */
export async function prepareKitLauncher(configPath: string, base: Base) {
  const c = kitLauncherSchema.parse(JSON.parse(await privateText(configPath)));
  const now = base.runtime.now ?? (() => new Date().toISOString()), a = c.admission;
  if (a.ownerId !== base.runtime.ownerId || a.scopeRef !== base.runtime.scopeRef) throw Error('kit_launcher_scope_invalid');
  const roots = [base.runtime.stateRoot, base.workerRoot, c.receiptDir, c.lockDir, ...(c.privateStoreDir ? [c.privateStoreDir] : []), ...(c.hosted ? [c.hosted.ledgerDir] : [])].map(v => resolve(v));
  if (roots.some((x, i) => roots.some((y, j) => i !== j && (x === y || x.startsWith(y + '/'))))) throw Error('kit_launcher_storage_overlap');
  if ([...roots, c.modelAdmission.path, configPath, ...(c.hosted ? [c.hosted.secretFile] : [])].some(p => p.includes('/Dropbox/'))) throw Error('kit_launcher_in_dropbox');
  const checkHostPins = kitHostPins(configPath, c, now);
  await checkHostPins();
  async function credentials() {
    if (c.publisherTokenFile === c.readerTokenFile) throw Error('independent_report_reader_required');
    const [writer, reader] = await Promise.all([privateToken(c.publisherTokenFile), privateToken(c.readerTokenFile)]);
    if (writer === reader) throw Error('independent_report_reader_required');
    return {writer, reader};
  }
  await credentials(); await privateToken(c.taskTokenFile);
  const {HttpReportRegistryMcp} = await import(/* @vite-ignore */ pathToFileURL(join(c.publisherRoot, 'src/mcp-client.ts')).href);
  const {PrivateTaskReportPublisher} = await import(/* @vite-ignore */ pathToFileURL(join(c.publisherRoot, 'src/task-publication.ts')).href);
  new HttpReportRegistryMcp(c.publisherUrl, (await credentials()).writer);
  new HttpReportRegistryMcp(c.readerUrl, (await credentials()).reader);
  const READS = ['getDocuments', 'getReportIdentities', 'getDocument', 'lookupReportPublicationV1', 'getReportDocumentV1', 'getRegistryDeploymentV1'];
  const client = (reader: boolean) => ({
    async call(name: string, args: Record<string, unknown>) {
      // R-4b-2: the kit saved-read scope (post-expiry status) never reaches the Registry, not even to read.
      if (kitSavedRead()) throw Error('kit_saved_read_registry_forbidden');
      if (reader && !['getDocuments', 'getDocument', 'getReportDocumentV1'].includes(name)) throw Error('independent_reader_write_forbidden');
      await checkHostPins();
      const tokens = await credentials();
      return new HttpReportRegistryMcp(reader ? c.readerUrl : c.publisherUrl, reader ? tokens.reader : tokens.writer).call(name, args);
    },
  });
  const loadAdmission = async () => {
    const text = await privateText(c.modelAdmission.path, 65536);
    if ('sha256:' + sha(text) !== c.modelAdmission.sha256) throw Error('kit_launcher_model_admission_changed');
    return {value: JSON.parse(text), endpoint: c.publisherUrl};
  };
  const modelAdmission = typeof PrivateTaskReportPublisher.prototype.publishReady === 'function' ? {load: loadAdmission} : await loadAdmission();
  let attached: {authority: FrameworkAuthority; kit: KitHost} | null = null;
  const publisher: PrivateTaskPublicationPort = new PrivateTaskReportPublisher({bindingRef: a.bindingRef, receiptDir: c.receiptDir, lockDir: c.lockDir, mcp: client(false), reader: client(true), modelAdmission,
    deployLock: {path: c.registryDeployLock.path, ...(c.registryDeployLock.timeoutMs !== undefined ? {timeoutMs: c.registryDeployLock.timeoutMs} : {})},
    authorize: async (request: TaskReportRequest) => {
      await checkHostPins();
      if (!attached || request.ownerId !== a.ownerId || request.scopeRef !== a.scopeRef || request.classification) return null; // private never goes to the Registry
      const inst = (await attached.authority.read(request.instanceId, 'kapelle/agent-instance')).state.global as AgentInstanceState;
      if (inst.instanceId !== request.instanceId || inst.ownerId !== a.ownerId || inst.scopeRef !== a.scopeRef || !inst.definitionRef) return null;
      let release = null;
      for (const docId of await attached.authority.backend.list('kapelle/agent-definition')) {
        const r = releaseOfDocument((await attached.authority.backend.read(docId, 'kapelle/agent-definition')).document as never);
        if (r?.launchPolicy && r.contentHash === inst.definitionRef.contentHash) { release = r; break; }
      }
      if (!release) return null; // only kit agents publish through this launcher
      try { attached.kit.packets.load(request.packetHash); } catch { return null; } // the run's packet was host-admitted
      return {...a, author: {id: inst.instanceId, label: inst.name ?? inst.instanceId, instanceId: inst.instanceId, definitionId: release.definitionId, definitionVersion: release.packageVersion, definitionHash: release.contentHash}};
    }});
  const ready = (publisher as unknown as {publishReady?: (driveId: string) => Promise<void>}).publishReady;
  if (typeof ready === 'function') Object.assign(publisher, {publishReady: () => ready.call(publisher, a.driveId)});
  let taskToken = await privateToken(c.taskTokenFile);
  const taskSource = new TaskSourceClient(c.taskAuthorityUrl, a.ownerId, () => taskToken, async (...args: Parameters<typeof fetch>) => {
    if (new Headers(args[1]?.headers).get('authorization') !== 'Bearer ' + taskToken) throw Error('task_token_changed');
    return fetch(...args);
  }, c.taskSourceOwnerId ?? a.ownerId, async () => { taskToken = await privateToken(c.taskTokenFile); });
  const reader = client(true);
  const kitConfig = c.kitHost as {permissionRef?: string};
  // One hosted spend ledger per host: recovered at start, shared by every hosted adapter, read by Ops via GET /agents/spend.
  const hostedLedger = c.hosted ? new HostedLedger(c.hosted.ledgerDir, {monthlyUsd: c.hosted.monthlyUsd}) : null;
  hostedLedger?.recoverAtStart();
  if (kitConfig?.permissionRef !== c.permissionRef) throw Error('kit_launcher_permission_differs');
  const options: KitRuntimeOptions = {
    runtime: base.runtime, kitConfig: c.kitHost, workerRoot: base.workerRoot, token: base.token, permissionRef: c.permissionRef,
    // The real restricted Claude adapter, loaded lazily per run (the kit execution asserts its SDK/CLI against the catalog).
    loadProvider: base.claudeHost ? () => loadRestrictedClaudeAdapter(base.claudeHost!) : async () => { throw Error('kit_claude_runtime_not_installed'); },
    publisher, reportProbe: async (documentId: string) => reader.call('getDocument', {id: documentId}),
    checkHostPins, readTask: (taskId: string) => taskSource.readTask(taskId),
    ...(c.privateStoreDir ? {privatePublisher: new OwnerPrivateReportStore(c.privateStoreDir, {ownerId: a.ownerId, scopeRef: a.scopeRef})} : {}),
    // Lazily per run/turn: plist pin + running service + qualified catalog profile, re-checked every load.
    ...(c.hosted ? {hostedSpend: () => hostedLedger!.status(), loadHostedProvider: (() => {
      const ledger = hostedLedger!, adapters = new Map<string, HostedAdapter>();
      // Only a hosted profile in the CURRENT pinned catalog with exactly this hash; one adapter per profile hash.
      return async (runtimeProfileHash: string) => {
        assert(attached, 'kit_not_attached');
        const profile = attached!.kit.catalogNow().profiles.find(p => p.runtime.kind === 'hosted-api' && profileHash(p) === runtimeProfileHash);
        assert(profile, 'kit_hosted_profile_not_admitted');
        let a = adapters.get(runtimeProfileHash);
        if (!a) { a = openHostedAdapter({profile, secretFile: c.hosted!.secretFile, ledger}); adapters.set(runtimeProfileHash, a); }
        return a;
      };
    })()} : {}),
    ...(c.localMlx ? {loadLocalProvider: localMlxProvider({config: c.localMlx, catalog: () => { assert(attached, 'kit_not_attached'); return attached!.kit.catalogNow(); }})} : {}),
  };
  return {options, checkHostPins, taskSource, attach(rt: {authority: FrameworkAuthority; kit: KitHost}) { attached = rt; }};
}
