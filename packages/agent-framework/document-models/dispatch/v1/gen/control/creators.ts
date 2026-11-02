/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  AcceptDispatchInputSchema,
  CreateDispatchInputSchema,
  RecordDispatchResultInputSchema,
  RequestDispatchCancelInputSchema,
} from "../schema/zod.js";
import type {
  AcceptDispatchInput,
  CreateDispatchInput,
  RecordDispatchResultInput,
  RequestDispatchCancelInput,
} from "../types.js";
import type {
  AcceptDispatchAction,
  CreateDispatchAction,
  RecordDispatchResultAction,
  RequestDispatchCancelAction,
} from "./actions.js";

export const createDispatch = (input: CreateDispatchInput) =>
  createAction<CreateDispatchAction>(
    "CREATE_DISPATCH",
    { ...input },
    undefined,
    CreateDispatchInputSchema,
    "global",
  );

export const acceptDispatch = (input: AcceptDispatchInput) =>
  createAction<AcceptDispatchAction>(
    "ACCEPT_DISPATCH",
    { ...input },
    undefined,
    AcceptDispatchInputSchema,
    "global",
  );

export const requestDispatchCancel = (input: RequestDispatchCancelInput) =>
  createAction<RequestDispatchCancelAction>(
    "REQUEST_DISPATCH_CANCEL",
    { ...input },
    undefined,
    RequestDispatchCancelInputSchema,
    "global",
  );

export const recordDispatchResult = (input: RecordDispatchResultInput) =>
  createAction<RecordDispatchResultAction>(
    "RECORD_DISPATCH_RESULT",
    { ...input },
    undefined,
    RecordDispatchResultInputSchema,
    "global",
  );
