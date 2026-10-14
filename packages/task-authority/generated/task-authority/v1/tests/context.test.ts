import { generateMock } from "document-model";
import {
  addComment,
  AddCommentInputSchema,
  addDependency,
  AddDependencyInputSchema,
  addExternalRef,
  AddExternalRefInputSchema,
  addLabel,
  AddLabelInputSchema,
  isTaskAuthorityDocument,
  reducer,
  removeDependency,
  RemoveDependencyInputSchema,
  removeExternalRef,
  RemoveExternalRefInputSchema,
  removeLabel,
  RemoveLabelInputSchema,
  utils,
} from "document-models/task-authority/v1";
import { describe, expect, it } from "vitest";

describe("ContextOperations", () => {
  it("should handle addLabel operation", () => {
    const document = utils.createDocument();
    const input = generateMock(AddLabelInputSchema());

    const updatedDocument = reducer(document, addLabel(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe("ADD_LABEL");
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle removeLabel operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RemoveLabelInputSchema());

    const updatedDocument = reducer(document, removeLabel(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REMOVE_LABEL",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle addComment operation", () => {
    const document = utils.createDocument();
    const input = generateMock(AddCommentInputSchema());

    const updatedDocument = reducer(document, addComment(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "ADD_COMMENT",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle addDependency operation", () => {
    const document = utils.createDocument();
    const input = generateMock(AddDependencyInputSchema());

    const updatedDocument = reducer(document, addDependency(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "ADD_DEPENDENCY",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle removeDependency operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RemoveDependencyInputSchema());

    const updatedDocument = reducer(document, removeDependency(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REMOVE_DEPENDENCY",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle addExternalRef operation", () => {
    const document = utils.createDocument();
    const input = generateMock(AddExternalRefInputSchema());

    const updatedDocument = reducer(document, addExternalRef(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "ADD_EXTERNAL_REF",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle removeExternalRef operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RemoveExternalRefInputSchema());

    const updatedDocument = reducer(document, removeExternalRef(input));

    expect(isTaskAuthorityDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REMOVE_EXTERNAL_REF",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
