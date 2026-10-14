import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openFrameworkRuntime } from "../src/service/runtime.js";
import type { ModelType, Command } from "../src/command-boundary.js";
import {
  PublicationCoordinator,
  dispatchIntent,
  publicationEffectFacts,
  websiteEffectPolicy,
} from "../src/publication/effects.js";
import { publicationReviewPlan } from "../src/publication/provision.js";
import { publicationProposal } from "../src/publication/manifest.js";
import {
  publicationFixture,
  SyntheticDispatch,
  SyntheticProvider,
} from "./publication-fixtures.js";
import { policy } from "./fixtures.js";
import type { PublicationDispatch, PublicationProvider } from "../src/publication/effects.js";
import { createServer, type RequestListener } from "node:http";
import { once } from "node:events";
import { managerPublicationFixture } from "./manager-publication-fixture.js";
import { managerPublicationHandler } from "../src/publication/manager-transport.js";
import {
  approvedPublication,
  nativePublicationDelivery,
  PublicationExecutorClient,
} from "../src/publication/executor-http.js";
import { vercelProviderFixture } from "./vercel-provider-fixture.js";
import { publicationExecutorAdapters } from "../src/publication/executor-adapters.js";
import { VercelPublicationProvider } from "../src/publication/vercel-provider.js";
import { publicationDecisionHandler } from "../src/publication/decision-http.js";
const reactorRoot = process.env.KAPELLE_SCOPED_REACTOR_ROOT;

