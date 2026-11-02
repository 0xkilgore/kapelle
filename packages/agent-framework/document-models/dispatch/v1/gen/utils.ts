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
import { dispatchUpgradeManifest } from "../../upgrades/upgrade-manifest.js";
import {
  assertIsDispatchDocument,
  assertIsDispatchState,
  isDispatchDocument,
  isDispatchState,
} from "./document-schema.js";
import { dispatchDocumentType } from "./document-type.js";
import { reducer } from "./reducer.js";
import type {
  DispatchGlobalState,
  DispatchLocalState,
  DispatchPHState,
} from "./types.js";

export const initialGlobalState: DispatchGlobalState = {
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
export const initialLocalState: DispatchLocalState = {};

export const utils: DocumentModelUtils<DispatchPHState> = {
  fileExtension: "phdispatch",
  createState(state) {
    return {
      ...createBaseState(state?.auth, { version: 1, ...state?.document }),
      global: { ...initialGlobalState, ...state?.global },
      local: { ...initialLocalState, ...state?.local },
    };
  },
  createDocument(state) {
    return baseCreateDocument(utils.createState, state, dispatchDocumentType);
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInputVersioned(input, {
      reducers: { 1: reducer as unknown as Reducer<PHBaseState> },
      upgradeManifest: dispatchUpgradeManifest,
    });
  },
  isStateOfType(state) {
    return isDispatchState(state);
  },
  assertIsStateOfType(state) {
    return assertIsDispatchState(state);
  },
  isDocumentOfType(document) {
    return isDispatchDocument(document);
  },
  assertIsDocumentOfType(document) {
    return assertIsDispatchDocument(document);
  },
};
