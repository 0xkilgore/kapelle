import { describe, it, expect } from "vitest";
import {
  applyNative,
  prepareCommand,
  canonical,
  digest,
  releaseHash,
  type NativeDocument,
} from "../src/command-boundary.js";
import {
  D,
  I,
  R,
  apply,
  at,
  installed,
  ready,
  release,
  context,
  vref,
  command,
  approved,
  proposed,
  proposal,
  reserve,
  policy,
} from "./fixtures.js";

describe("Released definitions and installed controls", () => {
  it("publishes a hash-checked immutable native release; a later release does not repin an instance", () => {
    const ctx = context(),
      r = release();
    const d = apply(D.utils.createDocument(), "PUBLISH_DEFINITION", { release: r }, ctx);
    expect(d.state.global.release?.contentHash).toBe(r.contentHash);
    expect(() => apply(d, "PUBLISH_DEFINITION", { release: r }, ctx)).toThrow(/initialized/);
    const installedDoc = installed(ctx),
      next = release("1.1.0", r);
    const later = apply(D.utils.createDocument(), "PUBLISH_DEFINITION", { release: next }, ctx);
    expect(later.state.global.release?.packageVersion).toBe("1.1.0");
    expect(installedDoc.state.global.definitionRef?.version).toBe("1.0.0");
  });
  it("rejects tampered release bytes and unqualified installation", () => {
    expect(() =>
      apply(D.utils.createDocument(), "PUBLISH_DEFINITION", {
        release: { ...release(), title: "tampered" },
      }),
    ).toThrow(/hash mismatch/);
    const ctx = context();
    ctx.definitions[0].qualified = false;
    expect(() => installed(ctx)).toThrow(/not qualified/);
  });
  it("starts paused, changes skills without granting capability, and forbids implicit paid fallback", () => {
    let d = installed();
    expect(d.state.global.desiredState).toBe("PAUSED");
    expect(d.state.global.modelPolicy?.paidFallback).toBe(false);
    d = apply(d, "ENABLE_SKILL", { ref: vref("rules"), source: "USER" });
    expect(d.state.global.grants).toEqual([]);
    expect(() => apply(d, "REQUEST_RESUME", {})).toThrow(/binding/);
    expect(() =>
      apply(d, "SET_MODEL_POLICY", { modelPolicy: { ...policy, paidFallback: true } }),
    ).toThrow(/Fallback|fallback/);
    d = apply(d, "SET_MODEL_POLICY", {
      modelPolicy: {
        ...policy,
        paidFallback: true,
        fallbackProvider: "approved-provider",
        fallbackScopeRef: "synthetic-league",
        fallbackBudgetRef: "budget-explicit",
      },
    });
    expect(d.state.global.modelPolicy?.fallbackProvider).toBe("approved-provider");
  });
  it("requires exact migration evidence and a paused instance, refuses downgrade", () => {
    const ctx = context(),
      r = release("1.1.0", ctx.definitions[0].release);
    ctx.definitions = [...ctx.definitions, { release: r, qualified: true }];
    let d = ready(ctx);
    const pin = {
      definitionRef: { id: r.definitionId, version: r.packageVersion, contentHash: r.contentHash },
      migrationRef: vref("migration"),
      compatibilityFixtureRef: vref("compatibility"),
    };
    expect(() => apply(d, "PIN_DEFINITION_VERSION", pin, ctx)).toThrow(/Pause/);
    d = apply(d, "REQUEST_PAUSE", {}, ctx);
    expect(() =>
      apply(d, "PIN_DEFINITION_VERSION", { ...pin, migrationRef: vref("wrong") }, ctx),
    ).toThrow(/migration/);
    d = apply(d, "PIN_DEFINITION_VERSION", pin, ctx);
    expect(d.state.global.definitionRef?.version).toBe("1.1.0");
    expect(() => apply(d, "PIN_DEFINITION_VERSION", pin, ctx)).toThrow(/migration|advance/);
  });
  it("binds named accounts and existing schedule references; stores no runtime hostname", () => {
    let d = installed();
    expect(() =>
      apply(d, "SET_RUNTIME_BINDING", { runtimeBindingRef: "https://example.test/token" }),
    ).toThrow();
    expect(() =>
      apply(d, "BIND_CONNECTION", {
        binding: {
          id: "b",
          connectionRef: "unowned",
          label: "Other inbox",
          accountRef: "other",
          directions: ["SEND"],
        },
      }),
    ).toThrow(/authorized/);
    d = apply(d, "BIND_SCHEDULE", {
      schedule: {
        id: "weekly",
        schedulerRef: "existing-scheduler",
        timezone: "America/Chicago",
        maxExecutions: 1,
        conditionRef: "new-week",
        catchUp: "COALESCE",
        watermarkRef: "watermark-week",
        lastRunRef: null,
      },
    });
    expect(d.state.global.schedules[0].schedulerRef).toBe("existing-scheduler");
    d = apply(d, "UNBIND_SCHEDULE", { scheduleId: "weekly" });
    expect(d.state.global.schedules).toEqual([]);
  });
  it("enforces required capabilities against resource type and authenticated document policy", () => {
    const ctx = context();
    const r = ctx.definitions[0].release;
    r.capabilities[0].requirement = "REQUIRED";
    r.contentHash = releaseHash(r);
    let d = installed(ctx);
    d = apply(d, "SET_RUNTIME_BINDING", { runtimeBindingRef: "local-adapter" }, ctx);
    expect(() => apply(d, "REQUEST_RESUME", {}, ctx)).toThrow(/not granted/);
    expect(() =>
      apply(
        d,
        "GRANT_CAPABILITY",
        {
          grant: {
            id: "bad",
            principalId: "commissioner-1",
            resourceRef: "private-finance",
            actions: ["read"],
            expiresAt: "2026-09-11T12:00:00.000Z",
            reviewPolicy: "ALWAYS",
          },
        },
        ctx,
      ),
    ).toThrow(/scope/);
  });
  it("retirement is final and preserves history and prior grants", () => {
    let d = ready();
    const n = d.operations.global.length;
    d = apply(d, "RETIRE_INSTANCE", {});
    expect(d.operations.global).toHaveLength(n + 1);
    expect(d.state.global.grants).toHaveLength(1);
    expect(() => apply(d, "REQUEST_RESUME", {})).toThrow(/retired/);
  });
  it("supports editing, skill removal, document links and explicit revocation without deleting evidence", () => {
    let d = ready();
    d = apply(d, "SET_RESPONSIBILITIES", { responsibilities: ["rules questions"] });
    d = apply(d, "SET_OPERATING_POLICY", { operatingPolicy: "Review every change" });
    d = apply(d, "ENABLE_SKILL", { ref: vref("rules"), source: "BUILTIN" });
    d = apply(d, "DISABLE_SKILL", { skillId: "rules" });
    d = apply(d, "LINK_DOCUMENT", { documentRef: "contracts", access: "PRIVATE" });
    d = apply(d, "UNLINK_DOCUMENT", { documentRef: "contracts" });
    d = apply(d, "REVOKE_CAPABILITY", { grantId: "grant-1" });
    d = apply(d, "REVOKE_CONNECTION", { connectionId: "chat-binding" });
    expect(d.state.global.grants[0].revokedAt).toBe(at);
    expect(d.state.global.connections[0].revokedAt).toBe(at);
    expect(d.state.global.skills).toEqual([]);
  });
});

