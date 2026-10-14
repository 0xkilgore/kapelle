/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { DispatchGlobalState } from "../types.js";
import type {
  AcceptDispatchAction,
  CreateDispatchAction,
  RecordDispatchResultAction,
  RequestDispatchCancelAction,
} from "./actions.js";

export interface DispatchControlOperations {
  createDispatchOperation: (
    state: DispatchGlobalState,
    action: CreateDispatchAction,
    dispatch?: SignalDispatch,
  ) => void;
  acceptDispatchOperation: (
    state: DispatchGlobalState,
    action: AcceptDispatchAction,
    dispatch?: SignalDispatch,
  ) => void;
  requestDispatchCancelOperation: (
    state: DispatchGlobalState,
    action: RequestDispatchCancelAction,
    dispatch?: SignalDispatch,
  ) => void;
  recordDispatchResultOperation: (
    state: DispatchGlobalState,
    action: RecordDispatchResultAction,
    dispatch?: SignalDispatch,
  ) => void;
}
