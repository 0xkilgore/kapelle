/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 * Factory methods for creating DispatchDocument instances
 */
import type { PHAuthState, PHBaseState, PHDocumentState } from "document-model";
import { createBaseState, defaultBaseState } from "document-model";
import type {
  DispatchDocument,
  DispatchGlobalState,
  DispatchLocalState,
  DispatchPHState,
} from "./types.js";
import { utils } from "./utils.js";

export function defaultGlobalState(): DispatchGlobalState {
  return {
    revision: 0,
    ownerId: null,
    createdAt: null,
    updatedAt: null,
    dispatchId: null,
    scopeRef: null,
    offer: null,
    phase: "OFFERED",
    acceptance: null,
    result: null,
    cancellationReason: null,
  };
}

export function defaultLocalState(): DispatchLocalState {
  return {};
}

export function defaultPHState(): DispatchPHState {
  return {
    ...defaultBaseState(),
    global: defaultGlobalState(),
    local: defaultLocalState(),
  };
}

export function createGlobalState(
  state?: Partial<DispatchGlobalState>,
): DispatchGlobalState {
  return {
    ...defaultGlobalState(),
    ...(state || {}),
  };
}

export function createLocalState(
  state?: Partial<DispatchLocalState>,
): DispatchLocalState {
  return {
    ...defaultLocalState(),
    ...(state || {}),
  } as DispatchLocalState;
}

export function createState(
  baseState?: Partial<PHBaseState>,
  globalState?: Partial<DispatchGlobalState>,
  localState?: Partial<DispatchLocalState>,
): DispatchPHState {
  return {
    ...createBaseState(baseState?.auth, baseState?.document),
    global: createGlobalState(globalState),
    local: createLocalState(localState),
  };
}

/**
 * Creates a DispatchDocument with custom global and local state
 * This properly handles the PHBaseState requirements while allowing
 * document-specific state to be set.
 */
export function createDispatchDocument(
  state?: Partial<{
    auth?: Partial<PHAuthState>;
    document?: Partial<PHDocumentState>;
    global?: Partial<DispatchGlobalState>;
    local?: Partial<DispatchLocalState>;
  }>,
): DispatchDocument {
  const document = utils.createDocument(
    createState(
      createBaseState(state?.auth, { version: 1, ...state?.document }),
      state?.global,
      state?.local,
    ),
  );

  return document;
}
