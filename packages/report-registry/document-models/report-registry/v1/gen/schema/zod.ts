/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  AddFeedbackInput,
  DismissAttentionInput,
  MarkFeedbackRouteFailedInput,
  MarkFeedbackRoutedInput,
  MarkOpenedInput,
  MarkReadInput,
  MarkUnreadInput,
  PublishReportInput,
  RegisterReportInput,
  ReportAgentSnapshot,
  ReportAgentSnapshotInput,
  ReportAttentionRequest,
  ReportAttentionResolution,
  ReportAttentionState,
  ReportContentDescriptor,
  ReportContentDescriptorInput,
  ReportContentStorage,
  ReportFeedback,
  ReportFeedbackRoute,
  ReportFeedbackRouteStatus,
  ReportLifecycle,
  ReportProducer,
  ReportProducerInput,
  ReportProducerKind,
  ReportPublication,
  ReportPublicationInput,
  ReportRegistryState,
  ReportReviewState,
  RequestReviewInput,
  ResolveAttentionInput,
  SupersedeReportInput,
  WithdrawReportInput,
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

export const ReportAttentionRequestSchema = z.enum([
  "ANSWER",
  "APPROVE",
  "DECIDE",
  "NONE",
  "READ",
  "REQUEST_CHANGE",
]);

export const ReportAttentionResolutionSchema = z.enum([
  "DISMISSED",
  "READ",
  "RESOLVED",
]);

export const ReportContentStorageSchema = z.enum(["BLOB", "INLINE_MARKDOWN"]);

export const ReportFeedbackRouteStatusSchema = z.enum([
  "FAILED",
  "ROUTED",
  "UNROUTED",
]);

export const ReportLifecycleSchema = z.enum([
  "DRAFT",
  "FINAL",
  "SUPERSEDED",
  "WITHDRAWN",
]);

export const ReportProducerKindSchema = z.enum([
  "AGENT",
  "HUMAN",
  "IMPORT",
  "SERVICE",
]);

export function AddFeedbackInputSchema(): z.ZodObject<
  Properties<AddFeedbackInput>
