import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { openPublicationHost } from "../src/publication/host.js";
import { publicationProposal } from "../src/publication/manifest.js";
import { PublicationExecutorClient } from "../src/publication/executor-http.js";
import { openSyntheticPublicationNative, openSyntheticPublicationTarget } from "./publication-host-fixture.js";
import { managerPublicationFixture } from "./manager-publication-fixture.js";

const reactorRoot = process.env.KAPELLE_SCOPED_REACTOR_ROOT, managerRoot = process.env.KAPELLE_PUBLICATION_MANAGER_ROOT;
export const syntheticTokens = { owner: "synthetic-owner-decision-0000000000000000", manager: "synthetic-manager-transport-00000000000000", executor: "synthetic-executor-transport-0000000000000" };
async function setup(root: string, automatic = false) {
  const native = await openSyntheticPublicationNative(root, reactorRoot!);
  const manager = await managerPublicationFixture(managerRoot!, native.manifest, native.ids.reviewId, native.ids.instanceId, async () => { }, join(root, "manager"));
  const binding = () => { const row = native.authority.journal.db.prepare("SELECT binding_json FROM publication_provider_contacts LIMIT 1").get(); return row ? JSON.parse(String(row.binding_json)) : null; };
  const target = openSyntheticPublicationTarget(join(root, "synthetic-target.sqlite"), binding);
  let ownerToken = syntheticTokens.owner;
  let settlementFault = "";
  const readSettlement: typeof target.settlement = async binding => {
    if (settlementFault === "unavailable") throw Error("Synthetic settlement unavailable");
    const proof = await target.settlement(binding);
    return proof && settlementFault === "wrong-binding" ? { ...proof, bindingHash: "sha256:" + "0".repeat(64) } : proof;
  };
  const mount = () => openPublicationHost(native.authority, {
    manifest: native.manifest, reviewId: native.ids.reviewId, instanceId: native.ids.instanceId, brokerHostId: "synthetic-host-stable", managerTeamId: "synthetic-team", managerAuthorityId: "synthetic-manager-stable", executorAgent: "publication-executor", managerDatabase: manager.database, managerQueue: manager.queue,
    managerToken: () => syntheticTokens.manager, executorToken: () => syntheticTokens.executor, ownerDecisionToken: () => ownerToken, providerToken: () => "synthetic-provider-token-00000000000000000", providerRequest: target.request, stagingReceipt: async () => target.stagingReceipt, assertExclusiveProjectWriter: async () => { }, readRequestSettlement: readSettlement, bindEffects: native.bindEffects, wakeOnDecision: automatic
  });
  let host = await mount();
  return {
    root, native, manager, target, setSettlementFault: (fault: string) => { settlementFault = fault; }, get host() { return host; }, setOwnerToken: (value: string) => { ownerToken = value; },
    async restart() { await host.close(); await native.restart(); await manager.restart(); host = await mount(); },
    async close() { await host.close(); target.close(); manager.close(); await native.close(); }
  };
}
describe.skipIf(!reactorRoot || !managerRoot)("Runnable retained publication host", () => {
  for (const mode of ["success", "lost-owner-ack", "lost-executor-ack", "lost-provider-ack", "pending-same-candidate", "no-contact", "no-contact-sealed-restart", "request-changes", "revoked-grant", "cancelled-parent"]) {
    it(mode, async () => {
      const root = mkdtempSync(join(tmpdir(), "publication-host-")); const f = await setup(root, mode === "success");
      try {
        const authority = f.native.authority;
        const initial = await authority.read(f.native.ids.reviewId, "kapelle/review-intent");
        const p = publicationProposal(f.native.manifest);
        const command = { operationId: "owner-publication-decision", documentId: f.native.ids.reviewId, documentType: "kapelle/review-intent", expectedRevision: initial.state.global.revision, type: "RECORD_DECISION", input: { proposalHash: p.contentHash, proposalVersion: p.version, approved: mode !== "request-changes", reason: mode === "request-changes" ? "Correct the synthetic heading" : null } };
        const post = (token = syntheticTokens.owner) => fetch(f.host.ownerOrigin + "/commands", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(command) });
        expect((await post(syntheticTokens.executor)).status).toBe(403);
        expect((await post(syntheticTokens.manager)).status).toBe(403);
        const stale = await fetch(f.host.ownerOrigin + "/commands", { method: "POST", headers: { authorization: "Bearer " + syntheticTokens.owner, "content-type": "application/json" }, body: JSON.stringify({ ...command, input: { ...command.input, proposalHash: "sha256:" + "0".repeat(64) } }) });
        expect(stale.status).toBe(403);
        const first = await post(); expect(first.status).toBe(200);
        if (mode === "lost-owner-ack") { await first.body?.cancel(); await f.restart(); }
        else await first.json();
        expect((await post()).status).toBe(200);
        const ownerDoc = await f.native.authority.read(f.native.ids.reviewId, "kapelle/review-intent");
        expect(ownerDoc.operations.global.filter(o => o.action.type === "RECORD_DECISION" && !o.error)).toHaveLength(1);
        if (mode === "lost-provider-ack") f.target.setFault("lost-response");
        if (mode === "pending-same-candidate") f.target.setFault("pending");
        if (mode === "revoked-grant") await f.native.command(f.native.ids.instanceId, "kapelle/agent-instance", "REVOKE_CAPABILITY", { grantId: "grant:" + f.native.manifest.target.bindingRef });
        if (mode === "cancelled-parent") await f.native.command(f.native.ids.parentId, "kapelle/dispatch", "REQUEST_DISPATCH_CANCEL", { reason: "Synthetic parent no longer admitted" });
        if (mode.startsWith("no-contact")) {
          const original = f.native.authority.backend.commit.bind(f.native.authority.backend);
          f.native.authority.backend.commit = async (id, prepared) => { const result = await original(id, prepared); if (prepared.action.type === "CLAIM_EXECUTION") throw Error("Synthetic lost native claim acknowledgment"); return result; };
        }
        if (mode === "lost-executor-ack") {
          const client = new PublicationExecutorClient(f.host.executorOrigin, () => syntheticTokens.executor, async (...args) => { const response = await fetch(...args); await response.body?.cancel(); throw Error("Lost executor acknowledgement"); });
          await expect(f.host.store.deliver(client)).rejects.toThrow();
        } else if (["no-contact", "no-contact-sealed-restart", "revoked-grant", "cancelled-parent"].includes(mode)) await expect(f.host.wake()).rejects.toThrow();
        else await f.host.wake();
        const beforeRestart = await f.host.readStatus();
        if (mode === "pending-same-candidate") await expect(f.host.recoverNoContact()).rejects.toThrow(/contact exists/);
        await f.restart();
        if (mode.startsWith("no-contact")) {
          expect(f.target.posts()).toBe(0);
          expect((await f.host.readStatus()).hold?.held).toBe(true);
          if (mode === "no-contact-sealed-restart") {
            const binding = await f.host.store.read(f.host.store.expected.key);
            await f.host.adapters.provider.sealNoContact(binding!); await f.restart();
          } else expect((await f.host.recoverNoContact()).status).toBe("FAILED");
        }
        if (mode === "pending-same-candidate") f.target.observeSameCandidate();
        if (!["revoked-grant", "cancelled-parent"].includes(mode)) await f.host.wake();
        const status = await f.host.readStatus();
        const stable = (value: any) => { const { observedAt, ...rest } = value; return rest; };
        const before = JSON.stringify(stable(status));
        const res = await fetch(f.host.ownerOrigin + "/publication-status", { headers: { authorization: "Bearer " + syntheticTokens.owner } });
        expect(res.status).toBe(200); expect(stable((await res.json()).status)).toEqual(stable(status));
        expect(JSON.stringify(stable(await f.host.readStatus()))).toBe(before);
        const doc = await f.native.authority.read(f.native.ids.reviewId, "kapelle/review-intent");
        const claims = doc.operations.global.filter(o => o.action.type === "CLAIM_EXECUTION" && !o.error);
        if (["request-changes", "revoked-grant", "cancelled-parent"].includes(mode)) {
          expect(f.target.posts()).toBe(0); expect(claims).toHaveLength(0);
          if (mode === "request-changes") {
            expect(status.decision).toBe("REJECTED");
            expect((doc.state.global as any).decision.reason).toBe("Correct the synthetic heading");
            expect((doc.state.global as any).instanceId).toBe(f.native.ids.instanceId);
          }
        } else {
          expect(claims).toHaveLength(1); expect(f.target.posts()).toBe(mode.startsWith("no-contact") ? 0 : 1);
          expect(status.delivery?.status).toBe(mode.startsWith("no-contact") ? "FAILED" : "DELIVERED");
          expect(status.hold?.requestSettlement).toBe(mode === "pending-same-candidate" ? "UNPROVEN" : mode.startsWith("no-contact") ? "NO_CONTACT" : "COMPLETED");
          expect(status.hold?.held).toBe(mode === "pending-same-candidate");
        }
        const evidence = process.env.KAPELLE_PUBLICATION_HOST_EVIDENCE;
        if (evidence) { mkdirSync(evidence, { recursive: true }); writeFileSync(join(evidence, mode + ".json"), JSON.stringify({ synthetic: true, beforeRestart, status, providerRequests: f.target.posts(), nativeClaims: claims.length, originDispatch: f.native.manifest.originDispatch, taskMutation: false }, null, 2) + "\n"); }
      } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
    }, 90000);
  }
  for (const fault of ["unavailable", "wrong-binding", "lost-settlement-ack"]) {
    it(`retains native delivery and exact operation through ${fault}, restart and settlement recovery`, async () => {
      const root = mkdtempSync(join(tmpdir(), "publication-settlement-recovery-"));
      const f = await setup(root);
      try {
        const p = publicationProposal(f.native.manifest);
        await f.native.command(f.native.ids.reviewId, "kapelle/review-intent", "RECORD_DECISION", {
          proposalHash: p.contentHash, proposalVersion: p.version, approved: true, reason: null
        });
        if (fault === "lost-settlement-ack") {
          const original = f.host.adapters.provider.confirmDelivery.bind(f.host.adapters.provider);
          f.host.adapters.provider.confirmDelivery = async (...args) => { await original(...args); throw Error("Synthetic lost settlement acknowledgment"); };
        } else f.setSettlementFault(fault);
        await expect(f.host.wake()).rejects.toThrow();
        const before = await f.host.readStatus();
        expect(before.delivery?.status).toBe("DELIVERED");
        expect(before.hold?.held).toBe(fault !== "lost-settlement-ack");
        expect(before.hold?.requestSettlement).toBe(fault === "lost-settlement-ack" ? "COMPLETED" : "UNPROVEN");
        expect(f.target.posts()).toBe(1);
        await f.restart();
        const retained = await f.host.readStatus();
        expect([retained.operationId, retained.dispatchRef, retained.outboxRef]).toEqual([before.operationId, before.dispatchRef, before.outboxRef]);
        f.setSettlementFault("");
        await f.host.wake();
        const after = await f.host.readStatus();
        expect(after.delivery?.id).toBe(before.delivery?.id);
        expect(after.hold).toMatchObject({ held: false, requestSettlement: "COMPLETED" });
        expect(f.target.posts()).toBe(1);
        const doc = await f.native.authority.read(f.native.ids.reviewId, "kapelle/review-intent");
        expect(doc.operations.global.filter(o => o.action.type === "CLAIM_EXECUTION" && !o.error)).toHaveLength(1);
        expect((await f.manager.database.query("SELECT * FROM dispatch_scheduler_queue")).rows).toHaveLength(1);
        expect(f.native.authority.journal.db.prepare("SELECT * FROM publication_settled_holds").all()).toHaveLength(1);
      } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
    }, 90000);
  }
  it("reports a real queued binding before reservation, rejects credential rotation collisions, and never mutates on status GET", async () => {
    const root = mkdtempSync(join(tmpdir(), "publication-host-queue-")), f = await setup(root);
    try {
      const p = publicationProposal(f.native.manifest);
      await f.native.command(f.native.ids.reviewId, "kapelle/review-intent", "RECORD_DECISION", { proposalHash: p.contentHash, proposalVersion: p.version, approved: true, reason: null });
      const binding = await f.host.store.ensure(f.host.store.expected);
      // NativeBackend.read rebuilds document headers on every read. Compare the
      // actual retained native snapshot and local journal writes instead.
      const snapshot = () => f.native.authority.backend.store.readOwnedOperationSnapshot({
        collectionId: f.native.authority.backend.collectionId, documentId: f.native.ids.reviewId,
        documentType: "kapelle/review-intent"
      });
      const before = await snapshot();
      const journalChanges = () => f.native.authority.journal.db.prepare("SELECT total_changes() AS count").get()?.count;
      const writesBefore = journalChanges();
      const status = await f.host.readStatus();
      expect(status).toMatchObject({ operationId: binding.operationId, dispatchRef: binding.dispatchRef, outboxRef: binding.outboxRef, invocationClaimed: false, automaticWakeup: false, delivery: null });
      expect(status.hold?.held).toBe(false);
      f.setOwnerToken(syntheticTokens.executor);
      const collision = await fetch(f.host.ownerOrigin + "/publication-status", { headers: { authorization: "Bearer " + syntheticTokens.executor } });
      expect(collision.status).toBe(503);
      f.setOwnerToken(syntheticTokens.owner);
      const response = await fetch(f.host.ownerOrigin + "/publication-status", { headers: { authorization: "Bearer " + syntheticTokens.owner } });
      expect(response.status).toBe(200);
      expect(await snapshot()).toEqual(before);
      expect(journalChanges()).toBe(writesBefore);
      expect(f.target.posts()).toBe(0);
    } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
  }, 90000);
});
