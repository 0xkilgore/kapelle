/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 * Factory methods for creating AgentDefinitionDocument instances
 */
import type { PHAuthState, PHBaseState, PHDocumentState } from "document-model";
import { createBaseState, defaultBaseState } from "document-model";
import type {
  AgentDefinitionDocument,
  AgentDefinitionGlobalState,
  AgentDefinitionLocalState,
  AgentDefinitionPHState,
} from "./types.js";
import { utils } from "./utils.js";

export function defaultGlobalState(): AgentDefinitionGlobalState {
  return {
    revision: 0,
    ownerId: null,
    createdAt: null,
    updatedAt: null,
    release: null,
  };
}

export function defaultLocalState(): AgentDefinitionLocalState {
  return {};
}

export function defaultPHState(): AgentDefinitionPHState {
  return {
    ...defaultBaseState(),
    global: defaultGlobalState(),
    local: defaultLocalState(),
  };
}

export function createGlobalState(
  state?: Partial<AgentDefinitionGlobalState>,
): AgentDefinitionGlobalState {
  return {
    ...defaultGlobalState(),
    ...(state || {}),
  };
}

export function createLocalState(
  state?: Partial<AgentDefinitionLocalState>,
): AgentDefinitionLocalState {
  return {
    ...defaultLocalState(),
    ...(state || {}),
  } as AgentDefinitionLocalState;
}

export function createState(
  baseState?: Partial<PHBaseState>,
  globalState?: Partial<AgentDefinitionGlobalState>,
  localState?: Partial<AgentDefinitionLocalState>,
): AgentDefinitionPHState {
  return {
    ...createBaseState(baseState?.auth, baseState?.document),
    global: createGlobalState(globalState),
    local: createLocalState(localState),
  };
}

/**
 * Creates a AgentDefinitionDocument with custom global and local state
 * This properly handles the PHBaseState requirements while allowing
 * document-specific state to be set.
 */
export function createAgentDefinitionDocument(
  state?: Partial<{
    auth?: Partial<PHAuthState>;
    document?: Partial<PHDocumentState>;
    global?: Partial<AgentDefinitionGlobalState>;
    local?: Partial<AgentDefinitionLocalState>;
  }>,
): AgentDefinitionDocument {
  const document = utils.createDocument(
    createState(
      createBaseState(state?.auth, { version: 1, ...state?.document }),
      state?.global,
      state?.local,
    ),
  );

  return document;
}
