import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vitest";
import { VercelPublicationProvider } from "../src/publication/vercel-provider.js";
import { dispatchIntent } from "../src/publication/effects.js";
import { vercelProviderFixture } from "./vercel-provider-fixture.js";

describe("No-contact seal at the final send boundary", () => {
  it("blocks a detached publisher that resumes admission after its run was retired and sealed", async () => {
    const f = vercelProviderFixture(), db = new DatabaseSync(":memory:");
    const binding = { intent: dispatchIntent("review", "publisher", f.m), operationId: "operation", dispatchRef: "dispatch", outboxRef: "outbox" };
    let entered!: () => void, resume!: () => void;
    const ready = new Promise<void>(resolve => entered = resolve), pause = new Promise<void>(resolve => resume = resolve);
    const provider = new VercelPublicationProvider({ manifest: f.m, reviewId: "review", instanceId: "publisher", journal: db, brokerHostId: "host", token: () => "synthetic-provider-token-000000000000", request: f.request, stagingReceipt: async () => f.stagingReceipt, assertExclusiveProjectWriter: async () => { }, admit: async () => { entered(); await pause; }, confirmNativeInvocation: async () => { }, confirmNativeDelivery: async () => { } });
    let detached: Promise<unknown> | undefined;
    try {
      await provider.withOperation(binding, async () => { detached = provider.publish(binding, f.m); await ready; });
      await provider.sealNoContact(binding);
      const rejected = expect(detached).rejects.toThrow(/guard required/);
      resume(); await rejected;
      expect(f.state.posts).toBe(0);
      expect(db.prepare("SELECT * FROM publication_provider_contacts").all()).toHaveLength(0);
      expect((await provider.receipt(binding)).status).toBe("FAILED");
      await expect(provider.withOperation(binding, () => provider.publish(binding, f.m))).rejects.toThrow(/permanently sealed/);
    } finally { resume(); await detached?.catch(() => { }); db.close(); }
  });
});
