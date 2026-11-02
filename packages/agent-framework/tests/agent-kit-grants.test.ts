// Agent launch kit, slice 4a: the per-Task grant plan. Predicted before approval (not effective), materialized after approval,
// and the live pin must equal the approved pin. Real command boundary + native reducers via the shared kit double.
import {it, expect, describe, beforeEach} from 'vitest';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical, digest, type NativeDocument, type ResourceFact} from '../src/command-boundary.js';
import {qualifiedRecipient} from '../src/task-delegation/contract.js';
import {CreationLedger, approveCreation, provision} from '../src/agent-kit/create-agent.js';
import {exampleOrgManifest} from '../src/agent-kit/templates/example-org.js';
import {taskGrantPlan, plannedRecipient, missingGrants, materializeGrantPlan} from '../src/agent-kit/grant-plan.js';
import {FakeAuthority, catalogOf, OWNER, SCOPE} from './agent-kit-double.js';

const PERMISSION = 'task-delegation:human:owner:kit:v1', TASK = 'task-block-party-volunteers';
let port: FakeAuthority, instanceId: string;
const inst = () => port.docs.get(instanceId)! as NativeDocument;
const state = () => inst().state.global as any;
const ctx = () => port.ctxFor(inst());
const plan = (op = randomUUID(), expiresAt = '2026-10-16T00:00:00.000Z') => taskGrantPlan({instanceId, taskId: TASK, permissionRef: PERMISSION, operationId: op, expiresAt});
const livePin = async () => qualifiedRecipient(state(), ctx(), TASK, PERMISSION);

beforeEach(async () => {
  const ledger = new CreationLedger(join(mkdtempSync(join(tmpdir(), 'kit-grants-')), 'creations'));
  port = new FakeAuthority(catalogOf(), ledger);
  const operationId = randomUUID();
  const {manifest, manifestHash, release} = exampleOrgManifest({operationId, ownerId: OWNER, scopeRef: SCOPE, name: 'Example Park', catalog: port.catalog});
  approveCreation(ledger, {manifest, manifestHash, principalId: OWNER, occurredAt: '2026-10-15T00:00:00.000Z'});
  port.approvedManifests.push(manifest as never);
  instanceId = (await provision(port, ledger, operationId, release)).instanceId;
  // Host-admitted facts: the Task-delegation permission (shared) and this instance's admitted Task read.
  const permission: ResourceFact = {id: PERMISSION, resourceType: 'task-delegation', revision: 1, contentHash: digest('permission'), allowedActions: ['receive', 'dispatch']};
  const task: ResourceFact = {id: TASK, resourceType: 'task', revision: 3, contentHash: digest('task'), allowedActions: ['read']};
  port.resources = [permission]; port.admittedTaskReads = [{instanceId, resource: task}];
});

describe('grant plan: predicted before approval, exact after', () => {
  it('the approved (planned) pin equals the live pin once exactly the plan grants are materialized', async () => {
    const p = plan();
    const approved = plannedRecipient(state(), ctx(), TASK, PERMISSION, p);
    expect(state().grants).toEqual([]); // nothing is granted before approval
    await expect(livePin()).rejects.toThrow(); // and the live check still refuses: no standing access
    await materializeGrantPlan(port, {instanceId, plan: p, approvedPin: approved, livePin});
    expect(canonical(await livePin())).toBe(canonical(approved));
    expect(state().grants.map((g: any) => g.id)).toEqual(p.grants.map(g => g.id));
    expect(state().grants.every((g: any) => g.expiresAt === p.expiresAt && g.revokedAt === null)).toBe(true);
  });
  it('materializing is replay-safe: a crash or lost reply after either grant resumes without a duplicate', async () => {
    for (const [when, n] of [['before', 1], ['after', 1], ['after', 2]] as const) {
      const p = plan(), approved = plannedRecipient(state(), ctx(), TASK, PERMISSION, p);
      port.faults.push({when, call: 'GRANT_CAPABILITY', times: n});
      await expect(materializeGrantPlan(port, {instanceId, plan: p, approvedPin: approved, livePin})).rejects.toThrow(/injected/);
      await materializeGrantPlan(port, {instanceId, plan: p, approvedPin: approved, livePin}).catch(() => materializeGrantPlan(port, {instanceId, plan: p, approvedPin: approved, livePin}));
      expect(missingGrants(state(), p)).toEqual([]);
      expect(state().grants.filter((g: any) => p.grants.some(x => x.id === g.id))).toHaveLength(2);
    }
  });
  it('a later run keeps the earlier live receive grant in both the planned and the live pin', async () => {
    const p1 = plan(); await materializeGrantPlan(port, {instanceId, plan: p1, approvedPin: plannedRecipient(state(), ctx(), TASK, PERMISSION, p1), livePin});
    const p2 = plan(randomUUID(), '2026-10-17T00:00:00.000Z');
    const approved2 = plannedRecipient(state(), ctx(), TASK, PERMISSION, p2);
    await materializeGrantPlan(port, {instanceId, plan: p2, approvedPin: approved2, livePin});
    expect(canonical(await livePin())).toBe(canonical(approved2));
  });
});

