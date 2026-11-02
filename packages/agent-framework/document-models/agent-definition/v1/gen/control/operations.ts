/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { AgentDefinitionGlobalState } from "../types.js";
import type { PublishDefinitionAction } from "./actions.js";

export interface AgentDefinitionControlOperations {
  publishDefinitionOperation: (
    state: AgentDefinitionGlobalState,
    action: PublishDefinitionAction,
    dispatch?: SignalDispatch,
  ) => void;
}
