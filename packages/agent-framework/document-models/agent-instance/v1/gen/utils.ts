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
import { agentInstanceUpgradeManifest } from "../../upgrades/upgrade-manifest.js";
import {
  assertIsAgentInstanceDocument,
  assertIsAgentInstanceState,
  isAgentInstanceDocument,
  isAgentInstanceState,
} from "./document-schema.js";
import { agentInstanceDocumentType } from "./document-type.js";
import { reducer } from "./reducer.js";
import type {
  AgentInstanceGlobalState,
  AgentInstanceLocalState,
  AgentInstancePHState,
} from "./types.js";

export const initialGlobalState: AgentInstanceGlobalState = {
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
export const initialLocalState: AgentInstanceLocalState = {};

export const utils: DocumentModelUtils<AgentInstancePHState> = {
  fileExtension: "phagent",
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
      agentInstanceDocumentType,
    );
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInputVersioned(input, {
      reducers: { 1: reducer as unknown as Reducer<PHBaseState> },
      upgradeManifest: agentInstanceUpgradeManifest,
    });
  },
  isStateOfType(state) {
    return isAgentInstanceState(state);
  },
  assertIsStateOfType(state) {
    return assertIsAgentInstanceState(state);
  },
  isDocumentOfType(document) {
    return isAgentInstanceDocument(document);
  },
  assertIsDocumentOfType(document) {
    return assertIsAgentInstanceDocument(document);
  },
};
