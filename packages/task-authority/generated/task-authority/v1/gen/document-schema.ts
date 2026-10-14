/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import {
  BaseDocumentHeaderSchema,
  BaseDocumentStateSchema,
} from "document-model";
import { z } from "zod";
import { taskAuthorityDocumentType } from "./document-type.js";
import { TaskAuthorityStateSchema } from "./schema/zod.js";
import type { TaskAuthorityDocument, TaskAuthorityPHState } from "./types.js";

/** Schema for validating the header object of a TaskAuthority document */
export const TaskAuthorityDocumentHeaderSchema =
  BaseDocumentHeaderSchema.extend({
    documentType: z.literal(taskAuthorityDocumentType),
  });

/** Schema for validating the state object of a TaskAuthority document */
export const TaskAuthorityPHStateSchema = BaseDocumentStateSchema.extend({
  global: TaskAuthorityStateSchema(),
});

export const TaskAuthorityDocumentSchema = z.object({
  header: TaskAuthorityDocumentHeaderSchema,
  state: TaskAuthorityPHStateSchema,
  initialState: TaskAuthorityPHStateSchema,
});

/** Simple helper function to check if a state object is a TaskAuthority document state object */
export function isTaskAuthorityState(
  state: unknown,
): state is TaskAuthorityPHState {
  return TaskAuthorityPHStateSchema.safeParse(state).success;
}

/** Simple helper function to assert that a document state object is a TaskAuthority document state object */
export function assertIsTaskAuthorityState(
  state: unknown,
): asserts state is TaskAuthorityPHState {
  TaskAuthorityPHStateSchema.parse(state);
}

/** Simple helper function to check if a document is a TaskAuthority document */
export function isTaskAuthorityDocument(
  document: unknown,
): document is TaskAuthorityDocument {
  return TaskAuthorityDocumentSchema.safeParse(document).success;
}

/** Simple helper function to assert that a document is a TaskAuthority document */
export function assertIsTaskAuthorityDocument(
  document: unknown,
): asserts document is TaskAuthorityDocument {
  TaskAuthorityDocumentSchema.parse(document);
}
