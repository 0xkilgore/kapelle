/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  AgentInstanceState,
  BindConnectionInput,
  BindScheduleInput,
  CapabilityGrant,
  CapabilityGrantInput,
  CatchUpPolicy,
  ConnectionBinding,
  ConnectionBindingInput,
  ConnectionDirection,
  CreateInstanceInput,
  DesiredState,
  DisableSkillInput,
  DocumentAccess,
  DocumentLink,
  EnableSkillInput,
  EnabledSkill,
  GrantCapabilityInput,
  LinkDocumentInput,
  ModelPolicy,
  ModelPolicyInput,
  PinDefinitionVersionInput,
  RequestPauseInput,
  RequestResumeInput,
  RetireInstanceInput,
  ReviewPolicy,
  RevokeCapabilityInput,
  RevokeConnectionInput,
  ScheduleBinding,
  ScheduleBindingInput,
  SetModelPolicyInput,
  SetOperatingPolicyInput,
  SetResponsibilitiesInput,
  SetRuntimeBindingInput,
  SkillSource,
  UnbindScheduleInput,
  UnlinkDocumentInput,
  VersionedRef,
  VersionedRefInput,
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

export const CatchUpPolicySchema = z.enum(["COALESCE", "SKIP"]);

export const ConnectionDirectionSchema = z.enum(["PREPARE", "RECEIVE", "SEND"]);

export const DesiredStateSchema = z.enum(["PAUSED", "READY", "RETIRED"]);

export const DocumentAccessSchema = z.enum(["PRIVATE", "PUBLIC", "SHARED"]);

export const ReviewPolicySchema = z.enum(["ALWAYS", "WITHIN_GRANT"]);

export const SkillSourceSchema = z.enum(["BUILTIN", "MARKET", "USER"]);

export function AgentInstanceStateSchema(): z.ZodObject<
  Properties<AgentInstanceState>
> {
  return z.object({
    __typename: z.literal("AgentInstanceState").optional(),
    connections: z.array(z.lazy(() => ConnectionBindingSchema())),
    createdAt: z.iso.datetime().nullish(),
    definitionRef: z.lazy(() => VersionedRefSchema().nullish()),
    desiredState: DesiredStateSchema,
    documentLinks: z.array(z.lazy(() => DocumentLinkSchema())),
    grants: z.array(z.lazy(() => CapabilityGrantSchema())),
    instanceId: z.string().nullish(),
    modelPolicy: z.lazy(() => ModelPolicySchema().nullish()),
    name: z.string().nullish(),
    operatingPolicy: z.string().nullish(),
    ownerId: z.string().nullish(),
    responsibilities: z.array(z.string()),
    revision: z.number(),
    runtimeBindingRef: z.string().nullish(),
    schedules: z.array(z.lazy(() => ScheduleBindingSchema())),
    scopeRef: z.string().nullish(),
    skills: z.array(z.lazy(() => EnabledSkillSchema())),
    updatedAt: z.iso.datetime().nullish(),
  });
}

export function BindConnectionInputSchema(): z.ZodObject<
  Properties<BindConnectionInput>
> {
  return z.object({
    actorId: z.string(),
    binding: z.lazy(() => ConnectionBindingInputSchema()),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function BindScheduleInputSchema(): z.ZodObject<
  Properties<BindScheduleInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    schedule: z.lazy(() => ScheduleBindingInputSchema()),
  });
}

export function CapabilityGrantSchema(): z.ZodObject<
  Properties<CapabilityGrant>
> {
  return z.object({
    __typename: z.literal("CapabilityGrant").optional(),
    actions: z.array(z.string()),
    expiresAt: z.iso.datetime(),
    id: z.string(),
    principalId: z.string(),
    resourceRef: z.string(),
    reviewPolicy: ReviewPolicySchema,
    revokedAt: z.iso.datetime().nullish(),
  });
}

export function CapabilityGrantInputSchema(): z.ZodObject<
  Properties<CapabilityGrantInput>
> {
  return z.object({
    actions: z.array(z.string()),
    expiresAt: z.iso.datetime(),
    id: z.string(),
    principalId: z.string(),
    resourceRef: z.string(),
    reviewPolicy: ReviewPolicySchema,
  });
}

export function ConnectionBindingSchema(): z.ZodObject<
  Properties<ConnectionBinding>
> {
  return z.object({
    __typename: z.literal("ConnectionBinding").optional(),
    accountRef: z.string(),
    connectionRef: z.string(),
    directions: z.array(ConnectionDirectionSchema),
    id: z.string(),
    label: z.string(),
    revokedAt: z.iso.datetime().nullish(),
  });
}

export function ConnectionBindingInputSchema(): z.ZodObject<
  Properties<ConnectionBindingInput>
> {
  return z.object({
    accountRef: z.string(),
    connectionRef: z.string(),
    directions: z.array(ConnectionDirectionSchema),
    id: z.string(),
    label: z.string(),
  });
}

export function CreateInstanceInputSchema(): z.ZodObject<
  Properties<CreateInstanceInput>
> {
  return z.object({
    actorId: z.string(),
    definitionRef: z.lazy(() => VersionedRefInputSchema()),
    expectedRevision: z.number(),
    instanceId: z.string(),
    modelPolicy: z.lazy(() => ModelPolicyInputSchema()),
    name: z.string(),
    occurredAt: z.iso.datetime(),
    operatingPolicy: z.string(),
    responsibilities: z.array(z.string()),
    scopeRef: z.string(),
  });
}

export function DisableSkillInputSchema(): z.ZodObject<
  Properties<DisableSkillInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    skillId: z.string(),
  });
}

