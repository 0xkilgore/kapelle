import type { TaskAuthorityContentOperations } from "document-models/task-authority/v1";
import {
  assertNotArchived,
  assertUtc,
  boundedText,
  mutationMetadata,
  normalizeLabel,
  optionalText,
  requireText,
  touch,
} from "../utils.js";

export const taskAuthorityContentOperations: TaskAuthorityContentOperations = {
  createTaskOperation(state, action) {
    if (state.id) throw new Error("CREATE_TASK: task already created");
    const input = action.input;
    const metadata = mutationMetadata(input.actorId, input.occurredAt);
    const id = requireText(input.id, "id", 500);
    const ownerId = requireText(input.ownerId, "ownerId", 500);
    const dueAt = input.dueAt == null ? null : assertUtc(input.dueAt, "dueAt");
    const labels = Array.from(
      new Set((input.labels ?? []).map((label) => normalizeLabel(label))),
    );
    if (labels.length > 100) throw new Error("labels: maximum count is 100");

    Object.assign(state, {
      id,
      schemaVersion: 1,
      title: requireText(input.title, "title", 500),
      bodyMarkdown: boundedText(input.bodyMarkdown, "bodyMarkdown", 100_000),
      status: "OPEN" as const,
      priority: input.priority ?? null,
      projectId: optionalText(input.projectId, "projectId", 500),
      labels,
      ownerId,
      assigneeId: optionalText(input.assigneeId, "assigneeId", 500),
      dueAt,
      snoozedUntil: null,
      createdAt: metadata.occurredAt,
      updatedAt: metadata.occurredAt,
      completedAt: null,
      archivedAt: null,
      openBlock: null,
      blockHistory: [],
      comments: [],
      dependsOn: [],
      externalRefs: [],
      source: input.source,
      sourceRef: optionalText(input.sourceRef, "sourceRef", 1_000),
      createdBy: metadata.actorId,
      updatedBy: metadata.actorId,
    });
  },
  updateTitleOperation(state, action) {
    assertNotArchived(state);
    const next = requireText(action.input.title, "title", 500);
    mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (state.title === next) return;
    state.title = next;
    touch(state, action.input.actorId, action.input.occurredAt);
  },
  updateBodyOperation(state, action) {
    assertNotArchived(state);
    const next = boundedText(action.input.bodyMarkdown, "bodyMarkdown", 100_000);
    mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (state.bodyMarkdown === next) return;
    state.bodyMarkdown = next;
    touch(state, action.input.actorId, action.input.occurredAt);
  },
  setProjectOperation(state, action) {
    assertNotArchived(state);
    const next = optionalText(action.input.projectId, "projectId", 500);
    mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (state.projectId === next) return;
    state.projectId = next;
    touch(state, action.input.actorId, action.input.occurredAt);
  },
  setDueOperation(state, action) {
    assertNotArchived(state);
    const next = action.input.dueAt == null
      ? null
      : assertUtc(action.input.dueAt, "dueAt");
    mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (state.dueAt === next) return;
    state.dueAt = next;
    touch(state, action.input.actorId, action.input.occurredAt);
  },
  setPriorityOperation(state, action) {
    assertNotArchived(state);
    const next = action.input.priority ?? null;
    mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (state.priority === next) return;
    state.priority = next;
    touch(state, action.input.actorId, action.input.occurredAt);
  },
  setAssigneeOperation(state, action) {
    assertNotArchived(state);
    const next = optionalText(action.input.assigneeId, "assigneeId", 500);
    mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (state.assigneeId === next) return;
    state.assigneeId = next;
    touch(state, action.input.actorId, action.input.occurredAt);
  },
};
