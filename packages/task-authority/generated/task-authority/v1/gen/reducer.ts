/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import type { Reducer, StateReducer } from "document-model";
import { createReducer, isDocumentAction } from "document-model";
import type { TaskAuthorityPHState } from "document-models/task-authority/v1";

import { taskAuthorityContentOperations } from "../src/reducers/content.js";
import { taskAuthorityContextOperations } from "../src/reducers/context.js";
import { taskAuthorityLifecycleOperations } from "../src/reducers/lifecycle.js";

import {
  AddCommentInputSchema,
  AddDependencyInputSchema,
  AddExternalRefInputSchema,
  AddLabelInputSchema,
  ArchiveTaskInputSchema,
  BlockTaskInputSchema,
  CompleteTaskInputSchema,
  CreateTaskInputSchema,
  RemoveDependencyInputSchema,
  RemoveExternalRefInputSchema,
  RemoveLabelInputSchema,
  ReopenTaskInputSchema,
  SetAssigneeInputSchema,
  SetDueInputSchema,
  SetPriorityInputSchema,
  SetProjectInputSchema,
  SnoozeTaskInputSchema,
  UnblockTaskInputSchema,
  UnsnoozeTaskInputSchema,
  UpdateBodyInputSchema,
  UpdateTitleInputSchema,
} from "./schema/zod.js";

const stateReducer: StateReducer<TaskAuthorityPHState> = (
  state,
  action,
  dispatch,
) => {
  if (isDocumentAction(action)) {
    return state;
  }
  switch (action.type) {
    case "CREATE_TASK": {
      CreateTaskInputSchema().parse(action.input);

      taskAuthorityContentOperations.createTaskOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "UPDATE_TITLE": {
      UpdateTitleInputSchema().parse(action.input);

      taskAuthorityContentOperations.updateTitleOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "UPDATE_BODY": {
      UpdateBodyInputSchema().parse(action.input);

      taskAuthorityContentOperations.updateBodyOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_PROJECT": {
      SetProjectInputSchema().parse(action.input);

      taskAuthorityContentOperations.setProjectOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_DUE": {
      SetDueInputSchema().parse(action.input);

      taskAuthorityContentOperations.setDueOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_PRIORITY": {
      SetPriorityInputSchema().parse(action.input);

      taskAuthorityContentOperations.setPriorityOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SET_ASSIGNEE": {
      SetAssigneeInputSchema().parse(action.input);

      taskAuthorityContentOperations.setAssigneeOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "COMPLETE_TASK": {
      CompleteTaskInputSchema().parse(action.input);

      taskAuthorityLifecycleOperations.completeTaskOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REOPEN_TASK": {
      ReopenTaskInputSchema().parse(action.input);

      taskAuthorityLifecycleOperations.reopenTaskOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "SNOOZE_TASK": {
      SnoozeTaskInputSchema().parse(action.input);

      taskAuthorityLifecycleOperations.snoozeTaskOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "UNSNOOZE_TASK": {
      UnsnoozeTaskInputSchema().parse(action.input);

      taskAuthorityLifecycleOperations.unsnoozeTaskOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "BLOCK_TASK": {
      BlockTaskInputSchema().parse(action.input);

      taskAuthorityLifecycleOperations.blockTaskOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "UNBLOCK_TASK": {
      UnblockTaskInputSchema().parse(action.input);

      taskAuthorityLifecycleOperations.unblockTaskOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ARCHIVE_TASK": {
      ArchiveTaskInputSchema().parse(action.input);

      taskAuthorityLifecycleOperations.archiveTaskOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ADD_LABEL": {
      AddLabelInputSchema().parse(action.input);

      taskAuthorityContextOperations.addLabelOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REMOVE_LABEL": {
      RemoveLabelInputSchema().parse(action.input);

      taskAuthorityContextOperations.removeLabelOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ADD_COMMENT": {
      AddCommentInputSchema().parse(action.input);

      taskAuthorityContextOperations.addCommentOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ADD_DEPENDENCY": {
      AddDependencyInputSchema().parse(action.input);

      taskAuthorityContextOperations.addDependencyOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REMOVE_DEPENDENCY": {
      RemoveDependencyInputSchema().parse(action.input);

      taskAuthorityContextOperations.removeDependencyOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "ADD_EXTERNAL_REF": {
      AddExternalRefInputSchema().parse(action.input);

      taskAuthorityContextOperations.addExternalRefOperation(
        (state as any)[action.scope],
        action as any,
        dispatch,
      );

      break;
    }

    case "REMOVE_EXTERNAL_REF": {
      RemoveExternalRefInputSchema().parse(action.input);

      taskAuthorityContextOperations.removeExternalRefOperation(
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

export const reducer: Reducer<TaskAuthorityPHState> =
  createReducer(stateReducer);
