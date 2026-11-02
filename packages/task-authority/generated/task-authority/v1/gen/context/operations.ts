/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { TaskAuthorityGlobalState } from "../types.js";
import type {
  AddCommentAction,
  AddDependencyAction,
  AddExternalRefAction,
  AddLabelAction,
  RemoveDependencyAction,
  RemoveExternalRefAction,
  RemoveLabelAction,
} from "./actions.js";

export interface TaskAuthorityContextOperations {
  addLabelOperation: (
    state: TaskAuthorityGlobalState,
    action: AddLabelAction,
    dispatch?: SignalDispatch,
  ) => void;
  removeLabelOperation: (
    state: TaskAuthorityGlobalState,
    action: RemoveLabelAction,
    dispatch?: SignalDispatch,
  ) => void;
  addCommentOperation: (
    state: TaskAuthorityGlobalState,
    action: AddCommentAction,
    dispatch?: SignalDispatch,
  ) => void;
  addDependencyOperation: (
    state: TaskAuthorityGlobalState,
    action: AddDependencyAction,
    dispatch?: SignalDispatch,
  ) => void;
  removeDependencyOperation: (
    state: TaskAuthorityGlobalState,
    action: RemoveDependencyAction,
    dispatch?: SignalDispatch,
  ) => void;
  addExternalRefOperation: (
    state: TaskAuthorityGlobalState,
    action: AddExternalRefAction,
    dispatch?: SignalDispatch,
  ) => void;
  removeExternalRefOperation: (
    state: TaskAuthorityGlobalState,
    action: RemoveExternalRefAction,
    dispatch?: SignalDispatch,
  ) => void;
}
