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

export type AgentInstanceState = {
  connections: Array<ConnectionBinding>;
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  definitionRef: Maybe<VersionedRef>;
  desiredState: DesiredState;
  documentLinks: Array<DocumentLink>;
  grants: Array<CapabilityGrant>;
  instanceId: Maybe<Scalars["ID"]["output"]>;
  modelPolicy: Maybe<ModelPolicy>;
  name: Maybe<Scalars["String"]["output"]>;
  operatingPolicy: Maybe<Scalars["String"]["output"]>;
  ownerId: Maybe<Scalars["ID"]["output"]>;
  responsibilities: Array<Scalars["String"]["output"]>;
  revision: Scalars["Int"]["output"];
  runtimeBindingRef: Maybe<Scalars["ID"]["output"]>;
  schedules: Array<ScheduleBinding>;
  scopeRef: Maybe<Scalars["ID"]["output"]>;
  skills: Array<EnabledSkill>;
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
};

export type BindConnectionInput = {
  actorId: Scalars["ID"]["input"];
  binding: ConnectionBindingInput;
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type BindScheduleInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  schedule: ScheduleBindingInput;
};

export type CapabilityGrant = {
  actions: Array<Scalars["String"]["output"]>;
  expiresAt: Scalars["DateTime"]["output"];
  id: Scalars["ID"]["output"];
  principalId: Scalars["ID"]["output"];
  resourceRef: Scalars["ID"]["output"];
  reviewPolicy: ReviewPolicy;
  revokedAt: Maybe<Scalars["DateTime"]["output"]>;
};

export type CapabilityGrantInput = {
  actions: Array<Scalars["String"]["input"]>;
  expiresAt: Scalars["DateTime"]["input"];
  id: Scalars["ID"]["input"];
  principalId: Scalars["ID"]["input"];
  resourceRef: Scalars["ID"]["input"];
  reviewPolicy: ReviewPolicy;
};

export type CatchUpPolicy = "COALESCE" | "SKIP";

export type ConnectionBinding = {
  accountRef: Scalars["ID"]["output"];
  connectionRef: Scalars["ID"]["output"];
  directions: Array<ConnectionDirection>;
  id: Scalars["ID"]["output"];
  label: Scalars["String"]["output"];
  revokedAt: Maybe<Scalars["DateTime"]["output"]>;
};

export type ConnectionBindingInput = {
  accountRef: Scalars["ID"]["input"];
  connectionRef: Scalars["ID"]["input"];
  directions: Array<ConnectionDirection>;
  id: Scalars["ID"]["input"];
  label: Scalars["String"]["input"];
};

export type ConnectionDirection = "PREPARE" | "RECEIVE" | "SEND";

export type CreateInstanceInput = {
  actorId: Scalars["ID"]["input"];
  definitionRef: VersionedRefInput;
  expectedRevision: Scalars["Int"]["input"];
  instanceId: Scalars["ID"]["input"];
  modelPolicy: ModelPolicyInput;
  name: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  operatingPolicy: Scalars["String"]["input"];
  responsibilities: Array<Scalars["String"]["input"]>;
  scopeRef: Scalars["ID"]["input"];
};

export type DesiredState = "PAUSED" | "READY" | "RETIRED";

export type DisableSkillInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  skillId: Scalars["ID"]["input"];
};

export type DocumentAccess = "PRIVATE" | "PUBLIC" | "SHARED";

export type DocumentLink = {
  access: DocumentAccess;
  documentRef: Scalars["ID"]["output"];
};

export type EnableSkillInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  ref: VersionedRefInput;
  source: SkillSource;
};

export type EnabledSkill = {
  ref: VersionedRef;
  source: SkillSource;
};

export type GrantCapabilityInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  grant: CapabilityGrantInput;
  occurredAt: Scalars["DateTime"]["input"];
};

export type LinkDocumentInput = {
  access: DocumentAccess;
  actorId: Scalars["ID"]["input"];
  documentRef: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type ModelPolicy = {
  budgetPolicyRef: Scalars["ID"]["output"];
  concurrencyLimit: Scalars["Int"]["output"];
  fallbackBudgetRef: Maybe<Scalars["ID"]["output"]>;
  fallbackProvider: Maybe<Scalars["String"]["output"]>;
  fallbackScopeRef: Maybe<Scalars["ID"]["output"]>;
  paidFallback: Scalars["Boolean"]["output"];
  preferredProfile: Scalars["String"]["output"];
};

export type ModelPolicyInput = {
  budgetPolicyRef: Scalars["ID"]["input"];
  concurrencyLimit: Scalars["Int"]["input"];
  fallbackBudgetRef?: InputMaybe<Scalars["ID"]["input"]>;
  fallbackProvider?: InputMaybe<Scalars["String"]["input"]>;
  fallbackScopeRef?: InputMaybe<Scalars["ID"]["input"]>;
  paidFallback: Scalars["Boolean"]["input"];
  preferredProfile: Scalars["String"]["input"];
};

export type PinDefinitionVersionInput = {
  actorId: Scalars["ID"]["input"];
  compatibilityFixtureRef: VersionedRefInput;
  definitionRef: VersionedRefInput;
  expectedRevision: Scalars["Int"]["input"];
  migrationRef: VersionedRefInput;
  occurredAt: Scalars["DateTime"]["input"];
};

export type RequestPauseInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type RequestResumeInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type RetireInstanceInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type ReviewPolicy = "ALWAYS" | "WITHIN_GRANT";

export type RevokeCapabilityInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  grantId: Scalars["ID"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type RevokeConnectionInput = {
  actorId: Scalars["ID"]["input"];
  connectionId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type ScheduleBinding = {
  catchUp: CatchUpPolicy;
  conditionRef: Scalars["ID"]["output"];
  id: Scalars["ID"]["output"];
  lastRunRef: Maybe<Scalars["ID"]["output"]>;
  maxExecutions: Scalars["Int"]["output"];
  schedulerRef: Scalars["ID"]["output"];
  timezone: Scalars["String"]["output"];
  watermarkRef: Scalars["ID"]["output"];
};

export type ScheduleBindingInput = {
  catchUp: CatchUpPolicy;
  conditionRef: Scalars["ID"]["input"];
  id: Scalars["ID"]["input"];
  lastRunRef?: InputMaybe<Scalars["ID"]["input"]>;
  maxExecutions: Scalars["Int"]["input"];
  schedulerRef: Scalars["ID"]["input"];
  timezone: Scalars["String"]["input"];
  watermarkRef: Scalars["ID"]["input"];
};

export type SetModelPolicyInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  modelPolicy: ModelPolicyInput;
  occurredAt: Scalars["DateTime"]["input"];
};

export type SetOperatingPolicyInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  operatingPolicy: Scalars["String"]["input"];
};

export type SetResponsibilitiesInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  responsibilities: Array<Scalars["String"]["input"]>;
};

export type SetRuntimeBindingInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  runtimeBindingRef: Scalars["ID"]["input"];
};

export type SkillSource = "BUILTIN" | "MARKET" | "USER";

export type UnbindScheduleInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  scheduleId: Scalars["ID"]["input"];
};

export type UnlinkDocumentInput = {
  actorId: Scalars["ID"]["input"];
  documentRef: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

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
