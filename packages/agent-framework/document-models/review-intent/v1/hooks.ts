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
  ReviewIntentAction,
  ReviewIntentDocument,
} from "document-models/review-intent/v1";
import {
  assertIsReviewIntentDocument,
  isReviewIntentDocument,
} from "./gen/document-schema.js";

/** Hook to get a ReviewIntent document by its id */
export function useReviewIntentDocumentById(
  documentId: string | null | undefined,
):
  | [ReviewIntentDocument, DocumentDispatch<ReviewIntentAction>]
  | [undefined, undefined] {
  const [document, dispatch] = useDocumentById(documentId);
  if (!isReviewIntentDocument(document)) return [undefined, undefined];
  return [document, dispatch];
}

/** Hook to get the selected ReviewIntent document */
export function useSelectedReviewIntentDocument(): [
  ReviewIntentDocument,
  DocumentDispatch<ReviewIntentAction>,
] {
  const [document, dispatch] = useSelectedDocument();

  assertIsReviewIntentDocument(document);
  return [document, dispatch] as const;
}

/** Hook to get all ReviewIntent documents in the selected drive */
export function useReviewIntentDocumentsInSelectedDrive() {
  const documentsInSelectedDrive = useDocumentsInSelectedDrive();
  return documentsInSelectedDrive?.filter(isReviewIntentDocument);
}

/** Hook to get all ReviewIntent documents in the selected folder */
export function useReviewIntentDocumentsInSelectedFolder() {
  const documentsInSelectedFolder = useDocumentsInSelectedFolder();
  return documentsInSelectedFolder?.filter(isReviewIntentDocument);
}
