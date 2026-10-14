import { generateMock } from "document-model";
import {
  createTask,
  CreateTaskInputSchema,
  isTaskAuthorityDocument,
  reducer,
  setAssignee,
  SetAssigneeInputSchema,
  setDue,
  SetDueInputSchema,
  setPriority,
  SetPriorityInputSchema,
  setProject,
  SetProjectInputSchema,
  updateBody,
  UpdateBodyInputSchema,
  updateTitle,
  UpdateTitleInputSchema,
  utils,
} from "document-models/task-authority/v1";
import { describe, expect, it } from "vitest";

describe("ContentOperations", () => {
  it("should handle createTask operation", () => {
    const document = utils.createDocument();
    const input = generateMock(CreateTaskInputSchema(), {
      dueAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, createTask(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "CREATE_TASK",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle updateTitle operation", () => {
    const document = utils.createDocument();
    const input = generateMock(UpdateTitleInputSchema());

    const updatedDocument = reducer(document, updateTitle(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "UPDATE_TITLE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle updateBody operation", () => {
    const document = utils.createDocument();
    const input = generateMock(UpdateBodyInputSchema());

    const updatedDocument = reducer(document, updateBody(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "UPDATE_BODY",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setProject operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetProjectInputSchema());

    const updatedDocument = reducer(document, setProject(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_PROJECT",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setDue operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetDueInputSchema(), {
      dueAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, setDue(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe("SET_DUE");
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setPriority operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetPriorityInputSchema());

    const updatedDocument = reducer(document, setPriority(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_PRIORITY",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setAssignee operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetAssigneeInputSchema());

    const updatedDocument = reducer(document, setAssignee(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_ASSIGNEE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
