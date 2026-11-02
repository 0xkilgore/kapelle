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
  AgentInstanceAction,
  AgentInstanceDocument,
} from "document-models/agent-instance/v1";
import {
  assertIsAgentInstanceDocument,
  isAgentInstanceDocument,
} from "./gen/document-schema.js";

/** Hook to get a AgentInstance document by its id */
export function useAgentInstanceDocumentById(
  documentId: string | null | undefined,
):
  | [AgentInstanceDocument, DocumentDispatch<AgentInstanceAction>]
  | [undefined, undefined] {
  const [document, dispatch] = useDocumentById(documentId);
  if (!isAgentInstanceDocument(document)) return [undefined, undefined];
  return [document, dispatch];
}

/** Hook to get the selected AgentInstance document */
export function useSelectedAgentInstanceDocument(): [
  AgentInstanceDocument,
  DocumentDispatch<AgentInstanceAction>,
] {
  const [document, dispatch] = useSelectedDocument();

  assertIsAgentInstanceDocument(document);
  return [document, dispatch] as const;
}

/** Hook to get all AgentInstance documents in the selected drive */
export function useAgentInstanceDocumentsInSelectedDrive() {
  const documentsInSelectedDrive = useDocumentsInSelectedDrive();
  return documentsInSelectedDrive?.filter(isAgentInstanceDocument);
}

/** Hook to get all AgentInstance documents in the selected folder */
export function useAgentInstanceDocumentsInSelectedFolder() {
  const documentsInSelectedFolder = useDocumentsInSelectedFolder();
  return documentsInSelectedFolder?.filter(isAgentInstanceDocument);
}
