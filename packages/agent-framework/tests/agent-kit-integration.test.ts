// Agent launch kit, slices 3+4a on the REAL Framework runtime (native backend on the scoped Reactor; synthetic data only):
// Create agent (one approval, provisioned READY with zero grants) -> Task proposal with a grant plan -> approve -> grants
// materialized exactly as planned -> the existing Dispatch path. Native-gated like the other Task workflow tests.
import {describe, it, expect} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {context} from './fixtures.js';
import {nativePlatformFixture} from './native-platform-fixture.js';
import {openFrameworkRuntime} from '../src/service/runtime.js';
import {digest, type ModelType} from '../src/command-boundary.js';
import {taskSchema} from '../src/task-delegation/contract.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {CreationLedger, approveCreation, provision, type ProvisionPort} from '../src/agent-kit/create-agent.js';
import {kitHostFacts} from '../src/agent-kit/host-facts.js';
import {exampleOrgManifest} from '../src/agent-kit/templates/example-org.js';
import {catalogOf} from './agent-kit-double.js';

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const OWNER = 'owner', PERMISSION = 'task-delegation:owner';

describe.skipIf(!enabled)('Agent kit on the real Framework runtime', () => {
  it('create agent -> plan with grants -> approve -> exact grants -> Dispatch; nothing granted before approval', async () => {
    const platform = await nativePlatformFixture(process.env.KAPELLE_PLATFORM_MODELS_ROOT!);
    const base = context(), catalog = catalogOf(), root = mkdtempSync(join(tmpdir(), 'agent-kit-int-'));
    const operationId = randomUUID();
    const {manifest, manifestHash, release} = exampleOrgManifest({operationId, ownerId: OWNER, scopeRef: base.scopeRef, name: 'Example Park', catalog});
    const kit = kitHostFacts([release], catalog, [manifest]);
    const permission = {id: PERMISSION, resourceType: 'task-delegation', revision: 1, contentHash: digest('permission'), allowedActions: ['receive', 'dispatch']};
    async function readTask(id: string) {
      const doc = await platform.read(id); const s = (doc.state as any).global;
      return taskSchema.parse({...s, revision: doc.operations.global.length, id, comments: s.comments ?? [], externalRefs: s.externalRefs ?? []});
    }
    const runtime = await openFrameworkRuntime({stateRoot: join(root, 'framework'), reactorRoot: process.env.KAPELLE_SCOPED_REACTOR_ROOT!, ownerId: OWNER, scopeRef: base.scopeRef,
      now: () => new Date().toISOString(), taskDelegation: {readTask, permissionRef: PERMISSION},
      facts: async () => ({...base, ...kit, resources: [permission], dispatch: {parents: [], agents: [], tasks: [], sources: [], results: []}})} as never);
    try {
      const a = runtime.authority;
      const port: ProvisionPort = {
        allocate: async (op, type, name, v) => (await a.allocate(op, type as ModelType, name, v)).documentId,
        read: (id, type) => a.read(id, type as ModelType) as never,
        command: raw => a.command(raw),
      };
      const ledger = new CreationLedger(join(root, 'creations'));
      approveCreation(ledger, {manifest, manifestHash, principalId: OWNER, occurredAt: new Date().toISOString()});
      const {instanceId} = await provision(port, ledger, operationId, release);
      const inst = async () => (await a.read(instanceId, 'kapelle/agent-instance')).state.global as any;
      expect((await inst()).desiredState).toBe('READY');
      expect((await inst()).grants).toEqual([]);

      // Without a plan the kit agent is listed as needing one; with the draft's operation id it gets a planned pin.
      const taskId = platform.taskId;
      expect((await a.taskDelegationAgents(taskId)).agents.find(x => x.id === instanceId)).toMatchObject({available: false, reason: 'kit_plan_required'});
      const draftOp = randomUUID(), expiresAt = new Date(Date.now() + 6 * 3600_000).toISOString();
      const roster = await a.taskDelegationAgents(taskId, {operationId: draftOp, expiresAt});
      const agent = roster.agents.find(x => x.id === instanceId) as any;
      expect(agent).toMatchObject({available: true});
      expect(agent.grantPlan.grants.map((g: any) => g.id)).toEqual([`kit:${draftOp}:read`, `kit:${draftOp}:receive`]);

      const api = new TaskProposals(a);
      const draft = {operationId: draftOp, taskId, revision: roster.task.revision, agentId: instanceId, recipient: agent.recipient, grantPlan: agent.grantPlan,
        sourceHash: roster.task.sourceHash, includeNotes: true, includeComments: true, includeReferences: true};
      // A plan that is not the one derived from this draft is refused (here: a different expiry under the same pin).
      await expect(api.create({operationId: draftOp, draft: {...draft, grantPlan: {...agent.grantPlan, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        grants: agent.grantPlan.grants.map((g: any) => ({...g, expiresAt: new Date(Date.now() + 3600_000).toISOString()}))}}})).rejects.toThrow();
      // A self-consistent plan + pin derived from ANOTHER operation id is refused: grants must be named by this draft.
      const foreign = (await a.taskDelegationAgents(taskId, {operationId: randomUUID(), expiresAt})).agents.find(x => x.id === instanceId) as any;
      await expect(api.create({operationId: draftOp, draft: {...draft, recipient: foreign.recipient, grantPlan: foreign.grantPlan}})).rejects.toThrow(/kit_grant_plan_not_derived_from_draft/);
      const proposal = (await api.create({operationId: draftOp, draft}))!;
      expect((await inst()).grants).toEqual([]); // proposing grants nothing
      const last = proposal.versions.at(-1)!;
      const sent = await api.approveAndSend(proposal.proposalId, {operationId: randomUUID(), expectedRevision: proposal.revision, version: last.version, planHash: last.planHash});
      expect(sent.item?.approval?.planHash).toBe(last.planHash);
      const grants = (await inst()).grants;
      expect(grants.map((g: any) => g.id)).toEqual(agent.grantPlan.grants.map((g: any) => g.id));
      expect(grants.every((g: any) => g.expiresAt === expiresAt && g.revokedAt === null)).toBe(true);
      expect(await a.backend.list('kapelle/dispatch')).toHaveLength(1);
      // Replaying the approval (lost reply) creates nothing new.
      await api.approveAndSend(proposal.proposalId, {operationId: sent.item!.approval!.operationId, expectedRevision: proposal.revision, version: last.version, planHash: last.planHash}).catch(() => undefined);
      expect((await inst()).grants).toHaveLength(2);
      expect(await a.backend.list('kapelle/dispatch')).toHaveLength(1);
    } finally { await runtime.close(); }
  }, 120_000);
});
