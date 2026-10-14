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
import { agentDefinitionUpgradeManifest } from "../../upgrades/upgrade-manifest.js";
import {
  assertIsAgentDefinitionDocument,
  assertIsAgentDefinitionState,
  isAgentDefinitionDocument,
  isAgentDefinitionState,
} from "./document-schema.js";
import { agentDefinitionDocumentType } from "./document-type.js";
import { reducer } from "./reducer.js";
import type {
  AgentDefinitionGlobalState,
  AgentDefinitionLocalState,
  AgentDefinitionPHState,
} from "./types.js";

export const initialGlobalState: AgentDefinitionGlobalState = {
  revision: 0,
  ownerId: null,
  createdAt: null,
  updatedAt: null,
  release: null,
};
export const initialLocalState: AgentDefinitionLocalState = {};

export const utils: DocumentModelUtils<AgentDefinitionPHState> = {
  fileExtension: "phagentdef",
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
      agentDefinitionDocumentType,
    );
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInputVersioned(input, {
      reducers: { 1: reducer as unknown as Reducer<PHBaseState> },
      upgradeManifest: agentDefinitionUpgradeManifest,
    });
  },
  isStateOfType(state) {
    return isAgentDefinitionState(state);
  },
  assertIsStateOfType(state) {
    return assertIsAgentDefinitionState(state);
  },
  isDocumentOfType(document) {
    return isAgentDefinitionDocument(document);
  },
  assertIsDocumentOfType(document) {
    return assertIsAgentDefinitionDocument(document);
  },
};
