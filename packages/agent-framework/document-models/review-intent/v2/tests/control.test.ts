import { generateMock } from "document-model";
import {
  claimExecution,
  ClaimExecutionInputSchema,
  createReview,
  CreateReviewInputSchema,
  invalidateReview,
  InvalidateReviewInputSchema,
  isReviewIntentDocument,
  recordDecision,
  RecordDecisionInputSchema,
  recordDelivery,
  RecordDeliveryInputSchema,
  reducer,
  reserveEffect,
  ReserveEffectInputSchema,
  utils,
} from "document-models/review-intent/v2";
import { describe, expect, it } from "vitest";

describe("ControlOperations", () => {
  it("should handle createReview operation", () => {
    const document = utils.createDocument();
    const input = generateMock(CreateReviewInputSchema(), {
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, createReview(input));

    expect(isReviewIntentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "CREATE_REVIEW",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle recordDecision operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RecordDecisionInputSchema(), {
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, recordDecision(input));

    expect(isReviewIntentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "RECORD_DECISION",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle invalidateReview operation", () => {
    const document = utils.createDocument();
    const input = generateMock(InvalidateReviewInputSchema(), {
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, invalidateReview(input));

    expect(isReviewIntentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "INVALIDATE_REVIEW",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle reserveEffect operation", () => {
    const document = utils.createDocument();
    const input = generateMock(ReserveEffectInputSchema(), {
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, reserveEffect(input));

    expect(isReviewIntentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "RESERVE_EFFECT",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle recordDelivery operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RecordDeliveryInputSchema(), {
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, recordDelivery(input));

    expect(isReviewIntentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "RECORD_DELIVERY",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle claimExecution operation", () => {
    const document = utils.createDocument();
    const input = generateMock(ClaimExecutionInputSchema(), {
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, claimExecution(input));

    expect(isReviewIntentDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "CLAIM_EXECUTION",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
