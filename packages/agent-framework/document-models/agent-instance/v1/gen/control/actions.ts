/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import type { Action } from "document-model";
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

export type CreateInstanceAction = Action & {
  type: "CREATE_INSTANCE";
  input: CreateInstanceInput;
};
export type SetResponsibilitiesAction = Action & {
  type: "SET_RESPONSIBILITIES";
  input: SetResponsibilitiesInput;
};
export type SetOperatingPolicyAction = Action & {
  type: "SET_OPERATING_POLICY";
  input: SetOperatingPolicyInput;
};
export type EnableSkillAction = Action & {
  type: "ENABLE_SKILL";
  input: EnableSkillInput;
};
export type DisableSkillAction = Action & {
  type: "DISABLE_SKILL";
  input: DisableSkillInput;
};
export type GrantCapabilityAction = Action & {
  type: "GRANT_CAPABILITY";
  input: GrantCapabilityInput;
};
export type RevokeCapabilityAction = Action & {
  type: "REVOKE_CAPABILITY";
  input: RevokeCapabilityInput;
};
export type BindConnectionAction = Action & {
  type: "BIND_CONNECTION";
  input: BindConnectionInput;
};
export type RevokeConnectionAction = Action & {
  type: "REVOKE_CONNECTION";
  input: RevokeConnectionInput;
};
export type SetRuntimeBindingAction = Action & {
  type: "SET_RUNTIME_BINDING";
  input: SetRuntimeBindingInput;
};
export type SetModelPolicyAction = Action & {
  type: "SET_MODEL_POLICY";
  input: SetModelPolicyInput;
};
export type LinkDocumentAction = Action & {
  type: "LINK_DOCUMENT";
  input: LinkDocumentInput;
};
export type UnlinkDocumentAction = Action & {
  type: "UNLINK_DOCUMENT";
  input: UnlinkDocumentInput;
};
export type BindScheduleAction = Action & {
  type: "BIND_SCHEDULE";
  input: BindScheduleInput;
};
export type UnbindScheduleAction = Action & {
  type: "UNBIND_SCHEDULE";
  input: UnbindScheduleInput;
};
export type PinDefinitionVersionAction = Action & {
  type: "PIN_DEFINITION_VERSION";
  input: PinDefinitionVersionInput;
};
export type RequestPauseAction = Action & {
  type: "REQUEST_PAUSE";
  input: RequestPauseInput;
};
export type RequestResumeAction = Action & {
  type: "REQUEST_RESUME";
  input: RequestResumeInput;
};
export type RetireInstanceAction = Action & {
  type: "RETIRE_INSTANCE";
  input: RetireInstanceInput;
};

export type AgentInstanceControlAction =
  | CreateInstanceAction
  | SetResponsibilitiesAction
  | SetOperatingPolicyAction
  | EnableSkillAction
  | DisableSkillAction
  | GrantCapabilityAction
  | RevokeCapabilityAction
  | BindConnectionAction
  | RevokeConnectionAction
  | SetRuntimeBindingAction
  | SetModelPolicyAction
  | LinkDocumentAction
  | UnlinkDocumentAction
  | BindScheduleAction
  | UnbindScheduleAction
  | PinDefinitionVersionAction
  | RequestPauseAction
  | RequestResumeAction
  | RetireInstanceAction;
