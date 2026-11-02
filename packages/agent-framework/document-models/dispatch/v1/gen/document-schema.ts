/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import {
  BaseDocumentHeaderSchema,
  BaseDocumentStateSchema,
} from "document-model";
import { z } from "zod";
import { dispatchDocumentType } from "./document-type.js";
import { DispatchStateSchema } from "./schema/zod.js";
import type { DispatchDocument, DispatchPHState } from "./types.js";

/** Schema for validating the header object of a Dispatch document */
export const DispatchDocumentHeaderSchema = BaseDocumentHeaderSchema.extend({
  documentType: z.literal(dispatchDocumentType),
});

/** Schema for validating the state object of a Dispatch document */
export const DispatchPHStateSchema = BaseDocumentStateSchema.extend({
  global: DispatchStateSchema(),
});

export const DispatchDocumentSchema = z.object({
  header: DispatchDocumentHeaderSchema,
  state: DispatchPHStateSchema,
  initialState: DispatchPHStateSchema,
});

/** Simple helper function to check if a state object is a Dispatch document state object */
export function isDispatchState(state: unknown): state is DispatchPHState {
  return DispatchPHStateSchema.safeParse(state).success;
}

/** Simple helper function to assert that a document state object is a Dispatch document state object */
export function assertIsDispatchState(
  state: unknown,
): asserts state is DispatchPHState {
  DispatchPHStateSchema.parse(state);
}

/** Simple helper function to check if a document is a Dispatch document */
export function isDispatchDocument(
  document: unknown,
): document is DispatchDocument {
  return DispatchDocumentSchema.safeParse(document).success;
}

/** Simple helper function to assert that a document is a Dispatch document */
export function assertIsDispatchDocument(
  document: unknown,
): asserts document is DispatchDocument {
  DispatchDocumentSchema.parse(document);
}
