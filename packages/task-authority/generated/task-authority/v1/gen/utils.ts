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
import { taskAuthorityUpgradeManifest } from "../../upgrades/upgrade-manifest.js";
import {
  assertIsTaskAuthorityDocument,
  assertIsTaskAuthorityState,
  isTaskAuthorityDocument,
  isTaskAuthorityState,
} from "./document-schema.js";
import { taskAuthorityDocumentType } from "./document-type.js";
import { reducer } from "./reducer.js";
import type {
  TaskAuthorityGlobalState,
  TaskAuthorityLocalState,
  TaskAuthorityPHState,
} from "./types.js";

export const initialGlobalState: TaskAuthorityGlobalState = {
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
export const initialLocalState: TaskAuthorityLocalState = {};

export const utils: DocumentModelUtils<TaskAuthorityPHState> = {
  fileExtension: "phtask",
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
      taskAuthorityDocumentType,
    );
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInputVersioned(input, {
      reducers: { 1: reducer as unknown as Reducer<PHBaseState> },
      upgradeManifest: taskAuthorityUpgradeManifest,
    });
  },
  isStateOfType(state) {
    return isTaskAuthorityState(state);
  },
  assertIsStateOfType(state) {
    return assertIsTaskAuthorityState(state);
  },
  isDocumentOfType(document) {
    return isTaskAuthorityDocument(document);
  },
  assertIsDocumentOfType(document) {
    return assertIsTaskAuthorityDocument(document);
  },
};