async function fixture(effects = true, staged = false, routed = false) {
  const f = publicationFixture(staged ? "dpl_new" : undefined, routed),
    root = mkdtempSync(join(tmpdir(), "kapelle-publication-"));
  let dispatch = new SyntheticDispatch(join(root, "synthetic-dispatch.sqlite"));
  const provider = new SyntheticProvider(f);
  let ports: { dispatch: PublicationDispatch; provider: PublicationProvider } | undefined;
  let instanceId = "unprovisioned",
    reviewId = "unprovisioned";
  const options = {
    stateRoot: join(root, "native"),
    reactorRoot: reactorRoot!,
    ownerId: f.m.ownerId,
    scopeRef: f.m.scopeRef,
    now: () => f.state.now,
    effectPolicy: effects
      ? (...args: Parameters<ReturnType<typeof websiteEffectPolicy>>) =>
          websiteEffectPolicy(f.m, instanceId)(...args)
      : undefined,
    facts: () =>
      publicationEffectFacts(
        f.ctx,
        f.adapter,
        reviewId,
        instanceId,
        ports?.dispatch ?? dispatch,
        ports?.provider ?? provider,
      ),
  };
  let runtime = await openFrameworkRuntime(options),
    n = 0;
  async function allocate(type: ModelType, version = 1) {
    return (
      await runtime.authority.allocate(`allocation-${n++}`, type, "Synthetic publication", version)
    ).documentId;
  }
  async function command(
    id: string,
    type: ModelType,
    name: string,
    input: Record<string, unknown>,
    operationId = `command-${n++}`,
  ) {
    const doc = await runtime.authority.read(id, type);
    const request: Command = {
      operationId,
      documentId: id,
      documentType: type,
      expectedRevision: doc.state.global.revision,
      type: name,
      input,
    };
    const result = await runtime.authority.command(request);
    expect(result.result.disposition, JSON.stringify(result.result)).toBe("ACCEPTED");
    return request;
  }
  const r = f.ctx.definitions[0].release;
  const definitionId = await allocate("kapelle/agent-definition");
  await command(definitionId, "kapelle/agent-definition", "PUBLISH_DEFINITION", { release: r });
  instanceId = await allocate("kapelle/agent-instance");
  await command(instanceId, "kapelle/agent-instance", "CREATE_INSTANCE", {
    instanceId,
    scopeRef: f.m.scopeRef,
    definitionRef: { id: r.definitionId, version: r.packageVersion, contentHash: r.contentHash },
    name: "Synthetic website publisher",
    responsibilities: ["Publish exact reviewed content"],
    operatingPolicy: "One consumed native approval per exact website publication",
    modelPolicy: policy,
  });
  await command(instanceId, "kapelle/agent-instance", "SET_RUNTIME_BINDING", {
    runtimeBindingRef: "local-adapter",
  });
  await command(instanceId, "kapelle/agent-instance", "GRANT_CAPABILITY", {
    grant: {
      id: "website-grant",
      principalId: instanceId,
      resourceRef: f.m.target.bindingRef,
      actions: ["read", "publish"],
      expiresAt: f.m.expiresAt,
      reviewPolicy: "ALWAYS",
    },
  });
  await command(instanceId, "kapelle/agent-instance", "REQUEST_RESUME", {});
  const plan = publicationReviewPlan(f.m),
    a = plan.allocation;
  reviewId = (
    await runtime.authority.allocate(a.operationId, a.documentType, a.name, a.modelVersion)
  ).documentId;
  expect(
    (await runtime.authority.command(plan.createReview(reviewId, instanceId))).result.disposition,
  ).toBe("ACCEPTED");
  const read = async () =>
    (await runtime.authority.read(reviewId, "kapelle/review-intent")).state.global as any;
  const decide = (approved = true) =>
    command(reviewId, "kapelle/review-intent", "RECORD_DECISION", {
      proposalHash: publicationProposal(f.m).contentHash,
      proposalVersion: 1,
      approved,
      reason: approved ? null : "Please correct the date",
    });
  const reserve = async () => {
    const p = publicationProposal(f.m),
      b = await dispatch.ensure(dispatchIntent(reviewId, instanceId, f.m));
    await command(reviewId, "kapelle/review-intent", "RESERVE_EFFECT", {
      operationId: b.operationId,
      dispatchRef: b.dispatchRef,
      outboxRef: b.outboxRef,
      proposalHash: p.contentHash,
      proposalVersion: p.version,
    });
    return b;
  };
  return {
    ...f,
    provider,
    instanceId,
    reviewId,
    read,
    decide,
    command,
    reserve,
    useAdapters(adapters: NonNullable<typeof ports>) {
      ports = adapters;
    },
    get authority() {
      return runtime.authority;
    },
    get dispatch() {
      return dispatch;
    },
    coordinator: () =>
      new PublicationCoordinator(
        runtime.authority,
        f.m,
        instanceId,
        ports?.dispatch ?? dispatch,
        ports?.provider ?? provider,
      ),
    async restart() {
      await runtime.close();
      dispatch.close();
      dispatch = new SyntheticDispatch(join(root, "synthetic-dispatch.sqlite"));
      runtime = await openFrameworkRuntime(options);
    },
    async close() {
      await runtime.close();
      dispatch.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!reactorRoot)("Native approval → synthetic Dispatch → verified publication", () => {
  function attach(f: Awaited<ReturnType<typeof fixture>>, fake: ReturnType<typeof vercelProviderFixture>, request = fake.request) {
    const provider = new VercelPublicationProvider({
      manifest: f.m, reviewId: f.reviewId, instanceId: f.instanceId,
      journal: f.authority.journal.db, brokerHostId: "synthetic-recovery-host",
      token: () => "synthetic-provider-token-0123456789", request,
      stagingReceipt: async () => f.state.staging,
      admit: b => f.authority.effectAdmission(f.reviewId, b.operationId).then(() => {}),
      assertExclusiveProjectWriter: async () => {},
      confirmNativeDelivery: (b, id) => nativePublicationDelivery(f.authority, f.m, f.reviewId, f.instanceId, b, id),
    });
    f.useAdapters({ dispatch: f.dispatch, provider });
    return provider;
  }
  it.each(["before-claim", "after-claim", "lost-claim-ack"])(
    "retains the pre-contact project hold across native restart at %s", async (window) => {
      const f = await fixture(true, true, true), fake = vercelProviderFixture(true);
      let provider = attach(f, fake);
      try {
        await f.decide();
        const claim = f.authority.claimPublicationInvocation.bind(f.authority);
        f.authority.claimPublicationInvocation = async (...args) => {
          expect(f.authority.journal.db.prepare("SELECT * FROM publication_project_holds").all()).toHaveLength(1);
          if (window === "before-claim") throw Error("Synthetic interruption");
          const result = await claim(...args);
          if (window === "after-claim") throw Error("Synthetic interruption");
          return result;
        };
        if (window === "lost-claim-ack") {
          const commit = f.authority.backend.commit.bind(f.authority.backend);
          f.authority.backend.commit = async (id, prepared) => {
            const result = await commit(id, prepared);
            if (prepared.action.type === "CLAIM_EXECUTION") throw Error("Synthetic interruption");
            return result;
          };
        }
        await expect(f.coordinator().run(f.reviewId)).rejects.toThrow(/Synthetic interruption/);
        expect(fake.state.posts).toBe(0);
        const b = (await f.dispatch.read(dispatchIntent(f.reviewId, f.instanceId, f.m).key))!;
        expect(provider.holdStatus(b).held).toBe(true);
        expect(f.authority.journal.db.prepare("SELECT * FROM publication_provider_contacts").all()).toHaveLength(0);
        await f.restart();
        provider = attach(f, fake);
        await expect(provider.withOperation({ ...b, operationId: "different" }, async () => {}))
          .rejects.toThrow(/Project held/);
        expect((await f.coordinator().run(f.reviewId)).status)
          .toBe(window === "before-claim" ? "DELIVERED" : "UNCERTAIN");
        expect(fake.state.posts).toBe(window === "before-claim" ? 1 : 0);
        expect(provider.holdStatus(b).held).toBe(true);
        const native = await f.authority.read(f.reviewId, "kapelle/review-intent");
        expect(native.operations.global.filter(o => o.action.type === "CLAIM_EXECUTION" && !o.error)).toHaveLength(1);
        expect((await f.coordinator().reconcile(f.reviewId)).status)
          .toBe(window === "before-claim" ? "DELIVERED" : "UNCERTAIN");
      } finally { await f.close(); }
    },
  );
  it("serializes reconciliation against a pending POST across provider instances", async () => {
    const f = await fixture(true, true, true), fake = vercelProviderFixture(true);
    let contacted!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => contacted = resolve);
    const wait = new Promise<void>(resolve => release = resolve);
    const provider = attach(f, fake, async (...args) => {
      if (args[1]?.method === "POST") { contacted(); await wait; }
      return fake.request(...args);
    });
    let run: Promise<unknown> | undefined;
    try {
      await f.decide(); run = f.coordinator().run(f.reviewId); await ready;
      const b = (await f.dispatch.read(dispatchIntent(f.reviewId, f.instanceId, f.m).key))!;
      // Owner independently makes the same candidate observable while broker POST is delayed.
      fake.state.published = true;
      const other = attach(f, fake);
      await expect(f.coordinator().reconcile(f.reviewId)).rejects.toThrow(/busy/);
      await expect(f.coordinator().run(f.reviewId)).rejects.toThrow(/busy/);
      await expect(provider.publish(b, f.m)).rejects.toThrow(/guard required/);
      expect((await f.read()).delivery).toHaveLength(0);
      release(); expect(await run).toEqual({ status: "DELIVERED" });
      expect(fake.state.posts).toBe(1);
      expect(other.holdStatus(b)).toMatchObject({ held: true, requestSettlement: "UNPROVEN" });
      expect(other.holdStatus(b).observations).toHaveLength(1);
      await expect(other.withOperation({ ...b, operationId: "next" }, async () => {})).rejects.toThrow(/Project held/);
      fake.state.fault = "missing-alias";
      // Retained native result is historical; later drift does not erase it or free the lane.
      expect(await f.coordinator().reconcile(f.reviewId)).toEqual({ status: "DELIVERED" });
      expect(fake.state.posts).toBe(1);
    } finally { release(); await run?.catch(() => {}); await f.close(); }
  });
  it("does not write delivery evidence before the native claim", async () => {
    const f = await fixture(true, true, true), fake = vercelProviderFixture(true);
    attach(f, fake);
    try {
      await f.decide(); await f.reserve();
      await expect(f.coordinator().reconcile(f.reviewId)).rejects.toThrow(/not been claimed/);
      expect((await f.read()).delivery).toHaveLength(0);
      expect(fake.state.posts).toBe(0);
    } finally { await f.close(); }
  });

  it("the unchanged owner facade approves only the exact v2 routing proposal", async () => {
    const f = await fixture(true, true, true);
    const token = "synthetic-owner-routing-token-0123456789";
    const server = await machineServer(
      publicationDecisionHandler(f.authority, {
        manifest: f.m,
        reviewDocumentId: f.reviewId,
        instanceId: f.instanceId,
        token: () => token,
      }),
    );
    try {
      const changed = structuredClone(f.m);
      if (changed.contract !== "kapelle/website-publication/v2") throw Error("Missing routing");
      const redirect = changed.target.routing.routes.find((r) => r.kind === "redirect")!;
      if (redirect.kind === "redirect") redirect.status = 308;
      const command = {
        operationId: "exact-v2-routing-decision",
        documentId: f.reviewId,
        documentType: "kapelle/review-intent",
        expectedRevision: 1,
        type: "RECORD_DECISION",
        input: {
          proposalHash: publicationProposal(changed).contentHash,
          proposalVersion: 1,
          approved: true,
          reason: null,
        },
      };
      const post = (body: unknown) =>
        fetch(server.url + "/commands", {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      expect((await post(command)).status).toBe(403);
      expect((await f.read()).decision).toBeNull();
      command.input.proposalHash = publicationProposal(f.m).contentHash;
      const accepted = await post(command);
      expect(accepted.status).toBe(200);
      expect(((await accepted.json()) as any).result.disposition).toBe("ACCEPTED");
      expect((await f.read()).decision.approved).toBe(true);
      expect((await f.read()).execution).toBeNull();
      expect((await post(command)).status).toBe(200);
      expect((await f.read()).revision).toBe(2);
    } finally {
      await server.close();
      await f.close();
    }
  });
  it("rejects changed trusted staging evidence before saving owner approval", async () => {
    const f = await fixture(true, true);
    try {
      f.state.staging!.deploymentId = "another-deployment";
      await expect(f.decide()).rejects.toThrow();
      expect((await f.read()).decision).toBeNull();
      expect((await f.read()).execution).toBeNull();
    } finally {
      await f.close();
    }
  });
  it("rejects changed redirect routing before saving owner approval", async () => {
    const f = await fixture(true, true, true);
    try {
      if (!("routing" in f.state.target)) throw Error("Missing routing fixture");
      const route = f.state.target.routing.routes.find((r) => r.kind === "redirect")!;
      if (route.kind === "redirect") route.status = 308;
      await expect(f.decide()).rejects.toThrow();
      expect((await f.read()).decision).toBeNull();
      expect((await f.read()).execution).toBeNull();
    } finally {
      await f.close();
    }
  });
  it.each([
    "rolling-release",
    "unbound-staged-bytes",
    "protected-staging",
    "redirect-status",
    "missing-alias",
    "extra-alias",
  ])(
    "rejects %s before a native invocation claim, then permits the same reservation once eligible",
    async (fault) => {
      const f = await fixture(true, true, true),
        fake = vercelProviderFixture(true);
      fake.state.fault = fault;
      const provider = new VercelPublicationProvider({
        manifest: f.m,
        reviewId: f.reviewId,
        instanceId: f.instanceId,
        journal: f.authority.journal.db,
        brokerHostId: "synthetic-host",
        token: () => "synthetic-provider-token-0123456789",
        request: fake.request,
        stagingReceipt: async () => f.state.staging,
        admit: (binding) =>
          f.authority.effectAdmission(f.reviewId, binding.operationId).then(() => {}),
        assertExclusiveProjectWriter: async () => {},
        confirmNativeDelivery: async () => {},
      });
      f.useAdapters({ dispatch: f.dispatch, provider });
      try {
        await f.decide();
        await expect(f.coordinator().run(f.reviewId)).rejects.toThrow();
        const before = await f.read();
        expect(before.effect).not.toBeNull();
        expect(before.execution).toBeNull();
        expect(fake.state.posts).toBe(0);
        expect(
          f.authority.journal.db.prepare("SELECT * FROM publication_provider_contacts").all(),
        ).toHaveLength(0);
        fake.state.fault = "";
        expect((await f.coordinator().run(f.reviewId)).status).toBe("DELIVERED");
        expect((await f.read()).effect).toEqual(before.effect);
        expect(fake.state.posts).toBe(1);
      } finally {
        await f.close();
      }
    },
  );
  it("replays v2 from native storage; two buttons, opposite decisions, and lost response retain one decision", async () => {
    const f = await fixture();
    try {
      const request: Command = {
        operationId: "decision-from-both-buttons",
        documentId: f.reviewId,
        documentType: "kapelle/review-intent",
        expectedRevision: 1,
        type: "RECORD_DECISION",
        input: {
          proposalHash: publicationProposal(f.m).contentHash,
          proposalVersion: 1,
          approved: true,
          reason: null,
        },
      };
      f.state.reportRevision = 99;
      const [a, b] = await Promise.all([
        f.authority.command(request),
        f.authority.command(request),
      ]);
      expect(a).toEqual(b);
      expect((await f.read()).revision).toBe(2);
      await expect(
        f.authority.command({
          ...request,
          operationId: "opposing-decision",
          input: { ...request.input, approved: false, reason: "Change date" },
        }),
      ).rejects.toThrow(/Stale/);
      f.state.now = f.m.expiresAt;
      f.state.sourceError = true;
      await f.restart();
      expect(await f.authority.command(request)).toEqual(a);
      await expect(
        f.authority.command({ ...request, input: { ...request.input, approved: false } }),
      ).rejects.toThrow(/conflicts/);
      expect(
        (await f.authority.read(f.reviewId, "kapelle/review-intent")).state.document.version,
      ).toBe(2);
      const allocation = publicationReviewPlan(f.m).allocation;
      expect(
        (
          await f.authority.allocate(
            allocation.operationId,
            allocation.documentType,
            allocation.name,
            2,
          )
        ).documentId,
      ).toBe(f.reviewId);
      await expect(
        f.authority.allocate(allocation.operationId, allocation.documentType, allocation.name, 1),
      ).rejects.toThrow(/version changed/);
      expect(f.dispatch.all()).toHaveLength(0);
      expect(f.provider.calls).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("makes rejection and invalidation terminal without enqueueing a publication", async () => {
    const f = await fixture();
    try {
      await f.decide(false);
      await expect(f.coordinator().run(f.reviewId)).rejects.toThrow(/approval/);
      await expect(f.decide(true)).rejects.toThrow();
      expect(f.dispatch.all()).toHaveLength(0);
      expect(f.provider.calls).toBe(0);
    } finally {
      await f.close();
    }
    const g = await fixture();
    try {
      await g.decide();
      await g.command(g.reviewId, "kapelle/review-intent", "INVALIDATE_REVIEW", {
        reason: "Superseded",
      });
      await expect(g.coordinator().run(g.reviewId)).rejects.toThrow(/approval/);
      expect(g.dispatch.all()).toHaveLength(0);
    } finally {
      await g.close();
    }
  });
  it("reserves/invokes once across duplicate wakeups and records publication independently of Task completion", async () => {
    const f = await fixture();
    try {
      await f.decide();
      const beforeTask = structuredClone(f.state.task);
      const coordinator = f.coordinator();
      await Promise.allSettled([coordinator.run(f.reviewId), coordinator.run(f.reviewId)]);
      expect(await coordinator.run(f.reviewId)).toEqual({ status: "DELIVERED" });
      const s = await f.read();
      expect(s.status).toBe("APPROVED");
      expect(s.effect).not.toBe(null);
      expect(s.delivery.at(-1).status).toBe("DELIVERED");
      expect(f.provider.calls).toBe(1);
      expect(f.dispatch.all()).toHaveLength(1);
      const doc = await f.authority.read(f.reviewId, "kapelle/review-intent");
      expect(
        doc.operations.global.filter((op) => op.action.type === "RESERVE_EFFECT" && !op.error),
      ).toHaveLength(1);
      expect(f.state.task).toEqual(beforeTask);
      await f.restart();
      expect(await f.coordinator().run(f.reviewId)).toEqual({ status: "DELIVERED" });
      expect(f.provider.calls).toBe(1);
      await expect(f.decide()).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
  it.each(["revoked", "paused", "target", "source", "expired"])(
    "blocks %s before reservation",
    async (change) => {
      const f = await fixture();
      try {
        await f.decide();
        if (change === "revoked")
          await f.command(f.instanceId, "kapelle/agent-instance", "REVOKE_CAPABILITY", {
            grantId: "website-grant",
          });
        if (change === "paused")
          await f.command(f.instanceId, "kapelle/agent-instance", "REQUEST_PAUSE", {});
        if (change === "target") f.state.target.aliases[0].deploymentId = "dpl_drift";
        if (change === "source") f.state.sourceError = true;
        if (change === "expired") f.state.now = f.m.expiresAt;
        await expect(f.coordinator().run(f.reviewId)).rejects.toThrow();
        expect((await f.read()).effect).toBe(null);
        expect(f.provider.calls).toBe(0);
      } finally {
        await f.close();
      }
    },
  );
  it("keeps unqualified effects disabled", async () => {
    const f = await fixture(false);
    try {
      await f.decide();
      await expect(f.coordinator().run(f.reviewId)).rejects.toThrow(/not activated/);
      expect(f.provider.calls).toBe(0);
      expect((await f.read()).effect).toBe(null);
    } finally {
      await f.close();
    }
  });
  it("rechecks revocation after reservation immediately before invoking", async () => {
    const f = await fixture();
    try {
      await f.decide();
      await f.reserve();
      const effect = (await f.read()).effect;
      expect(await f.authority.claimPublicationInvocation(f.reviewId, effect.operationId)).toBe(
        true,
      );
      await f.command(f.instanceId, "kapelle/agent-instance", "REVOKE_CAPABILITY", {
        grantId: "website-grant",
      });
      await expect(f.authority.effectAdmission(f.reviewId, effect.operationId)).rejects.toThrow(
        /revoked/,
      );
      expect(f.provider.calls).toBe(0);
      expect((await f.read()).effect).not.toBe(null);
      expect(await f.coordinator().run(f.reviewId)).toEqual({ status: "UNCERTAIN" });
      expect(f.provider.calls).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("recovers a crash after native reservation using the same Dispatch and one invocation", async () => {
    const f = await fixture();
    try {
      await f.decide();
      const b = await f.reserve();
      await f.restart();
      expect(await f.coordinator().run(f.reviewId)).toEqual({ status: "DELIVERED" });
      expect((await f.read()).effect.operationId).toBe(b.operationId);
      expect(f.provider.calls).toBe(1);
    } finally {
      await f.close();
    }
  });
  it("checks expiry again after reservation and before provider invocation", async () => {
    const f = await fixture();
    try {
      await f.decide();
      await f.reserve();
      f.state.now = f.m.expiresAt;
      await expect(f.coordinator().run(f.reviewId)).rejects.toThrow(/expired/);
      expect(f.provider.calls).toBe(0);
      expect((await f.read()).effect).not.toBe(null);
    } finally {
      await f.close();
    }
  });
  it("never reinvokes after a durable invocation claim or an uncertain response; reconciles later proof", async () => {
    const f = await fixture();
    try {
      await f.decide();
      const b = await f.reserve();
      expect(await f.authority.claimPublicationInvocation(f.reviewId, b.operationId)).toBe(true);
      await f.restart();
      expect(await f.coordinator().run(f.reviewId)).toEqual({ status: "UNCERTAIN" });
      expect(f.provider.calls).toBe(0);
      expect(await f.coordinator().run(f.reviewId)).toEqual({ status: "UNCERTAIN" });
      // Simulate provider evidence becoming available, not a second invocation.
      f.provider.status = "PUBLISHED";
      f.provider.targetState.aliases[0].deploymentId = "dpl_new";
      expect(await f.coordinator().reconcile(f.reviewId)).toEqual({ status: "DELIVERED" });
      expect(f.provider.calls).toBe(0);
      expect((await f.read()).delivery.map((e: any) => e.status)).toEqual([
        "UNCERTAIN",
        "DELIVERED",
      ]);
    } finally {
      await f.close();
    }
  });
  it.each(["unknown", "accepted-then-lost", "failed"] as const)(
    "handles %s without another provider call",
    async (mode) => {
      const f = await fixture();
      try {
        f.provider.mode = mode;
        await f.decide();
        const expected =
          mode === "unknown" ? "UNCERTAIN" : mode === "failed" ? "FAILED" : "DELIVERED";
        expect(await f.coordinator().run(f.reviewId)).toEqual({ status: expected });
        await f.restart();
        expect(await f.coordinator().run(f.reviewId)).toEqual({ status: expected });
        expect(f.provider.calls).toBe(1);
        if (mode === "unknown") {
          f.provider.status = "FAILED";
          expect(await f.coordinator().reconcile(f.reviewId)).toEqual({ status: "FAILED" });
        }
      } finally {
        await f.close();
      }
    },
  );
  it("rejects self-asserted delivered evidence", async () => {
    const f = await fixture();
    try {
      await f.decide();
      const b = await f.reserve();
      await expect(
        f.command(f.reviewId, "kapelle/review-intent", "RECORD_DELIVERY", {
          operationId: b.operationId,
          evidenceId: "fabricated",
          providerRef: "provider:synthetic",
          receiptRef: "fabricated",
          status: "DELIVERED",
        }),
      ).rejects.toThrow(/not verified/);
      expect((await f.read()).delivery).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
  it("does not issue another invocation right after a lost native claim acknowledgement", async () => {
    const f = await fixture();
    try {
      await f.decide();
      const backend = f.authority.backend,
        original = backend.commit.bind(backend);
      backend.commit = async (id, prepared) => {
        const result = await original(id, prepared);
        if (prepared.action.type === "CLAIM_EXECUTION")
          throw new Error("Synthetic native claim acknowledgement lost");
        return result;
      };
      await expect(f.coordinator().run(f.reviewId)).rejects.toThrow(/acknowledgement lost/);
      expect(f.provider.calls).toBe(0);
      await f.restart();
      expect(await f.coordinator().run(f.reviewId)).toEqual({ status: "UNCERTAIN" });
      expect(f.provider.calls).toBe(0);
      const d = await f.authority.read(f.reviewId, "kapelle/review-intent");
      expect(
        d.operations.global.filter((o) => o.action.type === "CLAIM_EXECUTION" && !o.error),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
});

async function machineServer(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${(server.address() as any).port}`,
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
describe.skipIf(!reactorRoot || !process.env.KAPELLE_PUBLICATION_MANAGER_ROOT)(
  "Native authority → existing Manager → scoped HTTP executor → Vercel adapter",
  () => {
    it.each(["lost-executor-response", "provider-unknown", "provider-accepted-lost"])(
      "preserves one operation and invocation for %s through restart and receipt projection",
      async (mode) => {
        const f = await fixture(true, true, true),
          fake = vercelProviderFixture(true);
        fake.state.fault =
          mode === "provider-unknown"
            ? "unknown"
            : mode === "provider-accepted-lost"
              ? "accepted-lost"
              : "";
        const manager = await managerPublicationFixture(
          process.env.KAPELLE_PUBLICATION_MANAGER_ROOT!,
          f.m,
          f.reviewId,
          f.instanceId,
          () => approvedPublication(f.authority, f.m, f.reviewId, f.instanceId).then(() => {}),
        );
        const managerToken = "synthetic-manager-credential-0123456789",
          executorToken = "synthetic-executor-credential-0123456789";
        let ownerToken = "synthetic-owner-credential-0123456789";
        let managerServer: Awaited<ReturnType<typeof machineServer>> | undefined,
          executorServer: Awaited<ReturnType<typeof machineServer>> | undefined;
        const mount = async () => {
          managerServer = await machineServer(
            managerPublicationHandler(manager.store, () => managerToken),
          );
          const adapters = publicationExecutorAdapters(f.authority, {
            manifest: f.m,
            reviewId: f.reviewId,
            instanceId: f.instanceId,
            brokerHostId: "synthetic-host",
            managerOrigin: managerServer.url,
            managerToken: () => managerToken,
            executorToken: () => executorToken,
            ownerDecisionToken: () => ownerToken,
            providerToken: () => "synthetic-vercel-credential-0123456789",
            providerRequest: fake.request,
            stagingReceipt: async () => f.state.staging,
            assertExclusiveProjectWriter: async () => {},
          });
          const { dispatch, provider } = adapters;
          f.useAdapters({ dispatch, provider });
          executorServer = await machineServer(adapters.handler);
          return {
            dispatch,
            executor: new PublicationExecutorClient(executorServer.url, () => executorToken),
          };
        };
        try {
          const ports = await mount();
          await expect(ports.dispatch.ensure(manager.store.expected)).rejects.toThrow();
          expect(
            (await manager.database.query("SELECT * FROM dispatch_scheduler_queue")).rows,
          ).toHaveLength(0);
          await f.decide();
          const binding = await ports.dispatch.ensure(manager.store.expected);
          const body = {
            operationId: binding.operationId,
            dispatchRef: binding.dispatchRef,
            outboxRef: binding.outboxRef,
          };
          const post = (path: string, input: unknown, token = executorToken) =>
            fetch(executorServer!.url + path, {
              method: "POST",
              headers: { authorization: "Bearer " + token, "content-type": "application/json" },
              body: JSON.stringify(input),
            });
          expect((await post("/run", body, managerToken)).status).toBe(403);
          expect((await post("/run", body, ownerToken)).status).toBe(403);
          ownerToken = executorToken;
          expect((await post("/run", body)).status).toBe(503);
          ownerToken = "synthetic-owner-credential-0123456789";
          expect((await post("/commands", { type: "RECORD_DECISION" })).status).toBe(409);
          expect((await post("/run", { ...body, actorId: "owner" })).status).toBe(409);
          expect((await post("/run", { ...body, operationId: "forged" })).status).toBe(409);
          expect(fake.state.posts).toBe(0);
          if (mode === "lost-executor-response") {
            const lost = new PublicationExecutorClient(
              executorServer!.url,
              () => executorToken,
              async (...args) => {
                const r = await fetch(...args);
                await r.body?.cancel();
                throw Error("Synthetic lost executor acknowledgement");
              },
            );
            await expect(manager.store.deliver(lost)).rejects.toThrow(
              /acknowledgement unavailable/,
            );
          } else {
            const receipt = await manager.store.deliver(ports.executor);
            expect(receipt.status).toBe(mode === "provider-unknown" ? "UNCERTAIN" : "DELIVERED");
          }
          expect(fake.state.posts).toBe(1);
          await executorServer!.close();
          executorServer = undefined;
          await managerServer!.close();
          managerServer = undefined;
          await f.restart();
          await manager.restart();
          const restarted = await mount();
          expect(await restarted.dispatch.read(manager.store.expected.key)).toEqual(binding);
          if (mode === "provider-unknown") {
            expect((await manager.store.deliver(restarted.executor, "reconcile")).status).toBe(
              "UNCERTAIN",
            );
            fake.state.published = true;
          }
          const receipt = await manager.store.deliver(restarted.executor, "reconcile");
          expect(receipt.status).toBe("DELIVERED");
          expect((await manager.store.deliver(restarted.executor)).status).toBe("DELIVERED");
          expect(fake.state.posts).toBe(1);
          const rows = await manager.database.query<{
            status: string;
            result_json: string;
            completed_at: string;
            updated_at: string;
          }>("SELECT status,result_json,completed_at,updated_at FROM dispatch_scheduler_queue");
          expect(rows.rows).toHaveLength(1);
          expect(rows.rows[0].status).toBe("done");
          expect(JSON.parse(rows.rows[0].result_json)).toEqual(receipt);
          expect(rows.rows[0].completed_at).toBe(receipt.occurredAt);
          expect(rows.rows[0].updated_at >= receipt.occurredAt).toBe(true);
          const native = await f.authority.read(f.reviewId, "kapelle/review-intent");
          expect(
            native.operations.global.filter((o) => o.action.type === "CLAIM_EXECUTION" && !o.error),
          ).toHaveLength(1);
          expect((await f.read()).effect.operationId).toBe(binding.operationId);
          const output = process.env.KAPELLE_PUBLICATION_TRANSPORT_EVIDENCE;
          if (output) {
            mkdirSync(output, { recursive: true });
            writeFileSync(
              join(output, mode + ".json"),
              JSON.stringify(
                {
                  synthetic: true,
                  manifestContract: f.m.contract,
                  approvedTarget: f.m.target,
                  binding,
                  native: {
                    effect: (await f.read()).effect,
                    execution: (await f.read()).execution,
                    delivery: (await f.read()).delivery,
                    operations: native.operations.global.map((o) => ({
                      id: o.action.id,
                      type: o.action.type,
                      error: o.error ?? null,
                    })),
                  },
                  managerProjection: rows.rows[0],
                  fakeProvider: { posts: fake.state.posts, requests: fake.state.requests },
                  receipt,
                },
                null,
                2,
              ) + "\n",
            );
          }
        } finally {
          await executorServer?.close();
          await managerServer?.close();
          manager.close();
          await f.close();
        }
      },
      30000,
    );
  },
);
