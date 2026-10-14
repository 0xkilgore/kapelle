/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { PHBaseState, PHDocument } from "document-model";
import type { AgentDefinitionAction } from "./actions.js";
import type { AgentDefinitionState as AgentDefinitionGlobalState } from "./schema/types.js";

type AgentDefinitionLocalState = Record<PropertyKey, never>;

type AgentDefinitionPHState = PHBaseState & {
  global: AgentDefinitionGlobalState;
  local: AgentDefinitionLocalState;
};
type AgentDefinitionDocument = PHDocument<AgentDefinitionPHState>;

export * from "./schema/types.js";

export type {
  AgentDefinitionAction,
  AgentDefinitionDocument,
  AgentDefinitionGlobalState,
  AgentDefinitionLocalState,
  AgentDefinitionPHState,
};
