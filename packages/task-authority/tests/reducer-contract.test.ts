import { describe, expect, it } from "vitest";
import type { TaskAuthorityGlobalState } from "document-models/task-authority/v1";
import { taskAuthorityContentOperations } from "../generated/task-authority/v1/src/reducers/content.js";
import { taskAuthorityContextOperations } from "../generated/task-authority/v1/src/reducers/context.js";
import { taskAuthorityLifecycleOperations } from "../generated/task-authority/v1/src/reducers/lifecycle.js";
import { stateFixture } from "../src/projection.js";

const actorId = "chris";
const occurredAt = "2026-08-13T16:00:00.000Z";

function action(type: string, input: Record<string, unknown> = {}) {
  return { type, scope: "global", input: { ...input, actorId, occurredAt } } as never;
}

function state(status: TaskAuthorityGlobalState["status"]): TaskAuthorityGlobalState {
  const base = stateFixture(`task:${status.toLowerCase()}`, { status });
  if (status === "SNOOZED") base.snoozedUntil = "2026-08-14T16:00:00.000Z";
  if (status === "DONE") base.completedAt = "2026-08-13T15:00:00.000Z";
  if (status === "ARCHIVED") base.archivedAt = "2026-08-13T15:00:00.000Z";
  if (status === "BLOCKED") {
    base.openBlock = {
      reason: "waiting",
      setAt: "2026-08-13T15:00:00.000Z",
      setBy: "chris",
      clearedAt: null,
      clearedBy: null,
      resolution: null,
    };
  }
  return base;
}

describe("Task Authority reducer contract", () => {
  const lifecycleCases = [
    ["OPEN", "completeTaskOperation", "COMPLETE_TASK", {}, "DONE"],
    ["SNOOZED", "completeTaskOperation", "COMPLETE_TASK", {}, "DONE"],
    ["BLOCKED", "completeTaskOperation", "COMPLETE_TASK", {}, "DONE"],
    ["DONE", "reopenTaskOperation", "REOPEN_TASK", {}, "OPEN"],
    ["OPEN", "snoozeTaskOperation", "SNOOZE_TASK", { snoozedUntil: "2026-08-14T16:00:00.000Z" }, "SNOOZED"],
    ["BLOCKED", "snoozeTaskOperation", "SNOOZE_TASK", { snoozedUntil: "2026-08-14T16:00:00.000Z" }, "SNOOZED"],
    ["SNOOZED", "unsnoozeTaskOperation", "UNSNOOZE_TASK", {}, "OPEN"],
    ["OPEN", "blockTaskOperation", "BLOCK_TASK", { reason: "waiting" }, "BLOCKED"],
    ["SNOOZED", "blockTaskOperation", "BLOCK_TASK", { reason: "waiting" }, "BLOCKED"],
    ["BLOCKED", "unblockTaskOperation", "UNBLOCK_TASK", { resolution: "done" }, "OPEN"],
  ] as const;

  it.each(lifecycleCases)(
    "%s -> %s -> %s",
    (from, operation, type, input, to) => {
      const subject = state(from);
      taskAuthorityLifecycleOperations[operation](subject, action(type, input));
      expect(subject.status).toBe(to);
    },
  );

  it("rejects invalid lifecycle transitions", () => {
    expect(() =>
      taskAuthorityLifecycleOperations.reopenTaskOperation(
        state("OPEN"),
        action("REOPEN_TASK"),
      ),
    ).toThrow(/requires DONE/);
    expect(() =>
      taskAuthorityLifecycleOperations.completeTaskOperation(
        state("DONE"),
        action("COMPLETE_TASK"),
      ),
    ).toThrow(/requires OPEN/);
    expect(() =>
      taskAuthorityLifecycleOperations.snoozeTaskOperation(
        state("OPEN"),
        action("SNOOZE_TASK", { snoozedUntil: occurredAt }),
      ),
    ).toThrow(/future/);
  });

  it("closes the active block when completing", () => {
    const subject = state("BLOCKED");
    taskAuthorityLifecycleOperations.completeTaskOperation(
      subject,
      action("COMPLETE_TASK", { resolution: "dependency landed" }),
    );
    expect(subject.openBlock).toBeNull();
    expect(subject.blockHistory).toHaveLength(1);
    expect(subject.blockHistory[0]?.resolution).toBe("dependency landed");
  });

  it("clears a snooze when completing", () => {
    const subject = state("SNOOZED");
    taskAuthorityLifecycleOperations.completeTaskOperation(
      subject,
      action("COMPLETE_TASK"),
    );
    expect(subject.status).toBe("DONE");
    expect(subject.snoozedUntil).toBeNull();
  });

  it("normalizes equivalent UTC timestamp precision before storage", () => {
    const subject = state("OPEN");
    taskAuthorityContentOperations.setDueOperation(
      subject,
      action("SET_DUE", { dueAt: "2026-08-14T10:00:00Z" }),
    );
    expect(subject.dueAt).toBe("2026-08-14T10:00:00.000Z");
    expect(subject.updatedAt).toBe("2026-08-13T16:00:00.000Z");
  });

  it("makes archive terminal for every subsequent write", () => {
    const subject = state("OPEN");
    taskAuthorityLifecycleOperations.archiveTaskOperation(
      subject,
      action("ARCHIVE_TASK", { reason: "stale" }),
    );
    expect(subject.status).toBe("ARCHIVED");
    expect(() =>
      taskAuthorityContentOperations.updateTitleOperation(
        subject,
        action("UPDATE_TITLE", { title: "Cannot change" }),
      ),
    ).toThrow(/archived/);
    expect(() =>
      taskAuthorityContextOperations.addLabelOperation(
        subject,
        action("ADD_LABEL", { label: "later" }),
      ),
    ).toThrow(/archived/);
  });

  it("normalizes labels and treats set-like duplicates as no-ops", () => {
    const subject = state("OPEN");
    taskAuthorityContextOperations.addLabelOperation(
      subject,
      action("ADD_LABEL", { label: " #Needs Response " }),
    );
    const firstUpdatedAt = subject.updatedAt;
    taskAuthorityContextOperations.addLabelOperation(
      subject,
      action("ADD_LABEL", { label: "needs-response" }),
    );
    expect(subject.labels).toStrictEqual(["needs-response"]);
    expect(subject.updatedAt).toBe(firstUpdatedAt);
  });

  it("rejects self-dependencies and preserves append-only comments", () => {
    const subject = state("OPEN");
    expect(() =>
      taskAuthorityContextOperations.addDependencyOperation(
        subject,
        action("ADD_DEPENDENCY", { taskId: subject.id! }),
      ),
    ).toThrow(/itself/);
    taskAuthorityContextOperations.addCommentOperation(
      subject,
      action("ADD_COMMENT", { id: "comment-1", bodyMarkdown: "First" }),
    );
    taskAuthorityContextOperations.addCommentOperation(
      subject,
      action("ADD_COMMENT", { id: "comment-1", bodyMarkdown: "Replacement" }),
    );
    expect(subject.comments).toHaveLength(1);
    expect(subject.comments[0]?.bodyMarkdown).toBe("First");
  });
});
