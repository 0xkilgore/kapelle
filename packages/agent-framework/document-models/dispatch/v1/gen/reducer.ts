/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Reducer, StateReducer } from "document-model";
import { createReducer, isDocumentAction } from "document-model";
import type { DispatchPHState } from "document-models/dispatch/v1";

import { dispatchControlOperations } from "../src/reducers/control.js";

import {
  AcceptDispatchInputSchema,
  CreateDispatchInputSchema,
  RecordDispatchResultInputSchema,
  RequestDispatchCancelInputSchema,
} from "./schema/zod.js";

const stateReducer: StateReducer<DispatchPHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }
  switch (action.type) {
    case "CREATE_DISPATCH": {
      CreateDispatchInputSchema().parse(action.input);

      dispatchControlOperations.createDispatchOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ACCEPT_DISPATCH": {
      AcceptDispatchInputSchema().parse(action.input);

      dispatchControlOperations.acceptDispatchOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REQUEST_DISPATCH_CANCEL": {
      RequestDispatchCancelInputSchema().parse(action.input);

      dispatchControlOperations.requestDispatchCancelOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "RECORD_DISPATCH_RESULT": {
      RecordDispatchResultInputSchema().parse(action.input);

      dispatchControlOperations.recordDispatchResultOperation(
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

export const reducer: Reducer<DispatchPHState> = createReducer(stateReducer);
