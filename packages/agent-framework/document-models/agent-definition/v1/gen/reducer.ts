/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Reducer, StateReducer } from "document-model";
import { createReducer, isDocumentAction } from "document-model";
import type { AgentDefinitionPHState } from "document-models/agent-definition/v1";

import { agentDefinitionControlOperations } from "../src/reducers/control.js";

import { PublishDefinitionInputSchema } from "./schema/zod.js";

const stateReducer: StateReducer<AgentDefinitionPHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }
  switch (action.type) {
    case "PUBLISH_DEFINITION": {
      PublishDefinitionInputSchema().parse(action.input);

      agentDefinitionControlOperations.publishDefinitionOperation(
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

export const reducer: Reducer<AgentDefinitionPHState> =
  createReducer(stateReducer);
