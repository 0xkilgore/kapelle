/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  AddCommentInput,
  AddDependencyInput,
  AddExternalRefInput,
  AddLabelInput,
  ArchiveTaskInput,
  BlockTaskInput,
  CompleteTaskInput,
  CreateTaskInput,
  RemoveDependencyInput,
  RemoveExternalRefInput,
  RemoveLabelInput,
  ReopenTaskInput,
  SetAssigneeInput,
  SetDueInput,
  SetPriorityInput,
  SetProjectInput,
  SnoozeTaskInput,
  TaskAuthorityState,
  TaskBlock,
  TaskComment,
  TaskExternalRef,
  TaskPriority,
  TaskSource,
  TaskStatus,
  UnblockTaskInput,
  UnsnoozeTaskInput,
  UpdateBodyInput,
  UpdateTitleInput,
} from "./types.js";

type Properties<T> = Required<{
  [K in keyof T]: z.ZodType<T[K]>;
}>;

type definedNonNullAny = {};

export const isDefinedNonNullAny = (v: any): v is definedNonNullAny =>
  v !== undefined && v !== null;

export const definedNonNullAnySchema = z
  .any()
  .refine((v) => isDefinedNonNullAny(v));

export const TaskPrioritySchema = z.enum(["HIGH", "LOW", "MED"]);

export const TaskSourceSchema = z.enum([
  "AGENT",
  "CLI",
  "HUMAN",
  "MIGRATION",
  "PERSONAL_CRM",
]);

export const TaskStatusSchema = z.enum([
  "ARCHIVED",
  "BLOCKED",
  "DONE",
  "OPEN",
  "SNOOZED",
]);

export function AddCommentInputSchema(): z.ZodObject<
  Properties<AddCommentInput>
> {
  return z.object({
    actorId: z.string(),
    bodyMarkdown: z.string(),
    id: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function AddDependencyInputSchema(): z.ZodObject<
  Properties<AddDependencyInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
    taskId: z.string(),
  });
}

export function AddExternalRefInputSchema(): z.ZodObject<
  Properties<AddExternalRefInput>
> {
  return z.object({
    actorId: z.string(),
    authority: z.string(),
    deepLink: z.string().nullish(),
    id: z.string(),
    occurredAt: z.iso.datetime(),
    opaqueId: z.string(),
  });
}

export function AddLabelInputSchema(): z.ZodObject<Properties<AddLabelInput>> {
  return z.object({
    actorId: z.string(),
    label: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function ArchiveTaskInputSchema(): z.ZodObject<
  Properties<ArchiveTaskInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
    reason: z.string().nullish(),
  });
}

export function BlockTaskInputSchema(): z.ZodObject<
  Properties<BlockTaskInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
    reason: z.string(),
  });
}

export function CompleteTaskInputSchema(): z.ZodObject<
  Properties<CompleteTaskInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
    resolution: z.string().nullish(),
  });
}

export function CreateTaskInputSchema(): z.ZodObject<
  Properties<CreateTaskInput>
> {
  return z.object({
    actorId: z.string(),
    assigneeId: z.string().nullish(),
    bodyMarkdown: z.string().nullish(),
    dueAt: z.iso.datetime().nullish(),
    id: z.string(),
    labels: z.array(z.string()).nullish(),
    occurredAt: z.iso.datetime(),
    ownerId: z.string(),
    priority: TaskPrioritySchema.nullish(),
    projectId: z.string().nullish(),
    source: TaskSourceSchema,
    sourceRef: z.string().nullish(),
    title: z.string(),
  });
}

export function RemoveDependencyInputSchema(): z.ZodObject<
  Properties<RemoveDependencyInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
    taskId: z.string(),
  });
}

export function RemoveExternalRefInputSchema(): z.ZodObject<
  Properties<RemoveExternalRefInput>
