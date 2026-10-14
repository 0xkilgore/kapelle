/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { TaskAuthorityContentAction } from "./content/actions.js";
import type { TaskAuthorityContextAction } from "./context/actions.js";
import type { TaskAuthorityLifecycleAction } from "./lifecycle/actions.js";

export * from "./content/actions.js";
export * from "./context/actions.js";
export * from "./lifecycle/actions.js";

export type TaskAuthorityAction =
  | TaskAuthorityContentAction
  | TaskAuthorityLifecycleAction
  | TaskAuthorityContextAction;
