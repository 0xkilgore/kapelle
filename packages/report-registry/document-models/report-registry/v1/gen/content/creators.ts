/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  PublishReportInputSchema,
  RegisterReportInputSchema,
} from "../schema/zod.js";
import type { PublishReportInput, RegisterReportInput } from "../types.js";
import type { PublishReportAction, RegisterReportAction } from "./actions.js";

export const registerReport = (input: RegisterReportInput) =>
  createAction<RegisterReportAction>(
    "REGISTER_REPORT",
    { ...input },
    undefined,
    RegisterReportInputSchema,
    "global",
  );

export const publishReport = (input: PublishReportInput) =>
  createAction<PublishReportAction>(
    "PUBLISH_REPORT",
    { ...input },
    undefined,
    PublishReportInputSchema,
    "global",
  );