describe("Authenticated commands and native rejection", () => {
  it.each(["actorId", "occurredAt", "expectedRevision"])("rejects caller supplied %s", (field) => {
    const d = installed();
    expect(() =>
      prepareCommand(command(d, "REQUEST_PAUSE", { [field]: "spoof" }), d, {
        ...context(),
        instance: d.state.global,
      }),
    ).toThrow(/authority-owned/);
  });
  it("denies another principal, scope, instance projection and native model identity", () => {
    const d = ready(),
      ctx = { ...context(), instance: d.state.global },
      c = command(d, "REQUEST_PAUSE", {});
    expect(() => prepareCommand(c, d, { ...ctx, principalId: "member" })).toThrow(/owner/);
    expect(() => prepareCommand(c, d, { ...ctx, scopeRef: "finance" })).toThrow(/scope/);
    expect(() => prepareCommand({ ...c, documentId: "other" }, d, ctx)).toThrow(/identity/);
    expect(() =>
      prepareCommand(command(d, "PUBLISH_DEFINITION", { release: release() }), d, ctx),
    ).toThrow(/belong/);
  });
  it("rejects unknown input fields and stale revisions before mutation", () => {
    const d = ready(),
      snapshot = canonical(d),
      ctx = { ...context(), instance: d.state.global };
    expect(() =>
      prepareCommand(command(d, "REQUEST_PAUSE", { secretToken: "not-an-actual-token" }), d, ctx),
    ).toThrow(/Unknown/);
    expect(() =>
      prepareCommand({ ...command(d, "REQUEST_PAUSE", {}), expectedRevision: 0 }, d, ctx),
    ).toThrow(/Stale/);
    expect(canonical(d)).toBe(snapshot);
  });
  it("native reducers reject invalid timestamps and spoofed owner without changing global state", () => {
    const d = ready();
    for (const input of [
      { actorId: "other", occurredAt: at, expectedRevision: d.state.global.revision },
      {
        actorId: "owner",
        occurredAt: "2026-09-09T12:00:00.000Z",
        expectedRevision: d.state.global.revision,
      },
    ]) {
      const result = I.reducer(d, I.requestPause(input));
      expect(result.operations.global.at(-1)?.error).toBeTruthy();
      expect(result.state.global).toEqual(d.state.global);
    }
  });
});

