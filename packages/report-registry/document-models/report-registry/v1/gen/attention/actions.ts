/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  AddFeedbackInput,
  DismissAttentionInput,
  MarkFeedbackRoutedInput,
  MarkFeedbackRouteFailedInput,
  MarkOpenedInput,
  MarkReadInput,
  MarkUnreadInput,
  RequestReviewInput,
  ResolveAttentionInput,
} from "../types.js";

export type RequestReviewAction = Action & {
  type: "REQUEST_REVIEW";
  input: RequestReviewInput;
};
export type MarkOpenedAction = Action & {
  type: "MARK_OPENED";
  input: MarkOpenedInput;
};
export type MarkReadAction = Action & {
  type: "MARK_READ";
  input: MarkReadInput;
};
export type MarkUnreadAction = Action & {
  type: "MARK_UNREAD";
  input: MarkUnreadInput;
};
export type AddFeedbackAction = Action & {
  type: "ADD_FEEDBACK";
  input: AddFeedbackInput;
};
export type MarkFeedbackRoutedAction = Action & {
  type: "MARK_FEEDBACK_ROUTED";
  input: MarkFeedbackRoutedInput;
};
export type MarkFeedbackRouteFailedAction = Action & {
  type: "MARK_FEEDBACK_ROUTE_FAILED";
  input: MarkFeedbackRouteFailedInput;
};
export type DismissAttentionAction = Action & {
  type: "DISMISS_ATTENTION";
  input: DismissAttentionInput;
};
export type ResolveAttentionAction = Action & {
  type: "RESOLVE_ATTENTION";
  input: ResolveAttentionInput;
};

export type ReportRegistryAttentionAction =
  | RequestReviewAction
  | MarkOpenedAction
  | MarkReadAction
  | MarkUnreadAction
  | AddFeedbackAction
  | MarkFeedbackRoutedAction
  | MarkFeedbackRouteFailedAction
  | DismissAttentionAction
  | ResolveAttentionAction;

