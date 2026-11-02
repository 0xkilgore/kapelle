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

export type AddFeedbackInput = {
  actorId: Scalars["String"]["input"];
  bodyMarkdown: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  feedbackId: Scalars["ID"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type DismissAttentionInput = {
  actorId: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type MarkFeedbackRouteFailedInput = {
  actorId: Scalars["String"]["input"];
  error: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  feedbackId: Scalars["ID"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type MarkFeedbackRoutedInput = {
  actorId: Scalars["String"]["input"];
  destination: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  feedbackId: Scalars["ID"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type MarkOpenedInput = {
  actorId: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type MarkReadInput = {
  actorId: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type MarkUnreadInput = {
  actorId: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type PublishReportInput = {
  actorId: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type RegisterReportInput = {
  actorId: Scalars["String"]["input"];
  content: ReportContentDescriptorInput;
  familyRef?: InputMaybe<Scalars["String"]["input"]>;
  id: Scalars["PHID"]["input"];
  lifecycle?: InputMaybe<ReportLifecycle>;
  occurredAt: Scalars["DateTime"]["input"];
  producer: ReportProducerInput;
  projectRef?: InputMaybe<Scalars["String"]["input"]>;
  publication?: InputMaybe<ReportPublicationInput>;
  reportRef: Scalars["String"]["input"];
  sourceRef?: InputMaybe<Scalars["String"]["input"]>;
  title: Scalars["String"]["input"];
};

export type ReportAgentSnapshot = {
  definitionHash: Maybe<Scalars["String"]["output"]>;
  definitionId: Maybe<Scalars["PHID"]["output"]>;
  definitionVersion: Maybe<Scalars["String"]["output"]>;
  id: Scalars["String"]["output"];
  instanceId: Maybe<Scalars["PHID"]["output"]>;
  label: Scalars["String"]["output"];
};

export type ReportAgentSnapshotInput = {
  definitionHash?: InputMaybe<Scalars["String"]["input"]>;
  definitionId?: InputMaybe<Scalars["PHID"]["input"]>;
  definitionVersion?: InputMaybe<Scalars["String"]["input"]>;
  id: Scalars["String"]["input"];
  instanceId?: InputMaybe<Scalars["PHID"]["input"]>;
  label: Scalars["String"]["input"];
};

export type ReportAttentionRequest =
  | "ANSWER"
  | "APPROVE"
  | "DECIDE"
  | "NONE"
  | "READ"
  | "REQUEST_CHANGE";

export type ReportAttentionResolution = "DISMISSED" | "READ" | "RESOLVED";

export type ReportAttentionState = {
  expiresAt: Maybe<Scalars["DateTime"]["output"]>;
  reason: Maybe<Scalars["String"]["output"]>;
  reasonCode: Maybe<Scalars["String"]["output"]>;
  request: ReportAttentionRequest;
  requestedAt: Maybe<Scalars["DateTime"]["output"]>;
  requestedBy: Maybe<Scalars["String"]["output"]>;
  resolution: Maybe<ReportAttentionResolution>;
  resolvedAt: Maybe<Scalars["DateTime"]["output"]>;
  reviewBy: Maybe<Scalars["DateTime"]["output"]>;
};

export type ReportContentDescriptor = {
  blobRef: Maybe<Scalars["String"]["output"]>;
  byteSize: Scalars["Int"]["output"];
  contentHash: Scalars["String"]["output"];
  filename: Maybe<Scalars["String"]["output"]>;
  markdown: Maybe<Scalars["String"]["output"]>;
  mimeType: Scalars["String"]["output"];
  storage: ReportContentStorage;
};

export type ReportContentDescriptorInput = {
  blobRef?: InputMaybe<Scalars["String"]["input"]>;
  byteSize: Scalars["Int"]["input"];
  contentHash: Scalars["String"]["input"];
  filename?: InputMaybe<Scalars["String"]["input"]>;
  markdown?: InputMaybe<Scalars["String"]["input"]>;
  mimeType: Scalars["String"]["input"];
  storage: ReportContentStorage;
};

export type ReportContentStorage = "BLOB" | "INLINE_MARKDOWN";

export type ReportFeedback = {
  actorId: Scalars["String"]["output"];
  bodyMarkdown: Scalars["String"]["output"];
  createdAt: Scalars["DateTime"]["output"];
  id: Scalars["ID"]["output"];
  route: ReportFeedbackRoute;
};

export type ReportFeedbackRoute = {
  destination: Maybe<Scalars["String"]["output"]>;
  error: Maybe<Scalars["String"]["output"]>;
  routedAt: Maybe<Scalars["DateTime"]["output"]>;
  status: ReportFeedbackRouteStatus;
};

export type ReportFeedbackRouteStatus = "FAILED" | "ROUTED" | "UNROUTED";

export type ReportLifecycle = "DRAFT" | "FINAL" | "SUPERSEDED" | "WITHDRAWN";

export type ReportProducer = {
  id: Scalars["String"]["output"];
  kind: ReportProducerKind;
  label: Maybe<Scalars["String"]["output"]>;
};

export type ReportProducerInput = {
  id: Scalars["String"]["input"];
  kind: ReportProducerKind;
  label?: InputMaybe<Scalars["String"]["input"]>;
};

export type ReportProducerKind = "AGENT" | "HUMAN" | "IMPORT" | "SERVICE";

export type ReportPublication = {
  author: ReportAgentSnapshot;
  authorizationRef: Scalars["String"]["output"];
  contentHash: Scalars["String"]["output"];
  contentVersion: Scalars["Int"]["output"];
  provenanceRef: Scalars["String"]["output"];
  publicationId: Scalars["String"]["output"];
  publishedAt: Scalars["DateTime"]["output"];
  publisher: ReportAgentSnapshot;
  runRef: Scalars["String"]["output"];
  sourceRef: Scalars["String"]["output"];
};

export type ReportPublicationInput = {
  author: ReportAgentSnapshotInput;
  authorizationRef: Scalars["String"]["input"];
  contentHash: Scalars["String"]["input"];
  contentVersion: Scalars["Int"]["input"];
  provenanceRef: Scalars["String"]["input"];
  publicationId: Scalars["String"]["input"];
  publishedAt: Scalars["DateTime"]["input"];
  publisher: ReportAgentSnapshotInput;
  runRef: Scalars["String"]["input"];
  sourceRef: Scalars["String"]["input"];
};

export type ReportRegistryState = {
  attention: ReportAttentionState;
  content: Maybe<ReportContentDescriptor>;
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  createdBy: Scalars["String"]["output"];
  familyRef: Maybe<Scalars["String"]["output"]>;
  id: Maybe<Scalars["PHID"]["output"]>;
  lifecycle: ReportLifecycle;
  producer: Maybe<ReportProducer>;
  projectRef: Maybe<Scalars["String"]["output"]>;
  /** Optional for historical journal/state compatibility. Preserve after generation. */
  publication?: Maybe<ReportPublication>;
  reportRef: Scalars["String"]["output"];
  review: ReportReviewState;
  revision: Scalars["Int"]["output"];
  schemaVersion: Scalars["Int"]["output"];
  sourceRef: Maybe<Scalars["String"]["output"]>;
  supersededByRef: Maybe<Scalars["String"]["output"]>;
  supersedesRef: Maybe<Scalars["String"]["output"]>;
  title: Scalars["String"]["output"];
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
  updatedBy: Scalars["String"]["output"];
};

export type ReportReviewState = {
  feedback: Array<ReportFeedback>;
  openedAt: Maybe<Scalars["DateTime"]["output"]>;
  readAt: Maybe<Scalars["DateTime"]["output"]>;
};

export type RequestReviewInput = {
  actorId: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  expiresAt?: InputMaybe<Scalars["DateTime"]["input"]>;
  occurredAt: Scalars["DateTime"]["input"];
  reason?: InputMaybe<Scalars["String"]["input"]>;
  reasonCode?: InputMaybe<Scalars["String"]["input"]>;
  request: ReportAttentionRequest;
  reviewBy?: InputMaybe<Scalars["DateTime"]["input"]>;
};

export type ResolveAttentionInput = {
  actorId: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type SupersedeReportInput = {
  actorId: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  supersededByRef: Scalars["String"]["input"];
};

export type WithdrawReportInput = {
  actorId: Scalars["String"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  reason?: InputMaybe<Scalars["String"]["input"]>;
};
