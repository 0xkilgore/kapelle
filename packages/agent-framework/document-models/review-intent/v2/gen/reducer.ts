/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Reducer, StateReducer } from "document-model";
import { createReducer, isDocumentAction } from "document-model";
import type { ReviewIntentPHState } from "document-models/review-intent/v2";

import { reviewIntentControlOperations } from "../src/reducers/control.js";

import {
  ClaimExecutionInputSchema,
  CreateReviewInputSchema,
  InvalidateReviewInputSchema,
  RecordDecisionInputSchema,
  RecordDeliveryInputSchema,
  ReserveEffectInputSchema,
} from "./schema/zod.js";

const stateReducer: StateReducer<ReviewIntentPHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }
  switch (action.type) {
    case "CREATE_REVIEW": {
      CreateReviewInputSchema().parse(action.input);

      reviewIntentControlOperations.createReviewOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "RECORD_DECISION": {
      RecordDecisionInputSchema().parse(action.input);

      reviewIntentControlOperations.recordDecisionOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "INVALIDATE_REVIEW": {
      InvalidateReviewInputSchema().parse(action.input);

      reviewIntentControlOperations.invalidateReviewOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "RESERVE_EFFECT": {
      ReserveEffectInputSchema().parse(action.input);

      reviewIntentControlOperations.reserveEffectOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "RECORD_DELIVERY": {
      RecordDeliveryInputSchema().parse(action.input);

      reviewIntentControlOperations.recordDeliveryOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "CLAIM_EXECUTION": {
      ClaimExecutionInputSchema().parse(action.input);

      reviewIntentControlOperations.claimExecutionOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    default:
      return state;
  }
};

export const reducer: Reducer<ReviewIntentPHState> =
  createReducer(stateReducer);
