// AGENT-MODEL-V2 slice 1a: owner-authored generic agents (no template). Pure policy/release tests + the real runtime and
// owner routes (native-gated, synthetic): two differently named agents from one host, refusals, resume reproduces the release.
import {describe, it, expect} from 'vitest';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {context} from './fixtures.js';
import {catalogOf} from './agent-kit-double.js';
import {launchPolicySchema, launchPolicyV2Schema, sourceScopeSchema} from '../src/agent-kit/launch-policy.js';
import {genericManifest, genericRequestSchema, releaseOfGenericManifest, genericDefinitionId} from '../src/agent-kit/templates/generic.js';
import {exampleOrgRelease, EXAMPLE_ORG_POLICY} from '../src/agent-kit/templates/example-org.js';
import {kitEligibility, releaseHashV2} from '../src/agent-kit/definition-v2.js';
import {openFrameworkRuntime} from '../src/service/runtime.js';
import {frameworkHandler} from '../src/service/http.js';
import {taskSchema} from '../src/task-delegation/contract.js';
import {KitHost, withKitFacts, catalogSha256} from '../src/agent-kit/kit-host.js';
import {approveCreation} from '../src/agent-kit/create-agent.js';
import {nativePlatformFixture} from './native-platform-fixture.js';

const catalog = catalogOf();
const fantasy = (over: Record<string, unknown> = {}) => genericRequestSchema.parse({kind: 'generic', operationId: randomUUID(), name: 'Fantasy Basketball',
  purpose: 'Prepare roster and free-agent recommendations; explain assumptions; never alter my roster.', instructions: 'Cite the CSV file and row for every number.',
  defaultScopes: [{kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'}], runtime: 'claude-current', ...over});

describe('generic agents: policy v2 and release (pure)', () => {
  it('a generic manifest is kit-eligible, bounded, reproducible from the manifest alone, and its definition id is per agent', () => {
    const r = fantasy(), {manifest, manifestHash, release} = genericManifest({request: r, ownerId: 'owner', scopeRef: 'kapelle', catalog});
    expect(kitEligibility(release, catalog)).toEqual({eligible: true, problems: []});
    expect(manifest).toMatchObject({contract: 'kapelle.agent-launch-manifest/v2', name: 'Fantasy Basketball', effectMode: 'PREPARE_ONLY', classification: 'project',
      launchPolicy: {contract: 'kapelle.agent-launch-policy/v2', scope: {mode: 'task-selected', defaults: r.defaultScopes}, approvalMode: 'EACH_TASK', fallback: 'NONE'}});
    expect(releaseOfGenericManifest(manifest).contentHash).toBe(release.contentHash);
    expect(release.definitionId).toBe(genericDefinitionId(r.operationId));
    expect(genericManifest({request: fantasy(), ownerId: 'owner', scopeRef: 'kapelle', catalog}).release.definitionId).not.toBe(release.definitionId);
    expect(manifestHash).toMatch(/^sha256:/);
    // The owner's text is inside the release hash: any edit is a different release.
    const edited = {...release, launchPolicy: {...manifest.launchPolicy, brief: {...manifest.launchPolicy.brief, instructions: 'x'}}};
    expect(releaseHashV2(edited)).not.toBe(release.contentHash);
  });
  it('bounds: name 80, purpose 500, instructions 8 KiB, at most 4 default scopes, no traversal/absolute/hidden path segments, known runtime only', () => {
    expect(() => fantasy({name: 'x'.repeat(81)})).toThrow();
    expect(() => fantasy({purpose: 'x'.repeat(501)})).toThrow();
    expect(() => genericManifest({request: fantasy({instructions: 'é'.repeat(4200)}), ownerId: 'owner', scopeRef: 'kapelle', catalog})).toThrow();
    expect(() => fantasy({defaultScopes: Array.from({length: 5}, (_, i) => ({kind: 'project', projectId: 'p' + i}))})).toThrow();
    for (const relativeDirectory of ['../secrets', '/etc', 'a/../b', '.ssh', 'a//b', 'a/.env', 'x/'])
      expect(sourceScopeSchema.safeParse({kind: 'folder', rootId: 'personal', relativeDirectory}).success, relativeDirectory).toBe(false);
    expect(sourceScopeSchema.safeParse({kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball/keeper model'}).success).toBe(true);
    expect(() => genericManifest({request: fantasy({runtime: 'unknown-profile'}), ownerId: 'owner', scopeRef: 'kapelle', catalog})).toThrow(/runtime_profile_unknown/);
  });
  it('v1 template releases keep their exact parse and hash (Endale history unchanged)', () => {
    const cp = exampleOrgRelease();
    expect(launchPolicySchema.parse(EXAMPLE_ORG_POLICY)).toEqual(EXAMPLE_ORG_POLICY);
    expect(releaseHashV2(cp)).toBe(cp.contentHash);
    expect(launchPolicyV2Schema.safeParse(EXAMPLE_ORG_POLICY).success).toBe(false);
  });
});

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const TOKEN = 'synthetic-owner-credential-for-the-agent-kit-0001';
describe.skipIf(!enabled)('generic agents on the real runtime and owner routes', () => {
  it('two owner-authored agents from one host; refusals create nothing; a crashed creation resumes to the identical release', async () => {
    const platform = await nativePlatformFixture(process.env.KAPELLE_PLATFORM_MODELS_ROOT!);
    const base = context(), root = mkdtempSync(join(tmpdir(), 'agent-kit-generic-'));
    const catalogPath = join(root, 'catalog.json'); writeFileSync(catalogPath, JSON.stringify(catalogOf()), {mode: 0o600});
    const config = {contract: 'kapelle.kit-host/v1', catalogPath, catalogSha256: catalogSha256(catalogPath), stateDir: join(root, 'kit'), permissionRef: 'task-delegation:owner',
      scopeRoots: [{id: 'personal', path: join(root, 'Workspace/personal'), label: 'Personal', projects: ['personal']}, {id: 'example-org', path: join(root, 'Workspace/example-org'), label: 'Example Park', projects: ['example-org']}]};
    async function readTask(id: string) { const doc = await platform.read(id); const s = (doc.state as any).global;
      return taskSchema.parse({...s, revision: doc.operations.global.length, id, comments: s.comments ?? [], externalRefs: s.externalRefs ?? []}); }
    let kit: KitHost | null = null;
    const baseFacts = async () => ({...base, definitions: [], resources: [], dispatch: {parents: [], agents: [], tasks: [], sources: [], results: []}});
    const runtime = await openFrameworkRuntime({stateRoot: join(root, 'framework'), reactorRoot: process.env.KAPELLE_SCOPED_REACTOR_ROOT!, ownerId: 'owner', scopeRef: base.scopeRef,
      now: () => new Date().toISOString(), taskDelegation: {readTask, permissionRef: 'task-delegation:owner'}, facts: withKitFacts(baseFacts as never, () => kit)} as never);
    kit = KitHost.open(config, runtime.authority);
    const handler = frameworkHandler(runtime.authority, () => TOKEN, () => kit);
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const call = async (path: string, body?: unknown) => {
      const r = await fetch(origin + path, {method: body === undefined ? 'GET' : 'POST', headers: {authorization: 'Bearer ' + TOKEN, ...(body === undefined ? {} : {'content-type': 'application/json'})}, body: body === undefined ? undefined : JSON.stringify(body)});
      return {status: r.status, json: await r.json() as any};
    };
    const instances = async () => (await runtime.authority.backend.list('kapelle/agent-instance')).length;
    try {
      const options = (await call('/agents/options')).json;
      expect(options.runtimes.map((r: any) => r.id)).toEqual(['claude-current']);
      expect(options.scopeRoots).toEqual([{id: 'personal', label: 'Personal', projects: ['personal']}, {id: 'example-org', label: 'Example Park', projects: ['example-org']}]);
      expect(JSON.stringify(options)).not.toContain(root); // never host paths
      expect(options.privateProjects).toEqual(['finances']); // default, fails closed
      const make = async (request: Record<string, unknown>) => {
        const preview = await call('/agents/preview', request);
        expect(preview.status).toBe(200);
        return {preview, created: await call('/agents/create', {...request, manifestHash: preview.json.manifestHash})};
      };
      const fb = {kind: 'generic', operationId: randomUUID(), name: 'Fantasy Basketball', purpose: 'Prepare roster and free-agent recommendations; never alter my roster.',
        instructions: '', defaultScopes: [{kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'}], runtime: 'claude-current'};
      const cp = {kind: 'generic', operationId: randomUUID(), name: 'Neighborhood drafts', purpose: 'Draft website and newsletter content from the selected sources.',
        instructions: 'Never send anything.', defaultScopes: [{kind: 'project', projectId: 'example-org'}], runtime: 'claude-current'};
      // Refusals create nothing: unadmitted root/project, unknown runtime, a changed review.
      expect((await call('/agents/preview', {...fb, defaultScopes: [{kind: 'folder', rootId: 'dropbox', relativeDirectory: ''}]})).json.error).toMatch(/^kit_agent_scope_not_admitted/);
      expect((await call('/agents/preview', {...cp, defaultScopes: [{kind: 'project', projectId: 'finances'}]})).json.error).toMatch(/^kit_agent_scope_not_admitted/);
      expect((await call('/agents/preview', {...fb, runtime: 'other'})).status).not.toBe(200);
      const p0 = await call('/agents/preview', fb);
      expect((await call('/agents/create', {...fb, name: 'Changed', manifestHash: p0.json.manifestHash})).json.error).toBe('creation_review_changed');
      expect(await instances()).toBe(0);
      expect(p0.json.scopes).toMatchObject({defaults: fb.defaultScopes, kinds: ['project', 'folder']});
      // Two different agents, same host, no Ops step.
      const a = await make(fb), b = await make(cp);
      expect(a.created.json).toMatchObject({item: {stage: 'READY', availability: 'available'}});
      expect(b.created.json.item).toMatchObject({stage: 'READY', availability: 'available'});
      expect(a.created.json.item.instanceId).not.toBe(b.created.json.item.instanceId);
      const listed = (await call('/instances')).json.items;
      expect(listed.filter((i: any) => i.kit?.kitDefinition).map((i: any) => i.name).sort()).toEqual(['Fantasy Basketball', 'Neighborhood drafts']);
      // Crash between approval and provisioning: the ledger alone resumes to the identical, approved release.
      const c = {...fb, operationId: randomUUID(), name: 'Resumed agent'};
      const pc = await call('/agents/preview', c);
      approveCreation(kit.ledger, {manifest: pc.json.manifest, manifestHash: pc.json.manifestHash, principalId: 'owner', occurredAt: new Date().toISOString()});
      expect(await instances()).toBe(2);
      expect(await kit.resumeAll()).toEqual([{operationId: c.operationId, ok: true}]);
      expect(await instances()).toBe(3);
      const resumed = kit.ledger.get(c.operationId)!;
      expect(resumed.readyAt).not.toBeNull();
      expect(releaseOfGenericManifest(resumed.manifest as any).contentHash).toBe(pc.json.manifest.definitionRef.contentHash);
    } finally { server.close(); await runtime.close(); }
  }, 180000);
});
