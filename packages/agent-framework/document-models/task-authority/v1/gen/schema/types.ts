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

export type AddCommentInput = {
  actorId: Scalars["String"]["input"];
  bodyMarkdown: Scalars["String"]["input"];
  id: Scalars["ID"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type AddDependencyInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  taskId: Scalars["PHID"]["input"];
};

export type AddExternalRefInput = {
  actorId: Scalars["String"]["input"];
  authority: Scalars["String"]["input"];
  deepLink?: InputMaybe<Scalars["String"]["input"]>;
  id: Scalars["ID"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  opaqueId: Scalars["String"]["input"];
};

export type AddLabelInput = {
  actorId: Scalars["String"]["input"];
  label: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type ArchiveTaskInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  reason?: InputMaybe<Scalars["String"]["input"]>;
};

export type BlockTaskInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  reason: Scalars["String"]["input"];
};

export type CompleteTaskInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  resolution?: InputMaybe<Scalars["String"]["input"]>;
};

export type CreateTaskInput = {
  actorId: Scalars["String"]["input"];
  assigneeId?: InputMaybe<Scalars["String"]["input"]>;
  bodyMarkdown?: InputMaybe<Scalars["String"]["input"]>;
  dueAt?: InputMaybe<Scalars["DateTime"]["input"]>;
  id: Scalars["PHID"]["input"];
  labels?: InputMaybe<Array<Scalars["String"]["input"]>>;
  occurredAt: Scalars["DateTime"]["input"];
  ownerId: Scalars["String"]["input"];
  priority?: InputMaybe<TaskPriority>;
  projectId?: InputMaybe<Scalars["String"]["input"]>;
  source: TaskSource;
  sourceRef?: InputMaybe<Scalars["String"]["input"]>;
  title: Scalars["String"]["input"];
};

export type RemoveDependencyInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  taskId: Scalars["PHID"]["input"];
};

export type RemoveExternalRefInput = {
  actorId: Scalars["String"]["input"];
  id: Scalars["ID"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type RemoveLabelInput = {
  actorId: Scalars["String"]["input"];
  label: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type ReopenTaskInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  reason?: InputMaybe<Scalars["String"]["input"]>;
};

export type SetAssigneeInput = {
  actorId: Scalars["String"]["input"];
  assigneeId?: InputMaybe<Scalars["String"]["input"]>;
  occurredAt: Scalars["DateTime"]["input"];
};

export type SetDueInput = {
  actorId: Scalars["String"]["input"];
  dueAt?: InputMaybe<Scalars["DateTime"]["input"]>;
  occurredAt: Scalars["DateTime"]["input"];
};

export type SetPriorityInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  priority?: InputMaybe<TaskPriority>;
};

export type SetProjectInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  projectId?: InputMaybe<Scalars["String"]["input"]>;
};

export type SnoozeTaskInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  reason?: InputMaybe<Scalars["String"]["input"]>;
  snoozedUntil: Scalars["DateTime"]["input"];
};

export type TaskAuthorityState = {
  archivedAt: Maybe<Scalars["DateTime"]["output"]>;
  assigneeId: Maybe<Scalars["String"]["output"]>;
  blockHistory: Array<TaskBlock>;
  bodyMarkdown: Scalars["String"]["output"];
  comments: Array<TaskComment>;
  completedAt: Maybe<Scalars["DateTime"]["output"]>;
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  createdBy: Scalars["String"]["output"];
  dependsOn: Array<Scalars["PHID"]["output"]>;
  dueAt: Maybe<Scalars["DateTime"]["output"]>;
  externalRefs: Array<TaskExternalRef>;
  id: Maybe<Scalars["PHID"]["output"]>;
  labels: Array<Scalars["String"]["output"]>;
  openBlock: Maybe<TaskBlock>;
  ownerId: Scalars["String"]["output"];
  priority: Maybe<TaskPriority>;
  projectId: Maybe<Scalars["String"]["output"]>;
  schemaVersion: Scalars["Int"]["output"];
  snoozedUntil: Maybe<Scalars["DateTime"]["output"]>;
  source: TaskSource;
  sourceRef: Maybe<Scalars["String"]["output"]>;
  status: TaskStatus;
  title: Scalars["String"]["output"];
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
  updatedBy: Scalars["String"]["output"];
};

export type TaskBlock = {
  clearedAt: Maybe<Scalars["DateTime"]["output"]>;
  clearedBy: Maybe<Scalars["String"]["output"]>;
  reason: Scalars["String"]["output"];
  resolution: Maybe<Scalars["String"]["output"]>;
  setAt: Scalars["DateTime"]["output"];
  setBy: Scalars["String"]["output"];
};

export type TaskComment = {
  addedAt: Scalars["DateTime"]["output"];
  addedBy: Scalars["String"]["output"];
  bodyMarkdown: Scalars["String"]["output"];
  id: Scalars["ID"]["output"];
};

export type TaskExternalRef = {
  addedAt: Scalars["DateTime"]["output"];
  addedBy: Scalars["String"]["output"];
  authority: Scalars["String"]["output"];
  deepLink: Maybe<Scalars["String"]["output"]>;
  id: Scalars["ID"]["output"];
  opaqueId: Scalars["String"]["output"];
};

export type TaskPriority = "HIGH" | "LOW" | "MED";

export type TaskSource =
  | "AGENT"
  | "CLI"
  | "HUMAN"
  | "MIGRATION"
  | "PERSONAL_CRM";

export type TaskStatus = "ARCHIVED" | "BLOCKED" | "DONE" | "OPEN" | "SNOOZED";

export type UnblockTaskInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  resolution?: InputMaybe<Scalars["String"]["input"]>;
};

export type UnsnoozeTaskInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type UpdateBodyInput = {
  actorId: Scalars["String"]["input"];
  bodyMarkdown: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type UpdateTitleInput = {
  actorId: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  title: Scalars["String"]["input"];
};