> {
  return z.object({
    actorId: z.string(),
    bodyMarkdown: z.string(),
    expectedRevision: z.number(),
    feedbackId: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function DismissAttentionInputSchema(): z.ZodObject<
  Properties<DismissAttentionInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function MarkFeedbackRouteFailedInputSchema(): z.ZodObject<
  Properties<MarkFeedbackRouteFailedInput>
> {
  return z.object({
    actorId: z.string(),
    error: z.string(),
    expectedRevision: z.number(),
    feedbackId: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function MarkFeedbackRoutedInputSchema(): z.ZodObject<
  Properties<MarkFeedbackRoutedInput>
> {
  return z.object({
    actorId: z.string(),
    destination: z.string(),
    expectedRevision: z.number(),
    feedbackId: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function MarkOpenedInputSchema(): z.ZodObject<
  Properties<MarkOpenedInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function MarkReadInputSchema(): z.ZodObject<Properties<MarkReadInput>> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function MarkUnreadInputSchema(): z.ZodObject<
  Properties<MarkUnreadInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function PublishReportInputSchema(): z.ZodObject<
  Properties<PublishReportInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function RegisterReportInputSchema(): z.ZodObject<
  Properties<RegisterReportInput>
> {
  return z.object({
    actorId: z.string(),
    content: z.lazy(() => ReportContentDescriptorInputSchema()),
    familyRef: z.string().nullish(),
    id: z.string(),
    lifecycle: ReportLifecycleSchema.nullish(),
    occurredAt: z.iso.datetime(),
    producer: z.lazy(() => ReportProducerInputSchema()),
    projectRef: z.string().nullish(),
    publication: z.lazy(() => ReportPublicationInputSchema().nullish()),
    reportRef: z.string(),
    sourceRef: z.string().nullish(),
    title: z.string(),
  });
}

export function ReportAgentSnapshotSchema(): z.ZodObject<
  Properties<ReportAgentSnapshot>
> {
  return z.object({
    __typename: z.literal("ReportAgentSnapshot").optional(),
    definitionHash: z.string().nullish(),
    definitionId: z.string().nullish(),
    definitionVersion: z.string().nullish(),
    id: z.string(),
    instanceId: z.string().nullish(),
    label: z.string(),
  });
}

export function ReportAgentSnapshotInputSchema(): z.ZodObject<
  Properties<ReportAgentSnapshotInput>
> {
  return z.object({
    definitionHash: z.string().nullish(),
    definitionId: z.string().nullish(),
    definitionVersion: z.string().nullish(),
    id: z.string(),
    instanceId: z.string().nullish(),
    label: z.string(),
  });
}

export function ReportAttentionStateSchema(): z.ZodObject<
  Properties<ReportAttentionState>
> {
  return z.object({
    __typename: z.literal("ReportAttentionState").optional(),
    expiresAt: z.iso.datetime().nullish(),
    reason: z.string().nullish(),
    reasonCode: z.string().nullish(),
    request: ReportAttentionRequestSchema,
    requestedAt: z.iso.datetime().nullish(),
    requestedBy: z.string().nullish(),
    resolution: ReportAttentionResolutionSchema.nullish(),
    resolvedAt: z.iso.datetime().nullish(),
    reviewBy: z.iso.datetime().nullish(),
  });
}

export function ReportContentDescriptorSchema(): z.ZodObject<
  Properties<ReportContentDescriptor>
> {
  return z.object({
    __typename: z.literal("ReportContentDescriptor").optional(),
    blobRef: z.string().nullish(),
    byteSize: z.number(),
    contentHash: z.string(),
    filename: z.string().nullish(),
    markdown: z.string().nullish(),
    mimeType: z.string(),
    storage: ReportContentStorageSchema,
  });
}

export function ReportContentDescriptorInputSchema(): z.ZodObject<
  Properties<ReportContentDescriptorInput>
> {
  return z.object({
    blobRef: z.string().nullish(),
    byteSize: z.number(),
    contentHash: z.string(),
    filename: z.string().nullish(),
    markdown: z.string().nullish(),
    mimeType: z.string(),
    storage: ReportContentStorageSchema,
  });
}

export function ReportFeedbackSchema(): z.ZodObject<
  Properties<ReportFeedback>
> {
  return z.object({
    __typename: z.literal("ReportFeedback").optional(),
    actorId: z.string(),
    bodyMarkdown: z.string(),
    createdAt: z.iso.datetime(),
    id: z.string(),
    route: z.lazy(() => ReportFeedbackRouteSchema()),
  });
}

export function ReportFeedbackRouteSchema(): z.ZodObject<
  Properties<ReportFeedbackRoute>
> {
  return z.object({
    __typename: z.literal("ReportFeedbackRoute").optional(),
    destination: z.string().nullish(),
    error: z.string().nullish(),
    routedAt: z.iso.datetime().nullish(),
    status: ReportFeedbackRouteStatusSchema,
  });
}

export function ReportProducerSchema(): z.ZodObject<
  Properties<ReportProducer>
> {
  return z.object({
    __typename: z.literal("ReportProducer").optional(),
    id: z.string(),
    kind: ReportProducerKindSchema,
    label: z.string().nullish(),
  });
}

export function ReportProducerInputSchema(): z.ZodObject<
  Properties<ReportProducerInput>
> {
  return z.object({
    id: z.string(),
    kind: ReportProducerKindSchema,
    label: z.string().nullish(),
  });
}

export function ReportPublicationSchema(): z.ZodObject<
  Properties<ReportPublication>
> {
  return z.object({
    __typename: z.literal("ReportPublication").optional(),
    author: z.lazy(() => ReportAgentSnapshotSchema()),
    authorizationRef: z.string(),
    contentHash: z.string(),
    contentVersion: z.number(),
    provenanceRef: z.string(),
    publicationId: z.string(),
    publishedAt: z.iso.datetime(),
    publisher: z.lazy(() => ReportAgentSnapshotSchema()),
    runRef: z.string(),
    sourceRef: z.string(),
  });
}

export function ReportPublicationInputSchema(): z.ZodObject<
  Properties<ReportPublicationInput>
> {
  return z.object({
    author: z.lazy(() => ReportAgentSnapshotInputSchema()),
    authorizationRef: z.string(),
    contentHash: z.string(),
    contentVersion: z.number(),
    provenanceRef: z.string(),
    publicationId: z.string(),
    publishedAt: z.iso.datetime(),
    publisher: z.lazy(() => ReportAgentSnapshotInputSchema()),
    runRef: z.string(),
    sourceRef: z.string(),
  });
}

export function ReportRegistryStateSchema(): z.ZodObject<
  Properties<ReportRegistryState>
> {
  return z.object({
    __typename: z.literal("ReportRegistryState").optional(),
    attention: z.lazy(() => ReportAttentionStateSchema()),
    content: z.lazy(() => ReportContentDescriptorSchema().nullish()),
    createdAt: z.iso.datetime().nullish(),
    createdBy: z.string(),
    familyRef: z.string().nullish(),
    id: z.string().nullish(),
    lifecycle: ReportLifecycleSchema,
    producer: z.lazy(() => ReportProducerSchema().nullish()),
    projectRef: z.string().nullish(),
    publication: z.lazy(() => ReportPublicationSchema().nullish()),
    reportRef: z.string(),
    review: z.lazy(() => ReportReviewStateSchema()),
    revision: z.number(),
    schemaVersion: z.number(),
    sourceRef: z.string().nullish(),
    supersededByRef: z.string().nullish(),
    supersedesRef: z.string().nullish(),
    title: z.string(),
    updatedAt: z.iso.datetime().nullish(),
    updatedBy: z.string(),
  });
}

export function ReportReviewStateSchema(): z.ZodObject<
  Properties<ReportReviewState>
> {
  return z.object({
    __typename: z.literal("ReportReviewState").optional(),
    feedback: z.array(z.lazy(() => ReportFeedbackSchema())),
    openedAt: z.iso.datetime().nullish(),
    readAt: z.iso.datetime().nullish(),
  });
}

export function RequestReviewInputSchema(): z.ZodObject<
  Properties<RequestReviewInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    expiresAt: z.iso.datetime().nullish(),
    occurredAt: z.iso.datetime(),
    reason: z.string().nullish(),
    reasonCode: z.string().nullish(),
    request: ReportAttentionRequestSchema,
    reviewBy: z.iso.datetime().nullish(),
  });
}

export function ResolveAttentionInputSchema(): z.ZodObject<
  Properties<ResolveAttentionInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function SupersedeReportInputSchema(): z.ZodObject<
  Properties<SupersedeReportInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    supersededByRef: z.string(),
  });
}

export function WithdrawReportInputSchema(): z.ZodObject<
  Properties<WithdrawReportInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    reason: z.string().nullish(),
  });
}
