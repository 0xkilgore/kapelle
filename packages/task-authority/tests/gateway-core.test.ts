import { actions, reducer, utils } from "document-models/task-authority/v1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  TaskAuthorityDocument,
} from "document-models/task-authority/v1";
import { TaskGatewayCore } from "../src/gateway/core.js";
import { ReceiptStore } from "../src/gateway/receipt-store.js";
import type {
  GatewayAction,
  GatewayPrincipal,
  ReactorOperation,
  ReactorPort,
} from "../src/gateway/types.js";

class FakeReactor implements ReactorPort {
  documents = new Map<string, TaskAuthorityDocument>();
  failAfterNextWrite = false;
  failBeforeNextWrite = false;
  failAfterNextAllocation = false;
  interleaveBeforeNextWrite = false;
  rejectNextWrite = false;
  omitOperations = false;
  lagOperationsCalls = 0;
  remintActionIds = false;
  findByNameCalls = 0;
  findByNameMaxCandidates: number[] = [];
  alterLedgerInput = false;
  jsonTransportOperations = false;

  probedDriveIds: string[] = [];
  probeHook: (() => void) | null = null;

  async probe(driveId: string): Promise<void> {
    this.probedDriveIds.push(driveId);
    this.probeHook?.();
  }

  async createDocument(input: {
    documentType: "kilgore/task";
    name: string;
    driveId: string;
  }): Promise<string> {
    const document = utils.createDocument();
    document.header.name = input.name;
    this.documents.set(document.header.id, document);
    if (this.failAfterNextAllocation) {
      this.failAfterNextAllocation = false;
      throw new Error("simulated failure after allocation");
    }
    return document.header.id;
  }

  async findDocumentByName(
    _driveId: string,
    name: string,
    maxCandidates: number,
  ): Promise<string | null> {
    this.findByNameCalls += 1;
    this.findByNameMaxCandidates.push(maxCandidates);
    return [...this.documents.values()].find((document) => document.header.name === name)
      ?.header.id ?? null;
  }

  async getDocument(id: string): Promise<TaskAuthorityDocument> {
    const document = this.documents.get(id);
    if (!document) throw new Error("not found");
    const clone = structuredClone(document);
    if (this.omitOperations) delete (clone as Partial<TaskAuthorityDocument>).operations;
    return clone;
  }

  async addActions(documentId: string, newActions: GatewayAction[]): Promise<void> {
    if (this.failBeforeNextWrite) {
      this.failBeforeNextWrite = false;
      throw new Error("simulated failure before write");
    }
    let document = structuredClone(this.documents.get(documentId)!);
    if (this.interleaveBeforeNextWrite) {
      this.interleaveBeforeNextWrite = false;
      document = reducer(document, actions.updateTitle({
        title: "Foreign interleaving title",
        actorId: "foreign-writer",
        occurredAt: "2026-08-13T19:59:59.000Z",
      }));
    }
    for (const action of newActions) {
      let applied = this.remintActionIds
        ? { ...action, id: crypto.randomUUID() }
        : action;
      if (this.rejectNextWrite) {
        this.rejectNextWrite = false;
        applied = {
          ...applied,
          input: { ...applied.input, title: "" },
        } as GatewayAction;
      }
      document = reducer(document, applied);
    }
    this.documents.set(documentId, document);
    if (this.failAfterNextWrite) {
      this.failAfterNextWrite = false;
      throw new Error("simulated lost acknowledgement");
    }
  }

  async getOperations(id: string, sinceRevision = 0): Promise<ReactorOperation[]> {
    if (this.lagOperationsCalls > 0) {
      this.lagOperationsCalls -= 1;
      return [];
    }
    const document = this.documents.get(id);
    if (!document) throw new Error("not found");
    return document.operations.global.slice(sinceRevision).map((operation) => ({
      id: operation.id,
      index: operation.index,
      error: operation.error ?? null,
      action: {
        id: operation.action.id,
        type: operation.action.type,
        input: this.alterLedgerInput
          ? {
            ...structuredClone(operation.action.input) as Record<string, unknown>,
            title: "Different same-type input",
          }
          : this.jsonTransportOperations
            ? JSON.parse(JSON.stringify(operation.action.input)) as Record<string, unknown>
            : structuredClone(operation.action.input) as Record<string, unknown>,
      },
    }));
  }

