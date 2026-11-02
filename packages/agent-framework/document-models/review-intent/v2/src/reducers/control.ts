import type { ReviewIntentControlOperations } from "document-models/review-intent/v2";
import {
  assert,
  before,
  hash,
  opaque,
  text,
  timestamp,
  touch,
  unique,
} from "../../../../../src/validation.js";
import type { ReviewIntentState } from "../../gen/schema/types.js";

function proposalMatches(
  s: ReviewIntentState,
  i: { proposalHash: string; proposalVersion: number },
) {
  assert(
    s.proposal &&
      s.proposal.contentHash === i.proposalHash &&
      s.proposal.version === i.proposalVersion,
    "Stale proposal",
  );
}
export const reviewIntentControlOperations: ReviewIntentControlOperations = {
  createReviewOperation(s, { input: i }) {
    before(s, i, true);
    [i.reviewId, i.instanceId, i.scopeRef].forEach(opaque);
    const p = i.proposal;
    hash(p.contentHash);
    hash(p.artifactHash);
    assert(Number.isInteger(p.contentVersion) && p.contentVersion > 0, "Invalid artifact version");
    assert(
      p.effectKind === "SEND_MESSAGE"
        ? p.action === "send"
        : p.effectKind === "PREPARE_MESSAGE"
          ? p.action === "prepare"
          : p.effectKind === "WEBSITE_PUBLICATION"
            ? p.action === "publish"
            : !["send", "prepare", "publish"].includes(p.action),
      "Effect kind and action disagree",
    );
    opaque(p.contentRef);
    if (p.expiresAt) {
      timestamp(p.expiresAt);
      assert(p.expiresAt > i.occurredAt, "Proposal expired");
    }
    if (p.effectKind === "WEBSITE_PUBLICATION") {
      assert(p.expiresAt, "Website publication requires expiry");
      assert(p.targets.length === 1, "Website publication requires one bound target");
    }
    text(p.action);
    assert(Number.isInteger(p.version) && p.version > 0, "Invalid proposal version");
    unique(
      p.targets.map((x) => x.documentRef),
      "target",
    );
    assert(p.targets.length > 0, "Target revision required");
    p.targets.forEach((t) => {
      opaque(t.documentRef);
      hash(t.contentHash);
      assert(Number.isInteger(t.revision) && t.revision >= 0, "Invalid target revision");
    });
    unique(p.recipients, "recipient");
    if (p.effectKind === "SEND_MESSAGE" || p.effectKind === "PREPARE_MESSAGE") {
      assert(p.senderConnectionRef && p.recipients.length, "Exact sender and recipients required");
      opaque(p.senderConnectionRef);
    } else
      assert(
        !p.senderConnectionRef && !p.recipients.length,
        "Document change cannot include a message destination",
      );
    Object.assign(s, {
      reviewId: i.reviewId,
      instanceId: i.instanceId,
      scopeRef: i.scopeRef,
      proposal: {
        ...p,
        senderConnectionRef: p.senderConnectionRef ?? null,
        expiresAt: p.expiresAt ?? null,
      },
    });
    touch(s, i);
  },
  recordDecisionOperation(s, { input: i }) {
    before(s, i);
    assert(s.status === "PROPOSED" && !s.effect, "Decision already recorded");
    proposalMatches(s, i);
    assert(!s.proposal?.expiresAt || s.proposal.expiresAt > i.occurredAt, "Proposal expired");
    if (s.proposal?.effectKind === "WEBSITE_PUBLICATION" && !i.approved)
      assert(i.reason?.trim(), "Request changes requires a reason");
    if (i.reason) text(i.reason);
    s.decision = {
      actorId: i.actorId,
      occurredAt: i.occurredAt,
      proposalHash: i.proposalHash,
      proposalVersion: i.proposalVersion,
      approved: i.approved,
      reason: i.reason ?? null,
    };
    s.status = i.approved ? "APPROVED" : "REJECTED";
    touch(s, i);
  },
  invalidateReviewOperation(s, { input: i }) {
    before(s, i);
    assert(
      !s.effect && (s.status === "APPROVED" || s.status === "PROPOSED"),
      "Cannot invalidate a reserved or terminal intent",
    );
    text(i.reason);
    s.status = "INVALIDATED";
    s.invalidatedReason = i.reason;
    touch(s, i);
  },
  reserveEffectOperation(s, { input: i }) {
    before(s, i);
    proposalMatches(s, i);
    assert(!s.proposal?.expiresAt || s.proposal.expiresAt > i.occurredAt, "Proposal expired");
    assert(
      s.status === "APPROVED" && s.decision?.approved && !s.effect,
      "Effect must have one exact approval and no reservation",
    );
    [i.operationId, i.dispatchRef, i.outboxRef].forEach(opaque);
    s.effect = {
      operationId: i.operationId,
      dispatchRef: i.dispatchRef,
      outboxRef: i.outboxRef,
      occurredAt: i.occurredAt,
    };
    touch(s, i);
  },
  recordDeliveryOperation(s, { input: i }) {
    before(s, i);
    assert(s.effect?.operationId === i.operationId, "Unknown effect");
    if (s.proposal?.effectKind === "WEBSITE_PUBLICATION")
      assert(s.execution?.operationId === i.operationId, "Native invocation claim required");
    [i.evidenceId, i.providerRef, i.receiptRef].forEach(opaque);
    assert(!s.delivery.some((e) => e.id === i.evidenceId), "Evidence ID already used");
    const last = s.delivery.at(-1);
    assert(!last || !["DELIVERED", "FAILED"].includes(last.status), "Delivery is terminal");
    if (last?.status === "UNCERTAIN")
      assert(
        i.status === "DELIVERED" || i.status === "FAILED",
        "Uncertain delivery requires definitive reconciliation",
      );
    assert(s.delivery.length < 100, "Evidence limit");
    s.delivery.push({
      id: i.evidenceId,
      status: i.status,
      providerRef: i.providerRef,
      receiptRef: i.receiptRef,
      occurredAt: i.occurredAt,
    });
    touch(s, i);
  },
  claimExecutionOperation(s, { input: i }) {
    before(s, i);
    proposalMatches(s, i);
    assert(
      s.proposal?.effectKind === "WEBSITE_PUBLICATION",
      "Only website invocation is qualified",
    );
    assert(s.proposal.expiresAt && s.proposal.expiresAt > i.occurredAt, "Proposal expired");
    assert(
      s.effect &&
        s.effect.operationId === i.operationId &&
        s.effect.dispatchRef === i.dispatchRef &&
        s.effect.outboxRef === i.outboxRef &&
        s.status === "APPROVED" &&
        s.decision?.approved,
      "Unknown approved reservation",
    );
    assert(!s.execution && !s.delivery.length, "Invocation already claimed or reported");
    [i.attemptId, i.executorId].forEach(opaque);
    assert(i.executorId === s.instanceId, "Wrong invocation executor");
    s.execution = {
      operationId: i.operationId,
      attemptId: i.attemptId,
      executorId: i.executorId,
      occurredAt: i.occurredAt,
    };
    touch(s, i);
  },
};
