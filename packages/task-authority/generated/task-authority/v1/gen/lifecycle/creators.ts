/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  ArchiveTaskInputSchema,
  BlockTaskInputSchema,
  CompleteTaskInputSchema,
  ReopenTaskInputSchema,
  SnoozeTaskInputSchema,
  UnblockTaskInputSchema,
  UnsnoozeTaskInputSchema,
} from "../schema/zod.js";
import type {
  ArchiveTaskInput,
  BlockTaskInput,
  CompleteTaskInput,
  ReopenTaskInput,
  SnoozeTaskInput,
  UnblockTaskInput,
  UnsnoozeTaskInput,
} from "../types.js";
import type {
  ArchiveTaskAction,
  BlockTaskAction,
  CompleteTaskAction,
  ReopenTaskAction,
  SnoozeTaskAction,
  UnblockTaskAction,
  UnsnoozeTaskAction,
} from "./actions.js";

export const completeTask = (input: CompleteTaskInput) =>
  createAction<CompleteTaskAction>(
    "COMPLETE_TASK",
    { ...input },
    undefined,
    CompleteTaskInputSchema,
    "global",
  );

export const reopenTask = (input: ReopenTaskInput) =>
  createAction<ReopenTaskAction>(
    "REOPEN_TASK",
    { ...input },
    undefined,
    ReopenTaskInputSchema,
    "global",
  );

export const snoozeTask = (input: SnoozeTaskInput) =>
  createAction<SnoozeTaskAction>(
    "SNOOZE_TASK",
    { ...input },
    undefined,
    SnoozeTaskInputSchema,
    "global",
  );

export const unsnoozeTask = (input: UnsnoozeTaskInput) =>
  createAction<UnsnoozeTaskAction>(
    "UNSNOOZE_TASK",
    { ...input },
    undefined,
    UnsnoozeTaskInputSchema,
    "global",
  );

export const blockTask = (input: BlockTaskInput) =>
  createAction<BlockTaskAction>(
    "BLOCK_TASK",
    { ...input },
    undefined,
    BlockTaskInputSchema,
    "global",
  );

export const unblockTask = (input: UnblockTaskInput) =>
  createAction<UnblockTaskAction>(
    "UNBLOCK_TASK",
    { ...input },
    undefined,
    UnblockTaskInputSchema,
    "global",
  );

export const archiveTask = (input: ArchiveTaskInput) =>
  createAction<ArchiveTaskAction>(
    "ARCHIVE_TASK",
    { ...input },
    undefined,
    ArchiveTaskInputSchema,
    "global",
  );
