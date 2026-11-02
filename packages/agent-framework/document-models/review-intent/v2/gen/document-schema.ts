/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import {
  BaseDocumentHeaderSchema,
  BaseDocumentStateSchema,
} from "document-model";
import { z } from "zod";
import { reviewIntentDocumentType } from "./document-type.js";
import { ReviewIntentStateSchema } from "./schema/zod.js";
import type { ReviewIntentDocument, ReviewIntentPHState } from "./types.js";

/** Schema for validating the header object of a ReviewIntent document */
export const ReviewIntentDocumentHeaderSchema = BaseDocumentHeaderSchema.extend(
  {
    documentType: z.literal(reviewIntentDocumentType),
  },
);

/** Schema for validating the state object of a ReviewIntent document */
export const ReviewIntentPHStateSchema = BaseDocumentStateSchema.extend({
  global: ReviewIntentStateSchema(),
});

export const ReviewIntentDocumentSchema = z.object({
  header: ReviewIntentDocumentHeaderSchema,
  state: ReviewIntentPHStateSchema,
  initialState: ReviewIntentPHStateSchema,
});

/** Simple helper function to check if a state object is a ReviewIntent document state object */
export function isReviewIntentState(
  state: unknown,
): state is ReviewIntentPHState {
  return ReviewIntentPHStateSchema.safeParse(state).success;
}

/** Simple helper function to assert that a document state object is a ReviewIntent document state object */
export function assertIsReviewIntentState(
  state: unknown,
): asserts state is ReviewIntentPHState {
  ReviewIntentPHStateSchema.parse(state);
}

/** Simple helper function to check if a document is a ReviewIntent document */
export function isReviewIntentDocument(
  document: unknown,
): document is ReviewIntentDocument {
  return ReviewIntentDocumentSchema.safeParse(document).success;
}

/** Simple helper function to assert that a document is a ReviewIntent document */
export function assertIsReviewIntentDocument(
  document: unknown,
): asserts document is ReviewIntentDocument {
  ReviewIntentDocumentSchema.parse(document);
}
