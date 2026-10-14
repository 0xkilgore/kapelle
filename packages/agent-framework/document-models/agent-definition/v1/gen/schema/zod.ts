/* eslint-disable @typescript-eslint/no-empty-object-type */
/* eslint-disable @typescript-eslint/no-unused-vars */
import * as z from "zod";
import type {
  AgentDefinitionState,
  CapabilityDeclaration,
  CapabilityDeclarationInput,
  DefinitionRelease,
  DefinitionReleaseInput,
  MigrationDeclaration,
  MigrationDeclarationInput,
  ModelDependency,
  ModelDependencyInput,
  PublishDefinitionInput,
  Requirement,
  VersionedRef,
  VersionedRefInput,
  ViewDeclaration,
  ViewDeclarationInput,
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

export const RequirementSchema = z.enum(["OPTIONAL", "REQUIRED"]);

export function AgentDefinitionStateSchema(): z.ZodObject<
  Properties<AgentDefinitionState>
> {
  return z.object({
    __typename: z.literal("AgentDefinitionState").optional(),
    createdAt: z.iso.datetime().nullish(),
    ownerId: z.string().nullish(),
    release: z.lazy(() => DefinitionReleaseSchema().nullish()),
    revision: z.number(),
    updatedAt: z.iso.datetime().nullish(),
  });
}

export function CapabilityDeclarationSchema(): z.ZodObject<
  Properties<CapabilityDeclaration>
> {
  return z.object({
    __typename: z.literal("CapabilityDeclaration").optional(),
    actions: z.array(z.string()),
    id: z.string(),
    outputTypes: z.array(z.string()),
    requirement: RequirementSchema,
    resourceType: z.string(),
  });
}

export function CapabilityDeclarationInputSchema(): z.ZodObject<
  Properties<CapabilityDeclarationInput>
> {
  return z.object({
    actions: z.array(z.string()),
    id: z.string(),
    outputTypes: z.array(z.string()),
    requirement: RequirementSchema,
    resourceType: z.string(),
  });
}

export function DefinitionReleaseSchema(): z.ZodObject<
  Properties<DefinitionRelease>
> {
  return z.object({
    __typename: z.literal("DefinitionRelease").optional(),
    avatarRef: z.string().nullish(),
    capabilities: z.array(z.lazy(() => CapabilityDeclarationSchema())),
    contentHash: z.string(),
    definitionId: z.string(),
    description: z.string(),
    documentModels: z.array(z.lazy(() => ModelDependencySchema())),
    examples: z.array(z.string()),
    exportRequirements: z.array(z.string()),
    instructionTokenCount: z.number().nullish(),
    instructions: z.lazy(() => VersionedRefSchema()),
    licenseRef: z.string(),
    migrations: z.array(z.lazy(() => MigrationDeclarationSchema())),
    modelProfiles: z.array(z.string()),
    packageVersion: z.string(),
    previousVersionRef: z.lazy(() => VersionedRefSchema().nullish()),
    publisherRef: z.string(),
    purpose: z.string(),
    qualificationFixtures: z.array(z.lazy(() => VersionedRefSchema())),
    responsibilities: z.array(z.string()),
    runtimeContracts: z.array(z.string()),
    schemaVersion: z.number(),
    skills: z.array(z.lazy(() => VersionedRefSchema())),
    tags: z.array(z.string()),
    title: z.string(),
    tokenizerRef: z.string().nullish(),
    views: z.array(z.lazy(() => ViewDeclarationSchema())),
  });
}

export function DefinitionReleaseInputSchema(): z.ZodObject<
  Properties<DefinitionReleaseInput>
> {
  return z.object({
    avatarRef: z.string().nullish(),
    capabilities: z.array(z.lazy(() => CapabilityDeclarationInputSchema())),
    contentHash: z.string(),
    definitionId: z.string(),
    description: z.string(),
    documentModels: z.array(z.lazy(() => ModelDependencyInputSchema())),
    examples: z.array(z.string()),
    exportRequirements: z.array(z.string()),
    instructionTokenCount: z.number().nullish(),
    instructions: z.lazy(() => VersionedRefInputSchema()),
    licenseRef: z.string(),
    migrations: z.array(z.lazy(() => MigrationDeclarationInputSchema())),
    modelProfiles: z.array(z.string()),
    packageVersion: z.string(),
    previousVersionRef: z.lazy(() => VersionedRefInputSchema().nullish()),
    publisherRef: z.string(),
    purpose: z.string(),
    qualificationFixtures: z.array(z.lazy(() => VersionedRefInputSchema())),
    responsibilities: z.array(z.string()),
    runtimeContracts: z.array(z.string()),
    schemaVersion: z.number(),
    skills: z.array(z.lazy(() => VersionedRefInputSchema())),
    tags: z.array(z.string()),
    title: z.string(),
    tokenizerRef: z.string().nullish(),
    views: z.array(z.lazy(() => ViewDeclarationInputSchema())),
  });
}

export function MigrationDeclarationSchema(): z.ZodObject<
  Properties<MigrationDeclaration>
> {
  return z.object({
    __typename: z.literal("MigrationDeclaration").optional(),
    compatibilityFixtureRef: z.lazy(() => VersionedRefSchema()),
    fromVersion: z.string(),
    migrationRef: z.lazy(() => VersionedRefSchema()),
  });
}

export function MigrationDeclarationInputSchema(): z.ZodObject<
  Properties<MigrationDeclarationInput>
> {
  return z.object({
    compatibilityFixtureRef: z.lazy(() => VersionedRefInputSchema()),
    fromVersion: z.string(),
    migrationRef: z.lazy(() => VersionedRefInputSchema()),
  });
}

export function ModelDependencySchema(): z.ZodObject<
  Properties<ModelDependency>
> {
  return z.object({
    __typename: z.literal("ModelDependency").optional(),
    documentType: z.string(),
    version: z.number(),
  });
}

export function ModelDependencyInputSchema(): z.ZodObject<
  Properties<ModelDependencyInput>
> {
  return z.object({
    documentType: z.string(),
    version: z.number(),
  });
}

export function PublishDefinitionInputSchema(): z.ZodObject<
  Properties<PublishDefinitionInput>
> {
  return z.object({
    actorId: z.string(),
    expectedRevision: z.number(),
    occurredAt: z.iso.datetime(),
    release: z.lazy(() => DefinitionReleaseInputSchema()),
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

export function ViewDeclarationSchema(): z.ZodObject<
  Properties<ViewDeclaration>
> {
  return z.object({
    __typename: z.literal("ViewDeclaration").optional(),
    codeRef: z.lazy(() => VersionedRefSchema()),
    id: z.string(),
  });
}

export function ViewDeclarationInputSchema(): z.ZodObject<
  Properties<ViewDeclarationInput>
> {
  return z.object({
    codeRef: z.lazy(() => VersionedRefInputSchema()),
    id: z.string(),
  });
}
