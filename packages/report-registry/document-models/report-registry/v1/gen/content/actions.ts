/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type { PublishReportInput, RegisterReportInput } from "../types.js";

export type RegisterReportAction = Action & {
  type: "REGISTER_REPORT";
  input: RegisterReportInput;
};
export type PublishReportAction = Action & {
  type: "PUBLISH_REPORT";
  input: PublishReportInput;
};

export type ReportRegistryContentAction =
  | RegisterReportAction
  | PublishReportAction;

