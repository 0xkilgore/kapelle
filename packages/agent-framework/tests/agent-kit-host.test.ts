// Agent launch kit, slice 3b: host wiring on the REAL Framework runtime + the real owner HTTP handler (native-gated, synthetic).
import {describe, it, expect} from 'vitest';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {context} from './fixtures.js';
import {nativePlatformFixture} from './native-platform-fixture.js';
import {openFrameworkRuntime} from '../src/service/runtime.js';
import {frameworkHandler} from '../src/service/http.js';
import {taskSchema} from '../src/task-delegation/contract.js';
import {KitHost, withKitFacts, catalogSha256} from '../src/agent-kit/kit-host.js';
import {approveCreation} from '../src/agent-kit/create-agent.js';
import {exampleOrgManifest} from '../src/agent-kit/templates/example-org.js';
import {catalogOf} from './agent-kit-double.js';

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const TOKEN = 'synthetic-owner-credential-for-the-agent-kit-0001';

describe.skipIf(!enabled)('Agent kit host wiring (real runtime, real owner routes)', () => {
  it('templates -> preview -> one approval -> available agent; roster planning via merged facts; refusals; resume at start', async () => {
    const platform = await nativePlatformFixture(process.env.KAPELLE_PLATFORM_MODELS_ROOT!);
    const base = context(), root = mkdtempSync(join(tmpdir(), 'agent-kit-host-'));
    const catalogPath = join(root, 'catalog.json');
    writeFileSync(catalogPath, JSON.stringify(catalogOf()), {mode: 0o600});
    const config = {contract: 'kapelle.kit-host/v1', catalogPath, catalogSha256: catalogSha256(catalogPath), stateDir: join(root, 'kit'), permissionRef: 'task-delegation:owner'};
    async function readTask(id: string) {
      const doc = await platform.read(id); const s = (doc.state as any).global;
      return taskSchema.parse({...s, revision: doc.operations.global.length, id, comments: s.comments ?? [], externalRefs: s.externalRefs ?? []});
    }
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
    try {
      expect((await call('/agents/templates')).json.items.map((t: any) => t.id)).toEqual(['example-org']);
      const req = {template: 'example-org', name: 'Example Park', operationId: randomUUID()};
      const preview = await call('/agents/preview', req);
      expect(preview.status).toBe(200);
      expect(preview.json.manifest).toMatchObject({name: 'Example Park', effectMode: 'PREPARE_ONLY', ownerId: 'owner'});
      // The approval must name the reviewed hash; anything else is refused and nothing is created.
      const wrong = await call('/agents/create', {...req, manifestHash: 'sha256:' + '0'.repeat(64)});
      expect(wrong).toMatchObject({status: 409, json: {error: 'creation_review_changed'}});
      expect(await runtime.authority.backend.list('kapelle/agent-instance')).toHaveLength(0);
      const created = await call('/agents/create', {...req, manifestHash: preview.json.manifestHash});
      expect(created.status).toBe(200);
      expect(created.json.item).toMatchObject({stage: 'READY', availability: 'available'});
      // Idempotent: the same approval again returns the same agent.
      expect((await call('/agents/create', {...req, manifestHash: preview.json.manifestHash})).json.item.instanceId).toBe(created.json.item.instanceId);
      expect(await runtime.authority.backend.list('kapelle/agent-instance')).toHaveLength(1);
      expect((await call(`/agents/${created.json.item.instanceId}/availability`)).json).toEqual({ok: true, availability: 'available', kitDefinition: true, outputClassification: 'project', scope: null});
      // A fixed-project (v1 template) agent such as Endale: readers, no own folder scopes, no owner instructions.
      expect((await call(`/agents/${created.json.item.instanceId}/profile`)).json).toMatchObject({ok: true, instructions: null, scopes: null, effectMode: 'PREPARE_ONLY',
        readers: [{reader: 'task', project: 'example-org'}, {reader: 'inbox-item', project: 'example-org'}, {reader: 'website-content', project: 'example-org'}, {reader: 'report', project: 'example-org'}]});
      // Carry-forward (Astra): the native instance projection itself carries the stable kit identity.
      const listed = (await call('/instances')).json.items.find((i: any) => i.instanceId === created.json.item.instanceId);
      expect(listed.kit).toEqual({kitDefinition: true, outputClassification: 'project'});

      // The merged facts let the Task roster plan for the kit agent (permission resource + kit proofs + runtime binding).
      const roster = await runtime.authority.taskDelegationAgents(platform.taskId, {operationId: randomUUID(), expiresAt: new Date(Date.now() + 3600_000).toISOString()});
      expect(roster.agents.find(x => x.id === created.json.item.instanceId)).toMatchObject({available: true});

      // Resume at start: an approved creation whose provisioning never ran is finished by resumeAll, once.
      const op2 = randomUUID(), m2 = exampleOrgManifest({operationId: op2, ownerId: 'owner', scopeRef: base.scopeRef, name: 'CP second', catalog: catalogOf()});
      approveCreation(kit.ledger, {manifest: m2.manifest, manifestHash: m2.manifestHash, principalId: 'owner', occurredAt: new Date().toISOString()});
      expect((await kit.resumeAll())).toEqual([{operationId: op2, ok: true}]);
      expect(await kit.resumeAll()).toEqual([]);
      expect(await runtime.authority.backend.list('kapelle/agent-instance')).toHaveLength(2);

      // An edited catalog file fails closed: no preview, and kit facts stop (agents show unavailable, nothing substituted).
      writeFileSync(catalogPath, JSON.stringify(catalogOf('2.1.296')), {mode: 0o600});
      expect((await call('/agents/preview', {...req, operationId: randomUUID()})).status).not.toBe(200);
    } finally { server.closeAllConnections(); await new Promise<void>(ok => server.close(() => ok())); await runtime.close(); }
  }, 180_000);
});
