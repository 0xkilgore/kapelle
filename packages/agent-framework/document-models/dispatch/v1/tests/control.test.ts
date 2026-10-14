import { generateMock } from "document-model";
import {
  acceptDispatch,
  AcceptDispatchInputSchema,
  createDispatch,
  CreateDispatchInputSchema,
  isDispatchDocument,
  recordDispatchResult,
  RecordDispatchResultInputSchema,
  reducer,
  requestDispatchCancel,
  RequestDispatchCancelInputSchema,
  utils,
} from "document-models/dispatch/v1";
import { describe, expect, it } from "vitest";

describe("ControlOperations", () => {
  it("should handle createDispatch operation", () => {
    const document = utils.createDocument();
    const input = generateMock(CreateDispatchInputSchema(), {
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, createDispatch(input));

    expect(isDispatchDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "CREATE_DISPATCH",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle acceptDispatch operation", () => {
    const document = utils.createDocument();
    const input = generateMock(AcceptDispatchInputSchema(), {
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, acceptDispatch(input));

    expect(isDispatchDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "ACCEPT_DISPATCH",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle requestDispatchCancel operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RequestDispatchCancelInputSchema(), {
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, requestDispatchCancel(input));

    expect(isDispatchDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "REQUEST_DISPATCH_CANCEL",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });

  it("should handle recordDispatchResult operation", () => {
    const document = utils.createDocument();
    const input = generateMock(RecordDispatchResultInputSchema(), {
      occurredAt: "2024-01-01T00:00:00.000Z",
    });

    const updatedDocument = reducer(document, recordDispatchResult(input));

    expect(isDispatchDocument(updatedDocument)).toBe(true);
    expect(updatedDocument.operations.global).toHaveLength(1);
    expect(updatedDocument.operations.global[0].action.type).toBe(
      "RECORD_DISPATCH_RESULT",
    );
    expect(updatedDocument.operations.global[0].action.input).toStrictEqual(
      input,
    );
    expect(updatedDocument.operations.global[0].index).toEqual(0);
  });
});
