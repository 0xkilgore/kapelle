/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { ReportRegistryGlobalState } from "../types.js";
import type { SupersedeReportAction, WithdrawReportAction } from "./actions.js";

export interface ReportRegistryLifecycleOperations {
  supersedeReportOperation: (
    state: ReportRegistryGlobalState,
    action: SupersedeReportAction,
    dispatch?: SignalDispatch,
  ) => void;
  withdrawReportOperation: (
    state: ReportRegistryGlobalState,
    action: WithdrawReportAction,
    dispatch?: SignalDispatch,
  ) => void;
}

