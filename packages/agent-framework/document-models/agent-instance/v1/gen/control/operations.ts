/**
 * WARNING: DO NOT EDIT
 * This file is auto-generated and updated by codegen
 */
import { type SignalDispatch } from "document-model";
import type { AgentInstanceGlobalState } from "../types.js";
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

export interface AgentInstanceControlOperations {
  createInstanceOperation: (
    state: AgentInstanceGlobalState,
    action: CreateInstanceAction,
    dispatch?: SignalDispatch,
  ) => void;
  setResponsibilitiesOperation: (
    state: AgentInstanceGlobalState,
    action: SetResponsibilitiesAction,
    dispatch?: SignalDispatch,
  ) => void;
  setOperatingPolicyOperation: (
    state: AgentInstanceGlobalState,
    action: SetOperatingPolicyAction,
    dispatch?: SignalDispatch,
  ) => void;
  enableSkillOperation: (
    state: AgentInstanceGlobalState,
    action: EnableSkillAction,
    dispatch?: SignalDispatch,
  ) => void;
  disableSkillOperation: (
    state: AgentInstanceGlobalState,
    action: DisableSkillAction,
    dispatch?: SignalDispatch,
  ) => void;
  grantCapabilityOperation: (
    state: AgentInstanceGlobalState,
    action: GrantCapabilityAction,
    dispatch?: SignalDispatch,
  ) => void;
  revokeCapabilityOperation: (
    state: AgentInstanceGlobalState,
    action: RevokeCapabilityAction,
    dispatch?: SignalDispatch,
  ) => void;
  bindConnectionOperation: (
    state: AgentInstanceGlobalState,
    action: BindConnectionAction,
    dispatch?: SignalDispatch,
  ) => void;
  revokeConnectionOperation: (
    state: AgentInstanceGlobalState,
    action: RevokeConnectionAction,
    dispatch?: SignalDispatch,
  ) => void;
  setRuntimeBindingOperation: (
    state: AgentInstanceGlobalState,
    action: SetRuntimeBindingAction,
    dispatch?: SignalDispatch,
  ) => void;
  setModelPolicyOperation: (
    state: AgentInstanceGlobalState,
    action: SetModelPolicyAction,
    dispatch?: SignalDispatch,
  ) => void;
  linkDocumentOperation: (
    state: AgentInstanceGlobalState,
    action: LinkDocumentAction,
    dispatch?: SignalDispatch,
  ) => void;
  unlinkDocumentOperation: (
    state: AgentInstanceGlobalState,
    action: UnlinkDocumentAction,
    dispatch?: SignalDispatch,
  ) => void;
  bindScheduleOperation: (
    state: AgentInstanceGlobalState,
    action: BindScheduleAction,
    dispatch?: SignalDispatch,
  ) => void;
  unbindScheduleOperation: (
    state: AgentInstanceGlobalState,
    action: UnbindScheduleAction,
    dispatch?: SignalDispatch,
  ) => void;
  pinDefinitionVersionOperation: (
    state: AgentInstanceGlobalState,
    action: PinDefinitionVersionAction,
    dispatch?: SignalDispatch,
  ) => void;
  requestPauseOperation: (
    state: AgentInstanceGlobalState,
    action: RequestPauseAction,
    dispatch?: SignalDispatch,
  ) => void;
  requestResumeOperation: (
    state: AgentInstanceGlobalState,
    action: RequestResumeAction,
    dispatch?: SignalDispatch,
  ) => void;
  retireInstanceOperation: (
    state: AgentInstanceGlobalState,
    action: RetireInstanceAction,
    dispatch?: SignalDispatch,
  ) => void;
}
