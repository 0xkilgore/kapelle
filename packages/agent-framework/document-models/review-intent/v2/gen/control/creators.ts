/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  ClaimExecutionInputSchema,
  CreateReviewInputSchema,
  InvalidateReviewInputSchema,
  RecordDecisionInputSchema,
  RecordDeliveryInputSchema,
  ReserveEffectInputSchema,
} from "../schema/zod.js";
import type {
  ClaimExecutionInput,
  CreateReviewInput,
  InvalidateReviewInput,
  RecordDecisionInput,
  RecordDeliveryInput,
  ReserveEffectInput,
} from "../types.js";
import type {
  ClaimExecutionAction,
  CreateReviewAction,
  InvalidateReviewAction,
  RecordDecisionAction,
  RecordDeliveryAction,
  ReserveEffectAction,
} from "./actions.js";

export const createReview = (input: CreateReviewInput) =>
  createAction<CreateReviewAction>(
    "CREATE_REVIEW",
    { ...input },
    undefined,
    CreateReviewInputSchema,
    "global",
  );

export const recordDecision = (input: RecordDecisionInput) =>
  createAction<RecordDecisionAction>(
    "RECORD_DECISION",
    { ...input },
    undefined,
    RecordDecisionInputSchema,
    "global",
  );

export const invalidateReview = (input: InvalidateReviewInput) =>
  createAction<InvalidateReviewAction>(
    "INVALIDATE_REVIEW",
    { ...input },
    undefined,
    InvalidateReviewInputSchema,
    "global",
  );

export const reserveEffect = (input: ReserveEffectInput) =>
  createAction<ReserveEffectAction>(
    "RESERVE_EFFECT",
    { ...input },
    undefined,
    ReserveEffectInputSchema,
    "global",
  );

export const recordDelivery = (input: RecordDeliveryInput) =>
  createAction<RecordDeliveryAction>(
    "RECORD_DELIVERY",
    { ...input },
    undefined,
    RecordDeliveryInputSchema,
    "global",
  );

export const claimExecution = (input: ClaimExecutionInput) =>
  createAction<ClaimExecutionAction>(
    "CLAIM_EXECUTION",
    { ...input },
    undefined,
    ClaimExecutionInputSchema,
    "global",
  );
