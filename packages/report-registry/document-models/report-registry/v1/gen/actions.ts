/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { ReportRegistryAttentionAction } from "./attention/actions.js";
import type { ReportRegistryContentAction } from "./content/actions.js";
import type { ReportRegistryLifecycleAction } from "./lifecycle/actions.js";

export * from "./attention/actions.js";
export * from "./content/actions.js";
export * from "./lifecycle/actions.js";

export type ReportRegistryAction =
  | ReportRegistryContentAction
  | ReportRegistryAttentionAction
  | ReportRegistryLifecycleAction;

