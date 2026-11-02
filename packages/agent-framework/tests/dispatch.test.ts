import { describe, it, expect } from "vitest";
import { createZip } from "document-model";
import * as Q from "../document-models/dispatch/v1/index.js";
import * as I from "../document-models/agent-instance/v1/index.js";
import {
  digest,
  releaseHash,
  prepareCommand,
  type TrustedContext,
} from "../src/command-boundary.js";
import {
  authorizeDispatchLineage,
  dispatchOfferHash,
  instructionsHash,
  type DispatchContext,
} from "../src/dispatch/contracts.js";
import { apply, context, policy, command, at } from "./fixtures.js";

import { dispatchFixture } from "./dispatch-fixtures.js";

describe("Native Dispatch immutable lineage and independent authority", () => {
  it("retains exact inputs and requester/parent through native export without any chat history", async () => {
    const f = dispatchFixture(),
      child = f.create("dispatch-child", f.childOffer);
    const accepted = apply(
      child,
      "ACCEPT_DISPATCH",
      { inputHash: f.childOffer.contentHash },
      { ...f.ctx, principalId: "domain" },
    );
    const restored = await Q.utils.loadFromInput(await createZip(accepted));
    expect(restored.state.global).toEqual(accepted.state.global);
    expect(restored.state.global.offer?.instructions).toBe(f.childOffer.instructions);
    expect(restored.state.global.offer?.originalRequesterId).toBe("owner");
    expect(restored.state.global.offer?.parentDispatchRef).toBe(f.root.header.id);
    expect(restored.operations.global.map((o) => o.action.id)).toEqual(
      accepted.operations.global.map((o) => o.action.id),
    );
  });
  it.each([
    "sender",
    "requester",
    "task",
    "scope",
    "source",
    "parent",
    "cycle",
    "definition",
    "revoked",
    "recipient-permission",
  ])("denies %s forgery or drift before accepting a child", (kind) => {
    const f = dispatchFixture();
    let p = structuredClone(f.childOffer),
      principal = "coordinator";
    if (kind === "sender") principal = "domain";
    if (kind === "requester") p.originalRequesterId = "coordinator";
    if (kind === "task") p.task.taskRef = "new-task";
    if (kind === "scope") p.scopeRef = "other-scope";
    if (kind === "source") p.sources[0].contentHash = digest("changed");
    if (kind === "parent") f.ctx.dispatch.parents = [];
    if (kind === "cycle") p.parentDispatchRef = "dispatch-child";
    if (kind === "definition") p.recipient.definitionHash = digest("different definition");
    if (kind === "revoked")
      f.ctx.dispatch.agents[0].grants.find((g) => g.resourceRef === "inbox:domain")!.revokedAt = at;
    if (kind === "recipient-permission")
      f.ctx.dispatch.agents[1].grants.find((g) => g.resourceRef === "inbox:domain")!.revokedAt = at;
    p.contentHash = dispatchOfferHash(p);
    expect(() => f.create("dispatch-child", p, principal)).toThrow();
  });
  it("rechecks parent source/grants independently, even when the child has its own valid permission", () => {
    const f = dispatchFixture();
    f.ctx.dispatch.agents[0].grants.find((g) => g.resourceRef === "inbox:coordinator")!.revokedAt =
      at;
    expect(() => f.create("dispatch-child", f.childOffer)).toThrow(/revoked/);
  });
  it("allows an agent-initiated root under current scoped standing permission without owner approval", () => {
    const f = dispatchFixture();
    const p = f.offer({
      originalRequesterId: "coordinator",
      senderId: "coordinator",
      senderAgent: f.agentRef(f.coordinator),
      recipient: f.agentRef(f.domain),
      permissionRef: "inbox:domain",
    });
    const d = f.create("standing-agent-request", p);
    expect(d.state.global.ownerId).toBe("owner");
    expect(d.state.global.offer?.originalRequesterId).toBe("coordinator");
    expect("decision" in d.state.global).toBe(false);
    expect(() =>
      prepareCommand(
        { ...command(d, "RECORD_DECISION", {}), documentType: "kapelle/review-intent" },
        d,
        { ...f.ctx, principalId: "coordinator" },
      ),
    ).toThrow(/owner/);
  });
  it("retains verified original output, never replaces it, and creates a linked continuation for changes", () => {
    const f = dispatchFixture();
    let child = f.create("dispatch-child", f.childOffer);
    child = apply(
      child,
      "ACCEPT_DISPATCH",
      { inputHash: f.childOffer.contentHash },
      { ...f.ctx, principalId: "domain" },
    );
    const result = {
      dispatchId: child.header.id,
      inputHash: f.childOffer.contentHash,
      reportId: "native-report-original",
      contentVersion: 1,
      contentHash: digest("original report bytes"),
      verificationRef: "verification:original",
    };
    f.ctx.dispatch.results = [result];
    const { dispatchId: _, ...input } = result;
    child = apply(child, "RECORD_DISPATCH_RESULT", input, { ...f.ctx, principalId: "domain" });
    expect(child.state.global.result?.contentHash).toBe(result.contentHash);
    expect(() =>
      apply(child, "RECORD_DISPATCH_RESULT", input, { ...f.ctx, principalId: "domain" }),
    ).toThrow(/one accepted input/);
    f.ctx.dispatch.parents = [child.state.global, f.root.state.global];
    const continuation = f.offer({
      parentDispatchRef: child.header.id,
      parentContentHash: f.childOffer.contentHash,
      continuationOfRef: child.header.id,
      senderId: "domain",
      senderAgent: f.agentRef(f.domain),
      recipient: f.agentRef(f.coordinator),
      instructions: "The requested changes require a new review of new content.",
    });
    const next = f.create("dispatch-continuation", continuation);
    expect(next.state.global.offer?.instructions).not.toBe(child.state.global.offer?.instructions);
    expect(child.state.global.offer?.instructions).toBe(f.childOffer.instructions);
    expect(f.ctx.dispatch.tasks[0].status).toBe("OPEN");
  });
  it("records cancellation as a request and does not claim that an accepted effect stopped", () => {
    const f = dispatchFixture();
    let child = f.create("dispatch-child", f.childOffer);
    child = apply(
      child,
      "ACCEPT_DISPATCH",
      { inputHash: f.childOffer.contentHash },
      { ...f.ctx, principalId: "domain" },
    );
    child = apply(
      child,
      "REQUEST_DISPATCH_CANCEL",
      { reason: "Please stop if no external action started" },
      { ...f.ctx, principalId: "coordinator" },
    );
    expect(child.state.global.phase).toBe("CANCEL_REQUESTED");
    expect(child.state.global.acceptance).not.toBe(null);
    expect(child.state.global.result).toBe(null);
    expect(f.ctx.dispatch.tasks[0].status).toBe("OPEN");
  });
  it("rejects tampered stored lineage and bounded traversal cycles", () => {
    const f = dispatchFixture();
    const parent = f.ctx.dispatch.parents[0];
    parent.offer!.parentDispatchRef = "dispatch-child";
    parent.offer!.parentContentHash = f.childOffer.contentHash;
    parent.offer!.contentHash = dispatchOfferHash(parent.offer!);
    parent.acceptance!.inputHash = parent.offer!.contentHash;
    const p = f.offer({ ...f.childOffer, parentContentHash: parent.offer!.contentHash });
    expect(() => authorizeDispatchLineage("dispatch-child", p, f.ctx)).toThrow(/cycle/);
  });
  it("accepts eight verified ancestors and rejects the ninth hop", () => {
    const f = dispatchFixture();
    let parent = f.root;
    for (let depth = 1; depth <= 9; depth++) {
      const sender = parent.state.global.offer!.recipient;
      const recipient = f.agentRef(sender.instanceId === "coordinator" ? f.domain : f.coordinator);
      const p = f.offer({
        senderId: sender.instanceId,
        senderAgent: sender,
        recipient,
        parentDispatchRef: parent.header.id,
        parentContentHash: parent.state.global.offer!.contentHash,
        permissionRef: "inbox:" + recipient.instanceId,
      });
      if (depth === 9) {
        expect(() => f.create("depth-9", p)).toThrow(/depth exceeded/);
      } else {
        parent = apply(
          f.create("depth-" + depth, p),
          "ACCEPT_DISPATCH",
          { inputHash: p.contentHash },
          { ...f.ctx, principalId: recipient.instanceId },
        );
        f.ctx.dispatch.parents = [parent.state.global, ...f.ctx.dispatch.parents];
      }
    }
  });
  it("rejects a continuation outside verified ancestry", () => {
    const f = dispatchFixture();
    const p = f.offer({ ...f.childOffer, continuationOfRef: "unrelated-work" });
    expect(() => f.create("dispatch-child", p)).toThrow(/outside verified ancestry/);
  });
  it("keeps cancellation effective for new children after the parent records a real result", () => {
    const f = dispatchFixture();
    let parent = apply(f.root, "REQUEST_DISPATCH_CANCEL", { reason: "Stop new work" }, f.ctx);
    const result = {
      dispatchId: parent.header.id,
      inputHash: parent.state.global.offer!.contentHash,
      reportId: "original-result",
      contentVersion: 1,
      contentHash: digest("original"),
      verificationRef: "verification:original",
    };
    f.ctx.dispatch.results = [result];
    const { dispatchId: _, ...input } = result;
    parent = apply(parent, "RECORD_DISPATCH_RESULT", input, {
      ...f.ctx,
      principalId: "coordinator",
    });
    expect(parent.state.global.phase).toBe("RESULT_RECORDED");
    f.ctx.dispatch.parents = [parent.state.global];
    expect(() => f.create("dispatch-child", f.childOffer)).toThrow(/cancelled/);
  });
});
