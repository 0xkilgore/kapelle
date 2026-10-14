import { createHash } from "node:crypto";
import type {
  TaskAuthorityGlobalState,
  TaskStatus,
} from "document-models/task-authority/v1";

export type TaskIndexRow = Omit<Pick<
  TaskAuthorityGlobalState,
  | "title"
  | "status"
  | "priority"
  | "projectId"
  | "dueAt"
  | "snoozedUntil"
  | "labels"
  | "ownerId"
  | "assigneeId"
  | "createdAt"
  | "updatedAt"
  | "completedAt"
>, "createdAt" | "updatedAt"> & {
  id: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  externalRefs: Array<{ id: string; authority: string; opaqueId: string }>;
};

export type TodayProjection = {
  kind: "task-authority.today.v1";
  viewerTimeZone: string;
  localDate: string;
  rows: TaskIndexRow[];
  totalCount: number;
  hasMore: boolean;
};

export type MorningDigestTaskRow = Pick<
  TaskIndexRow,
  | "id"
  | "title"
  | "status"
  | "priority"
  | "projectId"
  | "dueAt"
  | "ownerId"
  | "completedAt"
  | "updatedAt"
  | "revision"
>;

type BoundedDigestRows = {
  rows: MorningDigestTaskRow[];
  totalCount: number;
  hasMore: boolean;
};

export type MorningDigestProjection = {
  kind: "task-authority.morning-digest.v1";
  state: "fresh" | "authoritative_empty";
  reasonCode: "SOURCE_GENERATED" | "NO_MATCHING_TASKS";
  viewerTimeZone: string;
  localDate: string;
  previousLocalDate: string;
  weekEndsOn: string;
  generatedAt: string;
  ownerId: "chris";
  focus: BoundedDigestRows;
  counts: {
    overdue: number;
    dueThisWeek: number;
    completedPreviousLocalDay: number;
  };
  thisWeek: BoundedDigestRows;
  completedPreviousLocalDay: BoundedDigestRows;
};

export type MorningDigestLimits = {
  focus: number;
  thisWeek: number;
  completedPreviousLocalDay: number;
};

export type TaskQuery =
  | { lane: "INBOX" }
  | { lane: "UPCOMING"; viewerTimeZone: string; now: string }
  | { lane: "PROJECT"; projectId: string }
  | { lane: "BLOCKED" }
  | { lane: "SNOOZED" }
  | { lane: "COMPLETED" }
  | { lane: "ARCHIVED" };

export type TaskQueryProjection = {
  kind: "task-authority.query.v1";
  lane: TaskQuery["lane"];
  rows: TaskIndexRow[];
  totalCount: number;
  hasMore: boolean;
};

const priorityOrder = { HIGH: 0, MED: 1, LOW: 2 } as const;

function localDate(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function indexTask(
  state: TaskAuthorityGlobalState,
  revision: number,
): TaskIndexRow {
  if (!state.id) throw new Error("cannot index an uncreated task");
  if (!state.createdAt || !state.updatedAt) {
    throw new Error("cannot index a created task without timestamps");
  }
  return {
    id: state.id,
    title: state.title,
    status: state.status,
    priority: state.priority,
    projectId: state.projectId,
    dueAt: state.dueAt,
    snoozedUntil: state.snoozedUntil,
    labels: [...state.labels],
    ownerId: state.ownerId,
    assigneeId: state.assigneeId,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    revision,
    externalRefs: state.externalRefs.slice(0, 20).map(({ id, authority, opaqueId }) => ({
      id,
      authority,
      opaqueId,
    })),
  };
}

function addLocalDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day + days));
  return instant.toISOString().slice(0, 10);
}

function localWeekEnd(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addLocalDays(value, 7 - (weekday || 7));
}

function isActionableAt(row: TaskIndexRow, now: string): boolean {
  if (row.status === "OPEN" || row.status === "BLOCKED") return true;
  return row.status === "SNOOZED" && row.snoozedUntil != null &&
    Date.parse(row.snoozedUntil) <= Date.parse(now);
}

function isVisibleToday(row: TaskIndexRow, now: string, timeZone: string): boolean {
  if (row.status === "DONE" || row.status === "ARCHIVED") return false;
  if (row.status === "SNOOZED") {
    return row.snoozedUntil != null && Date.parse(row.snoozedUntil) <= Date.parse(now);
  }
  if (row.status !== "OPEN" && row.status !== "BLOCKED") return false;
  if (!row.dueAt) return false;
  return localDate(row.dueAt, timeZone) <= localDate(now, timeZone);
}

