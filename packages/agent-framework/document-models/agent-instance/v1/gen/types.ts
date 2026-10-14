/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { PHBaseState, PHDocument } from "document-model";
import type { AgentInstanceAction } from "./actions.js";
import type { AgentInstanceState as AgentInstanceGlobalState } from "./schema/types.js";

type AgentInstanceLocalState = Record<PropertyKey, never>;

type AgentInstancePHState = PHBaseState & {
  global: AgentInstanceGlobalState;
  local: AgentInstanceLocalState;
};
type AgentInstanceDocument = PHDocument<AgentInstancePHState>;

export * from "./schema/types.js";

export type {
  AgentInstanceAction,
  AgentInstanceDocument,
  AgentInstanceGlobalState,
  AgentInstanceLocalState,
  AgentInstancePHState,
};
