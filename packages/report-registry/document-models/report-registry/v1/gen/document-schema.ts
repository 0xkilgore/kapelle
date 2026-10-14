/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import {
  BaseDocumentHeaderSchema,
  BaseDocumentStateSchema,
} from "document-model";
import { z } from "zod";
import { reportRegistryDocumentType } from "./document-type.js";
import { ReportRegistryStateSchema } from "./schema/zod.js";
import type { ReportRegistryDocument, ReportRegistryPHState } from "./types.js";

/** Schema for validating the header object of a ReportRegistry document */
export const ReportRegistryDocumentHeaderSchema =
  BaseDocumentHeaderSchema.extend({
    documentType: z.literal(reportRegistryDocumentType),
  });

/** Schema for validating the state object of a ReportRegistry document */
export const ReportRegistryPHStateSchema = BaseDocumentStateSchema.extend({
  global: ReportRegistryStateSchema(),
});

export const ReportRegistryDocumentSchema = z.object({
  header: ReportRegistryDocumentHeaderSchema,
  state: ReportRegistryPHStateSchema,
  initialState: ReportRegistryPHStateSchema,
});

/** Simple helper function to check if a state object is a ReportRegistry document state object */
export function isReportRegistryState(
  state: unknown,
): state is ReportRegistryPHState {
  return ReportRegistryPHStateSchema.safeParse(state).success;
}

/** Simple helper function to assert that a document state object is a ReportRegistry document state object */
export function assertIsReportRegistryState(
  state: unknown,
): asserts state is ReportRegistryPHState {
  ReportRegistryPHStateSchema.parse(state);
}

/** Simple helper function to check if a document is a ReportRegistry document */
export function isReportRegistryDocument(
  document: unknown,
): document is ReportRegistryDocument {
  return ReportRegistryDocumentSchema.safeParse(document).success;
}

/** Simple helper function to assert that a document is a ReportRegistry document */
export function assertIsReportRegistryDocument(
  document: unknown,
): asserts document is ReportRegistryDocument {
  ReportRegistryDocumentSchema.parse(document);
}

