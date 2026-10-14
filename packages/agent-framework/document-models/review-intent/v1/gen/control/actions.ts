/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  CreateReviewInput,
  InvalidateReviewInput,
  RecordDecisionInput,
  RecordDeliveryInput,
  ReserveEffectInput,
} from "../types.js";

export type CreateReviewAction = Action & {
  type: "CREATE_REVIEW";
  input: CreateReviewInput;
};
export type RecordDecisionAction = Action & {
  type: "RECORD_DECISION";
  input: RecordDecisionInput;
};
export type InvalidateReviewAction = Action & {
  type: "INVALIDATE_REVIEW";
  input: InvalidateReviewInput;
};
export type ReserveEffectAction = Action & {
  type: "RESERVE_EFFECT";
  input: ReserveEffectInput;
};
export type RecordDeliveryAction = Action & {
  type: "RECORD_DELIVERY";
  input: RecordDeliveryInput;
};

export type ReviewIntentControlAction =
  | CreateReviewAction
  | RecordDecisionAction
  | InvalidateReviewAction
  | ReserveEffectAction
  | RecordDeliveryAction;
