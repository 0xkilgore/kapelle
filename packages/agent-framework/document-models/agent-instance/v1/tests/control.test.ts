import { generateMock } from "document-model";
import {
  bindConnection,
  BindConnectionInputSchema,
  bindSchedule,
  BindScheduleInputSchema,
  createInstance,
  CreateInstanceInputSchema,
  disableSkill,
  DisableSkillInputSchema,
  enableSkill,
  EnableSkillInputSchema,
  grantCapability,
  GrantCapabilityInputSchema,
  isAgentInstanceDocument,
  linkDocument,
  LinkDocumentInputSchema,
  pinDefinitionVersion,
  PinDefinitionVersionInputSchema,
  reducer,
  requestPause,
  RequestPauseInputSchema,
  requestResume,
  RequestResumeInputSchema,
  retireInstance,
  RetireInstanceInputSchema,
  revokeCapability,
  RevokeCapabilityInputSchema,
  revokeConnection,
  RevokeConnectionInputSchema,
  setModelPolicy,
  SetModelPolicyInputSchema,
  setOperatingPolicy,
  SetOperatingPolicyInputSchema,
  setResponsibilities,
  SetResponsibilitiesInputSchema,
  setRuntimeBinding,
  SetRuntimeBindingInputSchema,
  unbindSchedule,
  UnbindScheduleInputSchema,
  unlinkDocument,
  UnlinkDocumentInputSchema,
  utils,
} from "document-models/agent-instance/v1";
import { describe, expect, it } from "vitest";

describe("ControlOperations", () => {
  it("should handle createInstance operation", () => {
    const document = utils.createDocument();
    const input = generateMock(CreateInstanceInputSchema());

    const updatedDocument = reducer(document, createInstance(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "CREATE_INSTANCE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setResponsibilities operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetResponsibilitiesInputSchema());

    const updatedDocument = reducer(document, setResponsibilities(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_RESPONSIBILITIES",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setOperatingPolicy operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetOperatingPolicyInputSchema());

    const updatedDocument = reducer(document, setOperatingPolicy(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_OPERATING_POLICY",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle enableSkill operation", () => {
    const document = utils.createDocument();
    const input = generateMock(EnableSkillInputSchema());

    const updatedDocument = reducer(document, enableSkill(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "ENABLE_SKILL",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle disableSkill operation", () => {
    const document = utils.createDocument();
    const input = generateMock(DisableSkillInputSchema());

    const updatedDocument = reducer(document, disableSkill(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "DISABLE_SKILL",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle grantCapability operation", () => {
    const document = utils.createDocument();
    const input = generateMock(GrantCapabilityInputSchema());

    const updatedDocument = reducer(document, grantCapability(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "GRANT_CAPABILITY",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle revokeCapability operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RevokeCapabilityInputSchema());

    const updatedDocument = reducer(document, revokeCapability(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REVOKE_CAPABILITY",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle bindConnection operation", () => {
    const document = utils.createDocument();
    const input = generateMock(BindConnectionInputSchema());

    const updatedDocument = reducer(document, bindConnection(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "BIND_CONNECTION",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle revokeConnection operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RevokeConnectionInputSchema());

    const updatedDocument = reducer(document, revokeConnection(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REVOKE_CONNECTION",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setRuntimeBinding operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetRuntimeBindingInputSchema());

    const updatedDocument = reducer(document, setRuntimeBinding(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_RUNTIME_BINDING",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle setModelPolicy operation", () => {
    const document = utils.createDocument();
    const input = generateMock(SetModelPolicyInputSchema());

    const updatedDocument = reducer(document, setModelPolicy(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "SET_MODEL_POLICY",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle linkDocument operation", () => {
    const document = utils.createDocument();
    const input = generateMock(LinkDocumentInputSchema());

    const updatedDocument = reducer(document, linkDocument(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "LINK_DOCUMENT",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle unlinkDocument operation", () => {
    const document = utils.createDocument();
    const input = generateMock(UnlinkDocumentInputSchema());

    const updatedDocument = reducer(document, unlinkDocument(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "UNLINK_DOCUMENT",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle bindSchedule operation", () => {
    const document = utils.createDocument();
    const input = generateMock(BindScheduleInputSchema());

    const updatedDocument = reducer(document, bindSchedule(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "BIND_SCHEDULE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle unbindSchedule operation", () => {
    const document = utils.createDocument();
    const input = generateMock(UnbindScheduleInputSchema());

    const updatedDocument = reducer(document, unbindSchedule(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "UNBIND_SCHEDULE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle pinDefinitionVersion operation", () => {
    const document = utils.createDocument();
    const input = generateMock(PinDefinitionVersionInputSchema());

    const updatedDocument = reducer(document, pinDefinitionVersion(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "PIN_DEFINITION_VERSION",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle requestPause operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RequestPauseInputSchema());

    const updatedDocument = reducer(document, requestPause(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REQUEST_PAUSE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle requestResume operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RequestResumeInputSchema());

    const updatedDocument = reducer(document, requestResume(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REQUEST_RESUME",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle retireInstance operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RetireInstanceInputSchema());

    const updatedDocument = reducer(document, retireInstance(input));

    expect(isAgentInstanceDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "RETIRE_INSTANCE",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
