/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  CreateReviewInput,
  Decision,
  DeliveryEvidence,
  DeliveryStatus,
  EffectKind,
  EffectReservation,
  InvalidateReviewInput,
  Proposal,
  ProposalInput,
  RecordDecisionInput,
  RecordDeliveryInput,
  ReserveEffectInput,
  ReviewIntentState,
  ReviewState,
  TargetRevision,
  TargetRevisionInput,
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

export const DeliveryStatusSchema = z.enum([
  "ACCEPTED",
  "DELIVERED",
  "FAILED",
  "UNCERTAIN",
]);

export const EffectKindSchema = z.enum([
  "DOCUMENT_CHANGE",
  "PREPARE_MESSAGE",
  "SEND_MESSAGE",
]);

export const ReviewStateSchema = z.enum([
  "APPROVED",
  "INVALIDATED",
  "PROPOSED",
  "REJECTED",
]);

export function CreateReviewInputSchema(): z.ZodObject<
  Properties<CreateReviewInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    instanceId: z.string(),
    occurredAt: z.iso.datetime(),
    proposal: z.lazy(() => ProposalInputSchema()),
    reviewId: z.string(),
    scopeRef: z.string(),
  });
}

export function DecisionSchema(): z.ZodObject<Properties<Decision>> {
  return z.object({
    __typename: z.literal("Decision").optional(),
    actorId: z.string(),
    approved: z.boolean(),
    occurredAt: z.iso.datetime(),
    proposalHash: z.string(),
    proposalVersion: z.number(),
    reason: z.string().nullish(),
  });
}

export function DeliveryEvidenceSchema(): z.ZodObject<
  Properties<DeliveryEvidence>
> {
  return z.object({
    __typename: z.literal("DeliveryEvidence").optional(),
    id: z.string(),
    occurredAt: z.iso.datetime(),
    providerRef: z.string(),
    receiptRef: z.string(),
    status: DeliveryStatusSchema,
  });
}

export function EffectReservationSchema(): z.ZodObject<
  Properties<EffectReservation>
> {
  return z.object({
    __typename: z.literal("EffectReservation").optional(),
    dispatchRef: z.string(),
    occurredAt: z.iso.datetime(),
    operationId: z.string(),
    outboxRef: z.string(),
  });
}

export function InvalidateReviewInputSchema(): z.ZodObject<
  Properties<InvalidateReviewInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    reason: z.string(),
  });
}

export function ProposalSchema(): z.ZodObject<Properties<Proposal>> {
  return z.object({
    __typename: z.literal("Proposal").optional(),
    action: z.string(),
    artifactHash: z.string(),
    contentHash: z.string(),
    contentRef: z.string(),
    contentVersion: z.number(),
    effectKind: EffectKindSchema,
    recipients: z.array(z.string()),
    senderConnectionRef: z.string().nullish(),
    targets: z.array(z.lazy(() => TargetRevisionSchema())),
    version: z.number(),
  });
}

export function ProposalInputSchema(): z.ZodObject<Properties<ProposalInput>> {
  return z.object({
    action: z.string(),
    artifactHash: z.string(),
    contentHash: z.string(),
    contentRef: z.string(),
    contentVersion: z.number(),
    effectKind: EffectKindSchema,
    recipients: z.array(z.string()),
    senderConnectionRef: z.string().nullish(),
    targets: z.array(z.lazy(() => TargetRevisionInputSchema())),
    version: z.number(),
  });
}

export function RecordDecisionInputSchema(): z.ZodObject<
  Properties<RecordDecisionInput>
> {
  return z.object({
    actorId: z.string(),
    approved: z.boolean(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    proposalHash: z.string(),
    proposalVersion: z.number(),
    reason: z.string().nullish(),
  });
}

export function RecordDeliveryInputSchema(): z.ZodObject<
  Properties<RecordDeliveryInput>
> {
  return z.object({
    actorId: z.string(),
    evidenceId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    operationId: z.string(),
    providerRef: z.string(),
    receiptRef: z.string(),
    status: DeliveryStatusSchema,
  });
}

export function ReserveEffectInputSchema(): z.ZodObject<
  Properties<ReserveEffectInput>
> {
  return z.object({
    actorId: z.string(),
    dispatchRef: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    operationId: z.string(),
    outboxRef: z.string(),
    proposalHash: z.string(),
    proposalVersion: z.number(),
  });
}

export function ReviewIntentStateSchema(): z.ZodObject<
  Properties<ReviewIntentState>
> {
  return z.object({
    __typename: z.literal("ReviewIntentState").optional(),
    createdAt: z.iso.datetime().nullish(),
    decision: z.lazy(() => DecisionSchema().nullish()),
    delivery: z.array(z.lazy(() => DeliveryEvidenceSchema())),
    effect: z.lazy(() => EffectReservationSchema().nullish()),
    instanceId: z.string().nullish(),
    invalidatedReason: z.string().nullish(),
    ownerId: z.string().nullish(),
    proposal: z.lazy(() => ProposalSchema().nullish()),
    reviewId: z.string().nullish(),
    revision: z.number(),
    scopeRef: z.string().nullish(),
    status: ReviewStateSchema,
    updatedAt: z.iso.datetime().nullish(),
  });
}

export function TargetRevisionSchema(): z.ZodObject<
  Properties<TargetRevision>
> {
  return z.object({
    __typename: z.literal("TargetRevision").optional(),
    contentHash: z.string(),
    documentRef: z.string(),
    revision: z.number(),
  });
}

export function TargetRevisionInputSchema(): z.ZodObject<
  Properties<TargetRevisionInput>
> {
  return z.object({
    contentHash: z.string(),
    documentRef: z.string(),
    revision: z.number(),
  });
}
