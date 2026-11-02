import { describe, expect, it } from "vitest";
import * as R2 from "../document-models/review-intent/v2/index.js";
import { v2 } from "../document-models/review-intent/upgrades/v2.js";
import { canonical, digest, proposalHash } from "../src/command-boundary.js";
import {
  publicationArtifact,
  publicationProposal,
  bytesHash,
} from "../src/publication/manifest.js";
import { dispatchIntent, publicationDelivery } from "../src/publication/effects.js";
import { vercelTargetReader } from "../src/publication/vercel-target.js";
import { publicationFixture, SyntheticProvider } from "./publication-fixtures.js";
import { apply, ready, approved, reserve, context } from "./fixtures.js";

describe("Stable website publication artifact", () => {
  it("keeps approval binding across Report read/feedback revisions, not changed bytes", async () => {
    const f = publicationFixture(),
      before = await f.adapter.facts(f.ctx);
    f.state.reportRevision += 3;
    const after = await f.adapter.facts(f.ctx);
    expect(after.artifacts).toEqual(before.artifacts);
    expect(after.resources).toEqual(before.resources);
    f.state.reportBytes = Buffer.from("Different content");
    await expect(f.adapter.verify()).rejects.toThrow(/content/);
  });
  it.each(["commit", "tree", "files", "build", "report", "target", "task", "expiresAt"])(
    "binds %s into the approval",
    (field) => {
      const { m } = publicationFixture(),
        changed = structuredClone(m);
      if (field === "commit" || field === "tree") changed.source[field] = "c".repeat(40);
      if (field === "files") changed.source.files[0].hash = digest("different");
      if (field === "build") changed.build.outputHash = digest("different");
      if (field === "report") changed.report.contentHash = digest("different");
      if (field === "target") changed.target.aliases[0].deploymentId = "dpl_other";
      if (field === "task") changed.task.authorityTaskRef = "other-task";
      if (field === "expiresAt") changed.expiresAt = "2026-09-12T12:00:00.000Z";
      expect(publicationProposal(changed).contentHash).not.toBe(publicationProposal(m).contentHash);
    },
  );
  it.each(["owner", "source", "build", "target", "task", "expiry"])(
    "fails closed on %s drift",
    async (kind) => {
      const f = publicationFixture();
      if (kind === "owner") f.state.reportOwner = "other";
      if (kind === "source") f.state.sourceError = true;
      if (kind === "build") f.state.build.exitCode = 1;
      if (kind === "target") f.state.target.policyVersion++;
      if (kind === "task") f.state.task.authorityTaskRef = "unrelated";
      if (kind === "expiry") f.state.now = f.m.expiresAt;
      await expect(f.adapter.verify()).rejects.toThrow();
    },
  );
  it("does not accept mutable Report revision or self-asserted verification fields", () => {
    const { m } = publicationFixture();
    expect(() => publicationArtifact({ ...m, report: { ...m.report, revision: 3 } })).toThrow();
    expect(() => publicationArtifact({ ...m, verified: true })).toThrow();
    expect(() =>
      publicationArtifact({
        ...m,
        source: { ...m.source, files: [{ path: "../outside", hash: bytesHash("x"), bytes: 1 }] },
      }),
    ).toThrow();
  });
});

describe("Native v2 semantics and v1 preservation", () => {
  it("preserves legacy approval hash, decision, reservation and uncertainty on upgrade", () => {
    const ctx = context();
    ctx.instance = ready(ctx).state.global;
    const legacy = reserve(approved(ctx), ctx),
      before = canonical(legacy);
    const upgraded = v2.upgradeReducer(legacy, {} as any);
    expect(upgraded.state.global.proposal.expiresAt).toBe(null);
    expect(proposalHash(upgraded.state.global.proposal)).toBe(
      legacy.state.global.proposal!.contentHash,
    );
    expect(upgraded.state.global.effect).toEqual(legacy.state.global.effect);
    expect(upgraded.state.global.decision).toEqual(legacy.state.global.decision);
    expect(upgraded.operations).toEqual(legacy.operations);
    expect(canonical(legacy)).toBe(before);
  });
  it("requires website semantics and expiry, rejects disguising publish as document change", async () => {
    const f = publicationFixture(),
      ctx = { ...f.ctx, ...(await f.adapter.facts(f.ctx, true)) };
    ctx.instance = ready(ctx).state.global;
    const empty = R2.utils.createDocument(),
      p = publicationProposal(f.m);
    for (const change of [
      { effectKind: "DOCUMENT_CHANGE" },
      { expiresAt: null },
      { action: "update" },
    ]) {
      const proposal = { ...p, ...change } as R2.Proposal;
      proposal.contentHash = proposalHash(proposal);
      expect(() =>
        apply(
          empty,
          "CREATE_REVIEW",
          {
            reviewId: empty.header.id,
            instanceId: ctx.instance!.instanceId,
            scopeRef: ctx.scopeRef,
            proposal,
          },
          ctx,
        ),
      ).toThrow();
    }
    const d = apply(
      empty,
      "CREATE_REVIEW",
      {
        reviewId: empty.header.id,
        instanceId: ctx.instance.instanceId,
        scopeRef: ctx.scopeRef,
        proposal: p,
      },
      ctx,
    );
    expect(() =>
      apply(
        d,
        "RECORD_DECISION",
        { proposalHash: p.contentHash, proposalVersion: 1, approved: false, reason: "" },
        ctx,
      ),
    ).toThrow(/reason/);
    expect(() =>
      apply(
        d,
        "RECORD_DECISION",
        { proposalHash: p.contentHash, proposalVersion: 1, approved: true },
        { ...ctx, occurredAt: p.expiresAt! },
      ),
    ).toThrow(/expired/);
  });
});

