/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  AddFeedbackInputSchema,
  DismissAttentionInputSchema,
  MarkFeedbackRoutedInputSchema,
  MarkFeedbackRouteFailedInputSchema,
  MarkOpenedInputSchema,
  MarkReadInputSchema,
  MarkUnreadInputSchema,
  RequestReviewInputSchema,
  ResolveAttentionInputSchema,
} from "../schema/zod.js";
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
import type {
  AddFeedbackAction,
  DismissAttentionAction,
  MarkFeedbackRoutedAction,
  MarkFeedbackRouteFailedAction,
  MarkOpenedAction,
  MarkReadAction,
  MarkUnreadAction,
  RequestReviewAction,
  ResolveAttentionAction,
} from "./actions.js";

export const requestReview = (input: RequestReviewInput) =>
  createAction<RequestReviewAction>(
    "REQUEST_REVIEW",
    { ...input },
    undefined,
    RequestReviewInputSchema,
    "global",
  );

export const markOpened = (input: MarkOpenedInput) =>
  createAction<MarkOpenedAction>(
    "MARK_OPENED",
    { ...input },
    undefined,
    MarkOpenedInputSchema,
    "global",
  );

export const markRead = (input: MarkReadInput) =>
  createAction<MarkReadAction>(
    "MARK_READ",
    { ...input },
    undefined,
    MarkReadInputSchema,
    "global",
  );

export const markUnread = (input: MarkUnreadInput) =>
  createAction<MarkUnreadAction>(
    "MARK_UNREAD",
    { ...input },
    undefined,
    MarkUnreadInputSchema,
    "global",
  );

export const addFeedback = (input: AddFeedbackInput) =>
  createAction<AddFeedbackAction>(
    "ADD_FEEDBACK",
    { ...input },
    undefined,
    AddFeedbackInputSchema,
    "global",
  );

export const markFeedbackRouted = (input: MarkFeedbackRoutedInput) =>
  createAction<MarkFeedbackRoutedAction>(
    "MARK_FEEDBACK_ROUTED",
    { ...input },
    undefined,
    MarkFeedbackRoutedInputSchema,
    "global",
  );

export const markFeedbackRouteFailed = (input: MarkFeedbackRouteFailedInput) =>
  createAction<MarkFeedbackRouteFailedAction>(
    "MARK_FEEDBACK_ROUTE_FAILED",
    { ...input },
    undefined,
    MarkFeedbackRouteFailedInputSchema,
    "global",
  );

export const dismissAttention = (input: DismissAttentionInput) =>
  createAction<DismissAttentionAction>(
    "DISMISS_ATTENTION",
    { ...input },
    undefined,
    DismissAttentionInputSchema,
    "global",
  );

export const resolveAttention = (input: ResolveAttentionInput) =>
  createAction<ResolveAttentionAction>(
    "RESOLVE_ATTENTION",
    { ...input },
    undefined,
    ResolveAttentionInputSchema,
    "global",
  );

