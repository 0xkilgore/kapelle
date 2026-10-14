/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 * Factory methods for creating AgentInstanceDocument instances
 */
import type { PHAuthState, PHBaseState, PHDocumentState } from "document-model";
import { createBaseState, defaultBaseState } from "document-model";
import type {
  AgentInstanceDocument,
  AgentInstanceGlobalState,
  AgentInstanceLocalState,
  AgentInstancePHState,
} from "./types.js";
import { utils } from "./utils.js";

export function defaultGlobalState(): AgentInstanceGlobalState {
  return {
    revision: 0,
    ownerId: null,
    createdAt: null,
    updatedAt: null,
    instanceId: null,
    scopeRef: null,
    definitionRef: null,
    name: null,
    responsibilities: [],
    operatingPolicy: null,
    desiredState: "PAUSED",
    runtimeBindingRef: null,
    skills: [],
    grants: [],
    connections: [],
    documentLinks: [],
    schedules: [],
    modelPolicy: null,
  };
}

export function defaultLocalState(): AgentInstanceLocalState {
  return {};
}

export function defaultPHState(): AgentInstancePHState {
  return {
    ...defaultBaseState(),
    global: defaultGlobalState(),
    local: defaultLocalState(),
  };
}

export function createGlobalState(
  state?: Partial<AgentInstanceGlobalState>,
): AgentInstanceGlobalState {
  return {
    ...defaultGlobalState(),
    ...(state || {}),
  };
}

export function createLocalState(
  state?: Partial<AgentInstanceLocalState>,
): AgentInstanceLocalState {
  return {
    ...defaultLocalState(),
    ...(state || {}),
  } as AgentInstanceLocalState;
}

export function createState(
  baseState?: Partial<PHBaseState>,
  globalState?: Partial<AgentInstanceGlobalState>,
  localState?: Partial<AgentInstanceLocalState>,
): AgentInstancePHState {
  return {
    ...createBaseState(baseState?.auth, baseState?.document),
    global: createGlobalState(globalState),
    local: createLocalState(localState),
  };
}

/**
 * Creates a AgentInstanceDocument with custom global and local state
 * This properly handles the PHBaseState requirements while allowing
 * document-specific state to be set.
 */
export function createAgentInstanceDocument(
  state?: Partial<{
    auth?: Partial<PHAuthState>;
    document?: Partial<PHDocumentState>;
    global?: Partial<AgentInstanceGlobalState>;
    local?: Partial<AgentInstanceLocalState>;
  }>,
): AgentInstanceDocument {
  const document = utils.createDocument(
    createState(
      createBaseState(state?.auth, { version: 1, ...state?.document }),
      state?.global,
      state?.local,
    ),
  );

  return document;
}
