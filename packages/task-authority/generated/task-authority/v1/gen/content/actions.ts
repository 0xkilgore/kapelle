/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  CreateTaskInput,
  SetAssigneeInput,
  SetDueInput,
  SetPriorityInput,
  SetProjectInput,
  UpdateBodyInput,
  UpdateTitleInput,
} from "../types.js";

export type CreateTaskAction = Action & {
  type: "CREATE_TASK";
  input: CreateTaskInput;
};
export type UpdateTitleAction = Action & {
  type: "UPDATE_TITLE";
  input: UpdateTitleInput;
};
export type UpdateBodyAction = Action & {
  type: "UPDATE_BODY";
  input: UpdateBodyInput;
};
export type SetProjectAction = Action & {
  type: "SET_PROJECT";
  input: SetProjectInput;
};
export type SetDueAction = Action & { type: "SET_DUE"; input: SetDueInput };
export type SetPriorityAction = Action & {
  type: "SET_PRIORITY";
  input: SetPriorityInput;
};
export type SetAssigneeAction = Action & {
  type: "SET_ASSIGNEE";
  input: SetAssigneeInput;
};

export type TaskAuthorityContentAction =
  | CreateTaskAction
  | UpdateTitleAction
  | UpdateBodyAction
  | SetProjectAction
  | SetDueAction
  | SetPriorityAction
  | SetAssigneeAction;
