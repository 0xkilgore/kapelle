import type { DispatchControlOperations } from "document-models/dispatch/v1";
import type { DispatchState } from "../../gen/schema/types.js";
import {
  assert,
  hash,
  opaque,
  text,
  timestamp,
  touch,
  unique,
  version,
  type Mutation,
} from "../../../../../src/validation.js";
import { dispatchOfferHash, instructionsHash } from "../../../../../src/dispatch/contracts.js";

function before(s: DispatchState, i: Mutation, create = false) {
  opaque(i.actorId);
  timestamp(i.occurredAt);
  assert(s.revision === i.expectedRevision, "Stale dispatch revision");
  assert(
    create ? s.revision === 0 && s.ownerId === null : s.revision > 0 && s.ownerId,
    "Dispatch initialization differs",
  );
  assert(!s.updatedAt || s.updatedAt <= i.occurredAt, "Dispatch timestamp precedes last operation");
}

export const dispatchControlOperations: DispatchControlOperations = {
  createDispatchOperation(s, { input: i }) {
    before(s, i, true);
    const p = i.offer;
    [
      i.dispatchId,
      i.ownerId,
      p.scopeRef,
      p.originalRequesterId,
      p.senderId,
      p.permissionRef,
      p.task.authorityRef,
      p.task.taskRef,
    ].forEach(opaque);
    hash(p.contentHash);
    hash(p.instructionsHash);
    hash(p.task.commitmentHash);
    assert(p.senderId === i.actorId, "Authenticated dispatch sender differs");
    assert(
      dispatchOfferHash(p) === p.contentHash &&
        instructionsHash(p.instructions) === p.instructionsHash,
      "Dispatch offer hash differs",
    );
    text(p.instructions, "accepted instructions", 32000);
    timestamp(p.expiresAt);
    assert(p.expiresAt > i.occurredAt, "Dispatch offer expired");
    for (const a of [p.senderAgent, p.recipient].filter((a) => a != null)) {
      opaque(a.instanceId);
      opaque(a.definitionId);
      version(a.definitionVersion);
      hash(a.definitionHash);
    }
    assert(
      p.senderAgent ? p.senderAgent.instanceId === p.senderId : p.senderId === i.ownerId,
      "Dispatch sender instance differs",
    );
    assert(p.recipient.instanceId !== p.senderId, "Self dispatch is not supported");
    if (p.parentDispatchRef) {
      opaque(p.parentDispatchRef);
      assert(
        p.parentDispatchRef !== i.dispatchId && p.parentContentHash,
        "Invalid dispatch parent",
      );
      hash(p.parentContentHash);
    } else
      assert(
        !p.parentContentHash && p.originalRequesterId === p.senderId,
        "Invalid original requester",
      );
    if (p.continuationOfRef) {
      opaque(p.continuationOfRef);
      assert(
        p.parentDispatchRef && p.continuationOfRef !== i.dispatchId,
        "Continuation requires parent",
      );
    }
    unique(
      p.sources.map((s) => s.documentRef),
      "source",
    );
    for (const source of p.sources) {
      opaque(source.documentRef);
      text(source.documentType);
      hash(source.contentHash);
      assert(
        Number.isSafeInteger(source.contentVersion) && source.contentVersion > 0,
        "Invalid source content version",
      );
    }
    Object.assign(s, {
      ownerId: i.ownerId,
      dispatchId: i.dispatchId,
      scopeRef: p.scopeRef,
      offer: {
        ...p,
        senderAgent: p.senderAgent ?? null,
        parentDispatchRef: p.parentDispatchRef ?? null,
        parentContentHash: p.parentContentHash ?? null,
        continuationOfRef: p.continuationOfRef ?? null,
      },
    });
    touch(s, i);
  },
  acceptDispatchOperation(s, { input: i }) {
    before(s, i);
    assert(
      s.offer &&
        s.phase === "OFFERED" &&
        !s.acceptance &&
        s.offer.contentHash === i.inputHash &&
        s.offer.recipient.instanceId === i.actorId &&
        s.offer.expiresAt > i.occurredAt,
      "Dispatch cannot be accepted",
    );
    s.acceptance = { actorId: i.actorId, inputHash: i.inputHash, occurredAt: i.occurredAt };
    s.phase = "ACCEPTED";
    touch(s, i);
  },
  requestDispatchCancelOperation(s, { input: i }) {
    before(s, i);
    assert(
      s.offer &&
        !s.result &&
        !s.cancellationReason &&
        [s.ownerId, s.offer.senderId].includes(i.actorId),
      "Dispatch cancellation is not authorized or already recorded",
    );
    text(i.reason);
    s.cancellationReason = i.reason;
    s.phase = "CANCEL_REQUESTED";
    touch(s, i);
  },
  recordDispatchResultOperation(s, { input: i }) {
    before(s, i);
    assert(
      s.offer &&
        s.acceptance &&
        !s.result &&
        s.offer.contentHash === i.inputHash &&
        s.offer.recipient.instanceId === i.actorId,
      "Dispatch result must bind one accepted input",
    );
    opaque(i.reportId);
    opaque(i.verificationRef);
    hash(i.contentHash);
    assert(
      Number.isSafeInteger(i.contentVersion) && i.contentVersion > 0,
      "Invalid result content version",
    );
    s.result = {
      reportId: i.reportId,
      contentVersion: i.contentVersion,
      contentHash: i.contentHash,
      verificationRef: i.verificationRef,
      occurredAt: i.occurredAt,
    };
    s.phase = "RESULT_RECORDED";
    touch(s, i);
  },
};
