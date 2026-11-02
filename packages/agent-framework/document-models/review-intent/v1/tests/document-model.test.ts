/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */
/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */

import {
  assertIsReviewIntentDocument,
  assertIsReviewIntentState,
  initialGlobalState,
  initialLocalState,
  isReviewIntentDocument,
  isReviewIntentState,
  reviewIntentDocumentType,
  utils,
} from "document-models/review-intent/v1";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("ReviewIntent Document Model", () => {
  it("should create a new ReviewIntent document", () => {
    const document = utils.createDocument();

    expect(document).toBeDefined();
    expect(document.header.documentType).toBe(reviewIntentDocumentType);
  });

  it("should create a new ReviewIntent document with a valid initial state", () => {
    const document = utils.createDocument();
    expect(document.state.global).toStrictEqual(initialGlobalState);
    expect(document.state.local).toStrictEqual(initialLocalState);
    expect(isReviewIntentDocument(document)).toBe(true);
    expect(isReviewIntentState(document.state)).toBe(true);
  });
  it("should reject a document that is not a ReviewIntent document", () => {
    const wrongDocumentType = utils.createDocument();
    wrongDocumentType.header.documentType = "the-wrong-thing-1234";
    try {
      expect(assertIsReviewIntentDocument(wrongDocumentType)).toThrow();
      expect(isReviewIntentDocument(wrongDocumentType)).toBe(false);
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
    expect(isReviewIntentState(wrongState.state)).toBe(false);
    expect(assertIsReviewIntentState(wrongState.state)).toThrow();
    expect(isReviewIntentDocument(wrongState)).toBe(false);
    expect(assertIsReviewIntentDocument(wrongState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const wrongInitialState = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  wrongInitialState.initialState.global = {
    ...{ notWhat: "you want" },
  };
  try {
    expect(isReviewIntentState(wrongInitialState.state)).toBe(false);
    expect(assertIsReviewIntentState(wrongInitialState.state)).toThrow();
    expect(isReviewIntentDocument(wrongInitialState)).toBe(false);
    expect(assertIsReviewIntentDocument(wrongInitialState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingIdInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingIdInHeader.header.id;
  try {
    expect(isReviewIntentDocument(missingIdInHeader)).toBe(false);
    expect(assertIsReviewIntentDocument(missingIdInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingNameInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingNameInHeader.header.name;
  try {
    expect(isReviewIntentDocument(missingNameInHeader)).toBe(false);
    expect(assertIsReviewIntentDocument(missingNameInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingCreatedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingCreatedAtUtcIsoInHeader.header.createdAtUtcIso;
  try {
    expect(isReviewIntentDocument(missingCreatedAtUtcIsoInHeader)).toBe(false);
    expect(
      assertIsReviewIntentDocument(missingCreatedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingLastModifiedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingLastModifiedAtUtcIsoInHeader.header.lastModifiedAtUtcIso;
  try {
    expect(isReviewIntentDocument(missingLastModifiedAtUtcIsoInHeader)).toBe(
      false,
    );
    expect(
      assertIsReviewIntentDocument(missingLastModifiedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }
});
