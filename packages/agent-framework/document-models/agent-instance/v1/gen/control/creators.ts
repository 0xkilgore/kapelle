/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { createAction } from "document-model";
import {
  BindConnectionInputSchema,
  BindScheduleInputSchema,
  CreateInstanceInputSchema,
  DisableSkillInputSchema,
  EnableSkillInputSchema,
  GrantCapabilityInputSchema,
  LinkDocumentInputSchema,
  PinDefinitionVersionInputSchema,
  RequestPauseInputSchema,
  RequestResumeInputSchema,
  RetireInstanceInputSchema,
  RevokeCapabilityInputSchema,
  RevokeConnectionInputSchema,
  SetModelPolicyInputSchema,
  SetOperatingPolicyInputSchema,
  SetResponsibilitiesInputSchema,
  SetRuntimeBindingInputSchema,
  UnbindScheduleInputSchema,
  UnlinkDocumentInputSchema,
} from "../schema/zod.js";
import type {
  BindConnectionInput,
  BindScheduleInput,
  CreateInstanceInput,
  DisableSkillInput,
  EnableSkillInput,
  GrantCapabilityInput,
  LinkDocumentInput,
  PinDefinitionVersionInput,
  RequestPauseInput,
  RequestResumeInput,
  RetireInstanceInput,
  RevokeCapabilityInput,
  RevokeConnectionInput,
  SetModelPolicyInput,
  SetOperatingPolicyInput,
  SetResponsibilitiesInput,
  SetRuntimeBindingInput,
  UnbindScheduleInput,
  UnlinkDocumentInput,
} from "../types.js";
import type {
  BindConnectionAction,
  BindScheduleAction,
  CreateInstanceAction,
  DisableSkillAction,
  EnableSkillAction,
  GrantCapabilityAction,
  LinkDocumentAction,
  PinDefinitionVersionAction,
  RequestPauseAction,
  RequestResumeAction,
  RetireInstanceAction,
  RevokeCapabilityAction,
  RevokeConnectionAction,
  SetModelPolicyAction,
  SetOperatingPolicyAction,
  SetResponsibilitiesAction,
  SetRuntimeBindingAction,
  UnbindScheduleAction,
  UnlinkDocumentAction,
} from "./actions.js";

export const createInstance = (input: CreateInstanceInput) =>
  createAction<CreateInstanceAction>(
    "CREATE_INSTANCE",
    { ...input },
    undefined,
    CreateInstanceInputSchema,
    "global",
  );

export const setResponsibilities = (input: SetResponsibilitiesInput) =>
  createAction<SetResponsibilitiesAction>(
    "SET_RESPONSIBILITIES",
    { ...input },
    undefined,
    SetResponsibilitiesInputSchema,
    "global",
  );

export const setOperatingPolicy = (input: SetOperatingPolicyInput) =>
  createAction<SetOperatingPolicyAction>(
    "SET_OPERATING_POLICY",
    { ...input },
    undefined,
    SetOperatingPolicyInputSchema,
    "global",
  );

export const enableSkill = (input: EnableSkillInput) =>
  createAction<EnableSkillAction>(
    "ENABLE_SKILL",
    { ...input },
    undefined,
    EnableSkillInputSchema,
    "global",
  );

export const disableSkill = (input: DisableSkillInput) =>
  createAction<DisableSkillAction>(
    "DISABLE_SKILL",
    { ...input },
    undefined,
    DisableSkillInputSchema,
    "global",
  );

export const grantCapability = (input: GrantCapabilityInput) =>
  createAction<GrantCapabilityAction>(
    "GRANT_CAPABILITY",
    { ...input },
    undefined,
    GrantCapabilityInputSchema,
    "global",
  );

export const revokeCapability = (input: RevokeCapabilityInput) =>
  createAction<RevokeCapabilityAction>(
    "REVOKE_CAPABILITY",
    { ...input },
    undefined,
    RevokeCapabilityInputSchema,
    "global",
  );

export const bindConnection = (input: BindConnectionInput) =>
  createAction<BindConnectionAction>(
    "BIND_CONNECTION",
    { ...input },
    undefined,
    BindConnectionInputSchema,
    "global",
  );

export const revokeConnection = (input: RevokeConnectionInput) =>
  createAction<RevokeConnectionAction>(
    "REVOKE_CONNECTION",
    { ...input },
    undefined,
    RevokeConnectionInputSchema,
    "global",
  );

export const setRuntimeBinding = (input: SetRuntimeBindingInput) =>
  createAction<SetRuntimeBindingAction>(
    "SET_RUNTIME_BINDING",
    { ...input },
    undefined,
    SetRuntimeBindingInputSchema,
    "global",
  );

export const setModelPolicy = (input: SetModelPolicyInput) =>
  createAction<SetModelPolicyAction>(
    "SET_MODEL_POLICY",
    { ...input },
    undefined,
    SetModelPolicyInputSchema,
    "global",
  );

export const linkDocument = (input: LinkDocumentInput) =>
  createAction<LinkDocumentAction>(
    "LINK_DOCUMENT",
    { ...input },
    undefined,
    LinkDocumentInputSchema,
    "global",
  );

export const unlinkDocument = (input: UnlinkDocumentInput) =>
  createAction<UnlinkDocumentAction>(
    "UNLINK_DOCUMENT",
    { ...input },
    undefined,
    UnlinkDocumentInputSchema,
    "global",
  );

export const bindSchedule = (input: BindScheduleInput) =>
  createAction<BindScheduleAction>(
    "BIND_SCHEDULE",
    { ...input },
    undefined,
    BindScheduleInputSchema,
    "global",
  );

export const unbindSchedule = (input: UnbindScheduleInput) =>
  createAction<UnbindScheduleAction>(
    "UNBIND_SCHEDULE",
    { ...input },
    undefined,
    UnbindScheduleInputSchema,
    "global",
  );

export const pinDefinitionVersion = (input: PinDefinitionVersionInput) =>
  createAction<PinDefinitionVersionAction>(
    "PIN_DEFINITION_VERSION",
    { ...input },
    undefined,
    PinDefinitionVersionInputSchema,
    "global",
  );

export const requestPause = (input: RequestPauseInput) =>
  createAction<RequestPauseAction>(
    "REQUEST_PAUSE",
    { ...input },
    undefined,
    RequestPauseInputSchema,
    "global",
  );

export const requestResume = (input: RequestResumeInput) =>
  createAction<RequestResumeAction>(
    "REQUEST_RESUME",
    { ...input },
    undefined,
    RequestResumeInputSchema,
    "global",
  );

export const retireInstance = (input: RetireInstanceInput) =>
  createAction<RetireInstanceAction>(
    "RETIRE_INSTANCE",
    { ...input },
    undefined,
    RetireInstanceInputSchema,
    "global",
  );
