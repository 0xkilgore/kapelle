// CP agent launch prerequisite 2b: an owner-authored agent on a HOSTED-API profile, through the real native runtime and kit:
// chat Q&A and a delegated Task run, each exactly one fake hosted request, reserved and settled in the spend ledger on the
// returned cost, with routed provider + usage evidence. FAKE fetch: no network, provider, account or key.
import {describe, it, expect} from 'vitest';
import {mkdtempSync, writeFileSync, realpathSync, mkdirSync, chmodSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {frameworkHandler} from '../src/service/http.js';
import {context} from './fixtures.js';
import {nativePlatformFixture} from './native-platform-fixture.js';
import {openFrameworkRuntime} from '../src/service/runtime.js';
import {taskSchema} from '../src/task-delegation/contract.js';
import {type TaskReportRequest} from '../src/task-delegation/worker-contract.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {KitHost, withKitFacts, catalogSha256} from '../src/agent-kit/kit-host.js';
import {openKitExecution} from '../src/agent-kit/kit-execution.js';
import {openKitChat} from '../src/agent-kit/chat.js';
import {runtimeCatalogSchema, claudeProfileFromBinding, profileHash} from '../src/agent-kit/runtime-catalog.js';
import {hostedProfileSchema} from '../src/agent-kit/hosted/profile.js';
import {openHostedAdapter} from '../src/agent-kit/hosted/adapter.js';
import {HostedLedger} from '../src/agent-kit/hosted/ledger.js';
import type {ClaudeAdapter} from '../src/worker/execution.js';

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const TOKEN = 'synthetic-owner-credential-for-the-agent-kit-0001';
const W4 = {model: 'claude-opus-5-5', credentialTeamId: '00000000-0000-4000-8000-000000000001', credentialKind: 'claude-code-oauth' as const, runtime: 'claude-agent-sdk' as const,
  sdkVersion: '0.2.90', cliVersion: '2.1.295', maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: 'isolated' as const, thinking: 'adaptive' as const, effort: 'high' as const};
const hosted = hostedProfileSchema.parse({id: 'hosted-sonnet', contract: 'kapelle.restricted-execution/v3', qualificationRef: 'synthetic:hosted',
  runtime: {kind: 'hosted-api', locality: 'remote-provider', model: 'anthropic/claude-sonnet-4.6', origin: 'https://openrouter.ai/api/v1', providers: ['Anthropic'],
    dataPolicy: {dataCollection: 'deny', zdr: true}, contextTokens: 200000, reasoning: 'off', tools: [], concurrencyLimit: 1, usage: 'required'},
  harness: {kind: 'hosted-openai-compatible', adapterContract: 'kapelle.hosted-api-adapter/v1'},
  pricing: {version: 'synthetic-2026-10', inputUsdPerMTok: 3, outputUsdPerMTok: 15, reservationMargin: 1.5},
  limits: {maxOutputTokens: 5000, maxBudgetUsd: 1, timeoutMs: 120000}});

function registryDouble() {
  const pubs = new Map<string, any>(); const faults = {losePublishReply: 0, readerDown: 0}; const calls = {publish: 0, lookup: 0, read: 0};
  const evidence = (r: TaskReportRequest) => {
    const driveId = 'synthetic-drive', documentId = randomUUID(), planDigest = hex('plan:' + r.publicationId);
    const author = {id: r.instanceId, label: 'Example Park', instanceId: r.instanceId, definitionId: 'example-org-preparer', definitionVersion: '1.0.0', definitionHash: hex('def')};
    return {documentId, driveId, reportRef: 'report:task:' + r.publicationId.slice(12), sourceRef: 'dispatch:' + r.dispatchId, producerId: r.instanceId, revision: 1,
      publication: {publicationId: r.publicationId, author, publisher: {id: 'service:pub', label: 'Publisher', instanceId: null, definitionId: null, definitionVersion: null, definitionHash: null},
        runRef: `kapelle-task://dispatch/${r.dispatchId}?input=${r.inputHash.slice(7)}`, sourceRef: 'dispatch:' + r.dispatchId,
        provenanceRef: `kapelle-task://execution/${r.executionHash.slice(7)}?packet=${r.packetHash.slice(7)}`, contentHash: hex(r.markdown), contentVersion: 1,
        authorizationRef: 'auth:synthetic', publishedAt: new Date().toISOString()},
      markdown: r.markdown, planDigest, verificationRef: 'private-report:' + hex(JSON.stringify({driveId, documentId, planDigest})),
      scope: {ownerId: r.ownerId, scopeRef: r.scopeRef, driveId, admissionRef: 'kit-binding'}};
  };
  const port = {bindingRef: 'kit-binding', admitted: async () => true,
    async publish(r: TaskReportRequest) { calls.publish++; let e = pubs.get(r.publicationId); if (!e) { e = evidence(r); pubs.set(r.publicationId, e); }
      if (faults.losePublishReply > 0) { faults.losePublishReply--; throw Error('lost reply (publish)'); } return structuredClone(e); },
    async lookup(r: TaskReportRequest) { calls.lookup++; return pubs.has(r.publicationId) ? structuredClone(pubs.get(r.publicationId)) : null; },
    async read(id: string) { calls.read++; if (faults.readerDown > 0) { faults.readerDown--; throw Error('reader unavailable'); } return structuredClone(pubs.get(id)); }};
  return {port, pubs, faults, calls};
}


describe.skipIf(!enabled)('hosted-api runtime through the kit (fake provider)', () => {
  it('chat and a Task run each make one hosted request, settled on the returned cost; the Report is published; no Claude is loaded', async () => {
    const platform = await nativePlatformFixture(process.env.KAPELLE_PLATFORM_MODELS_ROOT!);
    const base = context(), root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-hosted-')));
    const ws = join(root, 'Workspace'), cp = join(ws, 'example-org');
    const put = (rel: string, text: string) => { const p = join(cp, rel); mkdirSync(join(p, '..'), {recursive: true}); writeFileSync(p, text); };
    put('meetings/2026-10-08/summary.md', '# EXNA meeting (synthetic)\nDecision: Block Partyival on Oct 31.\n');
    const catalog = runtimeCatalogSchema.parse({contract: 'kapelle.runtime-catalog/v1', profiles: [claudeProfileFromBinding('claude-current', W4, 'x'), hosted]});
    const catalogPath = join(root, 'catalog.json'); writeFileSync(catalogPath, JSON.stringify(catalog), {mode: 0o600});
    const secret = join(root, 'openrouter.key'); writeFileSync(secret, 'sk-or-v1-SYNTHETIC-NOT-A-REAL-KEY\n'); chmodSync(secret, 0o600);
    const ledger = new HostedLedger(join(root, 'ledger'), {monthlyUsd: 30});
    const requests: any[] = [];
    const fakeFetch = async (url: string, init: any) => {
      requests.push({url, auth: init.headers.authorization, redirect: init.redirect, body: JSON.parse(init.body)});
      const isChat = String(JSON.parse(init.body).messages[0].content).includes('frozen copy of the agent');
      const text = isChat ? 'The meeting set the festival for Oct 31 [2026-10-08/summary.md#L2].' : '# Draft minutes (synthetic)\n\nDecision: Block Partyival on Oct 31 (summary.md line 2).\n';
      return new Response(JSON.stringify({id: 'gen-' + requests.length, model: 'anthropic/claude-sonnet-4.6', provider: 'Anthropic',
        choices: [{finish_reason: 'stop', message: {role: 'assistant', content: text}}], usage: {prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: 0.0045}}),
        {status: 200, headers: {'content-type': 'application/json'}});
    };
    const loadHostedProvider = async (hash: string) => { expect(hash).toBe(profileHash(hosted)); return openHostedAdapter({profile: hosted, secretFile: secret, ledger, fetch: fakeFetch}); };
    async function readTask(id: string) { const doc = await platform.read(id); const s = (doc.state as any).global;
      return taskSchema.parse({...s, revision: doc.operations.global.length, id, comments: s.comments ?? [], externalRefs: s.externalRefs ?? []}); }
    let kit: KitHost | null = null, exec: ReturnType<typeof openKitExecution> | null = null;
    const kitFacts = withKitFacts((async () => ({...base, definitions: [], resources: [], dispatch: {parents: [], agents: [], tasks: [], sources: [], results: []}})) as never, () => kit);
    const runtime = await openFrameworkRuntime({stateRoot: join(root, 'framework'), reactorRoot: process.env.KAPELLE_SCOPED_REACTOR_ROOT!, ownerId: 'owner', scopeRef: base.scopeRef,
      now: () => new Date().toISOString(), taskDelegation: {readTask, permissionRef: 'task-delegation:owner'},
      facts: async () => { const f = await kitFacts(); return {...f, dispatch: {...(f as any).dispatch, results: exec ? await exec.resultFacts() : []}}; }} as never);
    const reg = registryDouble();
    const noClaude: ClaudeAdapter = {sdkVersion: '0.2.90', cliVersion: '2.1.295', async run() { throw Error('claude must not be used'); }};
    try {
      const a = runtime.authority;
      kit = KitHost.open({contract: 'kapelle.kit-host/v1', catalogPath, catalogSha256: catalogSha256(catalogPath), stateDir: join(root, 'kit'), permissionRef: 'task-delegation:owner',
        workspaceRoot: ws, scopeRoots: [{id: 'cp', path: cp, label: 'Example Park', projects: ['example-org']}]}, a);
      exec = openKitExecution({root: join(root, 'workers'), authority: a, kit, token: () => TOKEN, loadProvider: async () => noClaude, loadHostedProvider, publisher: reg.port as never, checkHostPins: async () => {}, readTask});
      const req = {kind: 'generic', operationId: randomUUID(), name: 'Example Park', purpose: 'Draft meeting minutes and newsletter items from the EXNA folder.', instructions: '',
        defaultScopes: [{kind: 'folder', rootId: 'cp', relativeDirectory: 'meetings'}], runtime: 'hosted-sonnet'};
      const preview = kit.preview(req);
      expect(preview.manifest).toMatchObject({runtime: {id: 'hosted-sonnet', profileHash: profileHash(hosted)}, classification: 'project'});
      const {instanceId} = await kit.create({...req, manifestHash: preview.manifestHash});
      // Chat: one hosted request, settled.
      const chat = openKitChat({kit, authority: a, root: join(root, 'kit', 'chats'), token: () => TOKEN, loadProvider: async () => noClaude, loadHostedProvider, checkHostPins: async () => {}});
      const turn = await chat.ask(instanceId, {operationId: randomUUID(), conversationId: randomUUID(), question: 'What did the meeting decide?'});
      expect(turn).toMatchObject({status: 'ANSWERED', destination: 'cloud', model: 'Claude Sonnet 4.6', costUsd: 0.0045});
      expect(turn.citations).toEqual([expect.objectContaining({path: '2026-10-08/summary.md', startLine: 2, valid: true})]);
      // Task run: snapshot -> plan -> approve -> one hosted request -> verified Report.
      const api = new TaskProposals(a), taskId = await platform.createTask('Draft the Oct 8 minutes');
      const snap = await kit.snapshot({instanceId, scope: {kind: 'folder', rootId: 'cp', relativeDirectory: 'meetings'}});
      const op = randomUUID(), expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const roster = await a.taskDelegationAgents(taskId, {operationId: op, expiresAt, instanceId, source: snap.source});
      const ag = roster.agents.find(x => x.id === instanceId) as any;
      expect(ag).toMatchObject({available: true, grantPlan: {contract: 'kapelle.kit-grant-plan/v2'}});
      const p = (await api.create({operationId: op, draft: {operationId: op, taskId, revision: roster.task.revision, agentId: instanceId, recipient: ag.recipient, grantPlan: ag.grantPlan,
        sourceHash: roster.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: 'Draft minutes from the supplied files only.'}}))!;
      const last = p.versions.at(-1)!;
      const sent = (await api.approveAndSend(p.proposalId, {operationId: randomUUID(), expectedRevision: p.revision, version: last.version, planHash: last.planHash})).item!;
      await exec.run(sent.dispatchId); await exec.drain();
      expect((await exec.status(sent.dispatchId))?.status).toBe('REPORT_PUBLISHED');
      expect(reg.pubs.size).toBe(1);
      // Finances admission (Fable R-1): a hosted agent's outputs are 'project', never owner-private, so a private-project Task is
      // not offered to it, and a Task moved into 'finances' AFTER approval is refused at run time: no hosted request, no spend.
      const fin = await platform.createTask('Categorize October spending (synthetic)');
      await platform.act(fin, 'setProject', {expectedRevision: (await readTask(fin)).revision, projectId: 'finances'}, 'owner');
      const opF = randomUUID();
      expect((await a.taskDelegationAgents(fin, {operationId: opF, expiresAt, instanceId, source: snap.source})).agents.find(x => x.id === instanceId))
        .toMatchObject({available: false, reason: 'kit_private_task_needs_local_agent'});
      const late = await platform.createTask('Draft the Oct 8 newsletter item'), opL = randomUUID();
      const rosterL = await a.taskDelegationAgents(late, {operationId: opL, expiresAt, instanceId, source: snap.source});
      const agL = rosterL.agents.find(x => x.id === instanceId) as any;
      const pL = (await api.create({operationId: opL, draft: {operationId: opL, taskId: late, revision: rosterL.task.revision, agentId: instanceId, recipient: agL.recipient, grantPlan: agL.grantPlan,
        sourceHash: rosterL.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: 'Draft from the supplied files only.'}}))!;
      const vL = pL.versions.at(-1)!;
      const sentL = (await api.approveAndSend(pL.proposalId, {operationId: randomUUID(), expectedRevision: pL.revision, version: vL.version, planHash: vL.planHash})).item!;
      await platform.act(late, 'setProject', {expectedRevision: (await readTask(late)).revision, projectId: 'finances'}, 'owner');
      await expect(exec.run(sentL.dispatchId)).rejects.toThrow(/kit_private_task_needs_local_agent/);
      expect(requests).toHaveLength(2); // still only the chat + first Task requests
      expect(ledger.entries()).toHaveLength(2);
      // Exactly two hosted requests (chat + Task), both with the pinned routing/data policy; both settled on the returned cost.
      expect(requests).toHaveLength(2);
      for (const r of requests) expect(r.body).toMatchObject({model: 'anthropic/claude-sonnet-4.6', stream: false, provider: {order: ['Anthropic'], allow_fallbacks: false, data_collection: 'deny', zdr: true}, usage: {include: true}});
      expect(ledger.entries().map(e => [e.state, e.costUsd])).toEqual([['settled', 0.0045], ['settled', 0.0045]]);
      expect(requests[1].body.max_tokens).toBe(5000);
      for (const r of requests) expect(r).toMatchObject({url: 'https://openrouter.ai/api/v1/chat/completions', auth: 'Bearer sk-or-v1-SYNTHETIC-NOT-A-REAL-KEY', redirect: 'error'});
      // The key exists only in its secret file: no evidence, receipt, chat turn, ledger or state file carries it.
      const walk = (d: string): string[] => readdirSync(d).flatMap(n => { const f = join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
      const leaks = walk(root).filter(f => f !== secret && readFileSync(f).includes('SYNTHETIC-NOT-A-REAL-KEY'));
      expect(leaks).toEqual([]);
      // Ops reads the spend (read-only) at GET /agents/spend; a host without a hosted runtime says so.
      for (const [spend, want] of [[() => ledger.status(), 200], [undefined, 404]] as const) {
        const server = createServer((req, res) => void frameworkHandler(a, () => TOKEN, () => kit, spend)(req, res));
        await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
        try {
          const r = await fetch(`http://127.0.0.1:${(server.address() as any).port}/agents/spend`, {headers: {authorization: 'Bearer ' + TOKEN}});
          const j = await r.json() as any;
          expect(r.status).toBe(want);
          if (want === 200) { expect(j.spend).toMatchObject({monthlyCapUsd: 30, openUsd: 0, unsettled: []}); expect(j.spend.settledUsd).toBeCloseTo(0.009); }
          else expect(j.error).toBe('hosted_runtime_not_installed');
        } finally { server.close(); }
      }
    } finally { exec?.close(); await runtime.close(); }
  }, 180000);
});
