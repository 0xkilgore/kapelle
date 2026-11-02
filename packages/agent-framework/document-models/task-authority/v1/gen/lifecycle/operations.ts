/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { TaskAuthorityGlobalState } from "../types.js";
import type {
  ArchiveTaskAction,
  BlockTaskAction,
  CompleteTaskAction,
  ReopenTaskAction,
  SnoozeTaskAction,
  UnblockTaskAction,
  UnsnoozeTaskAction,
} from "./actions.js";

export interface TaskAuthorityLifecycleOperations {
  completeTaskOperation: (
    state: TaskAuthorityGlobalState,
    action: CompleteTaskAction,
    dispatch?: SignalDispatch,
  ) => void;
  reopenTaskOperation: (
    state: TaskAuthorityGlobalState,
    action: ReopenTaskAction,
    dispatch?: SignalDispatch,
  ) => void;
  snoozeTaskOperation: (
    state: TaskAuthorityGlobalState,
    action: SnoozeTaskAction,
    dispatch?: SignalDispatch,
  ) => void;
  unsnoozeTaskOperation: (
    state: TaskAuthorityGlobalState,
    action: UnsnoozeTaskAction,
    dispatch?: SignalDispatch,
  ) => void;
  blockTaskOperation: (
    state: TaskAuthorityGlobalState,
    action: BlockTaskAction,
    dispatch?: SignalDispatch,
  ) => void;
  unblockTaskOperation: (
    state: TaskAuthorityGlobalState,
    action: UnblockTaskAction,
    dispatch?: SignalDispatch,
  ) => void;
  archiveTaskOperation: (
    state: TaskAuthorityGlobalState,
    action: ArchiveTaskAction,
    dispatch?: SignalDispatch,
  ) => void;
}
