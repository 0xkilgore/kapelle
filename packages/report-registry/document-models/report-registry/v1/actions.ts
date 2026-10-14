/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { baseActions } from "document-model";
import {
  reportRegistryAttentionActions,
  reportRegistryContentActions,
  reportRegistryLifecycleActions,
} from "./gen/creators.js";

/** Actions for the ReportRegistry document model */

export const actions = {
  ...baseActions,
  ...reportRegistryContentActions,
  ...reportRegistryAttentionActions,
  ...reportRegistryLifecycleActions,
};

