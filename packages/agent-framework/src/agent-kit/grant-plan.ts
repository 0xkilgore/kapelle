// Agent launch kit, slice 4a: the per-Task grant plan (AGENT-LAUNCH-KIT §3.5).
// Before approval the plan is deterministic and NOT effective: grant ids, resources, actions and expiry are fixed from the
// draft's operation id, and the predicted recipient pin is computed by the REAL qualifiedRecipient over the instance state with
// the planned grants applied (every existing recipient check runs unchanged; same capability-hash formula). After approval the
// host materializes exactly those grants and the live pin must equal the approved one. Nothing is granted before approval.
import {canonical} from '../content.js';
import {assert} from '../validation.js';
import type {TrustedContext} from '../command-boundary.js';
import type {AgentInstanceState} from '../../document-models/agent-instance/v1/index.js';
import {qualifiedRecipient, grantPlanSchema, planSourceSchema, planSourceOf, type GrantPlan, type PlanSource} from '../task-delegation/contract.js';

/** One Task run's grants: read on the Task, receive on the host's Task-delegation permission. Ids derive from the draft's
 *  operation id, so a retry of the unchanged plan names the same grants. */
export function taskGrantPlan(o: {instanceId: string; taskId: string; permissionRef: string; operationId: string; expiresAt: string; source?: PlanSource}): GrantPlan {
  // AGENT-MODEL-V2: with a frozen source snapshot the plan is v2 (same two grants + the source); without, v1 exactly as before.
  return grantPlanSchema.parse({contract: o.source ? 'kapelle.kit-grant-plan/v2' : 'kapelle.kit-grant-plan/v1', expiresAt: o.expiresAt,
    ...(o.source ? {source: planSourceSchema.parse(o.source)} : {}), grants: [
    {id: `kit:${o.operationId}:read`, principalId: o.instanceId, resourceRef: o.taskId, actions: ['read'], expiresAt: o.expiresAt, reviewPolicy: 'ALWAYS'},
    {id: `kit:${o.operationId}:receive`, principalId: o.instanceId, resourceRef: o.permissionRef, actions: ['receive'], expiresAt: o.expiresAt, reviewPolicy: 'ALWAYS'},
  ]});
}

/** Plan grants not yet on the instance (an identical existing grant counts as materialized; a same-id different grant refuses). */
export function missingGrants(state: AgentInstanceState, plan: GrantPlan) {
  return plan.grants.filter(g => {
    const have = state.grants.find(x => x.id === g.id);
    if (!have) return true;
    assert(canonical({...have, revokedAt: null}) === canonical({...g, revokedAt: null}) && !have.revokedAt, 'kit_grant_conflict');
    return false;
  });
}

/** The instance state as it will be once the plan is materialized (grants appended in plan order, as GRANT_CAPABILITY does). */
export function withPlannedGrants(state: AgentInstanceState, plan: GrantPlan): AgentInstanceState {
  return {...state, grants: [...state.grants, ...missingGrants(state, plan).map(g => ({...g, revokedAt: null}))]} as AgentInstanceState;
}

/** The pin the owner approves: qualifiedRecipient over the planned state. Refuses a plan for another instance/Task/permission,
 *  an expired plan, or any recipient check that would fail once granted (READY, runtime, definition, model policy...). */
export function plannedRecipient(state: AgentInstanceState, ctx: TrustedContext, taskId: string, permissionRef: string, plan: GrantPlan) {
  const p = grantPlanSchema.parse(plan);
  assert(p.grants[0].principalId === state.instanceId && p.grants[1].principalId === state.instanceId &&
    p.grants[0].resourceRef === taskId && p.grants[0].actions[0] === 'read' &&
    p.grants[1].resourceRef === permissionRef && p.grants[1].actions[0] === 'receive' &&
    p.grants.every(g => g.expiresAt === p.expiresAt) && p.expiresAt > ctx.occurredAt, 'kit_grant_plan_invalid');
  return qualifiedRecipient(withPlannedGrants(state, p), ctx, taskId, permissionRef, planSourceOf(p));
}

/** After approval, under the host's command lock: materialize exactly the planned grants (deterministic operation ids, so a
 *  retry replays the same journaled command), then require the live pin to equal the approved pin before any Dispatch. */
export async function materializeGrantPlan(port: {read(id: string, type: 'kapelle/agent-instance'): Promise<{state: {global: any}}>; command(raw: unknown): Promise<unknown>},
  o: {instanceId: string; plan: GrantPlan; approvedPin: unknown; livePin: () => Promise<unknown>}): Promise<void> {
  const plan = grantPlanSchema.parse(o.plan);
  for (const g of plan.grants) {
    const state = (await port.read(o.instanceId, 'kapelle/agent-instance')).state.global as AgentInstanceState;
    if (!missingGrants(state, {...plan, grants: [g, g]}).length) continue;
    await port.command({operationId: `kit-grant:${g.id}`, documentId: o.instanceId, documentType: 'kapelle/agent-instance', expectedRevision: state.revision,
      type: 'GRANT_CAPABILITY', input: {grant: g}});
  }
  assert(canonical(await o.livePin()) === canonical(o.approvedPin), 'kit_grant_plan_pin_mismatch');
}
