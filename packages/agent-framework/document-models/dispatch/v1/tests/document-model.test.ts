/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */
/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */

import {
  assertIsDispatchDocument,
  assertIsDispatchState,
  dispatchDocumentType,
  initialGlobalState,
  initialLocalState,
  isDispatchDocument,
  isDispatchState,
  utils,
} from "document-models/dispatch/v1";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("Dispatch Document Model", () => {
  it("should create a new Dispatch document", () => {
    const document = utils.createDocument();

    expect(document).toBeDefined();
    expect(document.header.documentType).toBe(dispatchDocumentType);
  });

  it("should create a new Dispatch document with a valid initial state", () => {
    const document = utils.createDocument();
    expect(document.state.global).toStrictEqual(initialGlobalState);
    expect(document.state.local).toStrictEqual(initialLocalState);
    expect(isDispatchDocument(document)).toBe(true);
    expect(isDispatchState(document.state)).toBe(true);
  });
  it("should reject a document that is not a Dispatch document", () => {
    const wrongDocumentType = utils.createDocument();
    wrongDocumentType.header.documentType = "the-wrong-thing-1234";
    try {
      expect(assertIsDispatchDocument(wrongDocumentType)).toThrow();
      expect(isDispatchDocument(wrongDocumentType)).toBe(false);
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
    expect(isDispatchState(wrongState.state)).toBe(false);
    expect(assertIsDispatchState(wrongState.state)).toThrow();
    expect(isDispatchDocument(wrongState)).toBe(false);
    expect(assertIsDispatchDocument(wrongState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const wrongInitialState = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  wrongInitialState.initialState.global = {
    ...{ notWhat: "you want" },
  };
  try {
    expect(isDispatchState(wrongInitialState.state)).toBe(false);
    expect(assertIsDispatchState(wrongInitialState.state)).toThrow();
    expect(isDispatchDocument(wrongInitialState)).toBe(false);
    expect(assertIsDispatchDocument(wrongInitialState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingIdInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingIdInHeader.header.id;
  try {
    expect(isDispatchDocument(missingIdInHeader)).toBe(false);
    expect(assertIsDispatchDocument(missingIdInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingNameInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingNameInHeader.header.name;
  try {
    expect(isDispatchDocument(missingNameInHeader)).toBe(false);
    expect(assertIsDispatchDocument(missingNameInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingCreatedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingCreatedAtUtcIsoInHeader.header.createdAtUtcIso;
  try {
    expect(isDispatchDocument(missingCreatedAtUtcIsoInHeader)).toBe(false);
    expect(assertIsDispatchDocument(missingCreatedAtUtcIsoInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingLastModifiedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingLastModifiedAtUtcIsoInHeader.header.lastModifiedAtUtcIso;
  try {
    expect(isDispatchDocument(missingLastModifiedAtUtcIsoInHeader)).toBe(false);
    expect(
      assertIsDispatchDocument(missingLastModifiedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }
});
