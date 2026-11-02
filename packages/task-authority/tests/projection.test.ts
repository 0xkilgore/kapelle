import { describe, expect, it } from "vitest";
import {
  indexHash,
  indexTask,
  InMemoryTaskIndex,
  projectMorningDigest,
  projectToday,
  queryTasks,
  stateFixture,
} from "../src/projection.js";

const now = "2026-08-13T17:00:00.000Z";
const zone = "America/Chicago";

function syntheticRows() {
  return Array.from({ length: 20 }, (_, index) => {
    const number = index + 1;
    const overrides = number <= 4
      ? { dueAt: "2026-08-12T17:00:00.000Z", priority: number === 1 ? "HIGH" as const : null }
      : number <= 8
        ? { dueAt: "2026-08-13T22:00:00.000Z", priority: number === 5 ? "MED" as const : null }
        : number <= 11
          ? { dueAt: "2026-08-15T17:00:00.000Z", projectId: "project:alpha" }
          : number <= 14
            ? { status: "DONE" as const, completedAt: now }
            : number <= 16
              ? { status: "ARCHIVED" as const, archivedAt: now }
              : number === 17
                ? { status: "SNOOZED" as const, snoozedUntil: "2026-08-13T16:00:00.000Z" }
                : number === 18
                  ? { status: "SNOOZED" as const, snoozedUntil: "2026-08-14T16:00:00.000Z" }
                  : { projectId: null };
    return indexTask(stateFixture(`task:${number.toString().padStart(2, "0")}`, overrides), number);
  });
}

