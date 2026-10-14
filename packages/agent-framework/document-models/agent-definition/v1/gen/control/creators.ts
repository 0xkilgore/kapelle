/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import { PublishDefinitionInputSchema } from "../schema/zod.js";
import type { PublishDefinitionInput } from "../types.js";
import type { PublishDefinitionAction } from "./actions.js";

export const publishDefinition = (input: PublishDefinitionInput) =>
  createAction<PublishDefinitionAction>(
    "PUBLISH_DEFINITION",
    { ...input },
    undefined,
    PublishDefinitionInputSchema,
    "global",
  );
