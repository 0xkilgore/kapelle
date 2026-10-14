/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  SupersedeReportInputSchema,
  WithdrawReportInputSchema,
} from "../schema/zod.js";
import type { SupersedeReportInput, WithdrawReportInput } from "../types.js";
import type { SupersedeReportAction, WithdrawReportAction } from "./actions.js";

export const supersedeReport = (input: SupersedeReportInput) =>
  createAction<SupersedeReportAction>(
    "SUPERSEDE_REPORT",
    { ...input },
    undefined,
    SupersedeReportInputSchema,
    "global",
  );

export const withdrawReport = (input: WithdrawReportInput) =>
  createAction<WithdrawReportAction>(
    "WITHDRAW_REPORT",
    { ...input },
    undefined,
    WithdrawReportInputSchema,
    "global",
  );

