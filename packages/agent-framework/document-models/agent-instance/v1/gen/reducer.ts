/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Reducer, StateReducer } from "document-model";
import { createReducer, isDocumentAction } from "document-model";
import type { AgentInstancePHState } from "document-models/agent-instance/v1";

import { agentInstanceControlOperations } from "../src/reducers/control.js";

import {
  BindConnectionInputSchema,
  BindScheduleInputSchema,
  CreateInstanceInputSchema,
  DisableSkillInputSchema,
  EnableSkillInputSchema,
  GrantCapabilityInputSchema,
  LinkDocumentInputSchema,
  PinDefinitionVersionInputSchema,
  RequestPauseInputSchema,
  RequestResumeInputSchema,
  RetireInstanceInputSchema,
  RevokeCapabilityInputSchema,
  RevokeConnectionInputSchema,
  SetModelPolicyInputSchema,
  SetOperatingPolicyInputSchema,
  SetResponsibilitiesInputSchema,
  SetRuntimeBindingInputSchema,
  UnbindScheduleInputSchema,
  UnlinkDocumentInputSchema,
} from "./schema/zod.js";

const stateReducer: StateReducer<AgentInstancePHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }
  switch (action.type) {
    case "CREATE_INSTANCE": {
      CreateInstanceInputSchema().parse(action.input);

      agentInstanceControlOperations.createInstanceOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_RESPONSIBILITIES": {
      SetResponsibilitiesInputSchema().parse(action.input);

      agentInstanceControlOperations.setResponsibilitiesOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_OPERATING_POLICY": {
      SetOperatingPolicyInputSchema().parse(action.input);

      agentInstanceControlOperations.setOperatingPolicyOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ENABLE_SKILL": {
      EnableSkillInputSchema().parse(action.input);

      agentInstanceControlOperations.enableSkillOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "DISABLE_SKILL": {
      DisableSkillInputSchema().parse(action.input);

      agentInstanceControlOperations.disableSkillOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "GRANT_CAPABILITY": {
      GrantCapabilityInputSchema().parse(action.input);

      agentInstanceControlOperations.grantCapabilityOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REVOKE_CAPABILITY": {
      RevokeCapabilityInputSchema().parse(action.input);

      agentInstanceControlOperations.revokeCapabilityOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "BIND_CONNECTION": {
      BindConnectionInputSchema().parse(action.input);

      agentInstanceControlOperations.bindConnectionOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REVOKE_CONNECTION": {
      RevokeConnectionInputSchema().parse(action.input);

      agentInstanceControlOperations.revokeConnectionOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_RUNTIME_BINDING": {
      SetRuntimeBindingInputSchema().parse(action.input);

      agentInstanceControlOperations.setRuntimeBindingOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_MODEL_POLICY": {
      SetModelPolicyInputSchema().parse(action.input);

      agentInstanceControlOperations.setModelPolicyOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "LINK_DOCUMENT": {
      LinkDocumentInputSchema().parse(action.input);

      agentInstanceControlOperations.linkDocumentOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "UNLINK_DOCUMENT": {
      UnlinkDocumentInputSchema().parse(action.input);

      agentInstanceControlOperations.unlinkDocumentOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "BIND_SCHEDULE": {
      BindScheduleInputSchema().parse(action.input);

      agentInstanceControlOperations.bindScheduleOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "UNBIND_SCHEDULE": {
      UnbindScheduleInputSchema().parse(action.input);

      agentInstanceControlOperations.unbindScheduleOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "PIN_DEFINITION_VERSION": {
      PinDefinitionVersionInputSchema().parse(action.input);

      agentInstanceControlOperations.pinDefinitionVersionOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REQUEST_PAUSE": {
      RequestPauseInputSchema().parse(action.input);

      agentInstanceControlOperations.requestPauseOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REQUEST_RESUME": {
      RequestResumeInputSchema().parse(action.input);

      agentInstanceControlOperations.requestResumeOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "RETIRE_INSTANCE": {
      RetireInstanceInputSchema().parse(action.input);

      agentInstanceControlOperations.retireInstanceOperation(
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

export const reducer: Reducer<AgentInstancePHState> =
  createReducer(stateReducer);
