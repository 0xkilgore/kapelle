/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { PHBaseState, PHDocument } from "document-model";
import type { TaskAuthorityAction } from "./actions.js";
import type { TaskAuthorityState as TaskAuthorityGlobalState } from "./schema/types.js";

type TaskAuthorityLocalState = Record<PropertyKey, never>;

type TaskAuthorityPHState = PHBaseState & {
  global: TaskAuthorityGlobalState;
  local: TaskAuthorityLocalState;
};
type TaskAuthorityDocument = PHDocument<TaskAuthorityPHState>;

export * from "./schema/types.js";

export type {
  TaskAuthorityAction,
  TaskAuthorityDocument,
  TaskAuthorityGlobalState,
  TaskAuthorityLocalState,
  TaskAuthorityPHState,
};
