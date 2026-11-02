import { generateMock } from "document-model";
import {
  archiveTask,
  ArchiveTaskInputSchema,
  blockTask,
  BlockTaskInputSchema,
  completeTask,
  CompleteTaskInputSchema,
  isTaskAuthorityDocument,
  reducer,
  reopenTask,
  ReopenTaskInputSchema,
  snoozeTask,
  SnoozeTaskInputSchema,
  unblockTask,
  UnblockTaskInputSchema,
  unsnoozeTask,
  UnsnoozeTaskInputSchema,
  utils,
} from "document-models/task-authority/v1";
import { describe, expect, it } from "vitest";

describe("LifecycleOperations", () => {
  it("should handle completeTask operation", () => {
    const document = utils.createDocument();
    const input = generateMock(CompleteTaskInputSchema());

    const updatedDocument = reducer(document, completeTask(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "COMPLETE_TASK",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle reopenTask operation", () => {
    const document = utils.createDocument();
    const input = generateMock(ReopenTaskInputSchema());

    const updatedDocument = reducer(document, reopenTask(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REOPEN_TASK",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle snoozeTask operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SnoozeTaskInputSchema(), {
      snoozedUntil: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, snoozeTask(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SNOOZE_TASK",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle unsnoozeTask operation", () => {
    const document = utils.createDocument();
    const input = generateMock(UnsnoozeTaskInputSchema());

    const updatedDocument = reducer(document, unsnoozeTask(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "UNSNOOZE_TASK",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle blockTask operation", () => {
    const document = utils.createDocument();
    const input = generateMock(BlockTaskInputSchema());

    const updatedDocument = reducer(document, blockTask(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe("BLOCK_TASK");
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle unblockTask operation", () => {
    const document = utils.createDocument();
    const input = generateMock(UnblockTaskInputSchema());

    const updatedDocument = reducer(document, unblockTask(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "UNBLOCK_TASK",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle archiveTask operation", () => {
    const document = utils.createDocument();
    const input = generateMock(ArchiveTaskInputSchema());

    const updatedDocument = reducer(document, archiveTask(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "ARCHIVE_TASK",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
