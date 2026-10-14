export type Maybe<T> = T | null | undefined;
export type InputMaybe<T> = T | null | undefined;
export type Exact<T extends { [key: string]: unknown }> = {
  [K in keyof T]: T[K];
};
export type MakeOptional<T, K extends keyof T> = Omit<T, K> & {
  [SubKey in K]?: Maybe<T[SubKey]>;
};
export type MakeMaybe<T, K extends keyof T> = Omit<T, K> & {
  [SubKey in K]: Maybe<T[SubKey]>;
};
export type MakeEmpty<
  T extends { [key: string]: unknown },
  K extends keyof T,
> = { [_ in K]?: never };
export type Incremental<T> =
  | T
  | {
      [P in keyof T]?: P extends " $fragmentName" | "__typename" ? T[P] : never;
    };
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
  Int: { input: number; output: number };
  Float: { input: number; output: number };
  Address: { input: `${string}:0x${string}`; output: `${string}:0x${string}` };
  Amount: {
    input: { unit?: string; value?: number };
    output: { unit?: string; value?: number };
  };
  Amount_Crypto: {
    input: { unit: string; value: string };
    output: { unit: string; value: string };
  };
  Amount_Currency: {
    input: { unit: string; value: string };
    output: { unit: string; value: string };
  };
  Amount_Fiat: {
    input: { unit: string; value: number };
    output: { unit: string; value: number };
  };
  Amount_Money: { input: number; output: number };
  Amount_Percentage: { input: number; output: number };
  Amount_Tokens: { input: number; output: number };
  AttachmentRef: {
    input: `attachment://v${number}:${string}`;
    output: `attachment://v${number}:${string}`;
  };
  Currency: { input: string; output: string };
  Date: { input: string; output: string };
  DateTime: { input: string; output: string };
  EmailAddress: { input: string; output: string };
  EthereumAddress: { input: string; output: string };
  OID: { input: string; output: string };
  OLabel: { input: string; output: string };
  PHID: { input: string; output: string };
  URL: { input: string; output: string };
  Unknown: { input: unknown; output: unknown };
  Upload: { input: File; output: File };
};

export type AgentDefinitionState = {
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  ownerId: Maybe<Scalars["ID"]["output"]>;
  release: Maybe<DefinitionRelease>;
  revision: Scalars["Int"]["output"];
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
};

export type CapabilityDeclaration = {
  actions: Array<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  outputTypes: Array<Scalars["String"]["output"]>;
  requirement: Requirement;
  resourceType: Scalars["String"]["output"];
};

export type CapabilityDeclarationInput = {
  actions: Array<Scalars["String"]["input"]>;
  id: Scalars["ID"]["input"];
  outputTypes: Array<Scalars["String"]["input"]>;
  requirement: Requirement;
  resourceType: Scalars["String"]["input"];
};

export type DefinitionRelease = {
  avatarRef: Maybe<Scalars["ID"]["output"]>;
  capabilities: Array<CapabilityDeclaration>;
  contentHash: Scalars["String"]["output"];
  definitionId: Scalars["ID"]["output"];
  description: Scalars["String"]["output"];
  documentModels: Array<ModelDependency>;
  examples: Array<Scalars["String"]["output"]>;
  exportRequirements: Array<Scalars["String"]["output"]>;
  instructionTokenCount: Maybe<Scalars["Int"]["output"]>;
  instructions: VersionedRef;
  licenseRef: Scalars["String"]["output"];
  migrations: Array<MigrationDeclaration>;
  modelProfiles: Array<Scalars["String"]["output"]>;
  packageVersion: Scalars["String"]["output"];
  previousVersionRef: Maybe<VersionedRef>;
  publisherRef: Scalars["ID"]["output"];
  purpose: Scalars["String"]["output"];
  qualificationFixtures: Array<VersionedRef>;
  responsibilities: Array<Scalars["String"]["output"]>;
  runtimeContracts: Array<Scalars["String"]["output"]>;
  schemaVersion: Scalars["Int"]["output"];
  skills: Array<VersionedRef>;
  tags: Array<Scalars["String"]["output"]>;
  title: Scalars["String"]["output"];
  tokenizerRef: Maybe<Scalars["String"]["output"]>;
  views: Array<ViewDeclaration>;
};

export type DefinitionReleaseInput = {
  avatarRef?: InputMaybe<Scalars["ID"]["input"]>;
  capabilities: Array<CapabilityDeclarationInput>;
  contentHash: Scalars["String"]["input"];
  definitionId: Scalars["ID"]["input"];
  description: Scalars["String"]["input"];
  documentModels: Array<ModelDependencyInput>;
  examples: Array<Scalars["String"]["input"]>;
  exportRequirements: Array<Scalars["String"]["input"]>;
  instructionTokenCount?: InputMaybe<Scalars["Int"]["input"]>;
  instructions: VersionedRefInput;
  licenseRef: Scalars["String"]["input"];
  migrations: Array<MigrationDeclarationInput>;
  modelProfiles: Array<Scalars["String"]["input"]>;
  packageVersion: Scalars["String"]["input"];
  previousVersionRef?: InputMaybe<VersionedRefInput>;
  publisherRef: Scalars["ID"]["input"];
  purpose: Scalars["String"]["input"];
  qualificationFixtures: Array<VersionedRefInput>;
  responsibilities: Array<Scalars["String"]["input"]>;
  runtimeContracts: Array<Scalars["String"]["input"]>;
  schemaVersion: Scalars["Int"]["input"];
  skills: Array<VersionedRefInput>;
  tags: Array<Scalars["String"]["input"]>;
  title: Scalars["String"]["input"];
  tokenizerRef?: InputMaybe<Scalars["String"]["input"]>;
  views: Array<ViewDeclarationInput>;
};

export type MigrationDeclaration = {
  compatibilityFixtureRef: VersionedRef;
  fromVersion: Scalars["String"]["output"];
  migrationRef: VersionedRef;
};

export type MigrationDeclarationInput = {
  compatibilityFixtureRef: VersionedRefInput;
  fromVersion: Scalars["String"]["input"];
  migrationRef: VersionedRefInput;
};

export type ModelDependency = {
  documentType: Scalars["String"]["output"];
  version: Scalars["Int"]["output"];
};

export type ModelDependencyInput = {
  documentType: Scalars["String"]["input"];
  version: Scalars["Int"]["input"];
};

export type PublishDefinitionInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  release: DefinitionReleaseInput;
};

export type Requirement = "OPTIONAL" | "REQUIRED";

export type VersionedRef = {
  contentHash: Scalars["String"]["output"];
  id: Scalars["ID"]["output"];
  version: Scalars["String"]["output"];
};

export type VersionedRefInput = {
  contentHash: Scalars["String"]["input"];
  id: Scalars["ID"]["input"];
  version: Scalars["String"]["input"];
};

export type ViewDeclaration = {
  codeRef: VersionedRef;
  id: Scalars["ID"]["output"];
};

export type ViewDeclarationInput = {
  codeRef: VersionedRefInput;
  id: Scalars["ID"]["input"];
};