function compareToday(left: TaskIndexRow, right: TaskIndexRow, now: string, timeZone: string): number {
  const today = localDate(now, timeZone);
  const leftOverdue = left.dueAt != null && localDate(left.dueAt, timeZone) < today;
  const rightOverdue = right.dueAt != null && localDate(right.dueAt, timeZone) < today;
  if (leftOverdue !== rightOverdue) return leftOverdue ? -1 : 1;
  const leftPriority = left.priority == null ? 3 : priorityOrder[left.priority];
  const rightPriority = right.priority == null ? 3 : priorityOrder[right.priority];
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;
  const dueComparison = (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999");
  if (dueComparison) return dueComparison;
  const updatedComparison = left.updatedAt.localeCompare(right.updatedAt);
  if (updatedComparison) return updatedComparison;
  return left.id.localeCompare(right.id);
}

export function projectToday(
  rows: TaskIndexRow[],
  viewerTimeZone: string,
  now: string,
  limit = 100,
): TodayProjection {
  if (limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
  const selected = rows
    .filter((row) => isVisibleToday(row, now, viewerTimeZone))
    .sort((left, right) => compareToday(left, right, now, viewerTimeZone));
  return {
    kind: "task-authority.today.v1",
    viewerTimeZone,
    localDate: localDate(now, viewerTimeZone),
    rows: selected.slice(0, limit),
    totalCount: selected.length,
    hasMore: selected.length > limit,
  };
}

function digestRow(row: TaskIndexRow): MorningDigestTaskRow {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    projectId: row.projectId,
    dueAt: row.dueAt,
    ownerId: row.ownerId,
    completedAt: row.completedAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
  };
}

function boundedDigestRows(
  rows: TaskIndexRow[],
  limit: number,
): BoundedDigestRows {
  return {
    rows: rows.slice(0, limit).map(digestRow),
    totalCount: rows.length,
    hasMore: rows.length > limit,
  };
}

function validDigestLimit(value: number, field: keyof MorningDigestLimits): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error(`${field} limit must be between 1 and 100`);
  }
  return value;
}

/**
 * Source-owned aggregate for the Morning Digest. Calendar membership is evaluated
 * in viewer time: "this week" means after today through Sunday, and completed
 * means the immediately preceding local calendar day. The owner is intentionally
 * fixed to the owner so callers cannot broaden the digest into team or Pipeline work.
 */
export function projectMorningDigest(
  rows: TaskIndexRow[],
  viewerTimeZone: string,
  now: string,
  limits: Partial<MorningDigestLimits> = {},
): MorningDigestProjection {
  const selectedLimits: MorningDigestLimits = {
    focus: validDigestLimit(limits.focus ?? 5, "focus"),
    thisWeek: validDigestLimit(limits.thisWeek ?? 8, "thisWeek"),
    completedPreviousLocalDay: validDigestLimit(
      limits.completedPreviousLocalDay ?? 3,
      "completedPreviousLocalDay",
    ),
  };
  const today = localDate(now, viewerTimeZone);
  const previousLocalDate = addLocalDays(today, -1);
  const weekEndsOn = localWeekEnd(today);
  const ownerRows = rows.filter((row) => row.ownerId === "chris");

  const focusRows = ownerRows
    .filter((row) => isVisibleToday(row, now, viewerTimeZone))
    .sort((left, right) => compareToday(left, right, now, viewerTimeZone));
  const overdue = focusRows.filter(
    (row) => row.dueAt != null && localDate(row.dueAt, viewerTimeZone) < today,
  );
  const thisWeekRows = ownerRows
    .filter((row) => {
      if (!isActionableAt(row, now) || row.dueAt == null) return false;
      const dueDate = localDate(row.dueAt, viewerTimeZone);
      return dueDate > today && dueDate <= weekEndsOn;
    })
    .sort((left, right) => {
      const dueComparison = (left.dueAt ?? "").localeCompare(right.dueAt ?? "");
      if (dueComparison) return dueComparison;
      const leftPriority = left.priority == null ? 3 : priorityOrder[left.priority];
      const rightPriority = right.priority == null ? 3 : priorityOrder[right.priority];
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      const updatedComparison = left.updatedAt.localeCompare(right.updatedAt);
      return updatedComparison || left.id.localeCompare(right.id);
    });
  const completedRows = ownerRows
    .filter(
      (row) => row.status === "DONE" && row.completedAt != null &&
        localDate(row.completedAt, viewerTimeZone) === previousLocalDate,
    )
    .sort((left, right) => {
      const completedComparison = (right.completedAt ?? "").localeCompare(left.completedAt ?? "");
      return completedComparison || left.id.localeCompare(right.id);
    });

  const focus = boundedDigestRows(focusRows, selectedLimits.focus);
  const thisWeek = boundedDigestRows(thisWeekRows, selectedLimits.thisWeek);
  const completedPreviousLocalDay = boundedDigestRows(
    completedRows,
    selectedLimits.completedPreviousLocalDay,
  );
  const authoritativeEmpty = focus.totalCount === 0 && thisWeek.totalCount === 0 &&
    completedPreviousLocalDay.totalCount === 0;

  return {
    kind: "task-authority.morning-digest.v1",
    state: authoritativeEmpty ? "authoritative_empty" : "fresh",
    reasonCode: authoritativeEmpty ? "NO_MATCHING_TASKS" : "SOURCE_GENERATED",
    viewerTimeZone,
    localDate: today,
    previousLocalDate,
    weekEndsOn,
    generatedAt: now,
    ownerId: "chris",
    focus,
    counts: {
      overdue: overdue.length,
      dueThisWeek: thisWeekRows.length,
      completedPreviousLocalDay: completedRows.length,
    },
    thisWeek,
    completedPreviousLocalDay,
  };
}

