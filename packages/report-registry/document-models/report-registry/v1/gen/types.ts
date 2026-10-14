/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { PHBaseState, PHDocument } from "document-model";
import type { ReportRegistryAction } from "./actions.js";
import type { ReportRegistryState as ReportRegistryGlobalState } from "./schema/types.js";

type ReportRegistryLocalState = Record<PropertyKey, never>;

type ReportRegistryPHState = PHBaseState & {
  global: ReportRegistryGlobalState;
  local: ReportRegistryLocalState;
};
type ReportRegistryDocument = PHDocument<ReportRegistryPHState>;

export * from "./schema/types.js";

export type {
  ReportRegistryAction,
  ReportRegistryDocument,
  ReportRegistryGlobalState,
  ReportRegistryLocalState,
  ReportRegistryPHState,
};

