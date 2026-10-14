/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { ReviewIntentGlobalState } from "../types.js";
import type {
  CreateReviewAction,
  InvalidateReviewAction,
  RecordDecisionAction,
  RecordDeliveryAction,
  ReserveEffectAction,
} from "./actions.js";

export interface ReviewIntentControlOperations {
  createReviewOperation: (
    state: ReviewIntentGlobalState,
    action: CreateReviewAction,
    dispatch?: SignalDispatch,
  ) => void;
  recordDecisionOperation: (
    state: ReviewIntentGlobalState,
    action: RecordDecisionAction,
    dispatch?: SignalDispatch,
  ) => void;
  invalidateReviewOperation: (
    state: ReviewIntentGlobalState,
    action: InvalidateReviewAction,
    dispatch?: SignalDispatch,
  ) => void;
  reserveEffectOperation: (
    state: ReviewIntentGlobalState,
    action: ReserveEffectAction,
    dispatch?: SignalDispatch,
  ) => void;
  recordDeliveryOperation: (
    state: ReviewIntentGlobalState,
    action: RecordDeliveryAction,
    dispatch?: SignalDispatch,
  ) => void;
}
