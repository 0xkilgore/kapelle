/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { PHBaseState, PHDocument } from "document-model";
import type { ReviewIntentAction } from "./actions.js";
import type { ReviewIntentState as ReviewIntentGlobalState } from "./schema/types.js";

type ReviewIntentLocalState = Record<PropertyKey, never>;

type ReviewIntentPHState = PHBaseState & {
  global: ReviewIntentGlobalState;
  local: ReviewIntentLocalState;
};
type ReviewIntentDocument = PHDocument<ReviewIntentPHState>;

export * from "./schema/types.js";

export type {
  ReviewIntentAction,
  ReviewIntentDocument,
  ReviewIntentGlobalState,
  ReviewIntentLocalState,
  ReviewIntentPHState,
};