> {
  return z.object({
    actorId: z.string(),
    id: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function RemoveLabelInputSchema(): z.ZodObject<
  Properties<RemoveLabelInput>
> {
  return z.object({
    actorId: z.string(),
    label: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function ReopenTaskInputSchema(): z.ZodObject<
  Properties<ReopenTaskInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
    reason: z.string().nullish(),
  });
}

export function SetAssigneeInputSchema(): z.ZodObject<
  Properties<SetAssigneeInput>
> {
  return z.object({
    actorId: z.string(),
    assigneeId: z.string().nullish(),
    occurredAt: z.iso.datetime(),
  });
}

export function SetDueInputSchema(): z.ZodObject<Properties<SetDueInput>> {
  return z.object({
    actorId: z.string(),
    dueAt: z.iso.datetime().nullish(),
    occurredAt: z.iso.datetime(),
  });
}

export function SetPriorityInputSchema(): z.ZodObject<
  Properties<SetPriorityInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
    priority: TaskPrioritySchema.nullish(),
  });
}

export function SetProjectInputSchema(): z.ZodObject<
  Properties<SetProjectInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
    projectId: z.string().nullish(),
  });
}

export function SnoozeTaskInputSchema(): z.ZodObject<
  Properties<SnoozeTaskInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
    reason: z.string().nullish(),
    snoozedUntil: z.iso.datetime(),
  });
}

export function TaskAuthorityStateSchema(): z.ZodObject<
  Properties<TaskAuthorityState>
> {
  return z.object({
    __typename: z.literal("TaskAuthorityState").optional(),
    archivedAt: z.iso.datetime().nullish(),
    assigneeId: z.string().nullish(),
    blockHistory: z.array(z.lazy(() => TaskBlockSchema())),
    bodyMarkdown: z.string(),
    comments: z.array(z.lazy(() => TaskCommentSchema())),
    completedAt: z.iso.datetime().nullish(),
    createdAt: z.iso.datetime().nullish(),
    createdBy: z.string(),
    dependsOn: z.array(z.string()),
    dueAt: z.iso.datetime().nullish(),
    externalRefs: z.array(z.lazy(() => TaskExternalRefSchema())),
    id: z.string().nullish(),
    labels: z.array(z.string()),
    openBlock: z.lazy(() => TaskBlockSchema().nullish()),
    ownerId: z.string(),
    priority: TaskPrioritySchema.nullish(),
    projectId: z.string().nullish(),
    schemaVersion: z.number(),
    snoozedUntil: z.iso.datetime().nullish(),
    source: TaskSourceSchema,
    sourceRef: z.string().nullish(),
    status: TaskStatusSchema,
    title: z.string(),
    updatedAt: z.iso.datetime().nullish(),
    updatedBy: z.string(),
  });
}

export function TaskBlockSchema(): z.ZodObject<Properties<TaskBlock>> {
  return z.object({
    __typename: z.literal("TaskBlock").optional(),
    clearedAt: z.iso.datetime().nullish(),
    clearedBy: z.string().nullish(),
    reason: z.string(),
    resolution: z.string().nullish(),
    setAt: z.iso.datetime(),
    setBy: z.string(),
  });
}

export function TaskCommentSchema(): z.ZodObject<Properties<TaskComment>> {
  return z.object({
    __typename: z.literal("TaskComment").optional(),
    addedAt: z.iso.datetime(),
    addedBy: z.string(),
    bodyMarkdown: z.string(),
    id: z.string(),
  });
}

export function TaskExternalRefSchema(): z.ZodObject<
  Properties<TaskExternalRef>
> {
  return z.object({
    __typename: z.literal("TaskExternalRef").optional(),
    addedAt: z.iso.datetime(),
    addedBy: z.string(),
    authority: z.string(),
    deepLink: z.string().nullish(),
    id: z.string(),
    opaqueId: z.string(),
  });
}

export function UnblockTaskInputSchema(): z.ZodObject<
  Properties<UnblockTaskInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
    resolution: z.string().nullish(),
  });
}

export function UnsnoozeTaskInputSchema(): z.ZodObject<
  Properties<UnsnoozeTaskInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function UpdateBodyInputSchema(): z.ZodObject<
  Properties<UpdateBodyInput>
> {
  return z.object({
    actorId: z.string(),
    bodyMarkdown: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function UpdateTitleInputSchema(): z.ZodObject<
  Properties<UpdateTitleInput>
> {
  return z.object({
    actorId: z.string(),
    occurredAt: z.iso.datetime(),
    title: z.string(),
  });
}
