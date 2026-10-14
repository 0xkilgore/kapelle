/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 * Factory methods for creating TaskAuthorityDocument instances
 */
import type { PHAuthState, PHBaseState, PHDocumentState } from "document-model";
import { createBaseState, defaultBaseState } from "document-model";
import type {
  TaskAuthorityDocument,
  TaskAuthorityGlobalState,
  TaskAuthorityLocalState,
  TaskAuthorityPHState,
} from "./types.js";
import { utils } from "./utils.js";

export function defaultGlobalState(): TaskAuthorityGlobalState {
  return {
    id: null,
    schemaVersion: 1,
    title: "",
    bodyMarkdown: "",
    status: "OPEN",
    priority: null,
    projectId: null,
    labels: [],
    ownerId: "",
    assigneeId: null,
    dueAt: null,
    snoozedUntil: null,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
    archivedAt: null,
    openBlock: null,
    blockHistory: [],
    comments: [],
    dependsOn: [],
    externalRefs: [],
    source: "HUMAN",
    sourceRef: null,
    createdBy: "",
    updatedBy: "",
  };
}

export function defaultLocalState(): TaskAuthorityLocalState {
  return {};
}

export function defaultPHState(): TaskAuthorityPHState {
  return {
    ...defaultBaseState(),
    global: defaultGlobalState(),
    local: defaultLocalState(),
  };
}

export function createGlobalState(
  state?: Partial<TaskAuthorityGlobalState>,
): TaskAuthorityGlobalState {
  return {
    ...defaultGlobalState(),
    ...(state || {}),
  };
}

export function createLocalState(
  state?: Partial<TaskAuthorityLocalState>,
): TaskAuthorityLocalState {
  return {
    ...defaultLocalState(),
    ...(state || {}),
  } as TaskAuthorityLocalState;
}

export function createState(
  baseState?: Partial<PHBaseState>,
  globalState?: Partial<TaskAuthorityGlobalState>,
  localState?: Partial<TaskAuthorityLocalState>,
): TaskAuthorityPHState {
  return {
    ...createBaseState(baseState?.auth, baseState?.document),
    global: createGlobalState(globalState),
    local: createLocalState(localState),
  };
}

/**
 * Creates a TaskAuthorityDocument with custom global and local state
 * This properly handles the PHBaseState requirements while allowing
 * document-specific state to be set.
 */
export function createTaskAuthorityDocument(
  state?: Partial<{
    auth?: Partial<PHAuthState>;
    document?: Partial<PHDocumentState>;
    global?: Partial<TaskAuthorityGlobalState>;
    local?: Partial<TaskAuthorityLocalState>;
  }>,
): TaskAuthorityDocument {
  const document = utils.createDocument(
    createState(
      createBaseState(state?.auth, { version: 1, ...state?.document }),
      state?.global,
      state?.local,
    ),
  );

  return document;
}
