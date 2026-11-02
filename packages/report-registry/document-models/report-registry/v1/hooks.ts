/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { DocumentDispatch } from "@powerhousedao/reactor-browser";
import {
  useDocumentById,
  useDocumentsInSelectedDrive,
  useDocumentsInSelectedFolder,
  useSelectedDocument,
} from "@powerhousedao/reactor-browser";
import type {
  ReportRegistryAction,
  ReportRegistryDocument,
} from "document-models/report-registry/v1";
import {
  assertIsReportRegistryDocument,
  isReportRegistryDocument,
} from "./gen/document-schema.js";

/** Hook to get a ReportRegistry document by its id */
export function useReportRegistryDocumentById(
  documentId: string | null | undefined,
):
  | [ReportRegistryDocument, DocumentDispatch<ReportRegistryAction>]
  | [undefined, undefined] {
  const [document, dispatch] = useDocumentById(documentId);
  if (!isReportRegistryDocument(document)) return [undefined, undefined];
  return [document, dispatch];
}

/** Hook to get the selected ReportRegistry document */
export function useSelectedReportRegistryDocument(): [
  ReportRegistryDocument,
  DocumentDispatch<ReportRegistryAction>,
] {
  const [document, dispatch] = useSelectedDocument();

  assertIsReportRegistryDocument(document);
  return [document, dispatch] as const;
}

/** Hook to get all ReportRegistry documents in the selected drive */
export function useReportRegistryDocumentsInSelectedDrive() {
  const documentsInSelectedDrive = useDocumentsInSelectedDrive();
  return documentsInSelectedDrive?.filter(isReportRegistryDocument);
}

/** Hook to get all ReportRegistry documents in the selected folder */
export function useReportRegistryDocumentsInSelectedFolder() {
  const documentsInSelectedFolder = useDocumentsInSelectedFolder();
  return documentsInSelectedFolder?.filter(isReportRegistryDocument);
}

