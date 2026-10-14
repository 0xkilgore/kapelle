/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { ReportRegistryGlobalState } from "../types.js";
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

export interface ReportRegistryAttentionOperations {
  requestReviewOperation: (
    state: ReportRegistryGlobalState,
    action: RequestReviewAction,
    dispatch?: SignalDispatch,
  ) => void;
  markOpenedOperation: (
    state: ReportRegistryGlobalState,
    action: MarkOpenedAction,
    dispatch?: SignalDispatch,
  ) => void;
  markReadOperation: (
    state: ReportRegistryGlobalState,
    action: MarkReadAction,
    dispatch?: SignalDispatch,
  ) => void;
  markUnreadOperation: (
    state: ReportRegistryGlobalState,
    action: MarkUnreadAction,
    dispatch?: SignalDispatch,
  ) => void;
  addFeedbackOperation: (
    state: ReportRegistryGlobalState,
    action: AddFeedbackAction,
    dispatch?: SignalDispatch,
  ) => void;
  markFeedbackRoutedOperation: (
    state: ReportRegistryGlobalState,
    action: MarkFeedbackRoutedAction,
    dispatch?: SignalDispatch,
  ) => void;
  markFeedbackRouteFailedOperation: (
    state: ReportRegistryGlobalState,
    action: MarkFeedbackRouteFailedAction,
    dispatch?: SignalDispatch,
  ) => void;
  dismissAttentionOperation: (
    state: ReportRegistryGlobalState,
    action: DismissAttentionAction,
    dispatch?: SignalDispatch,
  ) => void;
  resolveAttentionOperation: (
    state: ReportRegistryGlobalState,
    action: ResolveAttentionAction,
    dispatch?: SignalDispatch,
  ) => void;
}

