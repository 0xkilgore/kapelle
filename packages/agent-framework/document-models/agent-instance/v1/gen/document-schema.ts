/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import {
  BaseDocumentHeaderSchema,
  BaseDocumentStateSchema,
} from "document-model";
import { z } from "zod";
import { agentInstanceDocumentType } from "./document-type.js";
import { AgentInstanceStateSchema } from "./schema/zod.js";
import type { AgentInstanceDocument, AgentInstancePHState } from "./types.js";

/** Schema for validating the header object of a AgentInstance document */
export const AgentInstanceDocumentHeaderSchema =
  BaseDocumentHeaderSchema.extend({
    documentType: z.literal(agentInstanceDocumentType),
  });

/** Schema for validating the state object of a AgentInstance document */
export const AgentInstancePHStateSchema = BaseDocumentStateSchema.extend({
  global: AgentInstanceStateSchema(),
});

export const AgentInstanceDocumentSchema = z.object({
  header: AgentInstanceDocumentHeaderSchema,
  state: AgentInstancePHStateSchema,
  initialState: AgentInstancePHStateSchema,
});

/** Simple helper function to check if a state object is a AgentInstance document state object */
export function isAgentInstanceState(
  state: unknown,
): state is AgentInstancePHState {
  return AgentInstancePHStateSchema.safeParse(state).success;
}

/** Simple helper function to assert that a document state object is a AgentInstance document state object */
export function assertIsAgentInstanceState(
  state: unknown,
): asserts state is AgentInstancePHState {
  AgentInstancePHStateSchema.parse(state);
}

/** Simple helper function to check if a document is a AgentInstance document */
export function isAgentInstanceDocument(
  document: unknown,
): document is AgentInstanceDocument {
  return AgentInstanceDocumentSchema.safeParse(document).success;
}

/** Simple helper function to assert that a document is a AgentInstance document */
export function assertIsAgentInstanceDocument(
  document: unknown,
): asserts document is AgentInstanceDocument {
  AgentInstanceDocumentSchema.parse(document);
}
