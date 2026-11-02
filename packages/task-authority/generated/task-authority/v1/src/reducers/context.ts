import type { TaskAuthorityContextOperations } from "document-models/task-authority/v1";
import {
  assertNotArchived,
  boundedText,
  mutationMetadata,
  normalizeLabel,
  optionalText,
  requireText,
  touch,
} from "../utils.js";

export const taskAuthorityContextOperations: TaskAuthorityContextOperations = {
  addLabelOperation(state, action) {
    assertNotArchived(state);
    const label = normalizeLabel(action.input.label);
    mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (state.labels.includes(label)) return;
    if (state.labels.length >= 100) throw new Error("labels: maximum count is 100");
    state.labels = [...state.labels, label];
    touch(state, action.input.actorId, action.input.occurredAt);
  },
  removeLabelOperation(state, action) {
    assertNotArchived(state);
    const label = normalizeLabel(action.input.label);
    mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (!state.labels.includes(label)) return;
    state.labels = state.labels.filter((candidate) => candidate !== label);
    touch(state, action.input.actorId, action.input.occurredAt);
  },
  addCommentOperation(state, action) {
    assertNotArchived(state);
    const id = requireText(action.input.id, "comment.id", 500);
    const metadata = mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (state.comments.some((comment) => comment.id === id)) return;
    if (state.comments.length >= 10_000) throw new Error("comments: maximum count is 10000");
    state.comments = [...state.comments, {
      id,
      bodyMarkdown: requireText(action.input.bodyMarkdown, "comment.bodyMarkdown", 100_000),
      addedAt: metadata.occurredAt,
      addedBy: metadata.actorId,
    }];
    touch(state, metadata.actorId, metadata.occurredAt);
  },
  addDependencyOperation(state, action) {
    assertNotArchived(state);
    const taskId = requireText(action.input.taskId, "dependency.taskId", 500);
    mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (taskId === state.id) throw new Error("ADD_DEPENDENCY: task cannot depend on itself");
    if (state.dependsOn.includes(taskId)) return;
    if (state.dependsOn.length >= 1_000) throw new Error("dependsOn: maximum count is 1000");
    state.dependsOn = [...state.dependsOn, taskId];
    touch(state, action.input.actorId, action.input.occurredAt);
  },
  removeDependencyOperation(state, action) {
    assertNotArchived(state);
    const taskId = requireText(action.input.taskId, "dependency.taskId", 500);
    mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (!state.dependsOn.includes(taskId)) return;
    state.dependsOn = state.dependsOn.filter((candidate) => candidate !== taskId);
    touch(state, action.input.actorId, action.input.occurredAt);
  },
  addExternalRefOperation(state, action) {
    assertNotArchived(state);
    const id = requireText(action.input.id, "externalRef.id", 500);
    const metadata = mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (state.externalRefs.some((ref) => ref.id === id)) return;
    if (state.externalRefs.length >= 1_000) throw new Error("externalRefs: maximum count is 1000");
    state.externalRefs = [...state.externalRefs, {
      id,
      authority: requireText(action.input.authority, "externalRef.authority", 200),
      opaqueId: requireText(action.input.opaqueId, "externalRef.opaqueId", 2_000),
      deepLink: optionalText(action.input.deepLink, "externalRef.deepLink", 4_000),
      addedAt: metadata.occurredAt,
      addedBy: metadata.actorId,
    }];
    touch(state, metadata.actorId, metadata.occurredAt);
  },
  removeExternalRefOperation(state, action) {
    assertNotArchived(state);
    const id = requireText(action.input.id, "externalRef.id", 500);
    mutationMetadata(action.input.actorId, action.input.occurredAt);
    if (!state.externalRefs.some((ref) => ref.id === id)) return;
    state.externalRefs = state.externalRefs.filter((ref) => ref.id !== id);
    touch(state, action.input.actorId, action.input.occurredAt);
  },
};
