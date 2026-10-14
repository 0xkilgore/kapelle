/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  AddCommentInput,
  AddDependencyInput,
  AddExternalRefInput,
  AddLabelInput,
  RemoveDependencyInput,
  RemoveExternalRefInput,
  RemoveLabelInput,
} from "../types.js";

export type AddLabelAction = Action & {
  type: "ADD_LABEL";
  input: AddLabelInput;
};
export type RemoveLabelAction = Action & {
  type: "REMOVE_LABEL";
  input: RemoveLabelInput;
};
export type AddCommentAction = Action & {
  type: "ADD_COMMENT";
  input: AddCommentInput;
};
export type AddDependencyAction = Action & {
  type: "ADD_DEPENDENCY";
  input: AddDependencyInput;
};
export type RemoveDependencyAction = Action & {
  type: "REMOVE_DEPENDENCY";
  input: RemoveDependencyInput;
};
export type AddExternalRefAction = Action & {
  type: "ADD_EXTERNAL_REF";
  input: AddExternalRefInput;
};
export type RemoveExternalRefAction = Action & {
  type: "REMOVE_EXTERNAL_REF";
  input: RemoveExternalRefInput;
};

export type TaskAuthorityContextAction =
  | AddLabelAction
  | RemoveLabelAction
  | AddCommentAction
  | AddDependencyAction
  | RemoveDependencyAction
  | AddExternalRefAction
  | RemoveExternalRefAction;
