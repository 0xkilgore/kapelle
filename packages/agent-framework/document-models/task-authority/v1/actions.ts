/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { baseActions } from "document-model";
import {
  taskAuthorityContentActions,
  taskAuthorityContextActions,
  taskAuthorityLifecycleActions,
} from "./gen/creators.js";

/** Actions for the TaskAuthority document model */

export const actions = {
  ...baseActions,
  ...taskAuthorityContentActions,
  ...taskAuthorityLifecycleActions,
  ...taskAuthorityContextActions,
};
