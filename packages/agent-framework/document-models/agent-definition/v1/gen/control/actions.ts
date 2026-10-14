/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type { PublishDefinitionInput } from "../types.js";

export type PublishDefinitionAction = Action & {
  type: "PUBLISH_DEFINITION";
  input: PublishDefinitionInput;
};

export type AgentDefinitionControlAction = PublishDefinitionAction;
