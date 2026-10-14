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
  DispatchAction,
  DispatchDocument,
} from "document-models/dispatch/v1";
import {
  assertIsDispatchDocument,
  isDispatchDocument,
} from "./gen/document-schema.js";

/** Hook to get a Dispatch document by its id */
export function useDispatchDocumentById(
  documentId: string | null | undefined,
):
  | [DispatchDocument, DocumentDispatch<DispatchAction>]
  | [undefined, undefined] {
  const [document, dispatch] = useDocumentById(documentId);
  if (!isDispatchDocument(document)) return [undefined, undefined];
  return [document, dispatch];
}

/** Hook to get the selected Dispatch document */
export function useSelectedDispatchDocument(): [
  DispatchDocument,
  DocumentDispatch<DispatchAction>,
] {
  const [document, dispatch] = useSelectedDocument();

  assertIsDispatchDocument(document);
  return [document, dispatch] as const;
}

/** Hook to get all Dispatch documents in the selected drive */
export function useDispatchDocumentsInSelectedDrive() {
  const documentsInSelectedDrive = useDocumentsInSelectedDrive();
  return documentsInSelectedDrive?.filter(isDispatchDocument);
}

/** Hook to get all Dispatch documents in the selected folder */
export function useDispatchDocumentsInSelectedFolder() {
  const documentsInSelectedFolder = useDocumentsInSelectedFolder();
  return documentsInSelectedFolder?.filter(isDispatchDocument);
}
