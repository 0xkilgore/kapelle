import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type {
  DispatchAgentRef,
  DispatchOffer,
  DispatchState,
} from "../document-models/dispatch/v1/index.js";
import type { Command, ModelType } from "../src/command-boundary.js";
import { openFrameworkRuntime } from "../src/service/runtime.js";
import { dispatchFixture } from "./dispatch-fixtures.js";
import { dispatchOfferHash } from "../src/dispatch/contracts.js";
import { policy } from "./fixtures.js";
const reactorRoot = process.env.KAPELLE_SCOPED_REACTOR_ROOT;

async function fixture() {
  const f = dispatchFixture(),
    root = mkdtempSync(join(tmpdir(), "kapelle-dispatch-"));
  const ctx = f.ctx,
    options = {
      stateRoot: root,
      reactorRoot: reactorRoot!,
      ownerId: ctx.ownerId,
      scopeRef: ctx.scopeRef,
      facts: async () => ctx,
      now: () => ctx.occurredAt,
    };
  let runtime = await openFrameworkRuntime(options),
    n = 0;
  const allocate = async (type: ModelType) =>
    (await runtime.authority.allocate(`allocate-${n++}`, type, "Synthetic native Dispatch"))
      .documentId;
  async function command(
    id: string,
    type: ModelType,
    name: string,
    input: Record<string, unknown>,
    actor = ctx.ownerId,
    operationId = `command-${n++}`,
  ) {
    const d = await runtime.authority.read(id, type);
    const request: Command = {
      operationId,
      documentId: id,
      documentType: type,
      expectedRevision: d.state.global.revision,
      type: name,
      input,
    };
    const receipt =
      actor === ctx.ownerId
        ? await runtime.authority.command(request)
        : await runtime.authority.dispatchCommand(request, actor);
    expect(receipt.result.disposition, JSON.stringify(receipt.result)).toBe("ACCEPTED");
    return { request, receipt };
  }
  const r = ctx.definitions[0].release;
  const definition = await allocate("kapelle/agent-definition");
  await command(definition, "kapelle/agent-definition", "PUBLISH_DEFINITION", { release: r });
  async function provision() {
    const id = await allocate("kapelle/agent-instance");
    await command(id, "kapelle/agent-instance", "CREATE_INSTANCE", {
      instanceId: id,
      scopeRef: ctx.scopeRef,
      definitionRef: { id: r.definitionId, version: r.packageVersion, contentHash: r.contentHash },
      name: "Scoped synthetic agent",
      responsibilities: ["Exact native request"],
      operatingPolicy: "Independent authorization",
      modelPolicy: policy,
    });
    await command(id, "kapelle/agent-instance", "SET_RUNTIME_BINDING", {
      runtimeBindingRef: "local-adapter",
    });
    for (const resourceRef of ["inbox:coordinator", "inbox:domain", "contracts"])
      await command(id, "kapelle/agent-instance", "GRANT_CAPABILITY", {
        grant: {
          id: "grant:" + resourceRef,
          principalId: id,
          resourceRef,
          actions: resourceRef === "contracts" ? ["read"] : ["receive", "dispatch"],
          expiresAt: "2026-09-11T12:00:00.000Z",
          reviewPolicy: "ALWAYS",
        },
      });
    await command(id, "kapelle/agent-instance", "REQUEST_RESUME", {});
    return {
      instanceId: id,
      definitionId: r.definitionId,
      definitionVersion: r.packageVersion,
      definitionHash: r.contentHash,
    } satisfies DispatchAgentRef;
  }
  const coordinator = await provision(),
    domain = await provision();
  async function create(offer: DispatchOffer, actor = offer.senderId) {
    const id = await allocate("kapelle/dispatch");
    await command(
      id,
      "kapelle/dispatch",
      "CREATE_DISPATCH",
      { dispatchId: id, ownerId: ctx.ownerId, offer },
      actor,
    );
    return id;
  }
  const read = async (id: string) =>
    (await runtime.authority.read(id, "kapelle/dispatch")).state.global as DispatchState;
  const rootOffer = f.offer({ recipient: coordinator }),
    parentId = await create(rootOffer);
  const rootAcceptance = await command(
    parentId,
    "kapelle/dispatch",
    "ACCEPT_DISPATCH",
    { inputHash: rootOffer.contentHash },
    coordinator.instanceId,
  );
  const childOffer = f.offer({
    senderId: coordinator.instanceId,
    senderAgent: coordinator,
    recipient: domain,
    permissionRef: "inbox:domain",
    parentDispatchRef: parentId,
    parentContentHash: rootOffer.contentHash,
    instructions: "Reconstruct this scoped publication request only from these native records.",
  });
  return {
    ctx,
    coordinator,
    domain,
    rootOffer,
    parentId,
    rootAcceptance,
    childOffer,
    create,
    read,
    command,
    get authority() {
      return runtime.authority;
    },
    async restart() {
      await runtime.close();
      runtime = await openFrameworkRuntime(options);
    },
    async close() {
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe.skipIf(!reactorRoot)("Scoped native agent Dispatch service", () => {
  it("reconstructs from native records after restart and exact acceptance retries bind the authenticated recipient", async () => {
    const f = await fixture();
    try {
      const id = await f.create(f.childOffer);
      const { request, receipt } = await f.command(
        id,
        "kapelle/dispatch",
        "ACCEPT_DISPATCH",
        { inputHash: f.childOffer.contentHash },
        f.domain.instanceId,
        "stable-acceptance",
      );
      await f.restart();
      const cold = await f.authority.dispatchBundle(id, f.domain.instanceId);
      expect(cold.originalRequesterId).toBe("owner");
      expect(cold.instructions).toBe(f.childOffer.instructions);
      expect(cold.parents[0].dispatchId).toBe(f.parentId);
      expect(cold.task.taskRef).toBe("existing-task");
      expect(await f.authority.dispatchCommand(request, f.domain.instanceId)).toEqual(receipt);
      await expect(f.authority.dispatchCommand(request, f.coordinator.instanceId)).rejects.toThrow(
        /conflicts/,
      );
      expect((await f.read(id)).revision).toBe(2);
      await expect(
        f.authority.command({
          ...request,
          operationId: "owner-cannot-impersonate-recipient",
          expectedRevision: 2,
        }),
      ).rejects.toThrow(/recipient/);
    } finally {
      await f.close();
    }
  });
  it("reconciles lost native acceptance acknowledgement without changing instructions or actor", async () => {
    const f = await fixture();
    try {
      const id = await f.create(f.childOffer),
        backend = f.authority.backend,
        commit = backend.commit.bind(backend);
      const request: Command = {
        documentId: id,
        documentType: "kapelle/dispatch",
        operationId: "lost-acceptance",
        expectedRevision: 1,
        type: "ACCEPT_DISPATCH",
        input: { inputHash: f.childOffer.contentHash },
      };
      backend.commit = async (docId, p) => {
        const r = await commit(docId, p);
        if (p.action.type === "ACCEPT_DISPATCH") throw new Error("Synthetic lost acknowledgement");
        return r;
      };
      await expect(f.authority.dispatchCommand(request, f.domain.instanceId)).rejects.toThrow(
        /lost acknowledgement/,
      );
      await f.restart();
      expect(
        (await f.authority.dispatchCommand(request, f.domain.instanceId)).result.disposition,
      ).toBe("ACCEPTED");
      const d = await f.authority.read(id, "kapelle/dispatch");
      expect(
        d.operations.global.filter((o) => o.action.type === "ACCEPT_DISPATCH" && !o.error),
      ).toHaveLength(1);
      expect((await f.read(id)).offer?.instructions).toBe(f.childOffer.instructions);
    } finally {
      await f.close();
    }
  });
  it.each(["revoked", "parent-cancelled", "source-unavailable", "parent-unavailable"])(
    "checks %s from authorities when accepting delegated work",
    async (kind) => {
      const f = await fixture();
      try {
        const id = await f.create(f.childOffer);
        if (kind === "revoked")
          await f.command(f.coordinator.instanceId, "kapelle/agent-instance", "REVOKE_CAPABILITY", {
            grantId: "grant:inbox:domain",
          });
        if (kind === "parent-cancelled")
          await f.command(f.parentId, "kapelle/dispatch", "REQUEST_DISPATCH_CANCEL", {
            reason: "Stop delegation",
          });
        if (kind === "source-unavailable") f.ctx.dispatch.sources = [];
        if (kind === "parent-unavailable") {
          const read = f.authority.backend.read.bind(f.authority.backend);
          f.authority.backend.read = async (id, type) => {
            if (id === f.parentId) throw new Error("Document unavailable");
            return read(id, type);
          };
        }
        await expect(
          f.command(
            id,
            "kapelle/dispatch",
            "ACCEPT_DISPATCH",
            { inputHash: f.childOffer.contentHash },
            f.domain.instanceId,
          ),
        ).rejects.toThrow();
        expect((await f.read(id)).acceptance).toBe(null);
      } finally {
        await f.close();
      }
    },
  );
  it("records one original result after cancellation without completing the Task or parent", async () => {
    const f = await fixture();
    try {
      const id = await f.create(f.childOffer);
      await f.command(
        id,
        "kapelle/dispatch",
        "ACCEPT_DISPATCH",
        { inputHash: f.childOffer.contentHash },
        f.domain.instanceId,
      );
      await f.command(id, "kapelle/dispatch", "REQUEST_DISPATCH_CANCEL", {
        reason: "Cancellation requested, provider state must be checked",
      });
      await expect(f.authority.dispatchBundle(id, f.domain.instanceId)).rejects.toThrow(
        /no longer active/,
      );
      const result = {
        dispatchId: id,
        inputHash: f.childOffer.contentHash,
        reportId: "original-native-report-ref",
        contentHash: f.childOffer.sources[0].contentHash,
        contentVersion: 1,
        verificationRef: "verified-result-ref",
      };
      f.ctx.dispatch.results = [result];
      const { dispatchId: _, ...input } = result;
      await f.command(id, "kapelle/dispatch", "RECORD_DISPATCH_RESULT", input, f.domain.instanceId);
      expect((await f.read(id)).result?.reportId).toBe(result.reportId);
      expect((await f.read(id)).cancellationReason).not.toBe(null);
      expect((await f.read(f.parentId)).phase).toBe("ACCEPTED");
      expect(f.ctx.dispatch.tasks[0].status).toBe("OPEN");
    } finally {
      await f.close();
    }
  });
  it("rejects reusing a dispatch operation ID with changed accepted input", async () => {
    const f = await fixture();
    try {
      const request = f.rootAcceptance.request;
      await expect(
        f.authority.dispatchCommand(
          { ...request, input: { inputHash: dispatchOfferHash(f.childOffer) } },
          f.coordinator.instanceId,
        ),
      ).rejects.toThrow(/conflicts/);
    } finally {
      await f.close();
    }
  });
});