describe("task projections", () => {
  it("produces a stable bounded Today projection in viewer time", () => {
    const rows = syntheticRows();
    const first = projectToday(rows, zone, now, 5);
    const second = projectToday([...rows].reverse(), zone, now, 5);
    expect(first.rows.map((row) => row.id)).toStrictEqual(second.rows.map((row) => row.id));
    expect(first.totalCount).toBe(9);
    expect(first.hasMore).toBe(true);
    expect(first.rows[0]?.id).toBe("task:01");
    expect(first.localDate).toBe("2026-08-13");
  });

  it("produces an owner-only bounded Morning Digest aggregate with source-owned counts", () => {
    const rows = [
      indexTask(stateFixture("task:overdue", {
        dueAt: "2026-08-12T17:00:00.000Z",
        priority: "HIGH",
      }), 1),
      indexTask(stateFixture("task:today", {
        dueAt: "2026-08-13T21:00:00.000Z",
      }), 2),
      indexTask(stateFixture("task:this-week", {
        dueAt: "2026-08-16T17:00:00.000Z",
      }), 3),
      indexTask(stateFixture("task:next-week", {
        dueAt: "2026-08-17T17:00:00.000Z",
      }), 4),
      indexTask(stateFixture("task:completed-yesterday", {
        status: "DONE",
        completedAt: "2026-08-12T23:30:00.000Z",
      }), 5),
      indexTask(stateFixture("task:not-chris", {
        ownerId: "agent:other",
        dueAt: "2026-08-13T17:00:00.000Z",
      }), 6),
      indexTask(stateFixture("task:snoozed", {
        status: "SNOOZED",
        snoozedUntil: "2026-08-14T17:00:00.000Z",
        dueAt: "2026-08-12T17:00:00.000Z",
      }), 7),
    ];

    const projection = projectMorningDigest(rows, zone, now, {
      focus: 1,
      thisWeek: 1,
      completedPreviousLocalDay: 1,
    });
    expect(projection).toMatchObject({
      kind: "task-authority.morning-digest.v1",
      state: "fresh",
      reasonCode: "SOURCE_GENERATED",
      viewerTimeZone: zone,
      localDate: "2026-08-13",
      previousLocalDate: "2026-08-12",
      weekEndsOn: "2026-08-16",
      generatedAt: now,
      ownerId: "chris",
      focus: { totalCount: 2, hasMore: true },
      counts: {
        overdue: 1,
        dueThisWeek: 1,
        completedPreviousLocalDay: 1,
      },
      thisWeek: { totalCount: 1, hasMore: false },
      completedPreviousLocalDay: { totalCount: 1, hasMore: false },
    });
    expect(projection.focus.rows.map((row) => row.id)).toStrictEqual(["task:overdue"]);
    expect(projection.thisWeek.rows.map((row) => row.id)).toStrictEqual(["task:this-week"]);
    expect(projection.completedPreviousLocalDay.rows.map((row) => row.id)).toStrictEqual([
      "task:completed-yesterday",
    ]);
    expect(projection.focus.rows[0]).not.toHaveProperty("externalRefs");
  });

  it("distinguishes a valid authoritative empty Morning Digest", () => {
    expect(projectMorningDigest([
      indexTask(stateFixture("task:future", {
        dueAt: "2026-08-20T17:00:00.000Z",
      }), 1),
      indexTask(stateFixture("task:other-owner", {
        ownerId: "agent:other",
        dueAt: "2026-08-13T17:00:00.000Z",
      }), 2),
    ], zone, now)).toMatchObject({
      state: "authoritative_empty",
      reasonCode: "NO_MATCHING_TASKS",
      focus: { rows: [], totalCount: 0, hasMore: false },
      counts: { overdue: 0, dueThisWeek: 0, completedPreviousLocalDay: 0 },
      thisWeek: { rows: [], totalCount: 0, hasMore: false },
      completedPreviousLocalDay: { rows: [], totalCount: 0, hasMore: false },
    });
  });

  it("supports the synthetic query lanes", () => {
    const rows = syntheticRows();
    expect(queryTasks(rows, { lane: "INBOX" }).rows).toHaveLength(10);
    expect(queryTasks(rows, { lane: "UPCOMING", viewerTimeZone: zone, now }).rows).toHaveLength(3);
    expect(queryTasks(rows, { lane: "PROJECT", projectId: "project:alpha" }).rows).toHaveLength(3);
    expect(queryTasks(rows, { lane: "COMPLETED" }).rows).toHaveLength(3);
    expect(queryTasks(rows, { lane: "ARCHIVED" }).rows).toHaveLength(2);
    expect(queryTasks(rows, { lane: "SNOOZED" }).rows).toHaveLength(2);
  });

  it("keeps blocked and snoozed tasks visible without project or due dates", () => {
    const rows = [
      indexTask(stateFixture("task:blocked", { status: "BLOCKED" }), 1),
      indexTask(stateFixture("task:snoozed", {
        status: "SNOOZED",
        snoozedUntil: "2026-08-20T17:00:00.000Z",
      }), 2),
    ];
    expect(queryTasks(rows, { lane: "BLOCKED" }).rows.map((row) => row.id)).toStrictEqual([
      "task:blocked",
    ]);
    expect(queryTasks(rows, { lane: "SNOOZED" }).rows.map((row) => row.id)).toStrictEqual([
      "task:snoozed",
    ]);
  });

  it("bounds recovery lanes without hiding their full counts", () => {
    const rows = Array.from({ length: 105 }, (_, index) =>
      indexTask(stateFixture(`task:blocked-${index.toString().padStart(3, "0")}`, {
        status: "BLOCKED",
      }), index + 1),
    );
    const projection = queryTasks(rows, { lane: "BLOCKED" }, 25);
    expect(projection.rows).toHaveLength(25);
    expect(projection.totalCount).toBe(105);
    expect(projection.hasMore).toBe(true);
    expect(() => queryTasks(rows, { lane: "BLOCKED" }, 0)).toThrow(/between 1 and 100/);
    expect(() => queryTasks(rows, { lane: "BLOCKED" }, 101)).toThrow(/between 1 and 100/);
  });

  it("uses the viewer date across UTC midnight and a DST transition", () => {
    const lateChicago = indexTask(stateFixture("task:late-chicago", {
      dueAt: "2026-08-14T02:00:00.000Z",
    }), 1);
    expect(projectToday(
      [lateChicago],
      zone,
      "2026-08-13T23:00:00.000Z",
    ).rows).toHaveLength(1);

    const dstSunday = indexTask(stateFixture("task:dst-sunday", {
      dueAt: "2026-03-09T04:30:00.000Z",
    }), 1);
    expect(projectToday(
      [dstSunday],
      zone,
      "2026-03-08T16:00:00.000Z",
    ).rows).toHaveLength(1);
  });

  it("refuses to index created state without durable timestamps", () => {
    expect(() => indexTask(stateFixture("task:no-created-at", {
      createdAt: null,
    }), 1)).toThrow(/without timestamps/);
    expect(() => indexTask(stateFixture("task:no-updated-at", {
      updatedAt: null,
    }), 1)).toThrow(/without timestamps/);
  });

  it("rebuilds the same index hash independent of operation arrival order", () => {
    const rows = syntheticRows();
    expect(indexHash(rows)).toBe(indexHash([...rows].reverse()));
  });

  it("rebuilds a disposable index to the same hash", () => {
    const states = syntheticRows().map((row) => ({
      state: stateFixture(row.id, {
        title: row.title,
        status: row.status,
        priority: row.priority,
        projectId: row.projectId,
        dueAt: row.dueAt,
        snoozedUntil: row.snoozedUntil,
        labels: row.labels,
        ownerId: row.ownerId,
        assigneeId: row.assigneeId,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt,
      }),
      revision: row.revision,
    }));
    const incremental = new InMemoryTaskIndex();
    for (const entry of states) incremental.upsert(entry.state, entry.revision);
    const rebuilt = new InMemoryTaskIndex();
    rebuilt.rebuild([...states].reverse());
    expect(rebuilt.hash()).toBe(incremental.hash());
    expect(rebuilt.rows()).toStrictEqual(incremental.rows());
  });
});
