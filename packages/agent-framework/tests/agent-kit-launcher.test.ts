// Fable R-4b-1/R-4b-2: the kit launcher's REAL host pins refuse a kit claim (changed publisher source, missing/changed model
// admission, Framework source drift) with zero provider calls; the Registry client refuses inside the kit saved-read scope;
// the publisher author is derived from the native instance + kit release. Native-gated (real kit runtime on the local
// Reactor); stub publisher modules in a temp publisher root (the same loading path as production); fake Claude.
import {describe, it, expect} from 'vitest';
import {mkdtempSync, realpathSync, writeFileSync, mkdirSync, rmSync, appendFileSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {nativePlatformFixture} from './native-platform-fixture.js';
import {context} from './fixtures.js';
import {catalogOf} from './agent-kit-double.js';
import {catalogSha256} from '../src/agent-kit/kit-host.js';
import {prepareKitLauncher} from '../src/agent-kit/kit-launcher.js';
import {openKitRuntime} from '../src/agent-kit/kit-runtime.js';
import {publisherSourceHash} from '../src/task-delegation/launcher.js';
import {withKitSavedRead} from '../src/task-delegation/recovery.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {taskSchema} from '../src/task-delegation/contract.js';
import {packetTaskNotes, type TaskSourcePacket} from '../src/task-delegation/worker-contract.js';
import type {ClaudeAdapter} from '../src/worker/execution.js';

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const KEY = '__kapelleKitLauncherFixture';

describe.skipIf(!enabled)('kit launcher (R-4b-1/R-4b-2): real host pins at claim, saved-read Registry guard, native author', () => {
  it('refuses a claim on publisher/admission/framework drift with no provider call; publishes with the native author when pinned', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-launcher-'))); chmodSync(root, 0o700);
    const write = (name: string, value: string) => { const p = join(root, name); writeFileSync(p, value, {mode: 0o600}); return p; };
    // Stub publisher root (production loads src/mcp-client.ts + src/task-publication.ts from the pinned tree).
    const pub = join(root, 'publisher'); mkdirSync(join(pub, 'src'), {recursive: true});
    writeFileSync(join(pub, 'src/mcp-client.ts'), `export class HttpReportRegistryMcp { constructor(u,t){} async call(name,args){ return globalThis.${KEY}.call(name,args); } }`);
    writeFileSync(join(pub, 'src/task-publication.ts'), `export class PrivateTaskReportPublisher {
      constructor(o){ this.o=o; this.bindingRef=o.bindingRef; }
      async publishReady(){}
      async admitted(r){ return !!(await this.o.authorize(r)); }
      async publish(r){ const a=await this.o.authorize(r); if(!a) throw Error('not admitted'); await this.o.mcp.call('publishReport',{}); return globalThis.${KEY}.publish(r,a); }
      async lookup(r){ return globalThis.${KEY}.lookup(r); }
      async read(id){ await this.o.reader.call('getDocument',{id}); return globalThis.${KEY}.read(id); } }`);
    const fw = join(root, 'framework'); mkdirSync(join(fw, 'src'), {recursive: true}); writeFileSync(join(fw, 'src/index.ts'), 'export {};');
    const dep = write('dep.mjs', 'export {}');
    const admissionText = JSON.stringify({contract: 'synthetic-model-admission', status: 'QUALIFIED_LIVE'});
    const admissionPath = write('model-admission.json', admissionText);
    const catalogPath = write('catalog.json', JSON.stringify(catalogOf()));
    const base = context(), PERMISSION = 'task-delegation:owner';
    const config = {contract: 'kapelle.kit-launcher/v1', enabled: true, expiresAt: '2099-01-01T00:00:00.000Z',
      kitHost: {contract: 'kapelle.kit-host/v1', catalogPath, catalogSha256: catalogSha256(catalogPath), stateDir: join(root, 'kit'), permissionRef: PERMISSION}, permissionRef: PERMISSION,
      taskAuthorityUrl: 'http://127.0.0.1:1', taskTokenFile: write('task.token', 't'.repeat(40)),
      publisherRoot: pub, publisherSourceHash: await publisherSourceHash(pub), receiptDir: join(root, 'receipts'), lockDir: join(root, 'locks'),
      publisherUrl: 'http://127.0.0.1:1/mcp', publisherTokenFile: write('writer.token', 'w'.repeat(40)), readerUrl: 'http://127.0.0.1:1/mcp', readerTokenFile: write('reader.token', 'r'.repeat(40)),
      admission: {bindingRef: 'kit-binding', ownerId: 'owner', scopeRef: base.scopeRef, driveId: 'drive', actorId: 'actor', authorizationRef: 'auth', libraryOrigin: 'http://127.0.0.1:3000',
        publisher: {id: 'service:publisher', label: 'Publisher', instanceId: null, definitionId: null, definitionVersion: null, definitionHash: null}},
      modelAdmission: {path: admissionPath, sha256: 'sha256:' + hex(admissionText)}, registryDeployLock: {path: join(root, 'deploy.lock'), timeoutMs: 300},
      framework: {root: fw, sourceHash: await publisherSourceHash(fw)}, dependencyPins: [{path: dep, sha256: hex('export {}')}]};
    const configPath = write('kit-launcher.json', JSON.stringify(config));
    // Registry double behind the stub publisher; records the author the launcher authorized.
    const pubs = new Map<string, any>(), registryCalls: string[] = [], authors: any[] = [];
    (globalThis as any)[KEY] = {
      async call(name: string) { registryCalls.push(name); return {}; },
      async publish(r: any, a: any) { authors.push(a.author); let e = pubs.get(r.publicationId); if (!e) { const documentId = randomUUID(), driveId = 'drive', planDigest = hex('plan:' + r.publicationId);
        e = {documentId, driveId, reportRef: 'report:task:' + r.publicationId.slice(12), sourceRef: 'dispatch:' + r.dispatchId, producerId: r.instanceId, revision: 1,
          publication: {publicationId: r.publicationId, author: {...a.author, definitionHash: a.author.definitionHash.slice(7)}, publisher: a.publisher,
            runRef: `kapelle-task://dispatch/${r.dispatchId}?input=${r.inputHash.slice(7)}`, sourceRef: 'dispatch:' + r.dispatchId, provenanceRef: `kapelle-task://execution/${r.executionHash.slice(7)}?packet=${r.packetHash.slice(7)}`,
            contentHash: hex(r.markdown), contentVersion: 1, authorizationRef: a.authorizationRef, publishedAt: new Date().toISOString()},
          markdown: r.markdown, planDigest, verificationRef: 'private-report:' + hex(JSON.stringify({driveId, documentId, planDigest})), scope: {ownerId: r.ownerId, scopeRef: r.scopeRef, driveId, admissionRef: 'kit-binding'}};
        pubs.set(r.publicationId, e); } return structuredClone(e); },
      async lookup(r: any) { return pubs.has(r.publicationId) ? structuredClone(pubs.get(r.publicationId)) : null; },
      async read(id: string) { return structuredClone(pubs.get(id)); }};
    const platform = await nativePlatformFixture(process.env.KAPELLE_PLATFORM_MODELS_ROOT!);
    async function readTask(id: string) { const doc = await platform.read(id); const s = (doc.state as any).global;
      return taskSchema.parse({...s, revision: doc.operations.global.length, id, comments: s.comments ?? [], externalRefs: s.externalRefs ?? []}); }
    let providerCalls = 0;
    const fakeClaude: ClaudeAdapter = {sdkVersion: '0.2.90', cliVersion: '2.1.295', async run(input, sessionId, _s, capture) {
      providerCalls++;
      capture.runtime({provider: 'anthropic', runtime: 'claude-agent-sdk', model: input.model, sessionId, sdkVersion: '0.2.90', cliVersion: '2.1.295', tools: []});
      const md = '# Volunteer reminder (DRAFT, not sent)\n';
      capture.output({text: md, contentHash: hex(md), byteSize: Buffer.byteLength(md), stopReason: 'end_turn', resultId: 'synthetic', costUsd: 0});
    }};
    const runtimeOptions = {stateRoot: join(root, 'native'), reactorRoot: process.env.KAPELLE_SCOPED_REACTOR_ROOT!, ownerId: 'owner', scopeRef: base.scopeRef,
      facts: async () => ({...base, definitions: [], resources: [], dispatch: {parents: [], agents: [], tasks: [], sources: [], results: []}})} as never;
    const prepared = await prepareKitLauncher(configPath, {runtime: runtimeOptions as never, workerRoot: join(root, 'workers'), token: () => 'o'.repeat(40),
      claudeHost: {managerRoot: '/not-used', cliPath: '/not-used', runtimeRoot: join(root, 'claude')}});
    expect(prepared.options.loadProvider).toBeTypeOf('function'); // production: the real restricted adapter (replaced here only)
    // CP launch prereq 3: a hosted-only host (no Claude manager/CLI, no Keychain) starts; a Claude load refuses at use, not at start.
    const hostedOnly = await prepareKitLauncher(configPath, {runtime: runtimeOptions as never, workerRoot: join(root, 'workers-hosted-only'), token: () => 'o'.repeat(40)});
    await expect(hostedOnly.options.loadProvider()).rejects.toThrow('kit_claude_runtime_not_installed');
    const kitRuntime = await openKitRuntime({...prepared.options, readTask, loadProvider: async () => fakeClaude});
    prepared.attach(kitRuntime);
    try {
      const a = kitRuntime.authority, kit = kitRuntime.kit;
      const req = {template: 'example-org', name: 'Example Park', operationId: randomUUID()};
      const {instanceId} = await kit.create({...req, manifestHash: kit.preview(req).manifestHash});
      async function approvedDispatch() {
        const taskId = await platform.createTask('Volunteer reminder ' + randomUUID().slice(0, 4));
        const text = 'block partyIVAL (synthetic) ' + randomUUID();
        const packet: TaskSourcePacket = {contract: 'kapelle.task-source-packet/v1', sources: [{document: {id: randomUUID(), version: 1, hash: hex(text), title: 'Flyer (synthetic)', project: 'example-org', mimeType: 'text/markdown', content: text},
          reference: 'kapelle:synthetic:flyer', capturedAt: '2026-10-13T17:14:59.000Z'}]};
        kit.packets.admit(packet);
        let t = await readTask(taskId); await platform.act(taskId, 'setProject', {expectedRevision: t.revision, projectId: 'example-org'}, 'owner');
        t = await readTask(taskId); await platform.act(taskId, 'updateBody', {expectedRevision: t.revision, bodyMarkdown: packetTaskNotes(packet, 'Draft only.')}, 'owner');
        const op = randomUUID(), expiresAt = new Date(Date.now() + 3600_000).toISOString();
        const roster = await a.taskDelegationAgents(taskId, {operationId: op, expiresAt}); const ag = roster.agents.find(x => x.id === instanceId) as any;
        const api = new TaskProposals(a);
        const p = (await api.create({operationId: op, draft: {operationId: op, taskId, revision: roster.task.revision, agentId: instanceId, recipient: ag.recipient, grantPlan: ag.grantPlan,
          sourceHash: roster.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: 'Draft the reminder. Draft only; never send.'}}))!;
        const last = p.versions.at(-1)!;
        return (await api.approveAndSend(p.proposalId, {operationId: randomUUID(), expectedRevision: p.revision, version: last.version, planHash: last.planHash})).item!.dispatchId;
      }
      // 1. Publisher source changed -> claim refused, nothing invoked.
      const d1 = await approvedDispatch();
      appendFileSync(join(pub, 'src/task-publication.ts'), '\n// drift\n');
      await expect(kitRuntime.exec.run(d1)).rejects.toThrow(/kit_launcher_publisher_code_changed/);
      expect(providerCalls).toBe(0);
      writeFileSync(join(pub, 'src/task-publication.ts'), (await import('node:fs')).readFileSync(join(pub, 'src/task-publication.ts'), 'utf8').replace('\n// drift\n', ''));
      // 2. Model admission missing -> refused; changed -> refused.
      rmSync(admissionPath);
      await expect(kitRuntime.exec.run(d1)).rejects.toThrow(/kit_launcher_model_admission_missing/);
      write('model-admission.json', admissionText + ' ');
      await expect(kitRuntime.exec.run(d1)).rejects.toThrow(/kit_launcher_model_admission_changed/);
      write('model-admission.json', admissionText);
      // 3. Framework source drift -> refused.
      writeFileSync(join(fw, 'src/index.ts'), 'export const x = 1;');
      await expect(kitRuntime.exec.run(d1)).rejects.toThrow(/kit_launcher_framework_source_changed/);
      writeFileSync(join(fw, 'src/index.ts'), 'export {};');
      expect(providerCalls).toBe(0);
      // 4. R-4b-2: inside the kit saved-read scope the Registry client refuses before any call.
      const before = registryCalls.length;
      await expect(withKitSavedRead(d1, () => prepared.options.reportProbe!(randomUUID()))).rejects.toThrow(/kit_saved_read_registry_forbidden/);
      expect(registryCalls.length).toBe(before);
      // 5. Pinned again: the run publishes; the author is the native instance + its kit release.
      await kitRuntime.exec.run(d1); await kitRuntime.exec.drain();
      const s = await kitRuntime.exec.status(d1);
      expect(s?.status).toBe('REPORT_PUBLISHED');
      expect(providerCalls).toBe(1);
      expect(authors[0]).toMatchObject({id: instanceId, instanceId, definitionId: 'example-org-preparer', definitionVersion: '1.0.0'});
      // Live regression (2026-10-15): the Task Authority owns the owner's Tasks under an alias ('taskowner') while the Framework
      // owner is another id. Without the host-approved alias every kit Task read failed 'Task identity or owner differs' (409s
      // on /task-executions/kit/admission and /task-delegations/agents); with it the read maps to the Framework owner.
      const authorityTask = await readTask(platform.taskId);
      const {createServer} = await import('node:http');
      const authority = createServer((rq, rs) => { rs.writeHead(200, {'content-type': 'application/json'}); rs.end(JSON.stringify({...authorityTask, ownerId: 'taskowner'})); });
      await new Promise<void>(r => authority.listen(0, '127.0.0.1', () => r()));
      try {
        const url = `http://127.0.0.1:${(authority.address() as any).port}`;
        const variant = async (name: string, extra: Record<string, unknown>) => {
          const path = write(name, JSON.stringify({...config, taskAuthorityUrl: url, ...extra}));
          return prepareKitLauncher(path, {runtime: runtimeOptions as never, workerRoot: join(root, 'workers-' + name), token: () => 'o'.repeat(40), claudeHost: {managerRoot: '/not-used', cliPath: '/not-used', runtimeRoot: join(root, 'claude')}});
        };
        await expect((await variant('no-alias.json', {})).options.readTask(platform.taskId)).rejects.toThrow('Task identity or owner differs');
        const aliased = await (await variant('alias.json', {taskSourceOwnerId: 'taskowner'})).options.readTask(platform.taskId);
        expect(aliased).toMatchObject({id: platform.taskId, ownerId: 'owner'});
      } finally { authority.close(); }
    } finally { await kitRuntime.close(); delete (globalThis as any)[KEY]; }
  }, 180000);
});
