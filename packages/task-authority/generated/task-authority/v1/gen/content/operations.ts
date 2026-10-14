/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { TaskAuthorityGlobalState } from "../types.js";
import type {
  CreateTaskAction,
  SetAssigneeAction,
  SetDueAction,
  SetPriorityAction,
  SetProjectAction,
  UpdateBodyAction,
  UpdateTitleAction,
} from "./actions.js";

export interface TaskAuthorityContentOperations {
  createTaskOperation: (
    state: TaskAuthorityGlobalState,
    action: CreateTaskAction,
    dispatch?: SignalDispatch,
  ) => void;
  updateTitleOperation: (
    state: TaskAuthorityGlobalState,
    action: UpdateTitleAction,
    dispatch?: SignalDispatch,
  ) => void;
  updateBodyOperation: (
    state: TaskAuthorityGlobalState,
    action: UpdateBodyAction,
    dispatch?: SignalDispatch,
  ) => void;
  setProjectOperation: (
    state: TaskAuthorityGlobalState,
    action: SetProjectAction,
    dispatch?: SignalDispatch,
  ) => void;
  setDueOperation: (
    state: TaskAuthorityGlobalState,
    action: SetDueAction,
    dispatch?: SignalDispatch,
  ) => void;
  setPriorityOperation: (
    state: TaskAuthorityGlobalState,
    action: SetPriorityAction,
    dispatch?: SignalDispatch,
  ) => void;
  setAssigneeOperation: (
    state: TaskAuthorityGlobalState,
    action: SetAssigneeAction,
    dispatch?: SignalDispatch,
  ) => void;
}
