/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { PHBaseState, PHDocument } from "document-model";
import type { DispatchAction } from "./actions.js";
import type { DispatchState as DispatchGlobalState } from "./schema/types.js";

type DispatchLocalState = Record<PropertyKey, never>;

type DispatchPHState = PHBaseState & {
  global: DispatchGlobalState;
  local: DispatchLocalState;
};
type DispatchDocument = PHDocument<DispatchPHState>;

export * from "./schema/types.js";

export type {
  DispatchAction,
  DispatchDocument,
  DispatchGlobalState,
  DispatchLocalState,
  DispatchPHState,
};
