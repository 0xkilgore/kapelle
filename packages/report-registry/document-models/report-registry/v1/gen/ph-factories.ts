/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 * Factory methods for creating ReportRegistryDocument instances
 */
import type { PHAuthState, PHBaseState, PHDocumentState } from "document-model";
import { createBaseState, defaultBaseState } from "document-model";
import type {
  ReportRegistryDocument,
  ReportRegistryGlobalState,
  ReportRegistryLocalState,
  ReportRegistryPHState,
} from "./types.js";
import { utils } from "./utils.js";

export function defaultGlobalState(): ReportRegistryGlobalState {
  return {
    id: null,
    schemaVersion: 1,
    reportRef: "",
    revision: 0,
    title: "",
    projectRef: null,
    familyRef: null,
    sourceRef: null,
    producer: null,
    content: null,
    lifecycle: "DRAFT",
    attention: {
      request: "NONE",
      reasonCode: null,
      reason: null,
      reviewBy: null,
      expiresAt: null,
      requestedBy: null,
      requestedAt: null,
      resolvedAt: null,
      resolution: null,
    },
    review: { openedAt: null, readAt: null, feedback: [] },
    supersedesRef: null,
    supersededByRef: null,
    createdAt: null,
    updatedAt: null,
    createdBy: "",
    updatedBy: "",
  };
}

export function defaultLocalState(): ReportRegistryLocalState {
  return {};
}

export function defaultPHState(): ReportRegistryPHState {
  return {
    ...defaultBaseState(),
    global: defaultGlobalState(),
    local: defaultLocalState(),
  };
}

export function createGlobalState(
  state?: Partial<ReportRegistryGlobalState>,
): ReportRegistryGlobalState {
  return {
    ...defaultGlobalState(),
    ...(state || {}),
  };
}

export function createLocalState(
  state?: Partial<ReportRegistryLocalState>,
): ReportRegistryLocalState {
  return {
    ...defaultLocalState(),
    ...(state || {}),
  } as ReportRegistryLocalState;
}

export function createState(
  baseState?: Partial<PHBaseState>,
  globalState?: Partial<ReportRegistryGlobalState>,
  localState?: Partial<ReportRegistryLocalState>,
): ReportRegistryPHState {
  return {
    ...createBaseState(baseState?.auth, baseState?.document),
    global: createGlobalState(globalState),
    local: createLocalState(localState),
  };
}

/**
 * Creates a ReportRegistryDocument with custom global and local state
 * This properly handles the PHBaseState requirements while allowing
 * document-specific state to be set.
 */
export function createReportRegistryDocument(
  state?: Partial<{
    auth?: Partial<PHAuthState>;
    document?: Partial<PHDocumentState>;
    global?: Partial<ReportRegistryGlobalState>;
    local?: Partial<ReportRegistryLocalState>;
  }>,
): ReportRegistryDocument {
  const document = utils.createDocument(
    createState(
      createBaseState(state?.auth, { version: 1, ...state?.document }),
      state?.global,
      state?.local,
    ),
  );

  return document;
}

