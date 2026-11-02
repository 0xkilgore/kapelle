import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  canonicalTarget,
  publicationArtifact,
  publicationProposal,
} from "../src/publication/manifest.js";
import { dispatchIntent, publicationDelivery } from "../src/publication/effects.js";
import { VercelPublicationProvider } from "../src/publication/vercel-provider.js";
import { vercelProviderFixture } from "./vercel-provider-fixture.js";

function setup() {
  const f = vercelProviderFixture(true),
    db = new DatabaseSync(":memory:");
  let fenced = true;
  const binding = {
    intent: dispatchIntent("review", "publisher", f.m),
    operationId: "operation",
    dispatchRef: "dispatch",
    outboxRef: "outbox",
  };
  const config = {
    manifest: f.m,
    reviewId: "review",
    instanceId: "publisher",
    journal: db,
      brokerHostId: "synthetic-host",
    token: () => "synthetic-provider-token-0123456789",
    request: f.request,
    stagingReceipt: async () => f.stagingReceipt,
    admit: async () => {},
    confirmNativeDelivery: async () => {},
    assertExclusiveProjectWriter: async () => {
      if (!fenced) throw Error("Writer fence unavailable");
    },
  };
  return {
    ...f,
    db,
    binding,
    config,
    provider: new VercelPublicationProvider(config),
    unfence: () => {
      fenced = false;
    },
    close: () => db.close(),
  };
}
describe("Versioned exact routing manifest", () => {
  it("does not reinterpret v1 proposals as routing-bound approvals", () => {
    const f = setup();
    try {
      expect(() =>
        publicationArtifact({ ...f.m, contract: "kapelle/website-publication/v1" }),
      ).toThrow();
      const { routing: _routing, ...legacyTarget } = f.m.target;
      const legacy = publicationArtifact({
        ...f.m,
        contract: "kapelle/website-publication/v1",
        target: legacyTarget,
      }).manifest;
      expect(publicationProposal(legacy).contentHash).not.toBe(
        publicationProposal(f.m).contentHash,
      );
      expect(() => new VercelPublicationProvider({ ...f.config, manifest: legacy })).toThrow(
        /new v2/,
      );
    } finally {
      f.close();
    }
  });
  it.each([
    "destination",
    "effective-status",
    "configured-status",
    "project-domains",
    "deployment-aliases",
    "production-aliases",
  ])("binds %s into the exact approval identity", (kind) => {
    const f = vercelProviderFixture(true),
      m = structuredClone(f.m),
      r = m.target.routing.routes.find((r) => r.kind === "redirect")!;
    if (r.kind !== "redirect") throw Error("Missing redirect");
    if (kind === "destination") r.destination = "synthetic.vercel.app";
    if (kind === "effective-status") r.status = 308;
    if (kind === "configured-status") r.configuredStatus = 307;
    if (kind === "project-domains")
      m.target.routing.projectDomains.push("synthetic-team.vercel.app");
    if (kind === "deployment-aliases")
      m.target.routing.deploymentAliases = m.target.routing.deploymentAliases.filter(
        (n) => n !== "synthetic.test",
      );
    if (kind === "production-aliases")
      m.target.routing.productionAliases.push("www.synthetic.test");
    expect(publicationProposal(m).contentHash).not.toBe(publicationProposal(f.m).contentHash);
  });
  it.each([
    "self-loop",
    "chain",
    "external",
    "url",
    "http",
    "status",
    "missing-route",
    "duplicate-alias",
    "unclassified-alias",
  ])("rejects unsupported %s routing before a proposal exists", (kind) => {
    const m = structuredClone(vercelProviderFixture(true).m),
      r = m.target.routing.routes.find((r) => r.kind === "redirect")!;
    if (r.kind !== "redirect") throw Error("Missing redirect");
    if (kind === "self-loop") r.destination = r.domain;
    if (kind === "chain")
      m.target.routing.routes = m.target.routing.routes.map((v) =>
        v.domain === r.destination ? { ...r, domain: v.domain, destination: r.domain } : v,
      );
    if (kind === "external") r.destination = "outside.test";
    if (kind === "url") r.destination = "https://www.synthetic.test/path";
    if (kind === "http") r.destination = "http://www.synthetic.test";
    if (kind === "status") r.configuredStatus = 308;
    if (kind === "missing-route") m.target.routing.routes.pop();
    if (kind === "duplicate-alias") m.target.aliases[0].aliasId = m.target.aliases[1].aliasId;
    if (kind === "unclassified-alias")
      m.target.routing.deploymentAliases = m.target.routing.deploymentAliases.filter(
        (n) => n !== "synthetic-team.vercel.app",
      );
    expect(() => publicationArtifact(m)).toThrow();
  });
});
describe("Vercel complete inventory and direct/redirect verification", () => {
  it("preserves apex to www with null API override / effective 307 and all generated aliases through native delivery proof", async () => {
    const f = setup();
    try {
      expect(await f.provider.target()).toEqual(f.m.target);
      await f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m));
      expect((await publicationDelivery(f.binding, f.m, f.provider)).status).toBe("DELIVERED");
      expect(f.state.posts).toBe(1);
      const publicRequests = f.state.requests.filter(
        (r) =>
          r.origin !== "https://api.vercel.com" &&
          r.origin !== "https://synthetic-staged.vercel.app",
      );
      expect(
        publicRequests
          .filter((r) => r.origin === "https://synthetic.test")
          .every((r) => r.method === "HEAD" && !r.stagingCredential),
      ).toBe(true);
      expect(
        publicRequests.some(
          (r) =>
            r.origin === "https://synthetic.test" &&
            r.path === "/events/cleanup?kapelle-routing-probe=1",
        ),
      ).toBe(true);
      for (const host of [
        "www.synthetic.test",
        "synthetic.vercel.app",
        "synthetic-team.vercel.app",
      ])
        expect(
          publicRequests.some((r) => r.origin === "https://" + host && r.method === "GET"),
        ).toBe(true);
      await expect(f.provider.site("synthetic.test", "events/cleanup")).rejects.toThrow(/Unbound/);
      await expect(f.provider.redirect("outside.test", "")).rejects.toThrow(/Unbound/);
      await expect(f.provider.redirect("synthetic.test", "unexpected")).rejects.toThrow(/Unbound/);
    } finally {
      f.close();
    }
  });
  it.each([
    "redirect-destination",
    "redirect-status",
    "redirect-path",
    "redirect-query",
    "domain-alias-status",
    "branch-domain",
    "missing-alias",
    "extra-alias",
    "missing-deployment-alias",
    "extra-deployment-alias",
    "domain-pagination",
    "alias-pagination",
    "mixed-deployment",
    "routing-drift",
  ])("rejects %s before durable contact or promotion", async (fault) => {
    const f = setup();
    try {
      f.state.fault = fault;
      await expect(f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m))).rejects.toThrow();
      expect(f.state.posts).toBe(0);
      expect(f.db.prepare("SELECT * FROM publication_provider_contacts").all()).toHaveLength(0);
    } finally {
      f.close();
    }
  });
  it.each([
    "redirect-destination",
    "redirect-status",
    "redirect-path",
    "redirect-query",
    "direct-redirect",
    "missing-alias",
    "extra-alias",
    "missing-deployment-alias",
  ])("keeps %s after promotion unconfirmed, without another POST", async (fault) => {
    const f = setup();
    try {
      await f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m));
      f.state.fault = fault;
      expect((await f.provider.receipt(f.binding)).status).toBe("UNKNOWN");
      expect((await publicationDelivery(f.binding, f.m, f.provider)).status).toBe("UNCERTAIN");
      await f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m));
      expect(f.state.posts).toBe(1);
      expect(
        (f.db.prepare("SELECT settled FROM publication_provider_contacts").get() as any).settled,
      ).toBe(0);
    } finally {
      f.close();
    }
  });
  it("independently checks routing in native delivery rather than trusting provider PUBLISHED", async () => {
    const f = setup();
    try {
      await f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m));
      const receipt = await f.provider.receipt(f.binding);
      const actual = await f.provider.target();
      const forged = {
        receipt: async () => receipt,
        target: async () => actual,
        site: f.provider.site.bind(f.provider),
        redirect: async () => ({ status: 307, location: "https://outside.test/" }),
      };
      await expect(publicationDelivery(f.binding, f.m, forged)).rejects.toThrow(/Redirect/);
      const changed = structuredClone(actual);
      if (!("routing" in changed)) throw Error("Missing routing");
      const route = changed.routing.routes.find((r) => r.kind === "redirect")!;
      if (route.kind === "redirect") route.destination = "synthetic.vercel.app";
      await expect(
        publicationDelivery(f.binding, f.m, {
          ...forged,
          target: async () => canonicalTarget(changed),
        }),
      ).rejects.toThrow(/routing/);
    } finally {
      f.close();
    }
  });
  it("keeps the exclusive writer gate mandatory for a valid redirect topology", async () => {
    const f = setup();
    try {
      f.unfence();
      await expect(f.provider.withOperation(f.binding, () => f.provider.publish(f.binding, f.m))).rejects.toThrow(/Writer fence/);
      expect(f.state.posts).toBe(0);
      expect(f.state.requests).toHaveLength(0);
    } finally {
      f.close();
    }
  });
});
