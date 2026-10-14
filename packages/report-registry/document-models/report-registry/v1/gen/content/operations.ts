/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { ReportRegistryGlobalState } from "../types.js";
import type { PublishReportAction, RegisterReportAction } from "./actions.js";

export interface ReportRegistryContentOperations {
  registerReportOperation: (
    state: ReportRegistryGlobalState,
    action: RegisterReportAction,
    dispatch?: SignalDispatch,
  ) => void;
  publishReportOperation: (
    state: ReportRegistryGlobalState,
    action: PublishReportAction,
    dispatch?: SignalDispatch,
  ) => void;
}

