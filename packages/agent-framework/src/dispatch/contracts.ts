import {activeRecovery,recoveryFor} from '../task-delegation/recovery.js';
import {pilotAccess,pilotOffer} from '../task-delegation/pilot.js';
import { createHash } from "node:crypto";
import type {
  DispatchOffer,
  DispatchOfferInput,
  DispatchState,
} from "../../document-models/dispatch/v1/index.js";
import type { AgentInstanceState } from "../../document-models/agent-instance/v1/index.js";
import type { TrustedContext } from "../command-boundary.js";
import { canonical, digest } from "../content.js";
import { assert, timestamp } from "../validation.js";

export function dispatchOfferHash(input: DispatchOfferInput) {
  const { contentHash: _, ...rest } = input;
  return digest({
    ...rest,
    senderAgent: rest.senderAgent ?? null,
    parentDispatchRef: rest.parentDispatchRef ?? null,
    parentContentHash: rest.parentContentHash ?? null,
    continuationOfRef: rest.continuationOfRef ?? null,
  });
}
export const instructionsHash = (text: string) =>
  "sha256:" + createHash("sha256").update(text).digest("hex");
export interface DispatchFacts {
  /** Native reads, supplied by the host after traversing requested lineage. */
  parents: readonly DispatchState[];
  agents: readonly AgentInstanceState[];
  /** Task Authority owns status; Dispatch retains only its commitment hash. */
  tasks: readonly {
    authorityRef: string;
    taskRef: string;
    ownerId: string;
    scopeRef: string;
    commitmentHash: string;
    status: "OPEN" | "BLOCKED" | "SNOOZED" | "DONE" | "ARCHIVED";
  }[];
  sources: readonly {
    documentRef: string;
    documentType: string;
    ownerId: string;
    scopeRef: string;
    contentVersion: number;
    contentHash: string;
  }[];
  /** Derived from immutable native Report content and a trusted verifier. */
  results: readonly {
    dispatchId: string;
    inputHash: string;
    reportId: string;
    contentVersion: number;
    contentHash: string;
    verificationRef: string;
  }[];
}
export type DispatchContext = TrustedContext & { dispatch: DispatchFacts };
function agent(ref: DispatchOffer["recipient"], ctx: DispatchContext, offer?:DispatchOffer) {
  const state = ctx.dispatch.agents.find((a) => a.instanceId === ref.instanceId);
  assert(
    state &&
      state.ownerId === ctx.ownerId &&
      state.scopeRef === ctx.scopeRef &&
      state.desiredState === "READY" &&
      state.definitionRef?.id === ref.definitionId &&
      state.definitionRef.version === ref.definitionVersion &&
      state.definitionRef.contentHash === ref.definitionHash,
    "Dispatch agent version/scope/state changed",
  );
  const definition = ctx.definitions.find(
    (d) =>
      d.release.definitionId === ref.definitionId &&
      d.release.packageVersion === ref.definitionVersion &&
      d.release.contentHash === ref.definitionHash,
  );
  if(definition&&!definition.qualified){
    assert(definition.pilot&&offer,'pilot_not_production');
    const p=pilotAccess(definition.pilot,ctx,ref.instanceId);pilotOffer(p,offer);
    assert(p.definitionHash===ref.definitionHash&&p.runtimeBindingRef===state.runtimeBindingRef&&p.modelPolicyHash===digest(state.modelPolicy),'pilot_recipient_changed');
  }
  assert(
    definition &&
      state.runtimeBindingRef &&
      ctx.runtimeBindingRefs.includes(state.runtimeBindingRef) &&
      definition.release.runtimeContracts.includes(
        ctx.runtimeBindingContracts[state.runtimeBindingRef],
      ),
    "Dispatch agent definition/runtime unavailable",
  );
  return { state, definition: definition.release };
}
function capability(
  actor: ReturnType<typeof agent>,
  resourceRef: string,
  action: string,
  ctx: DispatchContext,
) {
  const resource = ctx.resources.find(
    (r) => r.id === resourceRef && r.allowedActions.includes(action),
  );
  assert(
    resource &&
      actor.definition.capabilities.some(
        (c) => c.resourceType === resource.resourceType && c.actions.includes(action),
      ) &&
      actor.state.grants.some(
        (g) =>
          g.principalId === actor.state.instanceId &&
          g.resourceRef === resourceRef &&
          g.actions.includes(action) &&
          !g.revokedAt &&
          g.expiresAt > ctx.occurredAt,
      ),
    "Dispatch capability missing, expired or revoked",
  );
}
function authorizeHop(offer: DispatchOffer, ctx: DispatchContext) {
  timestamp(offer.expiresAt);
  assert(
    offer.scopeRef === ctx.scopeRef &&
      (offer.expiresAt > ctx.occurredAt || activeRecovery()?.offerHash===offer.contentHash) &&
      dispatchOfferHash(offer) === offer.contentHash &&
      instructionsHash(offer.instructions) === offer.instructionsHash,
    "Dispatch input scope, hash or expiry differs",
  );
  const task = ctx.dispatch.tasks.find(
    (t) => t.authorityRef === offer.task.authorityRef && t.taskRef === offer.task.taskRef,
  );
  assert(
    task &&
      task.ownerId === ctx.ownerId &&
      task.scopeRef === ctx.scopeRef &&
      task.commitmentHash === offer.task.commitmentHash &&
      !["DONE", "ARCHIVED"].includes(task.status),
    "Dispatch Task unavailable or commitment changed",
  );
  const recipient = agent(offer.recipient, ctx, offer);
  capability(recipient, offer.permissionRef, "receive", ctx);
  const sender = offer.senderAgent ? agent(offer.senderAgent, ctx) : undefined;
  if (sender) capability(sender, offer.permissionRef, "dispatch", ctx);
  else
    assert(
      offer.senderId === ctx.ownerId &&
        ctx.resources.some(
          (r) => r.id === offer.permissionRef && r.allowedActions.includes("dispatch"),
        ),
      "Dispatch sender lacks scoped permission",
    );
  for (const source of offer.sources) {
    assert(
      ctx.dispatch.sources.some(
        (s) =>
          s.documentRef === source.documentRef &&
          s.documentType === source.documentType &&
          s.ownerId === ctx.ownerId &&
          s.scopeRef === ctx.scopeRef &&
          s.contentVersion === source.contentVersion &&
          s.contentHash === source.contentHash,
      ),
      "Dispatch source unavailable or changed",
    );
    capability(recipient, source.documentRef, "read", ctx);
    if (sender) capability(sender, source.documentRef, "read", ctx);
  }
}
/** Revalidates every hop from actual native parents; a parent grants no permission. */
export function authorizeDispatchLineage(id: string, offer: DispatchOffer, ctx: DispatchContext) {
  const recovery=activeRecovery();if(recovery){recoveryFor(recovery.pilot,id);assert(recovery.offerHash===offer.contentHash,'pilot_recovery_offer_changed');}
  const seen = new Set([id]);
  let child = offer,
    depth = 0;
  authorizeHop(child, ctx);
  while (child.parentDispatchRef) {
    const parentId = child.parentDispatchRef;
    assert(!seen.has(parentId) && ++depth <= 8, "Dispatch parent cycle or depth exceeded");
    seen.add(parentId);
    const parent = ctx.dispatch.parents.find((p) => p.dispatchId === parentId);
    assert(
      parent?.offer &&
        parent.ownerId === ctx.ownerId &&
        parent.scopeRef === ctx.scopeRef &&
        parent.offer.contentHash === child.parentContentHash &&
        parent.acceptance?.inputHash === parent.offer.contentHash &&
        parent.acceptance.actorId === parent.offer.recipient.instanceId &&
        !parent.cancellationReason &&
        parent.phase !== "CANCEL_REQUESTED",
      "Dispatch parent unavailable, unaccepted, cancelled or changed",
    );
    assert(
      child.senderId === parent.offer.recipient.instanceId &&
        child.senderAgent &&
        canonical(child.senderAgent) === canonical(parent.offer.recipient) &&
        canonical(child.task) === canonical(parent.offer.task) &&
        child.originalRequesterId === parent.offer.originalRequesterId &&
        child.expiresAt <= parent.offer.expiresAt,
      "Dispatch child changed requester, sender, Task or expiry",
    );
    child = parent.offer;
    authorizeHop(child, ctx);
  }
  assert(
    !child.parentContentHash && child.originalRequesterId === child.senderId,
    "Dispatch root requester differs",
  );
  if (offer.continuationOfRef)
    assert(
      seen.has(offer.continuationOfRef) && offer.continuationOfRef !== id,
      "Dispatch continuation is outside verified ancestry",
    );
}
