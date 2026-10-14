/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 * Factory methods for creating ReviewIntentDocument instances
 */
import type { PHAuthState, PHBaseState, PHDocumentState } from "document-model";
import { createBaseState, defaultBaseState } from "document-model";
import type {
  ReviewIntentDocument,
  ReviewIntentGlobalState,
  ReviewIntentLocalState,
  ReviewIntentPHState,
} from "./types.js";
import { utils } from "./utils.js";

export function defaultGlobalState(): ReviewIntentGlobalState {
  return {
    revision: 0,
    ownerId: null,
    createdAt: null,
    updatedAt: null,
    reviewId: null,
    instanceId: null,
    scopeRef: null,
    proposal: null,
    status: "PROPOSED",
    decision: null,
    invalidatedReason: null,
    effect: null,
    delivery: [],
  };
}

export function defaultLocalState(): ReviewIntentLocalState {
  return {};
}

export function defaultPHState(): ReviewIntentPHState {
  return {
    ...defaultBaseState(),
    global: defaultGlobalState(),
    local: defaultLocalState(),
  };
}

export function createGlobalState(
  state?: Partial<ReviewIntentGlobalState>,
): ReviewIntentGlobalState {
  return {
    ...defaultGlobalState(),
    ...(state || {}),
  };
}

export function createLocalState(
  state?: Partial<ReviewIntentLocalState>,
): ReviewIntentLocalState {
  return {
    ...defaultLocalState(),
    ...(state || {}),
  } as ReviewIntentLocalState;
}

export function createState(
  baseState?: Partial<PHBaseState>,
  globalState?: Partial<ReviewIntentGlobalState>,
  localState?: Partial<ReviewIntentLocalState>,
): ReviewIntentPHState {
  return {
    ...createBaseState(baseState?.auth, baseState?.document),
    global: createGlobalState(globalState),
    local: createLocalState(localState),
  };
}

/**
 * Creates a ReviewIntentDocument with custom global and local state
 * This properly handles the PHBaseState requirements while allowing
 * document-specific state to be set.
 */
export function createReviewIntentDocument(
  state?: Partial<{
    auth?: Partial<PHAuthState>;
    document?: Partial<PHDocumentState>;
    global?: Partial<ReviewIntentGlobalState>;
    local?: Partial<ReviewIntentLocalState>;
  }>,
): ReviewIntentDocument {
  const document = utils.createDocument(
    createState(
      createBaseState(state?.auth, { version: 1, ...state?.document }),
      state?.global,
      state?.local,
    ),
  );

  return document;
}
