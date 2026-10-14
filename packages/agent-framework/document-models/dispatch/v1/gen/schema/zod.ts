/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  AcceptDispatchInput,
  CreateDispatchInput,
  DispatchAcceptance,
  DispatchAgentRef,
  DispatchAgentRefInput,
  DispatchOffer,
  DispatchOfferInput,
  DispatchPhase,
  DispatchResultRef,
  DispatchSourceRef,
  DispatchSourceRefInput,
  DispatchState,
  DispatchTaskRef,
  DispatchTaskRefInput,
  RecordDispatchResultInput,
  RequestDispatchCancelInput,
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

export const DispatchPhaseSchema = z.enum([
  "ACCEPTED",
  "CANCEL_REQUESTED",
  "OFFERED",
  "RESULT_RECORDED",
]);

export function AcceptDispatchInputSchema(): z.ZodObject<
  Properties<AcceptDispatchInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    inputHash: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function CreateDispatchInputSchema(): z.ZodObject<
  Properties<CreateDispatchInput>
> {
  return z.object({
    actorId: z.string(),
    dispatchId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    offer: z.lazy(() => DispatchOfferInputSchema()),
    ownerId: z.string(),
  });
}

export function DispatchAcceptanceSchema(): z.ZodObject<
  Properties<DispatchAcceptance>
> {
  return z.object({
    __typename: z.literal("DispatchAcceptance").optional(),
    actorId: z.string(),
    inputHash: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function DispatchAgentRefSchema(): z.ZodObject<
  Properties<DispatchAgentRef>
> {
  return z.object({
    __typename: z.literal("DispatchAgentRef").optional(),
    definitionHash: z.string(),
    definitionId: z.string(),
    definitionVersion: z.string(),
    instanceId: z.string(),
  });
}

export function DispatchAgentRefInputSchema(): z.ZodObject<
  Properties<DispatchAgentRefInput>
> {
  return z.object({
    definitionHash: z.string(),
    definitionId: z.string(),
    definitionVersion: z.string(),
    instanceId: z.string(),
  });
}

export function DispatchOfferSchema(): z.ZodObject<Properties<DispatchOffer>> {
  return z.object({
    __typename: z.literal("DispatchOffer").optional(),
    contentHash: z.string(),
    continuationOfRef: z.string().nullish(),
    expiresAt: z.iso.datetime(),
    instructions: z.string(),
    instructionsHash: z.string(),
    originalRequesterId: z.string(),
    parentContentHash: z.string().nullish(),
    parentDispatchRef: z.string().nullish(),
    permissionRef: z.string(),
    recipient: z.lazy(() => DispatchAgentRefSchema()),
    scopeRef: z.string(),
    senderAgent: z.lazy(() => DispatchAgentRefSchema().nullish()),
    senderId: z.string(),
    sources: z.array(z.lazy(() => DispatchSourceRefSchema())),
    task: z.lazy(() => DispatchTaskRefSchema()),
  });
}

export function DispatchOfferInputSchema(): z.ZodObject<
  Properties<DispatchOfferInput>
> {
  return z.object({
    contentHash: z.string(),
    continuationOfRef: z.string().nullish(),
    expiresAt: z.iso.datetime(),
    instructions: z.string(),
    instructionsHash: z.string(),
    originalRequesterId: z.string(),
    parentContentHash: z.string().nullish(),
    parentDispatchRef: z.string().nullish(),
    permissionRef: z.string(),
    recipient: z.lazy(() => DispatchAgentRefInputSchema()),
    scopeRef: z.string(),
    senderAgent: z.lazy(() => DispatchAgentRefInputSchema().nullish()),
    senderId: z.string(),
    sources: z.array(z.lazy(() => DispatchSourceRefInputSchema())),
    task: z.lazy(() => DispatchTaskRefInputSchema()),
  });
}

export function DispatchResultRefSchema(): z.ZodObject<
  Properties<DispatchResultRef>
> {
  return z.object({
    __typename: z.literal("DispatchResultRef").optional(),
    contentHash: z.string(),
    contentVersion: z.number(),
    occurredAt: z.iso.datetime(),
    reportId: z.string(),
    verificationRef: z.string(),
  });
}

export function DispatchSourceRefSchema(): z.ZodObject<
  Properties<DispatchSourceRef>
> {
  return z.object({
    __typename: z.literal("DispatchSourceRef").optional(),
    contentHash: z.string(),
    contentVersion: z.number(),
    documentRef: z.string(),
    documentType: z.string(),
  });
}

export function DispatchSourceRefInputSchema(): z.ZodObject<
  Properties<DispatchSourceRefInput>
> {
  return z.object({
    contentHash: z.string(),
    contentVersion: z.number(),
    documentRef: z.string(),
    documentType: z.string(),
  });
}

export function DispatchStateSchema(): z.ZodObject<Properties<DispatchState>> {
  return z.object({
    __typename: z.literal("DispatchState").optional(),
    acceptance: z.lazy(() => DispatchAcceptanceSchema().nullish()),
    cancellationReason: z.string().nullish(),
    createdAt: z.iso.datetime().nullish(),
    dispatchId: z.string().nullish(),
    offer: z.lazy(() => DispatchOfferSchema().nullish()),
    ownerId: z.string().nullish(),
    phase: DispatchPhaseSchema,
    result: z.lazy(() => DispatchResultRefSchema().nullish()),
    revision: z.number(),
    scopeRef: z.string().nullish(),
    updatedAt: z.iso.datetime().nullish(),
  });
}

export function DispatchTaskRefSchema(): z.ZodObject<
  Properties<DispatchTaskRef>
> {
  return z.object({
    __typename: z.literal("DispatchTaskRef").optional(),
    authorityRef: z.string(),
    commitmentHash: z.string(),
    taskRef: z.string(),
  });
}

export function DispatchTaskRefInputSchema(): z.ZodObject<
  Properties<DispatchTaskRefInput>
> {
  return z.object({
    authorityRef: z.string(),
    commitmentHash: z.string(),
    taskRef: z.string(),
  });
}

export function RecordDispatchResultInputSchema(): z.ZodObject<
  Properties<RecordDispatchResultInput>
> {
  return z.object({
    actorId: z.string(),
    contentHash: z.string(),
    contentVersion: z.number(),
    expectedRevision: z.number(),
    inputHash: z.string(),
    occurredAt: z.iso.datetime(),
    reportId: z.string(),
    verificationRef: z.string(),
  });
}

export function RequestDispatchCancelInputSchema(): z.ZodObject<
  Properties<RequestDispatchCancelInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    reason: z.string(),
  });
}
