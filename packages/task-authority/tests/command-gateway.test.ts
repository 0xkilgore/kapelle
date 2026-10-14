import { describe, expect, it } from "vitest";
import { TaskCommandGateway } from "../src/command-gateway.js";

function createEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    operationId: "op-create-1",
    actorId: "chris",
    sourceClient: "test-client",
    expectedRevision: 0,
    command: {
      type: "CREATE_TASK" as const,
      input: {
        title: "Synthetic task",
        ownerId: "chris",
        source: "HUMAN",
        actorId: "attacker",
        occurredAt: "1900-01-01T00:00:00.000Z",
      },
    },
    ...overrides,
  };
}

describe("TaskCommandGateway", () => {
  it("derives actor and time, and returns an idempotent receipt", () => {
    const gateway = new TaskCommandGateway({
      clock: () => "2026-08-13T15:00:00.000Z",
      authorizations: { "test-client": ["chris"] },
    });
    const envelope = createEnvelope();
    const first = gateway.execute(envelope);
    const replay = gateway.execute(envelope);

    expect(replay).toStrictEqual(first);
    expect(gateway.document.operations.global).toHaveLength(1);
    expect(gateway.document.state.global.createdBy).toBe("chris");
    expect(gateway.document.state.global.createdAt).toBe("2026-08-13T15:00:00.000Z");
    expect(gateway.document.state.global.id).toBe(gateway.document.header.id);
    expect(first.taskId).toBe(gateway.document.header.id);
    expect(first.revision).toBe(1);
  });

  it("fails closed when an operation id is reused with another payload", () => {
    const gateway = new TaskCommandGateway({
      clock: () => "2026-08-13T15:00:00.000Z",
      authorizations: { "test-client": ["chris"] },
    });
    gateway.execute(createEnvelope());
    expect(() =>
      gateway.execute(
        createEnvelope({
          command: {
            type: "CREATE_TASK",
            input: {
              title: "Changed payload",
              ownerId: "chris",
              source: "HUMAN",
            },
          },
        }),
      ),
    ).toThrow(/different canonical payload/);
    expect(gateway.document.operations.global).toHaveLength(1);
  });

  it("rejects a stale expected revision without mutation", () => {
    const times = [
      "2026-08-13T15:00:00.000Z",
      "2026-08-13T15:01:00.000Z",
    ];
    const gateway = new TaskCommandGateway({
      clock: () => times.shift()!,
      authorizations: { "test-client": ["chris"] },
    });
    gateway.execute(createEnvelope());
    expect(() =>
      gateway.execute({
        operationId: "op-title-1",
        actorId: "chris",
        sourceClient: "test-client",
        expectedRevision: 0,
        command: { type: "UPDATE_TITLE", input: { title: "New title" } },
      }),
    ).toThrow(/revision conflict/);
    expect(gateway.document.state.global.title).toBe("Synthetic task");
    expect(gateway.document.operations.global).toHaveLength(1);
  });

  it("rejects malformed and oversized commands", () => {
    const gateway = new TaskCommandGateway({
      clock: () => "2026-08-13T15:00:00.000Z",
      authorizations: { "test-client": ["chris"] },
    });
    expect(() =>
      gateway.execute(
        createEnvelope({
          command: {
            type: "CREATE_TASK",
            input: {
              title: " ",
              ownerId: "chris",
              source: "HUMAN",
            },
          },
        }),
      ),
    ).toThrow(/non-empty/);
    expect(gateway.document.operations.global).toHaveLength(0);
    expect(() =>
      gateway.execute(
        createEnvelope({
          operationId: "x".repeat(501),
        }),
      ),
    ).toThrow(/too long/);
  });

  it("rejects caller-chosen task identity", () => {
    const gateway = new TaskCommandGateway({
      clock: () => "2026-08-13T15:00:00.000Z",
      authorizations: { "test-client": ["chris"] },
    });
    const envelope = createEnvelope();
    envelope.command.input = {
      ...envelope.command.input,
      id: "task:caller-choice",
    } as typeof envelope.command.input & { id: string };
    expect(() => gateway.execute(envelope)).toThrow(/server-managed/);
    expect(gateway.document.operations.global).toHaveLength(0);
  });

  it("rejects a duplicate create without advancing the accepted revision", () => {
    const gateway = new TaskCommandGateway({
      clock: () => "2026-08-13T15:00:00.000Z",
      authorizations: { "test-client": ["chris"] },
    });
    gateway.execute(createEnvelope());
    expect(() =>
      gateway.execute({
        ...createEnvelope(),
        operationId: "op-create-2",
        expectedRevision: 1,
      }),
    ).toThrow(/already created/);
    expect(gateway.document.operations.global).toHaveLength(1);
  });

  it.each([
    ["invalid priority", { priority: "URGENT" }],
    ["invalid source", { source: "EMAIL" }],
    ["malformed due date", { dueAt: "next Thursday" }],
  ])("rejects %s before accepting an operation", (_label, invalid) => {
    const gateway = new TaskCommandGateway({
      clock: () => "2026-08-13T15:00:00.000Z",
      authorizations: { "test-client": ["chris"] },
    });
    const envelope = createEnvelope();
    envelope.command.input = { ...envelope.command.input, ...invalid };
    expect(() => gateway.execute(envelope)).toThrow();
    expect(gateway.document.operations.global).toHaveLength(0);
  });

  it("rejects unauthorized actor and client combinations before mutation", () => {
    const gateway = new TaskCommandGateway({
      clock: () => "2026-08-13T15:00:00.000Z",
      authorizations: { "test-client": ["chris"] },
    });
    expect(() =>
      gateway.execute(createEnvelope({ actorId: "unknown-agent" })),
    ).toThrow(/unauthorized/);
    expect(gateway.document.operations.global).toHaveLength(0);
  });

  it("retains document, revision, and idempotency receipt across restart serialization", () => {
    const gateway = new TaskCommandGateway({
      clock: () => "2026-08-13T15:00:00.000Z",
      authorizations: { "test-client": ["chris"] },
    });
    const envelope = createEnvelope();
    const receipt = gateway.execute(envelope);
    const serialized = JSON.stringify(gateway.snapshot());
    const restarted = new TaskCommandGateway({
      snapshot: JSON.parse(serialized),
      clock: () => "2026-08-13T16:00:00.000Z",
      authorizations: { "test-client": ["chris"] },
    });

    expect(restarted.document.state.global).toStrictEqual(gateway.document.state.global);
    expect(restarted.document.operations.global).toHaveLength(1);
    expect(restarted.execute(envelope)).toStrictEqual(receipt);
    expect(restarted.document.operations.global).toHaveLength(1);
  });
});
