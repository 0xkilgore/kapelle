import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { VercelPublicationProvider } from "../src/publication/vercel-provider.js";
import { publicationDelivery, dispatchIntent } from "../src/publication/effects.js";
import { publicationProposal } from "../src/publication/manifest.js";
import { vercelProviderFixture } from "./vercel-provider-fixture.js";
function setup(stagedProtectionBypass?: () => string) {
  const f = vercelProviderFixture(),
    dir = mkdtempSync(join(tmpdir(), "provider-contact-"));
  let db = new DatabaseSync(join(dir, "journal.sqlite")),
    denied = false,
    fenced = true,
    nativeCommitted = false;
  const binding = {
    intent: dispatchIntent("review", "publisher", f.m),
    operationId: "operation",
    dispatchRef: "dispatch",
    outboxRef: "outbox",
  };
  const create = () =>
    new VercelPublicationProvider({
      manifest: f.m,
      reviewId: "review",
      instanceId: "publisher",
      journal: db,
      brokerHostId: "synthetic-host",
      token: () => "synthetic-provider-token-0123456789",
      request: f.request,
      stagingReceipt: async () => f.stagingReceipt,
      stagedProtectionBypass,
      admit: async () => {
        if (denied) throw Error("Native admission revoked");
      },
      assertExclusiveProjectWriter: async () => {
        if (!fenced) throw Error("Project writer fence unavailable");
      },
      confirmNativeDelivery: async (_b, evidenceId) => {
        if (!nativeCommitted || evidenceId !== "native-evidence")
          throw Error("Native delivery unavailable");
      },
    });
  let provider = create();
  return {
    ...f,
    binding,
    get provider() {
      return provider;
    },
    get db() {
      return db;
    },
    revoke() {
      denied = true;
    },
    unfence() {
      fenced = false;
    },
    commitNative() {
      nativeCommitted = true;
    },
    restart() {
      db.close();
      db = new DatabaseSync(join(dir, "journal.sqlite"));
      provider = create();
    },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
describe("Vercel staged production provider", () => {
  it("retains the project hold even after native delivery is observed", async () => {
    const f = setup();
    try {
      await f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m));
      expect((await f.provider.receipt(f.binding)).status).toBe("PUBLISHED");
      expect(
        (f.db.prepare("SELECT settled FROM publication_provider_contacts").get() as any).settled,
      ).toBe(0);
      await expect(f.provider.withOperation(f.binding, () => f.provider.confirmDelivery(f.binding, "native-evidence"))).rejects.toThrow(
        /Native delivery/,
      );
      f.commitNative();
      await f.provider.withOperation(f.binding, () => f.provider.confirmDelivery(f.binding, "native-evidence"));
      expect(
        (f.db.prepare("SELECT settled FROM publication_provider_contacts").get() as any).settled,
      ).toBe(0);
      expect(f.provider.holdStatus(f.binding)).toEqual({ held: true, requestSettlement: "UNPROVEN", observations: ["native-evidence"] });
    } finally {
      f.close();
    }
  });
  it("binds the staged ID into approval identity", () => {
    const f = vercelProviderFixture();
    expect(publicationProposal(f.m).contentHash).not.toBe(
      publicationProposal({ ...f.m, build: { ...f.m.build, stagedDeploymentId: "other" } })
        .contentHash,
    );
  });
  it.each(["success", "accepted-lost", "unknown"])(
    "sends one POST and reconciles %s after restart without reinvocation",
    async (fault) => {
      const f = setup();
      f.state.fault = fault;
      try {
        await f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m));
        expect(f.state.posts).toBe(1);
        f.restart();
        await f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m));
        expect(f.state.posts).toBe(1);
        const evidence = await publicationDelivery(f.binding, f.m, f.provider);
        expect(evidence.status).toBe(fault === "unknown" ? "UNCERTAIN" : "DELIVERED");
        if (fault === "unknown") {
          f.state.published = true;
          expect((await publicationDelivery(f.binding, f.m, f.provider)).status).toBe("DELIVERED");
        }
        expect(f.state.posts).toBe(1);
      } finally {
        f.close();
      }
    },
  );
  it.each([
    "team",
    "build",
    "target",
    "extra-domain",
    "policy",
    "revoked",
    "fence",
    "rolling-release",
    "unbound-staged-bytes",
    "unbound-staged-host",
    "protected-staging",
  ])("blocks %s before durable contact or POST", async (fault) => {
    const f = setup();
    f.state.fault = fault;
    if (fault === "revoked") f.revoke();
    if (fault === "fence") f.unfence();
    try {
      await expect(f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m))).rejects.toThrow();
      expect(f.state.posts).toBe(0);
      expect(f.db.prepare("SELECT * FROM publication_provider_contacts").all()).toHaveLength(0);
    } finally {
      f.close();
    }
  });
  it("requires PROMOTED and exact assigned aliases, without an undocumented promotedAt field", async () => {
    const f = setup();
    try {
      await f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m));
      expect((await f.provider.receipt(f.binding)).status).toBe("PUBLISHED");
      f.state.fault = "rolling-state";
      expect((await f.provider.receipt(f.binding)).status).toBe("UNKNOWN");
      expect(f.state.posts).toBe(1);
    } finally {
      f.close();
    }
  });
  it("uses a separate protection credential only on the receipt-bound staged host", async () => {
    const f = setup(() => "synthetic-deployment-protection-token");
    try {
      f.state.fault = "protected-staging";
      await f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m));
      expect((await f.provider.receipt(f.binding)).status).toBe("PUBLISHED");
      expect(
        f.state.requests.some(
          (r) => r.origin === "https://synthetic-staged.vercel.app" && r.stagingCredential,
        ),
      ).toBe(true);
      expect(
        f.state.requests
          .filter((r) => r.stagingCredential)
          .every((r) => r.origin === "https://synthetic-staged.vercel.app"),
      ).toBe(true);
    } finally {
      f.close();
    }
  });
  it("refuses using the Vercel REST credential as the staged-site bypass credential", async () => {
    const f = setup(() => "synthetic-provider-token-0123456789");
    try {
      await expect(f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m))).rejects.toThrow(/protection credential/);
      expect(f.state.posts).toBe(0);
      expect(f.state.requests.every((r) => r.origin === "https://api.vercel.com")).toBe(true);
    } finally {
      f.close();
    }
  });
  it("retains unknown contact across restart and rejects a changed saved binding", async () => {
    const f = setup();
    try {
      f.state.fault = "unknown";
      await f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m));
      f.restart();
      expect((await f.provider.receipt(f.binding)).status).toBe("UNKNOWN");
      await expect(
        f.provider.withOperation({ ...f.binding, dispatchRef: "forged" }, () => f.provider.publish(f.binding, f.m)),
      ).rejects.toThrow(/saved operation/);
      expect(f.state.posts).toBe(1);
    } finally {
      f.close();
    }
  });
  it("keeps unresolved project contact exclusive and requires live site bytes for a successful receipt", async () => {
    const f = setup();
    try {
      f.state.fault = "unknown";
      await f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m));
      await expect(
        f.provider.withOperation({ ...f.binding, operationId: "another" }, () => f.provider.publish(f.binding, f.m)),
      ).rejects.toThrow(/Project held/);
      expect(f.state.posts).toBe(1);
      f.state.published = true;
      f.state.page = Buffer.from("wrong");
      expect((await f.provider.receipt(f.binding)).status).toBe("UNKNOWN");
      expect(
        (f.db.prepare("SELECT settled FROM publication_provider_contacts").get() as any).settled,
      ).toBe(0);
    } finally {
      f.close();
    }
  });
  it("does not fetch arbitrary domains or paths", async () => {
    const f = setup();
    try {
      await expect(f.provider.site("other.synthetic.test", "events/cleanup")).rejects.toThrow(
        /Unbound/,
      );
      await expect(f.provider.site(f.m.target.domains[0], "events/cleanup?secret")).rejects.toThrow(
        /Unbound/,
      );
    } finally {
      f.close();
    }
  });
});
