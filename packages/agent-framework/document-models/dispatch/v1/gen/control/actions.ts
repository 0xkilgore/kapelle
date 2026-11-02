/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type {
  AcceptDispatchInput,
  CreateDispatchInput,
  RecordDispatchResultInput,
  RequestDispatchCancelInput,
} from "../types.js";

export type CreateDispatchAction = Action & {
  type: "CREATE_DISPATCH";
  input: CreateDispatchInput;
};
export type AcceptDispatchAction = Action & {
  type: "ACCEPT_DISPATCH";
  input: AcceptDispatchInput;
};
export type RequestDispatchCancelAction = Action & {
  type: "REQUEST_DISPATCH_CANCEL";
  input: RequestDispatchCancelInput;
};
export type RecordDispatchResultAction = Action & {
  type: "RECORD_DISPATCH_RESULT";
  input: RecordDispatchResultInput;
};

export type DispatchControlAction =
  | CreateDispatchAction
  | AcceptDispatchAction
  | RequestDispatchCancelAction
  | RecordDispatchResultAction;
