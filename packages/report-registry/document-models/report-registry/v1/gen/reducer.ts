/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Reducer, StateReducer } from "document-model";
import { createReducer, isDocumentAction } from "document-model";
import type { ReportRegistryPHState } from "document-models/report-registry/v1";

import { reportRegistryAttentionOperations } from "../src/reducers/attention.js";
import { reportRegistryContentOperations } from "../src/reducers/content.js";
import { reportRegistryLifecycleOperations } from "../src/reducers/lifecycle.js";

import {
  AddFeedbackInputSchema,
  DismissAttentionInputSchema,
  MarkFeedbackRoutedInputSchema,
  MarkFeedbackRouteFailedInputSchema,
  MarkOpenedInputSchema,
  MarkReadInputSchema,
  MarkUnreadInputSchema,
  PublishReportInputSchema,
  RegisterReportInputSchema,
  RequestReviewInputSchema,
  ResolveAttentionInputSchema,
  SupersedeReportInputSchema,
  WithdrawReportInputSchema,
} from "./schema/zod.js";

const stateReducer: StateReducer<ReportRegistryPHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }
  switch (action.type) {
    case "REGISTER_REPORT": {
      RegisterReportInputSchema().parse(action.input);

      reportRegistryContentOperations.registerReportOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "PUBLISH_REPORT": {
      PublishReportInputSchema().parse(action.input);

      reportRegistryContentOperations.publishReportOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REQUEST_REVIEW": {
      RequestReviewInputSchema().parse(action.input);

      reportRegistryAttentionOperations.requestReviewOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "MARK_OPENED": {
      MarkOpenedInputSchema().parse(action.input);

      reportRegistryAttentionOperations.markOpenedOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "MARK_READ": {
      MarkReadInputSchema().parse(action.input);

      reportRegistryAttentionOperations.markReadOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "MARK_UNREAD": {
      MarkUnreadInputSchema().parse(action.input);

      reportRegistryAttentionOperations.markUnreadOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ADD_FEEDBACK": {
      AddFeedbackInputSchema().parse(action.input);

      reportRegistryAttentionOperations.addFeedbackOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "MARK_FEEDBACK_ROUTED": {
      MarkFeedbackRoutedInputSchema().parse(action.input);

      reportRegistryAttentionOperations.markFeedbackRoutedOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "MARK_FEEDBACK_ROUTE_FAILED": {
      MarkFeedbackRouteFailedInputSchema().parse(action.input);

      reportRegistryAttentionOperations.markFeedbackRouteFailedOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "DISMISS_ATTENTION": {
      DismissAttentionInputSchema().parse(action.input);

      reportRegistryAttentionOperations.dismissAttentionOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "RESOLVE_ATTENTION": {
      ResolveAttentionInputSchema().parse(action.input);

      reportRegistryAttentionOperations.resolveAttentionOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SUPERSEDE_REPORT": {
      SupersedeReportInputSchema().parse(action.input);

      reportRegistryLifecycleOperations.supersedeReportOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "WITHDRAW_REPORT": {
      WithdrawReportInputSchema().parse(action.input);

      reportRegistryLifecycleOperations.withdrawReportOperation(
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

export const reducer: Reducer<ReportRegistryPHState> =
  createReducer(stateReducer);

