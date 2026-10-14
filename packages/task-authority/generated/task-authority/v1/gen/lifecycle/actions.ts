/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  ArchiveTaskInput,
  BlockTaskInput,
  CompleteTaskInput,
  ReopenTaskInput,
  SnoozeTaskInput,
  UnblockTaskInput,
  UnsnoozeTaskInput,
} from "../types.js";

export type CompleteTaskAction = Action & {
  type: "COMPLETE_TASK";
  input: CompleteTaskInput;
};
export type ReopenTaskAction = Action & {
  type: "REOPEN_TASK";
  input: ReopenTaskInput;
};
export type SnoozeTaskAction = Action & {
  type: "SNOOZE_TASK";
  input: SnoozeTaskInput;
};
export type UnsnoozeTaskAction = Action & {
  type: "UNSNOOZE_TASK";
  input: UnsnoozeTaskInput;
};
export type BlockTaskAction = Action & {
  type: "BLOCK_TASK";
  input: BlockTaskInput;
};
export type UnblockTaskAction = Action & {
  type: "UNBLOCK_TASK";
  input: UnblockTaskInput;
};
export type ArchiveTaskAction = Action & {
  type: "ARCHIVE_TASK";
  input: ArchiveTaskInput;
};

export type TaskAuthorityLifecycleAction =
  | CompleteTaskAction
  | ReopenTaskAction
  | SnoozeTaskAction
  | UnsnoozeTaskAction
  | BlockTaskAction
  | UnblockTaskAction
  | ArchiveTaskAction;
