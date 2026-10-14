import type {
  TaskAuthorityGlobalState,
  TaskBlock,
} from "document-models/task-authority/v1";

const UTC_INSTANT = /(Z|[+-]00:00)$/;

export function requireText(
  value: string,
  field: string,
  maxLength: number,
): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}: non-empty value required`);
  if (normalized.length > maxLength) {
    throw new Error(`${field}: maximum length is ${maxLength}`);
  }
  return normalized;
}

export function boundedText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string {
  const normalized = value ?? "";
  if (normalized.length > maxLength) {
    throw new Error(`${field}: maximum length is ${maxLength}`);
  }
  return normalized;
}

export function optionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new Error(`${field}: maximum length is ${maxLength}`);
  }
  return normalized;
}

export function assertUtc(value: string, field: string): string {
  if (!UTC_INSTANT.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${field}: valid UTC ISO-8601 instant required`);
  }
  return new Date(value).toISOString();
}

export function assertInitialized(state: TaskAuthorityGlobalState): void {
  if (!state.id) throw new Error("task has not been created");
}

export function assertNotArchived(state: TaskAuthorityGlobalState): void {
  assertInitialized(state);
  if (state.status === "ARCHIVED") {
    throw new Error("task is archived and cannot be changed");
  }
}

export function mutationMetadata(
  actorId: string,
  occurredAt: string,
): { actorId: string; occurredAt: string } {
  return {
    actorId: requireText(actorId, "actorId", 500),
    occurredAt: assertUtc(occurredAt, "occurredAt"),
  };
}

export function touch(
  state: TaskAuthorityGlobalState,
  actorId: string,
  occurredAt: string,
): void {
  const metadata = mutationMetadata(actorId, occurredAt);
  state.updatedBy = metadata.actorId;
  state.updatedAt = metadata.occurredAt;
}

export function normalizeLabel(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return requireText(normalized, "label", 64);
}

export function closeOpenBlock(
  state: TaskAuthorityGlobalState,
  actorId: string,
  occurredAt: string,
  resolution: string | null,
): void {
  if (!state.openBlock) return;
  const closed: TaskBlock = {
    ...state.openBlock,
    clearedAt: occurredAt,
    clearedBy: actorId,
    resolution,
  };
  state.blockHistory = [...state.blockHistory, closed];
  state.openBlock = null;
}
