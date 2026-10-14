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

export type ClaimExecutionInput = {
  actorId: Scalars["ID"]["input"];
  attemptId: Scalars["ID"]["input"];
  dispatchRef: Scalars["ID"]["input"];
  executorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  operationId: Scalars["ID"]["input"];
  outboxRef: Scalars["ID"]["input"];
  proposalHash: Scalars["String"]["input"];
  proposalVersion: Scalars["Int"]["input"];
};

export type CreateReviewInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  instanceId: Scalars["ID"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  proposal: ProposalInput;
  reviewId: Scalars["ID"]["input"];
  scopeRef: Scalars["ID"]["input"];
};

export type Decision = {
  actorId: Scalars["ID"]["output"];
  approved: Scalars["Boolean"]["output"];
  occurredAt: Scalars["DateTime"]["output"];
  proposalHash: Scalars["String"]["output"];
  proposalVersion: Scalars["Int"]["output"];
  reason: Maybe<Scalars["String"]["output"]>;
};

export type DeliveryEvidence = {
  id: Scalars["ID"]["output"];
  occurredAt: Scalars["DateTime"]["output"];
  providerRef: Scalars["ID"]["output"];
  receiptRef: Scalars["ID"]["output"];
  status: DeliveryStatus;
};

export type DeliveryStatus = "ACCEPTED" | "DELIVERED" | "FAILED" | "UNCERTAIN";

export type EffectKind =
  | "DOCUMENT_CHANGE"
  | "PREPARE_MESSAGE"
  | "SEND_MESSAGE"
  | "WEBSITE_PUBLICATION";

export type EffectReservation = {
  dispatchRef: Scalars["ID"]["output"];
  occurredAt: Scalars["DateTime"]["output"];
  operationId: Scalars["ID"]["output"];
  outboxRef: Scalars["ID"]["output"];
};

export type ExecutionClaim = {
  attemptId: Scalars["ID"]["output"];
  executorId: Scalars["ID"]["output"];
  occurredAt: Scalars["DateTime"]["output"];
  operationId: Scalars["ID"]["output"];
};

export type InvalidateReviewInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  reason: Scalars["String"]["input"];
};

export type Proposal = {
  action: Scalars["String"]["output"];
  artifactHash: Scalars["String"]["output"];
  contentHash: Scalars["String"]["output"];
  contentRef: Scalars["ID"]["output"];
  contentVersion: Scalars["Int"]["output"];
  effectKind: EffectKind;
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  recipients: Array<Scalars["String"]["output"]>;
  senderConnectionRef: Maybe<Scalars["ID"]["output"]>;
  targets: Array<TargetRevision>;
  version: Scalars["Int"]["output"];
};

export type ProposalInput = {
  action: Scalars["String"]["input"];
  artifactHash: Scalars["String"]["input"];
  contentHash: Scalars["String"]["input"];
  contentRef: Scalars["ID"]["input"];
  contentVersion: Scalars["Int"]["input"];
  effectKind: EffectKind;
  expiresAt?: InputMaybe<Scalars["DateTime"]["input"]>;
  recipients: Array<Scalars["String"]["input"]>;
  senderConnectionRef?: InputMaybe<Scalars["ID"]["input"]>;
  targets: Array<TargetRevisionInput>;
  version: Scalars["Int"]["input"];
};

export type RecordDecisionInput = {
  actorId: Scalars["ID"]["input"];
  approved: Scalars["Boolean"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  proposalHash: Scalars["String"]["input"];
  proposalVersion: Scalars["Int"]["input"];
  reason?: InputMaybe<Scalars["String"]["input"]>;
};

export type RecordDeliveryInput = {
  actorId: Scalars["ID"]["input"];
  evidenceId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  operationId: Scalars["ID"]["input"];
  providerRef: Scalars["ID"]["input"];
  receiptRef: Scalars["ID"]["input"];
  status: DeliveryStatus;
};

export type ReserveEffectInput = {
  actorId: Scalars["ID"]["input"];
  dispatchRef: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  operationId: Scalars["ID"]["input"];
  outboxRef: Scalars["ID"]["input"];
  proposalHash: Scalars["String"]["input"];
  proposalVersion: Scalars["Int"]["input"];
};

export type ReviewIntentState = {
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  decision: Maybe<Decision>;
  delivery: Array<DeliveryEvidence>;
  effect: Maybe<EffectReservation>;
  execution: Maybe<ExecutionClaim>;
  instanceId: Maybe<Scalars["ID"]["output"]>;
  invalidatedReason: Maybe<Scalars["String"]["output"]>;
  ownerId: Maybe<Scalars["ID"]["output"]>;
  proposal: Maybe<Proposal>;
  reviewId: Maybe<Scalars["ID"]["output"]>;
  revision: Scalars["Int"]["output"];
  scopeRef: Maybe<Scalars["ID"]["output"]>;
  status: ReviewState;
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
};

export type ReviewState = "APPROVED" | "INVALIDATED" | "PROPOSED" | "REJECTED";

export type TargetRevision = {
  contentHash: Scalars["String"]["output"];
  documentRef: Scalars["ID"]["output"];
  revision: Scalars["Int"]["output"];
};

export type TargetRevisionInput = {
  contentHash: Scalars["String"]["input"];
  documentRef: Scalars["ID"]["input"];
  revision: Scalars["Int"]["input"];
};
