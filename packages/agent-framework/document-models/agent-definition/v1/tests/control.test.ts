import { generateMock } from "document-model";
import {
  isAgentDefinitionDocument,
  publishDefinition,
  PublishDefinitionInputSchema,
  reducer,
  utils,
} from "document-models/agent-definition/v1";
import { describe, expect, it } from "vitest";

describe("ControlOperations", () => {
  it("should handle publishDefinition operation", () => {
    const document = utils.createDocument();
    const input = generateMock(PublishDefinitionInputSchema());

    const updatedDocument = reducer(document, publishDefinition(input));

    expect(isAgentDefinitionDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "PUBLISH_DEFINITION",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
