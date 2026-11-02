/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  AddCommentInputSchema,
  AddDependencyInputSchema,
  AddExternalRefInputSchema,
  AddLabelInputSchema,
  RemoveDependencyInputSchema,
  RemoveExternalRefInputSchema,
  RemoveLabelInputSchema,
} from "../schema/zod.js";
import type {
  AddCommentInput,
  AddDependencyInput,
  AddExternalRefInput,
  AddLabelInput,
  RemoveDependencyInput,
  RemoveExternalRefInput,
  RemoveLabelInput,
} from "../types.js";
import type {
  AddCommentAction,
  AddDependencyAction,
  AddExternalRefAction,
  AddLabelAction,
  RemoveDependencyAction,
  RemoveExternalRefAction,
  RemoveLabelAction,
} from "./actions.js";

export const addLabel = (input: AddLabelInput) =>
  createAction<AddLabelAction>(
    "ADD_LABEL",
    { ...input },
    undefined,
    AddLabelInputSchema,
    "global",
  );

export const removeLabel = (input: RemoveLabelInput) =>
  createAction<RemoveLabelAction>(
    "REMOVE_LABEL",
    { ...input },
    undefined,
    RemoveLabelInputSchema,
    "global",
  );

export const addComment = (input: AddCommentInput) =>
  createAction<AddCommentAction>(
    "ADD_COMMENT",
    { ...input },
    undefined,
    AddCommentInputSchema,
    "global",
  );

export const addDependency = (input: AddDependencyInput) =>
  createAction<AddDependencyAction>(
    "ADD_DEPENDENCY",
    { ...input },
    undefined,
    AddDependencyInputSchema,
    "global",
  );

export const removeDependency = (input: RemoveDependencyInput) =>
  createAction<RemoveDependencyAction>(
    "REMOVE_DEPENDENCY",
    { ...input },
    undefined,
    RemoveDependencyInputSchema,
    "global",
  );

export const addExternalRef = (input: AddExternalRefInput) =>
  createAction<AddExternalRefAction>(
    "ADD_EXTERNAL_REF",
    { ...input },
    undefined,
    AddExternalRefInputSchema,
    "global",
  );

export const removeExternalRef = (input: RemoveExternalRefInput) =>
  createAction<RemoveExternalRefAction>(
    "REMOVE_EXTERNAL_REF",
    { ...input },
    undefined,
    RemoveExternalRefInputSchema,
    "global",
  );
