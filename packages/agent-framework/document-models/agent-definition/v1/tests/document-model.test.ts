/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */
/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */

import {
  agentDefinitionDocumentType,
  assertIsAgentDefinitionDocument,
  assertIsAgentDefinitionState,
  initialGlobalState,
  initialLocalState,
  isAgentDefinitionDocument,
  isAgentDefinitionState,
  utils,
} from "document-models/agent-definition/v1";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("AgentDefinition Document Model", () => {
  it("should create a new AgentDefinition document", () => {
    const document = utils.createDocument();

    expect(document).toBeDefined();
    expect(document.header.documentType).toBe(agentDefinitionDocumentType);
  });

  it("should create a new AgentDefinition document with a valid initial state", () => {
    const document = utils.createDocument();
    expect(document.state.global).toStrictEqual(initialGlobalState);
    expect(document.state.local).toStrictEqual(initialLocalState);
    expect(isAgentDefinitionDocument(document)).toBe(true);
    expect(isAgentDefinitionState(document.state)).toBe(true);
  });
  it("should reject a document that is not a AgentDefinition document", () => {
    const wrongDocumentType = utils.createDocument();
    wrongDocumentType.header.documentType = "the-wrong-thing-1234";
    try {
      expect(assertIsAgentDefinitionDocument(wrongDocumentType)).toThrow();
      expect(isAgentDefinitionDocument(wrongDocumentType)).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
    }
  });
  const wrongState = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  wrongState.state.global = {
    ...{ notWhat: "you want" },
  };
  try {
    expect(isAgentDefinitionState(wrongState.state)).toBe(false);
    expect(assertIsAgentDefinitionState(wrongState.state)).toThrow();
    expect(isAgentDefinitionDocument(wrongState)).toBe(false);
    expect(assertIsAgentDefinitionDocument(wrongState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const wrongInitialState = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  wrongInitialState.initialState.global = {
    ...{ notWhat: "you want" },
  };
  try {
    expect(isAgentDefinitionState(wrongInitialState.state)).toBe(false);
    expect(assertIsAgentDefinitionState(wrongInitialState.state)).toThrow();
    expect(isAgentDefinitionDocument(wrongInitialState)).toBe(false);
    expect(assertIsAgentDefinitionDocument(wrongInitialState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingIdInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingIdInHeader.header.id;
  try {
    expect(isAgentDefinitionDocument(missingIdInHeader)).toBe(false);
    expect(assertIsAgentDefinitionDocument(missingIdInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingNameInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingNameInHeader.header.name;
  try {
    expect(isAgentDefinitionDocument(missingNameInHeader)).toBe(false);
    expect(assertIsAgentDefinitionDocument(missingNameInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingCreatedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingCreatedAtUtcIsoInHeader.header.createdAtUtcIso;
  try {
    expect(isAgentDefinitionDocument(missingCreatedAtUtcIsoInHeader)).toBe(
      false,
    );
    expect(
      assertIsAgentDefinitionDocument(missingCreatedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingLastModifiedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingLastModifiedAtUtcIsoInHeader.header.lastModifiedAtUtcIso;
  try {
    expect(isAgentDefinitionDocument(missingLastModifiedAtUtcIsoInHeader)).toBe(
      false,
    );
    expect(
      assertIsAgentDefinitionDocument(missingLastModifiedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }
});
