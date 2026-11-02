/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  CreateTaskInputSchema,
  SetAssigneeInputSchema,
  SetDueInputSchema,
  SetPriorityInputSchema,
  SetProjectInputSchema,
  UpdateBodyInputSchema,
  UpdateTitleInputSchema,
} from "../schema/zod.js";
import type {
  CreateTaskInput,
  SetAssigneeInput,
  SetDueInput,
  SetPriorityInput,
  SetProjectInput,
  UpdateBodyInput,
  UpdateTitleInput,
} from "../types.js";
import type {
  CreateTaskAction,
  SetAssigneeAction,
  SetDueAction,
  SetPriorityAction,
  SetProjectAction,
  UpdateBodyAction,
  UpdateTitleAction,
} from "./actions.js";

export const createTask = (input: CreateTaskInput) =>
  createAction<CreateTaskAction>(
    "CREATE_TASK",
    { ...input },
    undefined,
    CreateTaskInputSchema,
    "global",
  );

export const updateTitle = (input: UpdateTitleInput) =>
  createAction<UpdateTitleAction>(
    "UPDATE_TITLE",
    { ...input },
    undefined,
    UpdateTitleInputSchema,
    "global",
  );

export const updateBody = (input: UpdateBodyInput) =>
  createAction<UpdateBodyAction>(
    "UPDATE_BODY",
    { ...input },
    undefined,
    UpdateBodyInputSchema,
    "global",
  );

export const setProject = (input: SetProjectInput) =>
  createAction<SetProjectAction>(
    "SET_PROJECT",
    { ...input },
    undefined,
    SetProjectInputSchema,
    "global",
  );

export const setDue = (input: SetDueInput) =>
  createAction<SetDueAction>(
    "SET_DUE",
    { ...input },
    undefined,
    SetDueInputSchema,
    "global",
  );

export const setPriority = (input: SetPriorityInput) =>
  createAction<SetPriorityAction>(
    "SET_PRIORITY",
    { ...input },
    undefined,
    SetPriorityInputSchema,
    "global",
  );

export const setAssignee = (input: SetAssigneeInput) =>
  createAction<SetAssigneeAction>(
    "SET_ASSIGNEE",
    { ...input },
    undefined,
    SetAssigneeInputSchema,
    "global",
  );