describe('grant plan: what is refused', () => {
  it.each([
    ['a plan for another instance', () => taskGrantPlan({instanceId: 'other-instance', taskId: TASK, permissionRef: PERMISSION, operationId: randomUUID(), expiresAt: '2026-10-16T00:00:00.000Z'})],
    ['a plan for another Task', () => taskGrantPlan({instanceId, taskId: 'another-task', permissionRef: PERMISSION, operationId: randomUUID(), expiresAt: '2026-10-16T00:00:00.000Z'})],
    ['a plan for another permission', () => taskGrantPlan({instanceId, taskId: TASK, permissionRef: 'task-delegation:other', operationId: randomUUID(), expiresAt: '2026-10-16T00:00:00.000Z'})],
    ['an already-expired plan', () => plan(randomUUID(), '2026-10-14T00:00:00.000Z')],
  ])('refuses %s', (_l, make) => expect(() => plannedRecipient(state(), ctx(), TASK, PERMISSION, make())).toThrow(/kit_grant_plan_invalid/));
  it('refuses a plan for a PAUSED agent and for a runtime the host no longer offers (the recipient checks still run)', async () => {
    const p = plan();
    await port.command({operationId: randomUUID(), documentId: instanceId, documentType: 'kapelle/agent-instance', expectedRevision: state().revision, type: 'REQUEST_PAUSE', input: {}});
    expect(() => plannedRecipient(state(), ctx(), TASK, PERMISSION, p)).toThrow();
    await port.command({operationId: randomUUID(), documentId: instanceId, documentType: 'kapelle/agent-instance', expectedRevision: state().revision, type: 'REQUEST_RESUME', input: {}});
    expect(() => plannedRecipient(state(), ctx(), TASK, PERMISSION, p)).not.toThrow();
    port.catalog = catalogOf('2.1.296');
    expect(() => plannedRecipient(state(), ctx(), TASK, PERMISSION, p)).toThrow();
  });
  it('a changed instance between approval and materialization is caught: the live pin no longer matches (stale plan)', async () => {
    const p = plan(), approved = plannedRecipient(state(), ctx(), TASK, PERMISSION, p);
    const extra = taskGrantPlan({instanceId, taskId: TASK, permissionRef: PERMISSION, operationId: randomUUID(), expiresAt: '2026-10-16T00:00:00.000Z'});
    await port.command({operationId: randomUUID(), documentId: instanceId, documentType: 'kapelle/agent-instance', expectedRevision: state().revision, type: 'GRANT_CAPABILITY', input: {grant: extra.grants[1]}});
    await expect(materializeGrantPlan(port, {instanceId, plan: p, approvedPin: approved, livePin})).rejects.toThrow(/kit_grant_plan_pin_mismatch/);
  });
  it('a same-id grant with different content is a conflict, never silently reused', async () => {
    const p = plan();
    await port.command({operationId: randomUUID(), documentId: instanceId, documentType: 'kapelle/agent-instance', expectedRevision: state().revision, type: 'GRANT_CAPABILITY',
      input: {grant: {...p.grants[0], expiresAt: '2026-10-15T23:00:00.000Z'}}});
    expect(() => missingGrants(state(), p)).toThrow(/kit_grant_conflict/);
  });
  it('the host refuses to materialize a grant for a Task it has not admitted for this instance', async () => {
    port.admittedTaskReads = [];
    const p = plan();
    await expect(materializeGrantPlan(port, {instanceId, plan: p, approvedPin: {}, livePin})).rejects.toThrow(/Grant exceeds instance or document scope/);
  });
});
