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
  TaskAuthorityAction,
  TaskAuthorityDocument,
} from "document-models/task-authority/v1";
import {
  assertIsTaskAuthorityDocument,
  isTaskAuthorityDocument,
} from "./gen/document-schema.js";

/** Hook to get a TaskAuthority document by its id */
export function useTaskAuthorityDocumentById(
  documentId: string | null | undefined,
):
  | [TaskAuthorityDocument, DocumentDispatch<TaskAuthorityAction>]
  | [undefined, undefined] {
  const [document, dispatch] = useDocumentById(documentId);
  if (!isTaskAuthorityDocument(document)) return [undefined, undefined];
  return [document, dispatch];
}

/** Hook to get the selected TaskAuthority document */
export function useSelectedTaskAuthorityDocument(): [
  TaskAuthorityDocument,
  DocumentDispatch<TaskAuthorityAction>,
] {
  const [document, dispatch] = useSelectedDocument();

  assertIsTaskAuthorityDocument(document);
  return [document, dispatch] as const;
}

/** Hook to get all TaskAuthority documents in the selected drive */
export function useTaskAuthorityDocumentsInSelectedDrive() {
  const documentsInSelectedDrive = useDocumentsInSelectedDrive();
  return documentsInSelectedDrive?.filter(isTaskAuthorityDocument);
}

/** Hook to get all TaskAuthority documents in the selected folder */
export function useTaskAuthorityDocumentsInSelectedFolder() {
  const documentsInSelectedFolder = useDocumentsInSelectedFolder();
  return documentsInSelectedFolder?.filter(isTaskAuthorityDocument);
}
