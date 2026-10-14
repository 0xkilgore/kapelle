/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import {
  BaseDocumentHeaderSchema,
  BaseDocumentStateSchema,
} from "document-model";
import { z } from "zod";
import { agentDefinitionDocumentType } from "./document-type.js";
import { AgentDefinitionStateSchema } from "./schema/zod.js";
import type {
  AgentDefinitionDocument,
  AgentDefinitionPHState,
} from "./types.js";

/** Schema for validating the header object of a AgentDefinition document */
export const AgentDefinitionDocumentHeaderSchema =
  BaseDocumentHeaderSchema.extend({
    documentType: z.literal(agentDefinitionDocumentType),
  });

/** Schema for validating the state object of a AgentDefinition document */
export const AgentDefinitionPHStateSchema = BaseDocumentStateSchema.extend({
  global: AgentDefinitionStateSchema(),
});

export const AgentDefinitionDocumentSchema = z.object({
  header: AgentDefinitionDocumentHeaderSchema,
  state: AgentDefinitionPHStateSchema,
  initialState: AgentDefinitionPHStateSchema,
});

/** Simple helper function to check if a state object is a AgentDefinition document state object */
export function isAgentDefinitionState(
  state: unknown,
): state is AgentDefinitionPHState {
  return AgentDefinitionPHStateSchema.safeParse(state).success;
}

/** Simple helper function to assert that a document state object is a AgentDefinition document state object */
export function assertIsAgentDefinitionState(
  state: unknown,
): asserts state is AgentDefinitionPHState {
  AgentDefinitionPHStateSchema.parse(state);
}

/** Simple helper function to check if a document is a AgentDefinition document */
export function isAgentDefinitionDocument(
  document: unknown,
): document is AgentDefinitionDocument {
  return AgentDefinitionDocumentSchema.safeParse(document).success;
}

/** Simple helper function to assert that a document is a AgentDefinition document */
export function assertIsAgentDefinitionDocument(
  document: unknown,
): asserts document is AgentDefinitionDocument {
  AgentDefinitionDocumentSchema.parse(document);
}
