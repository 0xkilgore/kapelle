/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
import type { SupersedeReportInput, WithdrawReportInput } from "../types.js";

export type SupersedeReportAction = Action & {
  type: "SUPERSEDE_REPORT";
  input: SupersedeReportInput;
};
export type WithdrawReportAction = Action & {
  type: "WITHDRAW_REPORT";
  input: WithdrawReportInput;
};

export type ReportRegistryLifecycleAction =
  | SupersedeReportAction
  | WithdrawReportAction;

