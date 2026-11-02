// AGENT-MODEL-V2 slice 1c: one owner-authored agent reused across Tasks, each with its own scope frozen into the exact plan.
// Real Framework runtime on the local scoped Reactor; FAKE Claude; in-memory Registry double; a synthetic workspace.
import {describe, it, expect} from 'vitest';
import {mkdtempSync, writeFileSync, realpathSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {context} from './fixtures.js';
import {nativePlatformFixture} from './native-platform-fixture.js';
import {openFrameworkRuntime} from '../src/service/runtime.js';
import {taskSchema} from '../src/task-delegation/contract.js';
import {type TaskReportRequest} from '../src/task-delegation/worker-contract.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {KitHost, withKitFacts, catalogSha256} from '../src/agent-kit/kit-host.js';
import {openKitExecution} from '../src/agent-kit/kit-execution.js';
import type {ClaudeAdapter} from '../src/worker/execution.js';
import {catalogOf} from './agent-kit-double.js';
import {taskGrantPlan} from '../src/agent-kit/grant-plan.js';
import {createServer} from 'node:http';
import {frameworkHandler} from '../src/service/http.js';

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const TOKEN = 'synthetic-owner-credential-for-the-agent-kit-0001';

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

describe.skipIf(!enabled)('AGENT-MODEL-V2: generic agent, per-Task frozen scope, delegated from Tasks', () => {
  it('one agent, two Tasks, two scopes; runs consume only the approved snapshot; changed snapshots cannot reuse approval', async () => {
    const platform = await nativePlatformFixture(process.env.KAPELLE_PLATFORM_MODELS_ROOT!);
    const base = context(), root = realpathSync(mkdtempSync(join(tmpdir(), 'agent-v2-')));
    const ws = join(root, 'Workspace'), personal = join(ws, 'personal');
    const put = (rel: string, text: string) => { const p = join(personal, rel); mkdirSync(join(p, '..'), {recursive: true}); writeFileSync(p, text); };
    put('fantasy-basketball/available-players.csv', 'player,proj\nSynthetic A,31.2\n');
    put('fantasy-basketball/trade-analysis.md', '# Trade analysis (synthetic)\nKeep A.\n');
    put('fantasy-basketball/.env', 'LEAGUE_TOKEN=synthetic-should-never-be-read\n');
    put('notes/plan.md', '# Personal plan (synthetic)\n');
    const catalogPath = join(root, 'catalog.json'); writeFileSync(catalogPath, JSON.stringify(catalogOf()), {mode: 0o600});
    let clock = Date.now(); const now = () => new Date(clock).toISOString();
    async function readTask(id: string) { const doc = await platform.read(id); const s = (doc.state as any).global;
      return taskSchema.parse({...s, revision: doc.operations.global.length, id, comments: s.comments ?? [], externalRefs: s.externalRefs ?? []}); }
    let kit: KitHost | null = null, exec: ReturnType<typeof openKitExecution> | null = null;
    const baseFacts = async () => ({...base, definitions: [], resources: [], dispatch: {parents: [], agents: [], tasks: [], sources: [], results: []}});
    const kitFacts = withKitFacts(baseFacts as never, () => kit);
    const runtime = await openFrameworkRuntime({stateRoot: join(root, 'framework'), reactorRoot: process.env.KAPELLE_SCOPED_REACTOR_ROOT!, ownerId: 'owner', scopeRef: base.scopeRef, now,
      taskDelegation: {readTask, permissionRef: 'task-delegation:owner'},
      facts: async () => { const f = await kitFacts(); return {...f, dispatch: {...(f as any).dispatch, results: exec ? await exec.resultFacts() : []}}; }} as never);
    const reg = registryDouble();
    const prompts: string[] = [];
    const fakeClaude: ClaudeAdapter = {sdkVersion: '0.2.90', cliVersion: '2.1.295', async run(input, sessionId, _signal, capture) {
      prompts.push(input.user);
      capture.runtime({provider: 'anthropic', runtime: 'claude-agent-sdk', model: input.model, sessionId, sdkVersion: '0.2.90', cliVersion: '2.1.295', tools: []});
      const md = '# Recommendation (synthetic)\n\nSource: available-players.csv row 2.\n';
      capture.output({text: md, contentHash: hex(md), byteSize: Buffer.byteLength(md), stopReason: 'end_turn', resultId: 'synthetic', costUsd: 0});
    }};
    try {
      const a = runtime.authority;
      kit = KitHost.open({contract: 'kapelle.kit-host/v1', catalogPath, catalogSha256: catalogSha256(catalogPath), stateDir: join(root, 'kit'), permissionRef: 'task-delegation:owner',
        workspaceRoot: ws, scopeRoots: [{id: 'personal', path: personal, label: 'Personal', projects: ['personal']}]}, a);
      exec = openKitExecution({root: join(root, 'workers'), authority: a, kit, token: () => TOKEN, loadProvider: async () => fakeClaude, publisher: reg.port as never, checkHostPins: async () => {}, readTask});
      // The owner creates ONE agent (no template, no Ops step).
      const req = {kind: 'generic', operationId: randomUUID(), name: 'Fantasy Basketball', purpose: 'Prepare roster and free-agent recommendations; never alter my roster.',
        instructions: 'Cite the file for every number.', runtime: 'claude-current',
        // Owner decision (Oct 15): the agent's OWN folders/projects, fixed at creation; Tasks can use only these.
        defaultScopes: [{kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'}, {kind: 'project', projectId: 'personal'}, {kind: 'folder', rootId: 'personal', relativeDirectory: 'notes'}, {kind: 'folder', rootId: 'personal', relativeDirectory: 'secrets-only'}]};
      const {instanceId} = await kit.create({...req, manifestHash: kit.preview(req).manifestHash});
      // A v2 agent cannot be planned without a frozen source.
      const t1 = await platform.createTask('Who should I pick up this week?');
      const bare = await a.taskDelegationAgents(t1, {operationId: randomUUID(), expiresAt: new Date(clock + 3600_000).toISOString()});
      expect(bare.agents.find(x => x.id === instanceId)).toMatchObject({available: false, reason: 'kit_source_required'});
      const api = new TaskProposals(a);
      async function delegate(taskId: string, scope: any, opts: {mutateAfterApproval?: () => void} = {}) {
        const snap = await kit!.snapshot({instanceId, scope});
        const op = randomUUID(), expiresAt = new Date(clock + 3600_000).toISOString();
        const roster = await a.taskDelegationAgents(taskId, {operationId: op, expiresAt, instanceId, source: snap.source});
        const ag = roster.agents.find(x => x.id === instanceId) as any;
        expect(ag).toMatchObject({available: true, grantPlan: {contract: 'kapelle.kit-grant-plan/v2', source: snap.source}});
        const draft = {operationId: op, taskId, revision: roster.task.revision, agentId: instanceId, recipient: ag.recipient, grantPlan: ag.grantPlan,
          sourceHash: roster.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: 'Recommend pickups from the supplied files only.'};
        const p = (await api.create({operationId: op, draft}))!;
        const last = p.versions.at(-1)!;
        const sent = (await api.approveAndSend(p.proposalId, {operationId: randomUUID(), expectedRevision: p.revision, version: last.version, planHash: last.planHash})).item!;
        opts.mutateAfterApproval?.();
        await exec!.run(sent.dispatchId); await exec!.drain();
        return {snap, ag, dispatchId: sent.dispatchId, status: await exec!.status(sent.dispatchId)};
      }
      // Task 1: folder scope. The file changes AFTER approval: the run still uses the approved bytes (no reread).
      const r1 = await delegate(t1, {kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'},
        {mutateAfterApproval: () => put('fantasy-basketball/trade-analysis.md', '# Trade analysis (synthetic)\nSELL A NOW.\n')});
      expect(r1.snap.manifest.entries.map((e: any) => e.relativePath)).toEqual(['available-players.csv', 'trade-analysis.md']);
      expect(r1.snap.manifest.excluded).toEqual({secret_name: 1});
      expect(r1.status?.status).toBe('REPORT_PUBLISHED');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('kapelle-folder:personal/available-players.csv');
      expect(prompts[0]).toContain('Keep A.'); expect(prompts[0]).not.toContain('SELL A NOW'); expect(prompts[0]).not.toContain('LEAGUE_TOKEN');
      // Task 2: the SAME agent, a different scope (project -> its root). A different snapshot gives a different pin.
      const t2 = await platform.createTask('Summarize my personal plan');
      const r2 = await delegate(t2, {kind: 'project', projectId: 'personal'});
      expect(r2.status?.status).toBe('REPORT_PUBLISHED');
      expect(prompts).toHaveLength(2);
      expect(r2.ag.recipient.instanceId).toBe(instanceId);
      expect(r2.snap.manifestHash).not.toBe(r1.snap.manifestHash);
      // Finances admission: a Task in a private project (default 'finances') is never offered to, planned for, or run by a cloud agent.
      const fin = await platform.createTask('Categorize October spending (synthetic)');
      await platform.act(fin, 'setProject', {expectedRevision: (await readTask(fin)).revision, projectId: 'finances'}, 'owner');
      {
        const snapF = await kit!.snapshot({instanceId, scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'}});
        const opF = randomUUID(), expF = new Date(clock + 3600_000).toISOString();
        const rF = await a.taskDelegationAgents(fin, {operationId: opF, expiresAt: expF, instanceId, source: snapF.source});
        expect(rF.agents.find(x => x.id === instanceId)).toMatchObject({available: false, reason: 'kit_private_task_needs_local_agent'});
        const plannedElsewhere = (await a.taskDelegationAgents(t1, {operationId: opF, expiresAt: expF, instanceId, source: snapF.source})).agents.find(x => x.id === instanceId) as any;
        await expect(api.create({operationId: opF, draft: {operationId: opF, taskId: fin, revision: rF.task.revision, agentId: instanceId, recipient: plannedElsewhere.recipient,
          grantPlan: taskGrantPlan({instanceId, taskId: fin, permissionRef: 'task-delegation:owner', operationId: opF, expiresAt: expF, source: snapF.source}),
          sourceHash: rF.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: 'x'}})).rejects.toThrow(/kit_private_task_needs_local_agent/);
      }
      // ...and a Task moved into 'finances' AFTER approval is refused at claim time (nothing reaches the cloud model).
      {
        const moved = await platform.createTask('Looks harmless (synthetic)');
        const before = prompts.length;
        const snapM = await kit!.snapshot({instanceId, scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'}});
        const opM = randomUUID(), expM = new Date(clock + 3600_000).toISOString();
        const rM = await a.taskDelegationAgents(moved, {operationId: opM, expiresAt: expM, instanceId, source: snapM.source});
        const agM = rM.agents.find(x => x.id === instanceId) as any;
        const pM = (await api.create({operationId: opM, draft: {operationId: opM, taskId: moved, revision: rM.task.revision, agentId: instanceId, recipient: agM.recipient, grantPlan: agM.grantPlan,
          sourceHash: rM.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: 'Prepare it.'}}))!;
        const lastM = pM.versions.at(-1)!;
        const sentM = (await api.approveAndSend(pM.proposalId, {operationId: randomUUID(), expectedRevision: pM.revision, version: lastM.version, planHash: lastM.planHash})).item!;
        await platform.act(moved, 'setProject', {expectedRevision: (await readTask(moved)).revision, projectId: 'finances'}, 'owner');
        await expect(exec!.run(sentM.dispatchId)).rejects.toThrow(/kit_private_task_needs_local_agent/);
        expect(prompts.length).toBe(before);
        // Settle it so the agent can still be retired later in this test (cancel the unrun Dispatch).
        await a.command({operationId: randomUUID(), documentId: sentM.dispatchId, documentType: 'kapelle/dispatch',
          expectedRevision: ((await a.read(sentM.dispatchId, 'kapelle/dispatch')).state.global as any).revision, type: 'REQUEST_DISPATCH_CANCEL', input: {reason: 'synthetic: moved to finances'}}).catch(() => undefined);
      }
      // "Revise or run again": a SECOND run on Task 1 while the first run's grants are still live is planned (roster offers the
      // v2 plan, not the standing-grant pin), approved and run; the earlier grants stay as they were.
      const again = await delegate(t1, {kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'});
      expect(again.ag.grantPlan.contract).toBe('kapelle.kit-grant-plan/v2');
      expect(again.status?.status).toBe('REPORT_PUBLISHED');
      expect(prompts).toHaveLength(3);
      // A changed snapshot cannot reuse an approval: the pin is bound to the source, and a draft mixing source A with
      // the pin computed for source B is refused at proposal creation.
      const t3 = await platform.createTask('Third task');
      const a1 = await kit.snapshot({instanceId, scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'}});
      const b1 = await kit.snapshot({instanceId, scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'notes'}});
      const op = randomUUID(), expiresAt = new Date(clock + 3600_000).toISOString();
      const rA = (await a.taskDelegationAgents(t3, {operationId: op, expiresAt, instanceId, source: a1.source})).agents.find(x => x.id === instanceId) as any;
      const rB = (await a.taskDelegationAgents(t3, {operationId: op, expiresAt, instanceId, source: b1.source})).agents.find(x => x.id === instanceId) as any;
      expect(rA.recipient.capabilityHash).not.toBe(rB.recipient.capabilityHash);
      // 1e reads: the approval screen re-reads the frozen manifest by hash with the root's owner-facing label (never a path);
      // the agent's scope defaults are suggestions only.
      expect(a1.root).toEqual({id: 'personal', label: expect.any(String)});
      expect(kit.readSnapshot(a1.manifestHash)).toEqual({manifest: a1.manifest, manifestHash: a1.manifestHash, root: a1.root});
      expect(() => kit!.readSnapshot('sha256:' + '0'.repeat(64))).toThrow(/kit_manifest_not_found/);
      expect((await kit.describe(instanceId)).scope).toMatchObject({kinds: ['project', 'folder']});
      // The console reaches all of this over HTTP (owner token): snapshot, snapshot read-back, and the roster planned for a snapshot.
      const server = createServer(frameworkHandler(a, () => TOKEN, () => kit) as never);
      await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
      try {
        const origin = `http://127.0.0.1:${(server.address() as any).port}`, auth = {authorization: 'Bearer ' + TOKEN};
        const get = async (path: string) => { const r = await fetch(origin + path, {headers: auth}); return {status: r.status, json: await r.json() as any}; };
        const snapped = await fetch(origin + '/agents/snapshot', {method: 'POST', headers: {...auth, 'content-type': 'application/json'},
          body: JSON.stringify({instanceId, scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'}})}).then(r => r.json()) as any;
        expect(snapped).toMatchObject({ok: true, manifestHash: a1.manifestHash, root: {id: 'personal', label: 'Personal'}});
        expect((await get('/agents/snapshots/' + a1.manifestHash)).json).toMatchObject({ok: true, manifestHash: a1.manifestHash, manifest: a1.manifest});
        expect((await get('/agents/snapshots/sha256:' + '0'.repeat(64))).status).toBe(409);
        const planned = await get(`/task-delegations/agents?taskId=${t3}&operationId=${op}&expiresAt=${encodeURIComponent(expiresAt)}&instanceId=${instanceId}&manifestHash=${a1.manifestHash}`);
        expect(planned.status).toBe(200);
        expect(planned.json.agents.find((x: any) => x.id === instanceId)).toMatchObject({available: true, grantPlan: {contract: 'kapelle.kit-grant-plan/v2', source: a1.source}});
        expect((await get(`/agents/${instanceId}/availability`)).json.scope).toMatchObject({kinds: ['project', 'folder']});
        // The agent page's About facts (release + catalog only; root labels, never host paths).
        const prof = (await get(`/agents/${instanceId}/profile`)).json;
        expect(prof).toMatchObject({ok: true, purpose: req.purpose, instructions: req.instructions, readers: null, classification: 'project', effectMode: 'PREPARE_ONLY',
          runtime: {id: 'claude-current', model: 'Claude Opus 5.5', harness: 'claude-agent-sdk'}, budget: {maxBudgetUsd: 2}});
        expect(prof.scopes[0]).toEqual({kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball', rootLabel: 'Personal'});
        expect(JSON.stringify(prof)).not.toContain(ws);
        // The agent page's Files: the latest snapshot's top level (names + sizes, no contents, no host paths).
        const files = (await get(`/agents/${instanceId}/files`)).json.files;
        expect(files).toMatchObject({root: {id: 'personal', label: 'Personal'}, scope: {kind: 'folder'}});
        expect(files.items.every((i: any) => typeof i.name === 'string' && typeof i.byteSize === 'number' && !('content' in i))).toBe(true);
        expect(JSON.stringify(files)).not.toContain(ws);
      } finally { server.close(); }
      const roster3 = await a.taskDelegationAgents(t3, {operationId: op, expiresAt, instanceId, source: a1.source});
      await expect(api.create({operationId: op, draft: {operationId: op, taskId: t3, revision: roster3.task.revision, agentId: instanceId, recipient: rB.recipient, grantPlan: rA.grantPlan,
        sourceHash: roster3.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: 'x'}})).rejects.toThrow(/capability changed/);
      // Fable R-1: a hand-built source the host never froze (unknown manifest, or a stored manifest under another scope or
      // packet) is refused at proposal creation, before any approval or grant; the roster never offers it.
      const forged = [{...a1.source, manifestHash: 'sha256:' + '0'.repeat(64)}, {...a1.source, scope: b1.source.scope}, {...a1.source, packetHash: b1.source.packetHash}];
      for (const source of forged) {
        const o2 = randomUUID();
        const offered = (await a.taskDelegationAgents(t3, {operationId: o2, expiresAt, instanceId, source})).agents.find(x => x.id === instanceId) as any;
        expect(offered.available).toBe(false);
        await expect(api.create({operationId: o2, draft: {operationId: o2, taskId: t3, revision: roster3.task.revision, agentId: instanceId, recipient: rA.recipient,
          grantPlan: taskGrantPlan({instanceId, taskId: t3, permissionRef: 'task-delegation:owner', operationId: o2, expiresAt, source}),
          sourceHash: roster3.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: 'x'}})).rejects.toThrow(/kit_grant_plan_source_not_frozen/);
      }
      // Snapshot refusals: an unadmitted root, traversal (schema), a secrets-only folder.
      put('secrets-only/.env', 'X=1\n'); put('secrets-only/api-token.txt', 'synthetic\n');
      // Owner decision (Oct 15): a scope that is not one of the agent's own is refused before any file is read.
      await expect(kit.snapshot({instanceId, scope: {kind: 'folder', rootId: 'other', relativeDirectory: ''}})).rejects.toThrow(/kit_snapshot_scope_not_agents_own/);
      await expect(kit.snapshot({instanceId, scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball/sub'}})).rejects.toThrow(/kit_snapshot_scope_not_agents_own/);
      await expect(kit.snapshot({instanceId, scope: {kind: 'folder', rootId: 'personal', relativeDirectory: '../x'}})).rejects.toThrow();
      await expect(kit.snapshot({instanceId, scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'secrets-only'}})).rejects.toThrow(/kit_scope_scope_has_no_admissible_files/);
      expect(reg.pubs.size).toBe(3);
      // Slice 1d: retire = pause first, keep history; never with an unsettled Dispatch.
      await expect(kit.lifecycle(instanceId, 'retire', {operationId: randomUUID()})).rejects.toThrow('kit_retire_requires_pause_first');
      const t4 = await platform.createTask('Approved but not run');
      const s4 = await kit.snapshot({instanceId, scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'notes'}});
      const op4 = randomUUID(), exp4 = new Date(clock + 3600_000).toISOString();
      const ro4 = await a.taskDelegationAgents(t4, {operationId: op4, expiresAt: exp4, instanceId, source: s4.source}), ag4 = ro4.agents.find(x => x.id === instanceId) as any;
      const p4 = (await api.create({operationId: op4, draft: {operationId: op4, taskId: t4, revision: ro4.task.revision, agentId: instanceId, recipient: ag4.recipient, grantPlan: ag4.grantPlan,
        sourceHash: ro4.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: 'x'}}))!;
      const l4 = p4.versions.at(-1)!;
      const d4 = (await api.approveAndSend(p4.proposalId, {operationId: randomUUID(), expectedRevision: p4.revision, version: l4.version, planHash: l4.planHash})).item!;
      const pauseOp = randomUUID();
      expect(await kit.lifecycle(instanceId, 'pause', {operationId: pauseOp})).toEqual({instanceId, desiredState: 'PAUSED'});
      expect(await kit.lifecycle(instanceId, 'pause', {operationId: pauseOp})).toEqual({instanceId, desiredState: 'PAUSED'}); // replay-safe
      await expect(kit.lifecycle(instanceId, 'retire', {operationId: randomUUID()})).rejects.toThrow('kit_retire_unsettled_dispatch');
      await a.command({operationId: randomUUID(), documentId: d4.dispatchId, documentType: 'kapelle/dispatch',
        expectedRevision: ((await a.read(d4.dispatchId, 'kapelle/dispatch')).state.global as any).revision, type: 'REQUEST_DISPATCH_CANCEL', input: {reason: 'synthetic: not used'}}).catch(() => undefined);
      // Still not retirable while anything is offered/accepted/cancel-requested; its finished history stays attributed.
      await expect(kit.lifecycle(instanceId, 'retire', {operationId: randomUUID()})).rejects.toThrow('kit_retire_unsettled_dispatch');
      expect((await a.listDispatches({recipient: instanceId, limit: 10})).items.filter((x: any) => x.phase === 'RESULT_RECORDED')).toHaveLength(3);
      // A second agent with nothing open: pause, then retire succeeds; it is no longer offered for new work.
      const reqB = {...req, operationId: randomUUID(), name: 'Retire me'};
      const {instanceId: b} = await kit.create({...reqB, manifestHash: kit.preview(reqB).manifestHash});
      await kit.lifecycle(b, 'pause', {operationId: randomUUID()});
      // Resume is the owner's way back from a pause (replay-safe); then pause again before retiring.
      const opR = randomUUID();
      expect(await kit.lifecycle(b, 'resume', {operationId: opR})).toEqual({instanceId: b, desiredState: 'READY'});
      expect(await kit.lifecycle(b, 'resume', {operationId: opR})).toEqual({instanceId: b, desiredState: 'READY'});
      await kit.lifecycle(b, 'pause', {operationId: randomUUID()});
      expect(await kit.lifecycle(b, 'retire', {operationId: randomUUID()})).toEqual({instanceId: b, desiredState: 'RETIRED'});
      expect(await kit.availability(b)).toBe('retired');
      await expect(kit.lifecycle(b, 'resume', {operationId: randomUUID()})).rejects.toThrow('kit_lifecycle_not_paused');
      await expect(kit.snapshot({instanceId: b, scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'notes'}})).rejects.toThrow('kit_snapshot_agent_not_ready');
      // A snapshot frozen for agent A cannot be planned for agent C whose own folder is different (refused at proposal creation).
      const reqC = {...req, operationId: randomUUID(), name: 'Notes only', defaultScopes: [{kind: 'folder', rootId: 'personal', relativeDirectory: 'notes'}]};
      const {instanceId: c} = await kit.create({...reqC, manifestHash: kit.preview(reqC).manifestHash});
      const tC = await platform.createTask('Use someone else\'s files'), oC = randomUUID(), expC = new Date(clock + 3600_000).toISOString();
      const offeredC = (await a.taskDelegationAgents(tC, {operationId: oC, expiresAt: expC, instanceId: c, source: a1.source})).agents.find(x => x.id === c) as any;
      expect(offeredC.available).toBe(false);
      const rosterC = await a.taskDelegationAgents(tC, {operationId: oC, expiresAt: expC, instanceId: c, source: (await kit.snapshot({instanceId: c, scope: reqC.defaultScopes[0]})).source});
      const okC = rosterC.agents.find(x => x.id === c) as any;
      await expect(api.create({operationId: oC, draft: {operationId: oC, taskId: tC, revision: rosterC.task.revision, agentId: c, recipient: okC.recipient,
        grantPlan: taskGrantPlan({instanceId: c, taskId: tC, permissionRef: 'task-delegation:owner', operationId: oC, expiresAt: expC, source: a1.source}),
        sourceHash: rosterC.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: 'x'}})).rejects.toThrow(/kit_grant_plan_scope_not_agents_own/);
      // Creation needs at least one own folder or project.
      expect(() => kit!.preview({...req, operationId: randomUUID(), defaultScopes: []})).toThrow();
    } finally { exec?.close(); await runtime.close(); }
  }, 240000);
});
