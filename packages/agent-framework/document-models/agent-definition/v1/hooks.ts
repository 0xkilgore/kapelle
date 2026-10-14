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
  AgentDefinitionAction,
  AgentDefinitionDocument,
} from "document-models/agent-definition/v1";
import {
  assertIsAgentDefinitionDocument,
  isAgentDefinitionDocument,
} from "./gen/document-schema.js";

/** Hook to get a AgentDefinition document by its id */
export function useAgentDefinitionDocumentById(
  documentId: string | null | undefined,
):
  | [AgentDefinitionDocument, DocumentDispatch<AgentDefinitionAction>]
  | [undefined, undefined] {
  const [document, dispatch] = useDocumentById(documentId);
  if (!isAgentDefinitionDocument(document)) return [undefined, undefined];
  return [document, dispatch];
}

/** Hook to get the selected AgentDefinition document */
export function useSelectedAgentDefinitionDocument(): [
  AgentDefinitionDocument,
  DocumentDispatch<AgentDefinitionAction>,
] {
  const [document, dispatch] = useSelectedDocument();

  assertIsAgentDefinitionDocument(document);
  return [document, dispatch] as const;
}

/** Hook to get all AgentDefinition documents in the selected drive */
export function useAgentDefinitionDocumentsInSelectedDrive() {
  const documentsInSelectedDrive = useDocumentsInSelectedDrive();
  return documentsInSelectedDrive?.filter(isAgentDefinitionDocument);
}

/** Hook to get all AgentDefinition documents in the selected folder */
export function useAgentDefinitionDocumentsInSelectedFolder() {
  const documentsInSelectedFolder = useDocumentsInSelectedFolder();
  return documentsInSelectedFolder?.filter(isAgentDefinitionDocument);
}