export function queryTasks(
  rows: TaskIndexRow[],
  query: TaskQuery,
  limit = 100,
): TaskQueryProjection {
  if (limit < 1 || limit > 100) throw new Error("limit must be between 1 and 100");
  let result: TaskIndexRow[];
  switch (query.lane) {
    case "INBOX":
      result = rows.filter((row) => row.status === "OPEN" && row.projectId == null);
      break;
    case "UPCOMING": {
      const today = localDate(query.now, query.viewerTimeZone);
      result = rows.filter(
        (row) =>
          (row.status === "OPEN" || row.status === "BLOCKED") &&
          row.dueAt != null &&
          localDate(row.dueAt, query.viewerTimeZone) > today,
      );
      break;
    }
    case "PROJECT":
      result = rows.filter(
        (row) => row.projectId === query.projectId && row.status !== "ARCHIVED",
      );
      break;
    case "BLOCKED":
      result = rows.filter((row) => row.status === "BLOCKED");
      break;
    case "SNOOZED":
      result = rows.filter((row) => row.status === "SNOOZED");
      break;
    case "COMPLETED":
      result = rows.filter((row) => row.status === "DONE");
      break;
    case "ARCHIVED":
      result = rows.filter((row) => row.status === "ARCHIVED");
      break;
  }
  const sorted = result.sort((left, right) => left.id.localeCompare(right.id));
  return {
    kind: "task-authority.query.v1",
    lane: query.lane,
    rows: sorted.slice(0, limit),
    totalCount: sorted.length,
    hasMore: sorted.length > limit,
  };
}

export function indexHash(rows: TaskIndexRow[]): string {
  const canonical = [...rows]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((row) => JSON.stringify(row))
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function stateFixture(
  id: string,
  overrides: Partial<TaskAuthorityGlobalState> = {},
): TaskAuthorityGlobalState {
  const now = "2026-08-13T12:00:00.000Z";
  return {
    id,
    schemaVersion: 1,
    title: `Task ${id}`,
    bodyMarkdown: "",
    status: "OPEN" as TaskStatus,
    priority: null,
    projectId: null,
    labels: [],
    ownerId: "chris",
    assigneeId: null,
    dueAt: null,
    snoozedUntil: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    archivedAt: null,
    openBlock: null,
    blockHistory: [],
    comments: [],
    dependsOn: [],
    externalRefs: [],
    source: "HUMAN",
    sourceRef: null,
    createdBy: "chris",
    updatedBy: "chris",
    ...overrides,
  };
}

export class InMemoryTaskIndex {
  #rows = new Map<string, TaskIndexRow>();

  upsert(state: TaskAuthorityGlobalState, revision: number): void {
    const row = indexTask(state, revision);
    this.#rows.set(row.id, row);
  }

  rebuild(entries: Array<{ state: TaskAuthorityGlobalState; revision: number }>): void {
    const replacement = new Map<string, TaskIndexRow>();
    for (const entry of entries) {
      const row = indexTask(entry.state, entry.revision);
      replacement.set(row.id, row);
    }
    this.#rows = replacement;
  }

  rows(): TaskIndexRow[] {
    return [...this.#rows.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((row) => structuredClone(row));
  }

  hash(): string {
    return indexHash(this.rows());
  }
}