  advanceWithForeignWrite(id: string): void {
    const document = this.documents.get(id);
    if (!document) throw new Error("not found");
    this.documents.set(id, reducer(document, actions.updateTitle({
      title: "Foreign advanced title",
      actorId: "foreign-writer",
      occurredAt: "2026-08-13T19:59:58.000Z",
    })));
  }
}

const principal: GatewayPrincipal = {
  clientId: "taskview",
  actorId: "chris",
  scopes: new Set(["task.read", "task.create", "task.update"]),
  allowedSources: new Set(["CLI"]),
  canAssignOwner: false,
};

const clock = () => "2026-08-13T20:00:00.000Z";

function createRequest(operationId = "create-1") {
  return {
    operationId,
    expectedRevision: 0,
    commands: [{
      type: "CREATE_TASK" as const,
      input: {
        title: "Synthetic gateway task",
        ownerId: "chris",
        source: "CLI",
      } as Record<string, unknown>,
    }],
  };
}

describe("TaskGatewayCore", () => {
  let reactor: FakeReactor;
  let receipts: ReceiptStore;
  let gateway: TaskGatewayCore;
  let ownsDrive: boolean;

  beforeEach(() => {
    reactor = new FakeReactor();
    receipts = new ReceiptStore(":memory:");
    ownsDrive = true;
    gateway = new TaskGatewayCore({
      driveId: "synthetic-drive",
      reactor,
      receipts,
      ownsDrive: () => ownsDrive,
      clock,
    });
  });

  afterEach(() => receipts.close());

  it("proves configured drive reachability and drive-lock ownership for readiness", async () => {
    await expect(gateway.ready()).resolves.toBeUndefined();
    expect(reactor.probedDriveIds).toEqual(["synthetic-drive"]);

    ownsDrive = false;
    await expect(gateway.ready()).rejects.toThrow("drive lock");
    expect(reactor.probedDriveIds).toHaveLength(1);
  });

  it("fails readiness from the start of shutdown", async () => {
    gateway.beginShutdown();
    await expect(gateway.ready()).rejects.toThrow("shutting down");
    expect(reactor.probedDriveIds).toHaveLength(0);
  });

  it("rechecks local ownership after the asynchronous Reactor probe", async () => {
    reactor.probeHook = () => { ownsDrive = false; };
    await expect(gateway.ready()).rejects.toThrow("drive lock");
  });

  it("does not report ready when shutdown starts during the Reactor probe", async () => {
    reactor.probeHook = () => gateway.beginShutdown();
    await expect(gateway.ready()).rejects.toThrow("shutting down");
  });

  it("mints task identity from the Reactor PHID and stores a durable receipt", async () => {
    const receipt = await gateway.mutate(principal, createRequest());
    const document = await reactor.getDocument(receipt.taskId);

    expect(document.header.id).toBe(receipt.taskId);
    expect(document.state.global.id).toBe(receipt.taskId);
    expect(document.state.global.title).toBe("Synthetic gateway task");
    expect(receipt.revision).toBe(1);
    expect(receipts.find("create-1")).toEqual(receipt);
    expect(reactor.findByNameCalls).toBe(0);
  });

  it("replays an accepted receipt without writing again", async () => {
    const first = await gateway.mutate(principal, createRequest());
    const replay = await gateway.mutate(principal, createRequest());

    expect(replay).toEqual({ ...first, replayed: true });
    expect((await reactor.getDocument(first.taskId)).operations.global).toHaveLength(1);
  });

  it("rejects operation-id reuse with a changed canonical payload", async () => {
    await gateway.mutate(principal, createRequest());
    const changed = createRequest();
    changed.commands[0].input.title = "Different title";

    await expect(gateway.mutate(principal, changed)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
      status: 409,
    });
  });

  it("recovers a Reactor write whose acknowledgement was lost", async () => {
    reactor.failAfterNextWrite = true;
    await expect(gateway.mutate(principal, createRequest())).rejects.toThrow(
      "simulated lost acknowledgement",
    );

    const recovered = await gateway.mutate(principal, createRequest());
    expect(recovered.revision).toBe(1);
    expect((await reactor.getDocument(recovered.taskId)).operations.global).toHaveLength(1);
  });

  it("recovers the narrow allocation-before-attachment crash window by intent name", async () => {
    reactor.failAfterNextAllocation = true;
    await expect(gateway.mutate(principal, createRequest("allocation-recovery"))).rejects.toThrow(
      "simulated failure after allocation",
    );

    expect(reactor.documents.size).toBe(1);
    expect(receipts.find("allocation-recovery")).toMatchObject({ taskId: null });

    const recovered = await gateway.mutate(principal, createRequest("allocation-recovery"));
    expect(recovered.revision).toBe(1);
    expect(reactor.documents.size).toBe(1);
    expect(reactor.findByNameCalls).toBe(1);
    expect(reactor.findByNameMaxCandidates).toEqual([100]);
  });

  it("reconciles optional undefined input after JSON transport omits the keys", async () => {
    const request = createRequest("json-transport-recovery");
    request.commands[0].input.bodyMarkdown = undefined;
    request.commands[0].input.projectId = undefined;
    reactor.jsonTransportOperations = true;
    reactor.failAfterNextWrite = true;

    await expect(gateway.mutate(principal, request)).rejects.toThrow(
      "simulated lost acknowledgement",
    );
    const recovered = await gateway.mutate(principal, request);

    expect(recovered.revision).toBe(1);
    expect((await reactor.getDocument(recovered.taskId)).operations.global).toHaveLength(1);
  });

  it("does not reconcile a same-type operation with different canonical input", async () => {
    reactor.failAfterNextWrite = true;
    await expect(gateway.mutate(principal, createRequest("input-match-create"))).rejects.toThrow(
      "simulated lost acknowledgement",
    );
    reactor.alterLedgerInput = true;

    await expect(
      gateway.mutate(principal, createRequest("input-match-create")),
    ).rejects.toMatchObject({ code: "UNCERTAIN_MUTATION", status: 503 });
  });

  it("fails closed when another writer interleaves before addActions", async () => {
    const created = await gateway.mutate(principal, createRequest("interleave-create"));
    const request = {
      operationId: "interleave-update",
      taskId: created.taskId,
      expectedRevision: 1,
      commands: [{ type: "UPDATE_TITLE" as const, input: { title: "Gateway title" } }],
    };
    reactor.interleaveBeforeNextWrite = true;

    await expect(gateway.mutate(principal, request)).rejects.toMatchObject({
      code: "UNCERTAIN_MUTATION",
      status: 503,
    });
    await expect(gateway.mutate(principal, request)).rejects.toMatchObject({
      code: "UNCERTAIN_MUTATION",
      status: 503,
    });
    expect(receipts.find("interleave-update")).toMatchObject({
      operationId: "interleave-update",
      resultStateHash: expect.any(String),
    });
  });

  it("rejects live reducer divergence and gives wedged creates terminal guidance", async () => {
    reactor.rejectNextWrite = true;
    const request = createRequest("live-reducer-rejection");

    await expect(gateway.mutate(principal, request)).rejects.toMatchObject({
      code: "REACTOR_MODEL_REJECTED",
      status: 422,
    });
    expect(receipts.find("live-reducer-rejection")).toMatchObject({
      operationId: "live-reducer-rejection",
      resultStateHash: expect.any(String),
    });
    const document = [...reactor.documents.values()][0];
    expect(document.operations.global[0]?.error).toBeTruthy();

    await expect(gateway.mutate(principal, request)).rejects.toMatchObject({
      code: "CREATE_REJECTED_USE_NEW_OPERATION_ID",
      status: 409,
    });
  });

  it("keeps a prepared receipt uncertain when its document advances unexpectedly", async () => {
    const created = await gateway.mutate(principal, createRequest("advanced-create"));
    const request = {
      operationId: "advanced-update",
      taskId: created.taskId,
      expectedRevision: 1,
      commands: [{ type: "UPDATE_TITLE" as const, input: { title: "Expected title" } }],
    };
    reactor.failBeforeNextWrite = true;
    await expect(gateway.mutate(principal, request)).rejects.toThrow(
      "simulated failure before write",
    );
    reactor.advanceWithForeignWrite(created.taskId);

    await expect(gateway.mutate(principal, request)).rejects.toMatchObject({
      code: "UNCERTAIN_MUTATION",
      status: 503,
    });
  });

  it("waits for a lagging operation ledger before accepting recovery", async () => {
    const created = await gateway.mutate(principal, createRequest("ledger-create"));
    const request = {
      operationId: "ledger-update",
      taskId: created.taskId,
      expectedRevision: 1,
      commands: [{ type: "UPDATE_TITLE" as const, input: { title: "Ledger title" } }],
    };
    reactor.lagOperationsCalls = 1;

    await expect(gateway.mutate(principal, request)).rejects.toMatchObject({
      code: "UNCERTAIN_MUTATION",
      status: 503,
    });
    const recovered = await gateway.mutate(principal, request);
    expect(recovered).toMatchObject({ revision: 2, operationIndexes: [1] });
  });

  it("uses header revisions when the live MCP document shape omits operations", async () => {
    reactor.omitOperations = true;
    const receipt = await gateway.mutate(principal, createRequest("header-revision-create"));

    expect(receipt.revision).toBe(1);
    expect((await gateway.getTask(receipt.taskId)).revision).toBe(1);
  });

  it("abandons a locally rejected create so corrected input can reuse the operation id", async () => {
    const rejected = createRequest("local-reject-create");
    rejected.commands[0].input.title = "";
    await expect(gateway.mutate(principal, rejected)).rejects.toMatchObject({
      code: "MODEL_REJECTED",
      status: 422,
    });
    expect(receipts.find("local-reject-create")).toBeNull();

    const corrected = createRequest("local-reject-create");
    const receipt = await gateway.mutate(principal, corrected);
    expect(receipt.revision).toBe(1);
  });

  it("reconciles writes when the Reactor adapter remints action ids", async () => {
    reactor.remintActionIds = true;
    const receipt = await gateway.mutate(principal, createRequest("reminted-create"));

    expect(receipt.revision).toBe(1);
    expect(receipt.operationIndexes).toEqual([0]);
    expect((await reactor.getDocument(receipt.taskId)).state.global.title).toBe(
      "Synthetic gateway task",
    );
  });

  it("enforces optimistic revision before update", async () => {
    const created = await gateway.mutate(principal, createRequest());
    await expect(gateway.mutate(principal, {
      operationId: "update-wrong-revision",
      taskId: created.taskId,
      expectedRevision: 0,
      commands: [{ type: "UPDATE_TITLE", input: { title: "Nope" } }],
    })).rejects.toMatchObject({ code: "REVISION_CONFLICT", status: 409 });
    expect((await reactor.getDocument(created.taskId)).state.global.title).toBe(
      "Synthetic gateway task",
    );
  });

  it("applies a multi-field patch as one idempotent request", async () => {
    const created = await gateway.mutate(principal, createRequest());
    const updated = await gateway.mutate(principal, {
      operationId: "patch-1",
      taskId: created.taskId,
      expectedRevision: 1,
      commands: [
        { type: "UPDATE_TITLE", input: { title: "Revised" } },
        { type: "SET_DUE", input: { dueAt: "2026-08-14T15:00:00.000Z" } },
      ],
    });

    expect(updated.revision).toBe(3);
    expect(updated.operationIndexes).toEqual([1, 2]);
    expect((await reactor.getDocument(created.taskId)).state.global).toMatchObject({
      title: "Revised",
      dueAt: "2026-08-14T15:00:00.000Z",
    });
  });

  it("rejects caller-chosen task identity before reserving or allocating", async () => {
    const request = createRequest();
    request.commands[0].input = {
      ...request.commands[0].input,
      id: "caller-id",
    };

    await expect(gateway.mutate(principal, request)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      status: 400,
    });
    expect(receipts.find("create-1")).toBeNull();
    expect(reactor.documents.size).toBe(0);
  });

  it("does not let a caller inject actor or timestamp", async () => {
    const request = createRequest();
    request.commands[0].input = {
      ...request.commands[0].input,
      actorId: "attacker",
      occurredAt: "1999-01-01T00:00:00.000Z",
    };
    const receipt = await gateway.mutate(principal, request);
    const state = (await reactor.getDocument(receipt.taskId)).state.global;

    expect(state.createdBy).toBe("chris");
    expect(state.createdAt).toBe(clock());
  });

  it("enforces the client source allowlist and owner boundary", async () => {
    const wrongSource = createRequest("wrong-source");
    wrongSource.commands[0].input.source = "AGENT";
    await expect(gateway.mutate(principal, wrongSource)).rejects.toMatchObject({
      code: "FORBIDDEN_SOURCE",
      status: 403,
    });

    const wrongOwner = createRequest("wrong-owner");
    wrongOwner.commands[0].input.ownerId = "someone-else";
    await expect(gateway.mutate(principal, wrongOwner)).rejects.toMatchObject({
      code: "FORBIDDEN_OWNER",
      status: 403,
    });
    expect(reactor.documents.size).toBe(0);
  });
});
