/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { DocumentModelUtils, PHBaseState, Reducer } from "document-model";
import {
  baseCreateDocument,
  baseLoadFromInputVersioned,
  baseSaveToFileHandle,
  createBaseState,
} from "document-model";
import { reviewIntentUpgradeManifest } from "../../upgrades/upgrade-manifest.js";
import {
  assertIsReviewIntentDocument,
  assertIsReviewIntentState,
  isReviewIntentDocument,
  isReviewIntentState,
} from "./document-schema.js";
import { reviewIntentDocumentType } from "./document-type.js";
import { reducer } from "./reducer.js";
import type {
  ReviewIntentGlobalState,
  ReviewIntentLocalState,
  ReviewIntentPHState,
} from "./types.js";

export const initialGlobalState: ReviewIntentGlobalState = {
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
export const initialLocalState: ReviewIntentLocalState = {};

export const utils: DocumentModelUtils<ReviewIntentPHState> = {
  fileExtension: "phreview",
  createState(state) {
    return {
      ...createBaseState(state?.auth, { version: 1, ...state?.document }),
      global: { ...initialGlobalState, ...state?.global },
      local: { ...initialLocalState, ...state?.local },
    };
  },
  createDocument(state) {
    return baseCreateDocument(
      utils.createState,
      state,
      reviewIntentDocumentType,
    );
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInputVersioned(input, {
      reducers: { 1: reducer as unknown as Reducer<PHBaseState> },
      upgradeManifest: reviewIntentUpgradeManifest,
    });
  },
  isStateOfType(state) {
    return isReviewIntentState(state);
  },
  assertIsStateOfType(state) {
    return assertIsReviewIntentState(state);
  },
  isDocumentOfType(document) {
    return isReviewIntentDocument(document);
  },
  assertIsDocumentOfType(document) {
    return assertIsReviewIntentDocument(document);
  },
};
