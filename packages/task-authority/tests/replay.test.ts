import { describe, expect, it } from "vitest";
import { reducer, utils } from "document-models/task-authority/v1";
import { TaskCommandGateway } from "../src/command-gateway.js";
import { indexHash, indexTask } from "../src/projection.js";

describe("Powerhouse operation-log replay", () => {
  it("rebuilds identical state and index hash", () => {
    const times = [
      "2026-08-13T15:00:00.000Z",
      "2026-08-13T15:01:00.000Z",
      "2026-08-13T15:02:00.000Z",
    ];
    const gateway = new TaskCommandGateway({
      clock: () => times.shift()!,
      authorizations: { "replay-test": ["chris"] },
    });
    gateway.execute({
      operationId: "op-create",
      actorId: "chris",
      sourceClient: "replay-test",
      expectedRevision: 0,
      command: {
        type: "CREATE_TASK",
        input: {
          title: "Replay me",
          ownerId: "chris",
          source: "HUMAN",
          dueAt: "2026-08-14T15:00:00.000Z",
        },
      },
    });
    gateway.execute({
      operationId: "op-label",
      actorId: "chris",
      sourceClient: "replay-test",
      expectedRevision: 1,
      command: { type: "ADD_LABEL", input: { label: "Needs Response" } },
    });
    gateway.execute({
      operationId: "op-block",
      actorId: "chris",
      sourceClient: "replay-test",
      expectedRevision: 2,
      command: { type: "BLOCK_TASK", input: { reason: "waiting" } },
    });

    const original = gateway.document;
    const replayBase = utils.createDocument();
    replayBase.header = structuredClone(original.header);
    replayBase.header.revision.global = 0;
    const replayed = original.operations.global.reduce(
      (document, operation) => reducer(document, operation.action),
      replayBase,
    );
    expect(replayed.state.global).toStrictEqual(original.state.global);
    expect(indexHash([indexTask(replayed.state.global, 3)])).toBe(
      indexHash([indexTask(original.state.global, 3)]),
    );
  });
});