export function DocumentLinkSchema(): z.ZodObject<Properties<DocumentLink>> {
  return z.object({
    __typename: z.literal("DocumentLink").optional(),
    access: DocumentAccessSchema,
    documentRef: z.string(),
  });
}

export function EnableSkillInputSchema(): z.ZodObject<
  Properties<EnableSkillInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    ref: z.lazy(() => VersionedRefInputSchema()),
    source: SkillSourceSchema,
  });
}

export function EnabledSkillSchema(): z.ZodObject<Properties<EnabledSkill>> {
  return z.object({
    __typename: z.literal("EnabledSkill").optional(),
    ref: z.lazy(() => VersionedRefSchema()),
    source: SkillSourceSchema,
  });
}

export function GrantCapabilityInputSchema(): z.ZodObject<
  Properties<GrantCapabilityInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    grant: z.lazy(() => CapabilityGrantInputSchema()),
    occurredAt: z.iso.datetime(),
  });
}

export function LinkDocumentInputSchema(): z.ZodObject<
  Properties<LinkDocumentInput>
> {
  return z.object({
    access: DocumentAccessSchema,
    actorId: z.string(),
    documentRef: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function ModelPolicySchema(): z.ZodObject<Properties<ModelPolicy>> {
  return z.object({
    __typename: z.literal("ModelPolicy").optional(),
    budgetPolicyRef: z.string(),
    concurrencyLimit: z.number(),
    fallbackBudgetRef: z.string().nullish(),
    fallbackProvider: z.string().nullish(),
    fallbackScopeRef: z.string().nullish(),
    paidFallback: z.boolean(),
    preferredProfile: z.string(),
  });
}

export function ModelPolicyInputSchema(): z.ZodObject<
  Properties<ModelPolicyInput>
> {
  return z.object({
    budgetPolicyRef: z.string(),
    concurrencyLimit: z.number(),
    fallbackBudgetRef: z.string().nullish(),
    fallbackProvider: z.string().nullish(),
    fallbackScopeRef: z.string().nullish(),
    paidFallback: z.boolean(),
    preferredProfile: z.string(),
  });
}

export function PinDefinitionVersionInputSchema(): z.ZodObject<
  Properties<PinDefinitionVersionInput>
> {
  return z.object({
    actorId: z.string(),
    compatibilityFixtureRef: z.lazy(() => VersionedRefInputSchema()),
    definitionRef: z.lazy(() => VersionedRefInputSchema()),
    expectedRevision: z.number(),
    migrationRef: z.lazy(() => VersionedRefInputSchema()),
    occurredAt: z.iso.datetime(),
  });
}

export function RequestPauseInputSchema(): z.ZodObject<
  Properties<RequestPauseInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function RequestResumeInputSchema(): z.ZodObject<
  Properties<RequestResumeInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function RetireInstanceInputSchema(): z.ZodObject<
  Properties<RetireInstanceInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function RevokeCapabilityInputSchema(): z.ZodObject<
  Properties<RevokeCapabilityInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    grantId: z.string(),
    occurredAt: z.iso.datetime(),
  });
}

export function RevokeConnectionInputSchema(): z.ZodObject<
  Properties<RevokeConnectionInput>
> {
  return z.object({
    actorId: z.string(),
    connectionId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function ScheduleBindingSchema(): z.ZodObject<
  Properties<ScheduleBinding>
> {
  return z.object({
    __typename: z.literal("ScheduleBinding").optional(),
    catchUp: CatchUpPolicySchema,
    conditionRef: z.string(),
    id: z.string(),
    lastRunRef: z.string().nullish(),
    maxExecutions: z.number(),
    schedulerRef: z.string(),
    timezone: z.string(),
    watermarkRef: z.string(),
  });
}

export function ScheduleBindingInputSchema(): z.ZodObject<
  Properties<ScheduleBindingInput>
> {
  return z.object({
    catchUp: CatchUpPolicySchema,
    conditionRef: z.string(),
    id: z.string(),
    lastRunRef: z.string().nullish(),
    maxExecutions: z.number(),
    schedulerRef: z.string(),
    timezone: z.string(),
    watermarkRef: z.string(),
  });
}

export function SetModelPolicyInputSchema(): z.ZodObject<
  Properties<SetModelPolicyInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    modelPolicy: z.lazy(() => ModelPolicyInputSchema()),
    occurredAt: z.iso.datetime(),
  });
}

export function SetOperatingPolicyInputSchema(): z.ZodObject<
  Properties<SetOperatingPolicyInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    operatingPolicy: z.string(),
  });
}

export function SetResponsibilitiesInputSchema(): z.ZodObject<
  Properties<SetResponsibilitiesInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    responsibilities: z.array(z.string()),
  });
}

export function SetRuntimeBindingInputSchema(): z.ZodObject<
  Properties<SetRuntimeBindingInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    runtimeBindingRef: z.string(),
  });
}

export function UnbindScheduleInputSchema(): z.ZodObject<
  Properties<UnbindScheduleInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    scheduleId: z.string(),
  });
}

export function UnlinkDocumentInputSchema(): z.ZodObject<
  Properties<UnlinkDocumentInput>
> {
  return z.object({
    actorId: z.string(),
    documentRef: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
  });
}

export function VersionedRefSchema(): z.ZodObject<Properties<VersionedRef>> {
  return z.object({
    __typename: z.literal("VersionedRef").optional(),
    contentHash: z.string(),
    id: z.string(),
    version: z.string(),
  });
}

export function VersionedRefInputSchema(): z.ZodObject<
  Properties<VersionedRefInput>
> {
  return z.object({
    contentHash: z.string(),
    id: z.string(),
    version: z.string(),
  });
}
