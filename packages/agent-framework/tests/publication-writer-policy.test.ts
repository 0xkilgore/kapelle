import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { proposedWriterPolicy, verifyWriterPolicy } from "../src/publication/writer-policy.js";
import { publicationArtifact, publicationProposal } from "../src/publication/manifest.js";
import { dispatchIntent, PublicationCoordinator, websiteEffectPolicy } from "../src/publication/effects.js";
import { VercelPublicationProvider } from "../src/publication/vercel-provider.js";
import { vercelProviderFixture } from "./vercel-provider-fixture.js";

function fixture() {
  const f = vercelProviderFixture(true);
  const policy = proposedWriterPolicy({
    contract: "kapelle/website-writer-policy/v1", status: "PROPOSED",
    mode: "brokered-automation-owner-override", teamId: f.m.target.teamId,
    projectId: f.m.target.projectId, brokerId: "broker:synthetic", generation: 1,
    managedAutomation: "one-broker-all-automated-production-writes",
    managedWrites: "deploy-promote-rollback-alias-domain-routing",
    ownerRace: "manual-write-can-race-and-be-overwritten",
    providerGuarantee: "no-atomic-cas-no-exactly-once-no-continuous-currentness",
    recoveryRelease: "requires-qualified-no-remaining-effect-evidence",
    ownerException: "owner-manual-writes-remain-possible",
    gitPromotion: "disconnect-before-activation", credentials: "isolate-broker-from-other-automation",
    serialization: "single-host-durable-project-hold-before-native-claim",
    ambiguousRequest: "retain-hold-no-retry-no-timeout-release",
    delivery: "observed-result-is-not-request-settlement-or-continuous-currentness",
    drift: "pause-and-require-new-exact-review",
  });
  return { ...f, policy, proposed: publicationArtifact({ ...f.m,
    contract: "kapelle/website-publication/v3", writerPolicy: policy }).manifest };
}
describe("Proposed managed writer policy", () => {
  it("immutably binds policy content and explicit mode to a distinct proposal and Dispatch", () => {
    const f = fixture();
    expect(Object.isFrozen(f.policy.policy)).toBe(true);
    expect(verifyWriterPolicy(f.policy)).toEqual(f.policy);
    const changed = { ...f.proposed, writerPolicy: proposedWriterPolicy({ ...f.policy.policy, generation: 2 }) };
    expect(publicationProposal(changed).contentHash).not.toBe(publicationProposal(f.proposed).contentHash);
    expect(dispatchIntent("review", "publisher", changed).key)
      .not.toBe(dispatchIntent("review", "publisher", f.proposed).key);
    expect(publicationProposal(f.proposed).contentHash).not.toBe(publicationProposal(f.m).contentHash);
    expect(() => publicationArtifact({ ...f.m, writerPolicy: f.policy })).toThrow();
  });
  it("refuses tampering, cross-project policy, executable status and weakened settlement terms", () => {
    const f = fixture();
    expect(() => verifyWriterPolicy({ ...f.policy, policy: { ...f.policy.policy, generation: 2 } })).toThrow(/identity differs/);
    expect(() => publicationArtifact({ ...f.proposed, writerPolicy:
      proposedWriterPolicy({ ...f.policy.policy, projectId: "other" }) })).toThrow(/target differs/);
    expect(() => proposedWriterPolicy({ ...f.policy.policy, status: "ACTIVE" })).toThrow();
    expect(() => proposedWriterPolicy({ ...f.policy.policy, ambiguousRequest: "release-after-timeout" })).toThrow();
  });
  it("rejects execution through the coordinator, native effect policy and Vercel adapter", async () => {
    const f = fixture(), db = new DatabaseSync(":memory:");
    try {
      // Empty ports deliberately fail if any authority/queue/provider work is attempted.
      const coordinator = new PublicationCoordinator({} as any, f.proposed, "publisher", {} as any, {} as any);
      await expect(coordinator.run("review")).rejects.toThrow(/not executable/);
      for (const type of ["RESERVE_EFFECT", "CLAIM_EXECUTION"])
        await expect(websiteEffectPolicy(f.proposed, "publisher")({ type } as any, {} as any, {} as any))
          .rejects.toThrow(/not executable/);
      expect(() => new VercelPublicationProvider({ manifest: f.proposed, journal: db } as any))
        .toThrow(/new v2/);
      expect(db.prepare("SELECT name FROM sqlite_master").all()).toHaveLength(0);
      expect(f.state.posts).toBe(0);
    } finally { db.close(); }
  });
});