describe("Provider/site evidence", () => {
  async function fixture() {
    const f = publicationFixture(),
      provider = new SyntheticProvider(f);
    const binding = {
      intent: dispatchIntent("review-1", "publisher-1", f.m),
      dispatchRef: "dispatch-1",
      outboxRef: "outbox-1",
      operationId: "effect-1",
    };
    await provider.publish(binding);
    return { f, provider, binding };
  }
  it("requires provider identity, aliases and exact live-site bytes to say delivered", async () => {
    const { f, provider, binding } = await fixture();
    expect((await publicationDelivery(binding, f.m, provider)).status).toBe("DELIVERED");
    provider.siteBytes = Buffer.from("stale page");
    await expect(publicationDelivery(binding, f.m, provider)).rejects.toThrow(/bytes/);
  });
  it.each(["projectId", "teamId", "commit", "tree", "buildHash", "operationId", "intentHash"])(
    "rejects mismatched %s receipt",
    async (field) => {
      const { f, provider, binding } = await fixture();
      provider.tamper = { [field]: "wrong" };
      await expect(publicationDelivery(binding, f.m, provider)).rejects.toThrow(/identity/);
    },
  );
  it("rejects wrong alias deployment and preserves unknown separately from failed", async () => {
    const { f, provider, binding } = await fixture();
    provider.targetState.aliases[0].deploymentId = "dpl_other";
    await expect(publicationDelivery(binding, f.m, provider)).rejects.toThrow(/aliases/);
    provider.status = "UNKNOWN";
    expect((await publicationDelivery(binding, f.m, provider)).status).toBe("UNCERTAIN");
    provider.status = "FAILED";
    expect((await publicationDelivery(binding, f.m, provider)).status).toBe("FAILED");
  });
});

describe("Read-only provider target adapter", () => {
  function setup(change = "") {
    const { m } = publicationFixture();
    let reads = 0;
    const calls: URL[] = [];
    const fetcher = (async (url: URL, init: RequestInit) => {
      calls.push(url);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(url.origin).toBe("https://api.vercel.com");
      expect(url.searchParams.get("teamId")).toBe(m.target.teamId);
      if (change === "403") return new Response("private", { status: 403 });
      if (url.pathname.includes("projects"))
        return Response.json({
          id: m.target.projectId,
          accountId: change === "owner" ? "other-team" : m.target.teamId,
        });
      if (url.pathname.includes("aliases")) {
        reads++;
        return Response.json({
          alias: m.target.domains[0],
          uid: "alias_synthetic",
          projectId: m.target.projectId,
          deploymentId: change === "drift" && reads > 1 ? "dpl_new" : "dpl_old",
          redirect: change === "redirect" ? "somewhere.test" : null,
        });
      }
      return Response.json({
        id: url.pathname.split("/").at(-1),
        projectId: m.target.projectId,
        readyState: change === "building" ? "BUILDING" : "READY",
        target: "production",
        aliasAssigned: true,
      });
    }) as unknown as typeof fetch;
    return {
      read: vercelTargetReader(m.target, () => "synthetic-provider-token-0123456789", fetcher),
      calls,
      m,
    };
  }
  it("uses verified account/project/alias/deployment reads, twice, without provider mutation", async () => {
    const f = setup();
    expect(await f.read()).toEqual(f.m.target);
    expect(f.calls).toHaveLength(6);
  });
  it.each(["403", "owner", "redirect", "building", "drift"])("fails closed on %s", async (kind) => {
    await expect(setup(kind).read()).rejects.toThrow(/Target/);
  });
});
