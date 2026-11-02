/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */
/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */

import {
  assertIsTaskAuthorityDocument,
  assertIsTaskAuthorityState,
  initialGlobalState,
  initialLocalState,
  isTaskAuthorityDocument,
  isTaskAuthorityState,
  taskAuthorityDocumentType,
  utils,
} from "document-models/task-authority/v1";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("TaskAuthority Document Model", () => {
  it("should create a new TaskAuthority document", () => {
    const document = utils.createDocument();

    expect(document).toBeDefined();
    expect(document.header.documentType).toBe(taskAuthorityDocumentType);
  });

  it("should create a new TaskAuthority document with a valid initial state", () => {
    const document = utils.createDocument();
    expect(document.state.global).toStrictEqual(initialGlobalState);
    expect(document.state.local).toStrictEqual(initialLocalState);
    expect(isTaskAuthorityDocument(document)).toBe(true);
    expect(isTaskAuthorityState(document.state)).toBe(true);
  });
  it("should reject a document that is not a TaskAuthority document", () => {
    const wrongDocumentType = utils.createDocument();
    wrongDocumentType.header.documentType = "the-wrong-thing-1234";
    try {
      expect(assertIsTaskAuthorityDocument(wrongDocumentType)).toThrow();
      expect(isTaskAuthorityDocument(wrongDocumentType)).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
    }
  });
  const wrongState = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  wrongState.state.global = {
    ...{ notWhat: "you want" },
  };
  try {
    expect(isTaskAuthorityState(wrongState.state)).toBe(false);
    expect(assertIsTaskAuthorityState(wrongState.state)).toThrow();
    expect(isTaskAuthorityDocument(wrongState)).toBe(false);
    expect(assertIsTaskAuthorityDocument(wrongState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const wrongInitialState = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  wrongInitialState.initialState.global = {
    ...{ notWhat: "you want" },
  };
  try {
    expect(isTaskAuthorityState(wrongInitialState.state)).toBe(false);
    expect(assertIsTaskAuthorityState(wrongInitialState.state)).toThrow();
    expect(isTaskAuthorityDocument(wrongInitialState)).toBe(false);
    expect(assertIsTaskAuthorityDocument(wrongInitialState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingIdInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingIdInHeader.header.id;
  try {
    expect(isTaskAuthorityDocument(missingIdInHeader)).toBe(false);
    expect(assertIsTaskAuthorityDocument(missingIdInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingNameInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingNameInHeader.header.name;
  try {
    expect(isTaskAuthorityDocument(missingNameInHeader)).toBe(false);
    expect(assertIsTaskAuthorityDocument(missingNameInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingCreatedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingCreatedAtUtcIsoInHeader.header.createdAtUtcIso;
  try {
    expect(isTaskAuthorityDocument(missingCreatedAtUtcIsoInHeader)).toBe(false);
    expect(
      assertIsTaskAuthorityDocument(missingCreatedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingLastModifiedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingLastModifiedAtUtcIsoInHeader.header.lastModifiedAtUtcIso;
  try {
    expect(isTaskAuthorityDocument(missingLastModifiedAtUtcIsoInHeader)).toBe(
      false,
    );
    expect(
      assertIsTaskAuthorityDocument(missingLastModifiedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }
});
