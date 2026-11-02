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

export type AcceptDispatchInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  inputHash: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
};

export type CreateDispatchInput = {
  actorId: Scalars["ID"]["input"];
  dispatchId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  offer: DispatchOfferInput;
  ownerId: Scalars["ID"]["input"];
};

export type DispatchAcceptance = {
  actorId: Scalars["ID"]["output"];
  inputHash: Scalars["String"]["output"];
  occurredAt: Scalars["DateTime"]["output"];
};

export type DispatchAgentRef = {
  definitionHash: Scalars["String"]["output"];
  definitionId: Scalars["ID"]["output"];
  definitionVersion: Scalars["String"]["output"];
  instanceId: Scalars["ID"]["output"];
};

export type DispatchAgentRefInput = {
  definitionHash: Scalars["String"]["input"];
  definitionId: Scalars["ID"]["input"];
  definitionVersion: Scalars["String"]["input"];
  instanceId: Scalars["ID"]["input"];
};

export type DispatchOffer = {
  contentHash: Scalars["String"]["output"];
  continuationOfRef: Maybe<Scalars["ID"]["output"]>;
  expiresAt: Scalars["DateTime"]["output"];
  instructions: Scalars["String"]["output"];
  instructionsHash: Scalars["String"]["output"];
  originalRequesterId: Scalars["ID"]["output"];
  parentContentHash: Maybe<Scalars["String"]["output"]>;
  parentDispatchRef: Maybe<Scalars["ID"]["output"]>;
  permissionRef: Scalars["ID"]["output"];
  recipient: DispatchAgentRef;
  scopeRef: Scalars["ID"]["output"];
  senderAgent: Maybe<DispatchAgentRef>;
  senderId: Scalars["ID"]["output"];
  sources: Array<DispatchSourceRef>;
  task: DispatchTaskRef;
};

export type DispatchOfferInput = {
  contentHash: Scalars["String"]["input"];
  continuationOfRef?: InputMaybe<Scalars["ID"]["input"]>;
  expiresAt: Scalars["DateTime"]["input"];
  instructions: Scalars["String"]["input"];
  instructionsHash: Scalars["String"]["input"];
  originalRequesterId: Scalars["ID"]["input"];
  parentContentHash?: InputMaybe<Scalars["String"]["input"]>;
  parentDispatchRef?: InputMaybe<Scalars["ID"]["input"]>;
  permissionRef: Scalars["ID"]["input"];
  recipient: DispatchAgentRefInput;
  scopeRef: Scalars["ID"]["input"];
  senderAgent?: InputMaybe<DispatchAgentRefInput>;
  senderId: Scalars["ID"]["input"];
  sources: Array<DispatchSourceRefInput>;
  task: DispatchTaskRefInput;
};

export type DispatchPhase =
  | "ACCEPTED"
  | "CANCEL_REQUESTED"
  | "OFFERED"
  | "RESULT_RECORDED";

export type DispatchResultRef = {
  contentHash: Scalars["String"]["output"];
  contentVersion: Scalars["Int"]["output"];
  occurredAt: Scalars["DateTime"]["output"];
  reportId: Scalars["ID"]["output"];
  verificationRef: Scalars["ID"]["output"];
};

export type DispatchSourceRef = {
  contentHash: Scalars["String"]["output"];
  contentVersion: Scalars["Int"]["output"];
  documentRef: Scalars["ID"]["output"];
  documentType: Scalars["String"]["output"];
};

export type DispatchSourceRefInput = {
  contentHash: Scalars["String"]["input"];
  contentVersion: Scalars["Int"]["input"];
  documentRef: Scalars["ID"]["input"];
  documentType: Scalars["String"]["input"];
};

export type DispatchState = {
  acceptance: Maybe<DispatchAcceptance>;
  cancellationReason: Maybe<Scalars["String"]["output"]>;
  createdAt: Maybe<Scalars["DateTime"]["output"]>;
  dispatchId: Maybe<Scalars["ID"]["output"]>;
  offer: Maybe<DispatchOffer>;
  ownerId: Maybe<Scalars["ID"]["output"]>;
  phase: DispatchPhase;
  result: Maybe<DispatchResultRef>;
  revision: Scalars["Int"]["output"];
  scopeRef: Maybe<Scalars["ID"]["output"]>;
  updatedAt: Maybe<Scalars["DateTime"]["output"]>;
};

export type DispatchTaskRef = {
  authorityRef: Scalars["ID"]["output"];
  commitmentHash: Scalars["String"]["output"];
  taskRef: Scalars["ID"]["output"];
};

export type DispatchTaskRefInput = {
  authorityRef: Scalars["ID"]["input"];
  commitmentHash: Scalars["String"]["input"];
  taskRef: Scalars["ID"]["input"];
};

export type RecordDispatchResultInput = {
  actorId: Scalars["ID"]["input"];
  contentHash: Scalars["String"]["input"];
  contentVersion: Scalars["Int"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  inputHash: Scalars["String"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  reportId: Scalars["ID"]["input"];
  verificationRef: Scalars["ID"]["input"];
};

export type RequestDispatchCancelInput = {
  actorId: Scalars["ID"]["input"];
  expectedRevision: Scalars["Int"]["input"];
  occurredAt: Scalars["DateTime"]["input"];
  reason: Scalars["String"]["input"];
};
