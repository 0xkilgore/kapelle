/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */
/**
 * This is a scaffold file meant for customization:
 * - change it by adding new tests or modifying the existing ones
 */

import {
  agentInstanceDocumentType,
  assertIsAgentInstanceDocument,
  assertIsAgentInstanceState,
  initialGlobalState,
  initialLocalState,
  isAgentInstanceDocument,
  isAgentInstanceState,
  utils,
} from "document-models/agent-instance/v1";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("AgentInstance Document Model", () => {
  it("should create a new AgentInstance document", () => {
    const document = utils.createDocument();

    expect(document).toBeDefined();
    expect(document.header.documentType).toBe(agentInstanceDocumentType);
  });

  it("should create a new AgentInstance document with a valid initial state", () => {
    const document = utils.createDocument();
    expect(document.state.global).toStrictEqual(initialGlobalState);
    expect(document.state.local).toStrictEqual(initialLocalState);
    expect(isAgentInstanceDocument(document)).toBe(true);
    expect(isAgentInstanceState(document.state)).toBe(true);
  });
  it("should reject a document that is not a AgentInstance document", () => {
    const wrongDocumentType = utils.createDocument();
    wrongDocumentType.header.documentType = "the-wrong-thing-1234";
    try {
      expect(assertIsAgentInstanceDocument(wrongDocumentType)).toThrow();
      expect(isAgentInstanceDocument(wrongDocumentType)).toBe(false);
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
    expect(isAgentInstanceState(wrongState.state)).toBe(false);
    expect(assertIsAgentInstanceState(wrongState.state)).toThrow();
    expect(isAgentInstanceDocument(wrongState)).toBe(false);
    expect(assertIsAgentInstanceDocument(wrongState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const wrongInitialState = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  wrongInitialState.initialState.global = {
    ...{ notWhat: "you want" },
  };
  try {
    expect(isAgentInstanceState(wrongInitialState.state)).toBe(false);
    expect(assertIsAgentInstanceState(wrongInitialState.state)).toThrow();
    expect(isAgentInstanceDocument(wrongInitialState)).toBe(false);
    expect(assertIsAgentInstanceDocument(wrongInitialState)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingIdInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingIdInHeader.header.id;
  try {
    expect(isAgentInstanceDocument(missingIdInHeader)).toBe(false);
    expect(assertIsAgentInstanceDocument(missingIdInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingNameInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingNameInHeader.header.name;
  try {
    expect(isAgentInstanceDocument(missingNameInHeader)).toBe(false);
    expect(assertIsAgentInstanceDocument(missingNameInHeader)).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingCreatedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingCreatedAtUtcIsoInHeader.header.createdAtUtcIso;
  try {
    expect(isAgentInstanceDocument(missingCreatedAtUtcIsoInHeader)).toBe(false);
    expect(
      assertIsAgentInstanceDocument(missingCreatedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }

  const missingLastModifiedAtUtcIsoInHeader = utils.createDocument();
  // @ts-expect-error - we are testing the error case
  delete missingLastModifiedAtUtcIsoInHeader.header.lastModifiedAtUtcIso;
  try {
    expect(isAgentInstanceDocument(missingLastModifiedAtUtcIsoInHeader)).toBe(
      false,
    );
    expect(
      assertIsAgentInstanceDocument(missingLastModifiedAtUtcIsoInHeader),
    ).toThrow();
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
  }
});
