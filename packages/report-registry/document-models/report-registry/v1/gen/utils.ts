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
import { reportRegistryUpgradeManifest } from "../../upgrades/upgrade-manifest.js";
import {
  assertIsReportRegistryDocument,
  assertIsReportRegistryState,
  isReportRegistryDocument,
  isReportRegistryState,
} from "./document-schema.js";
import { reportRegistryDocumentType } from "./document-type.js";
import { reducer } from "./reducer.js";
import type {
  ReportRegistryGlobalState,
  ReportRegistryLocalState,
  ReportRegistryPHState,
} from "./types.js";

export const initialGlobalState: ReportRegistryGlobalState = {
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
export const initialLocalState: ReportRegistryLocalState = {};

export const utils: DocumentModelUtils<ReportRegistryPHState> = {
  fileExtension: "phreport",
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
      reportRegistryDocumentType,
    );
  },
  saveToFileHandle(document, input) {
    return baseSaveToFileHandle(document, input);
  },
  loadFromInput(input) {
    return baseLoadFromInputVersioned(input, {
      reducers: { 1: reducer as unknown as Reducer<PHBaseState> },
      upgradeManifest: reportRegistryUpgradeManifest,
    });
  },
  isStateOfType(state) {
    return isReportRegistryState(state);
  },
  assertIsStateOfType(state) {
    return assertIsReportRegistryState(state);
  },
  isDocumentOfType(document) {
    return isReportRegistryDocument(document);
  },
  assertIsDocumentOfType(document) {
    return assertIsReportRegistryDocument(document);
  },
};