describe("Exact reviews and effects", () => {
  function ctx() {
    return { ...context(), instance: ready().state.global };
  }
  it("rejects changed proposal hash and changed target revision on approval", () => {
    const c = ctx(),
      d = proposed(c);
    const decision = {
      proposalHash: d.state.global.proposal!.contentHash,
      proposalVersion: 1,
      approved: true,
      reason: null,
    };
    expect(() =>
      apply(d, "RECORD_DECISION", { ...decision, proposalHash: digest("other") }, c),
    ).toThrow(/Stale proposal/);
    expect(() =>
      apply(d, "RECORD_DECISION", decision, {
        ...c,
        resources: [{ ...c.resources[0], revision: 8 }],
      }),
    ).toThrow(/Stale target/);
  });
  it("rejects stale targets again at effect reservation after valid approval", () => {
    const c = ctx(),
      d = approved(c);
    expect(() => reserve(d, { ...c, resources: [{ ...c.resources[0], revision: 8 }] })).toThrow(
      /Stale target/,
    );
  });
  it.each(["paused", "retired", "expired", "revoked", "document-denied"])(
    "denies %s effect admission",
    (mode) => {
      const c = ctx(),
        d = approved(c),
        copy = structuredClone(c);
      if (mode === "paused") copy.instance!.desiredState = "PAUSED";
      if (mode === "retired") copy.instance!.desiredState = "RETIRED";
      if (mode === "expired") copy.instance!.grants[0].expiresAt = "2026-09-09T00:00:00.000Z";
      if (mode === "revoked") copy.instance!.grants[0].revokedAt = at;
      if (mode === "document-denied")
        copy.resources = [{ ...copy.resources[0], allowedActions: ["read"] }];
      expect(() => reserve(d, copy)).toThrow();
    },
  );
  it("rejects cross-instance review and unauthorized target creation", () => {
    const c = ctx();
    expect(() =>
      apply(
        R.utils.createDocument(),
        "CREATE_REVIEW",
        { reviewId: "r", instanceId: "other", scopeRef: c.scopeRef, proposal: proposal() },
        c,
      ),
    ).toThrow(/instance/);
    expect(() => proposed({ ...c, resources: [] })).toThrow(/authorized/);
  });
  it("preserves a rejected decision and permits explicit invalidation before any effect", () => {
    const c = ctx(),
      p = proposed(c);
    const rejected = apply(
      p,
      "RECORD_DECISION",
      {
        proposalHash: p.state.global.proposal!.contentHash,
        proposalVersion: 1,
        approved: false,
        reason: "Not needed",
      },
      c,
    );
    expect(() => reserve(rejected, c)).toThrow(/approval/);
    const invalid = apply(approved(c), "INVALIDATE_REVIEW", { reason: "Source edited" }, c);
    expect(invalid.state.global.decision?.approved).toBe(true);
    expect(invalid.state.global.status).toBe("INVALIDATED");
    expect(() => reserve(invalid, c)).toThrow();
  });
  it("uncertain delivery retains one effect, allows evidence reconciliation, refuses a new effect or repeated terminal evidence", () => {
    const c = ctx();
    c.deliveryReceipts = [
      {
        id: "evidence-1",
        operationId: "effect-1",
        status: "UNCERTAIN",
        providerRef: "synthetic-provider",
        receiptRef: "receipt-uncertain",
      },
      {
        id: "evidence-2",
        operationId: "effect-1",
        status: "DELIVERED",
        providerRef: "synthetic-provider",
        receiptRef: "receipt-confirmed",
      },
      {
        id: "evidence-3",
        operationId: "effect-1",
        status: "FAILED",
        providerRef: "synthetic-provider",
        receiptRef: "receipt-uncertain",
      },
    ];
    let d = reserve(approved(c), c);
    const evidence = {
      evidenceId: "evidence-1",
      operationId: "effect-1",
      status: "UNCERTAIN",
      providerRef: "synthetic-provider",
      receiptRef: "receipt-uncertain",
    };
    d = apply(d, "RECORD_DELIVERY", evidence, c);
    expect(() => reserve(d, c)).toThrow(/reservation/);
    expect(() => apply(d, "INVALIDATE_REVIEW", { reason: "Try again" }, c)).toThrow(/reserved/);
    expect(() =>
      apply(d, "RECORD_DELIVERY", { ...evidence, evidenceId: "evidence-2", status: "ACCEPTED" }, c),
    ).toThrow(/verified|reconciliation/);
    d = apply(
      d,
      "RECORD_DELIVERY",
      {
        ...evidence,
        evidenceId: "evidence-2",
        status: "DELIVERED",
        receiptRef: "receipt-confirmed",
      },
      c,
    );
    expect(d.state.global.delivery.map((x) => x.status)).toEqual(["UNCERTAIN", "DELIVERED"]);
    expect(() =>
      apply(d, "RECORD_DELIVERY", { ...evidence, evidenceId: "evidence-3", status: "FAILED" }, c),
    ).toThrow(/terminal/);
  });
  it("send requires the exact connection with SEND permission; preparation alone cannot send", () => {
    const c = ctx();
    const empty = R.utils.createDocument();
    empty.header.id = "send-review";
    c.effects = [{ ...c.effects[0], proposalHash: proposal("SEND_MESSAGE").contentHash }];
    let d = apply(
      empty,
      "CREATE_REVIEW",
      {
        reviewId: "send-review",
        instanceId: "commissioner-1",
        scopeRef: c.scopeRef,
        proposal: proposal("SEND_MESSAGE"),
      },
      c,
    );
    d = apply(
      d,
      "RECORD_DECISION",
      {
        proposalHash: d.state.global.proposal!.contentHash,
        proposalVersion: 1,
        approved: true,
        reason: null,
      },
      c,
    );
    const denied = structuredClone(c);
    denied.instance!.connections[0].directions = ["PREPARE"];
    expect(() => reserve(d, denied)).toThrow(/direction/);
    expect(reserve(d, c).state.global.effect?.operationId).toBe("effect-1");
  });
});

