import { describe, expect, it } from "vitest";
import { digest } from "../src/content.js";
import { publicationFixture } from "./publication-fixtures.js";
import { publicationArtifact, publicationProposal } from "../src/publication/manifest.js";
import { verifiedStagingReceipt } from "../src/publication/staging.js";

describe("Trusted immutable staging binding", () => {
  it("requires a receipt binding for a staged ID and includes the receipt hash in approval identity", () => {
    const f = publicationFixture("dpl_new"),
      unbound = structuredClone(f.m);
    delete unbound.build.staging;
    expect(() => publicationArtifact(unbound)).toThrow(/staging receipt/);
    const changed = structuredClone(f.m);
    changed.build.staging!.receiptHash = digest("different retained upload receipt");
    expect(publicationProposal(changed).contentHash).not.toBe(publicationProposal(f.m).contentHash);
  });
  it.each([
    "deploymentId",
    "buildReceiptHash",
    "outputHash",
    "recipeRef",
    "teamId",
    "projectId",
    "deploymentHost",
  ])("refuses changed trusted receipt %s despite unchanged provider metadata", async (field) => {
    const f = publicationFixture("dpl_new");
    (f.state.staging as any)[field] = "changed";
    await expect(f.adapter.verify()).rejects.toThrow();
  });
  it("verifies inventory bytes rather than accepting a claimed output hash in a retained receipt", async () => {
    const f = publicationFixture("dpl_new"),
      staged = structuredClone(f.state.staging!);
    staged.uploadedFiles[0].hash = digest("wrong uploaded file");
    const m = structuredClone(f.m);
    m.build.staging!.receiptHash = digest(staged);
    await expect(verifiedStagingReceipt(m, async () => staged)).rejects.toThrow(/inventory/);
  });
  it("requires the trusted reader even when the manifest and provider metadata claim the same hashes", async () => {
    const f = publicationFixture("dpl_new");
    f.state.staging = undefined;
    await expect(f.adapter.verify()).rejects.toThrow();
  });
});
