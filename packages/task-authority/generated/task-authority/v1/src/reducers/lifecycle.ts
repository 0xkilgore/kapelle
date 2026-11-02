import type { TaskAuthorityLifecycleOperations } from "document-models/task-authority/v1";
import {
  assertNotArchived,
  assertUtc,
  closeOpenBlock,
  mutationMetadata,
  optionalText,
  requireText,
  touch,
} from "../utils.js";

export const taskAuthorityLifecycleOperations: TaskAuthorityLifecycleOperations =
  {
    completeTaskOperation(state, action) {
      assertNotArchived(state);
      if (!(["OPEN", "SNOOZED", "BLOCKED"] as const).includes(state.status as never)) {
        throw new Error("COMPLETE_TASK: requires OPEN, SNOOZED, or BLOCKED");
      }
      const metadata = mutationMetadata(action.input.actorId, action.input.occurredAt);
      closeOpenBlock(
        state,
        metadata.actorId,
        metadata.occurredAt,
        optionalText(action.input.resolution, "resolution", 2_000),
      );
      state.status = "DONE";
      state.completedAt = metadata.occurredAt;
      state.snoozedUntil = null;
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    reopenTaskOperation(state, action) {
      assertNotArchived(state);
      if (state.status !== "DONE") throw new Error("REOPEN_TASK: requires DONE");
      const metadata = mutationMetadata(action.input.actorId, action.input.occurredAt);
      optionalText(action.input.reason, "reason", 2_000);
      state.status = "OPEN";
      state.completedAt = null;
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    snoozeTaskOperation(state, action) {
      assertNotArchived(state);
      if (state.status !== "OPEN" && state.status !== "BLOCKED") {
        throw new Error("SNOOZE_TASK: requires OPEN or BLOCKED");
      }
      const metadata = mutationMetadata(action.input.actorId, action.input.occurredAt);
      const snoozedUntil = assertUtc(action.input.snoozedUntil, "snoozedUntil");
      if (Date.parse(snoozedUntil) <= Date.parse(metadata.occurredAt)) {
        throw new Error("SNOOZE_TASK: snoozedUntil must be in the future");
      }
      const reason = optionalText(action.input.reason, "reason", 2_000);
      if (state.status === "BLOCKED") {
        closeOpenBlock(state, metadata.actorId, metadata.occurredAt, reason ?? "snoozed");
      }
      state.status = "SNOOZED";
      state.snoozedUntil = snoozedUntil;
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    unsnoozeTaskOperation(state, action) {
      assertNotArchived(state);
      if (state.status !== "SNOOZED") throw new Error("UNSNOOZE_TASK: requires SNOOZED");
      const metadata = mutationMetadata(action.input.actorId, action.input.occurredAt);
      state.status = "OPEN";
      state.snoozedUntil = null;
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    blockTaskOperation(state, action) {
      assertNotArchived(state);
      if (state.status !== "OPEN" && state.status !== "SNOOZED") {
        throw new Error("BLOCK_TASK: requires OPEN or SNOOZED");
      }
      if (state.openBlock) throw new Error("BLOCK_TASK: task already has an open block");
      const metadata = mutationMetadata(action.input.actorId, action.input.occurredAt);
      state.openBlock = {
        reason: requireText(action.input.reason, "reason", 2_000),
        setAt: metadata.occurredAt,
        setBy: metadata.actorId,
        clearedAt: null,
        clearedBy: null,
        resolution: null,
      };
      state.status = "BLOCKED";
      state.snoozedUntil = null;
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    unblockTaskOperation(state, action) {
      assertNotArchived(state);
      if (state.status !== "BLOCKED" || !state.openBlock) {
        throw new Error("UNBLOCK_TASK: requires BLOCKED with an open block");
      }
      const metadata = mutationMetadata(action.input.actorId, action.input.occurredAt);
      closeOpenBlock(
        state,
        metadata.actorId,
        metadata.occurredAt,
        optionalText(action.input.resolution, "resolution", 2_000),
      );
      state.status = "OPEN";
      touch(state, metadata.actorId, metadata.occurredAt);
    },
    archiveTaskOperation(state, action) {
      assertNotArchived(state);
      const metadata = mutationMetadata(action.input.actorId, action.input.occurredAt);
      const reason = optionalText(action.input.reason, "reason", 2_000);
      closeOpenBlock(state, metadata.actorId, metadata.occurredAt, reason ?? "archived");
      state.status = "ARCHIVED";
      state.archivedAt = metadata.occurredAt;
      state.snoozedUntil = null;
      touch(state, metadata.actorId, metadata.occurredAt);
    },
  };