describe("Deterministic native operation replay", () => {
  it("restores all three models from retained initial state and exact actions", () => {
    const c = { ...context(), instance: ready().state.global };
    const docs: NativeDocument[] = [
      apply(D.utils.createDocument(), "PUBLISH_DEFINITION", { release: release() }),
      ready(),
      reserve(approved(c), c),
    ];
    for (const d of docs) {
      // Keep the same native header/initial state. No action IDs or timestamps regenerated.
      const saved = JSON.parse(JSON.stringify(d));
      let replay: NativeDocument = {
        ...saved,
        state: structuredClone(saved.initialState),
        operations: { global: [], local: [] },
      };
      for (const op of saved.operations.global) replay = applyNative(replay, op.action);
      expect(replay.state.global).toEqual(d.state.global);
      expect(replay.operations.global.map((o) => o.action)).toEqual(
        d.operations.global.map((o) => o.action),
      );
    }
  });
});

describe("Artifact and identity integrity", () => {
  it("denies a review when proposal bytes or artifact version are unavailable", () => {
    const c = { ...context(), instance: ready().state.global };
    expect(() =>
      proposed({ ...c, artifacts: [{ ...c.artifacts[0], contentHash: digest("corrupt") }] }),
    ).toThrow(/artifact/);
    const d = approved(c);
    expect(() => reserve(d, { ...c, artifacts: [{ ...c.artifacts[0], version: 2 }] })).toThrow(
      /artifact/,
    );
  });
  it("does not substitute an arbitrary Dispatch or unverified delivery receipt", () => {
    const c = { ...context(), instance: ready().state.global },
      d = approved(c);
    expect(() => reserve(d, { ...c, effects: [] })).toThrow(/Dispatch/);
    const reserved = reserve(d, c);
    expect(() =>
      apply(
        reserved,
        "RECORD_DELIVERY",
        {
          evidenceId: "invented",
          operationId: "effect-1",
          status: "DELIVERED",
          providerRef: "synthetic-provider",
          receiptRef: "invented-receipt",
        },
        c,
      ),
    ).toThrow(/not verified/);
  });
  it("refuses republishing different bytes under a released package identity", () => {
    const r = release();
    r.title = "Changed release";
    r.contentHash = releaseHash(r);
    expect(() => apply(D.utils.createDocument(), "PUBLISH_DEFINITION", { release: r })).toThrow(
      /identity/,
    );
  });
  it("binds instance identity to its unique native document identity", () => {
    const d = installed(),
      input = d.operations.global[0].action.input as Record<string, unknown>;
    const { actorId: _, occurredAt: __, expectedRevision: ___, ...creation } = input;
    expect(() => apply(I.utils.createDocument(), "CREATE_INSTANCE", creation)).toThrow(/identity/);
  });
  it("rejects a send action disguised as a document change", () => {
    const c = { ...context(), instance: ready().state.global },
      empty = R.utils.createDocument();
    empty.header.id = "review-1";
    const p = proposal();
    p.action = "send";
    // The hash matches the malicious envelope; deterministic semantic validation must still reject it.
    const { contentHash: _, ...body } = p;
    p.contentHash = digest(body);
    expect(() =>
      apply(
        empty,
        "CREATE_REVIEW",
        { reviewId: "review-1", instanceId: "commissioner-1", scopeRef: c.scopeRef, proposal: p },
        c,
      ),
    ).toThrow(/disagree/);
  });
});

describe("Runtime and model portability constraints", () => {
  it("requires a tested model capability profile and compatible runtime contract", () => {
    const d = installed();
    expect(() =>
      apply(d, "SET_MODEL_POLICY", {
        modelPolicy: { ...policy, preferredProfile: "unknown-provider-default" },
      }),
    ).toThrow(/not qualified/);
    expect(() =>
      apply(
        d,
        "SET_RUNTIME_BINDING",
        { runtimeBindingRef: "local-adapter" },
        { ...context(), runtimeBindingContracts: { "local-adapter": "incompatible-v9" } },
      ),
    ).toThrow(/Runtime binding/);
  });
});
