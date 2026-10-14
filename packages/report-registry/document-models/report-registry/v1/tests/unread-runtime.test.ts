import type { Action } from "document-model";
import { describe, expect, it } from "vitest";
import { addFeedback, dismissAttention, markRead, markUnread, requestReview, resolveAttention } from "../gen/attention/creators.js";
import { registerReport } from "../gen/content/creators.js";
import { reducer } from "../gen/reducer.js";
import type { ReportRegistryDocument } from "../gen/types.js";
import { utils } from "../utils.js";

const ACTOR = "human:synthetic";
const T0 = "2026-09-14T10:00:00.000Z";
const T1 = "2026-09-14T10:01:00.000Z";
const T2 = "2026-09-14T10:02:00.000Z";
const T3 = "2026-09-14T10:03:00.000Z";
function input(document: ReportRegistryDocument, occurredAt = T1) {
  return { expectedRevision: document.state.global.revision, occurredAt, actorId: ACTOR };
}
function apply(document: ReportRegistryDocument, action: Action) {
  const next = reducer(document, action);
  expect(next.operations.global.at(-1)?.error ?? null).toBeNull();
  return next;
}
function registration(lifecycle: "FINAL" | "DRAFT" = "FINAL") {
  return registerReport({ id: "synthetic-unread", reportRef: "report://synthetic/unread", title: "Synthetic unread", producer: {kind: "SERVICE", id: "synthetic"}, content: {storage: "INLINE_MARKDOWN", mimeType: "text/markdown", contentHash: "sha256:synthetic", byteSize: 4, markdown: "Text"}, lifecycle, actorId: ACTOR, occurredAt: T0 });
}
const registered = (lifecycle: "FINAL" | "DRAFT" = "FINAL") => apply(utils.createDocument(), registration(lifecycle));

describe("native unread transitions", () => {
  it("reopens only reading attention and preserves content, feedback and opening history across read/unread/read", () => {
    let doc = registered();
    doc = apply(doc, requestReview({...input(doc), request: "READ", reason: "Read this result"}));
    doc = apply(doc, addFeedback({...input(doc), feedbackId: "existing-feedback", bodyMarkdown: "Keep this feedback"}));
    doc = apply(doc, markRead(input(doc, T1)));
    const before = structuredClone(doc);
    expect(before.state.global.attention.resolution).toBe("READ");
    doc = apply(doc, markUnread(input(doc, T2)));
    expect(doc.state.global.review?.readAt).toBeNull();
    expect(doc.state.global.review?.openedAt).toBe(T1);
    expect(doc.state.global.review?.feedback).toStrictEqual(before.state.global.review?.feedback);
    expect(doc.state.global.content).toStrictEqual(before.state.global.content);
    expect(doc.state.global.attention).toStrictEqual({...before.state.global.attention, resolvedAt: null, resolution: null});
    expect(doc.state.global.revision).toBe(before.state.global.revision + 1);
    expect(doc.operations.global.slice(0, -1)).toStrictEqual(before.operations.global);
    doc = apply(doc, markRead(input(doc, T3)));
    expect(doc.state.global.review?.readAt).toBe(T3);
    expect(doc.state.global.review?.openedAt).toBe(T1);
    expect(doc.state.global.attention.resolution).toBe("READ");
  });

  it.each([
    ["READ", "DISMISSED"], ["READ", "RESOLVED"],
    ["APPROVE", "RESOLVED"], ["APPROVE", null], ["ANSWER", null], ["NONE", null],
  ] as const)("preserves %s attention with resolution %s", (request, resolution) => {
    let doc = registered();
    if (request !== "NONE") doc = apply(doc, requestReview({...input(doc), request}));
    if (resolution) doc = apply(doc, (resolution === "DISMISSED" ? dismissAttention : resolveAttention)(input(doc)));
    doc = apply(doc, markRead(input(doc)));
    const attention = structuredClone(doc.state.global.attention);
    doc = apply(doc, markUnread(input(doc, T2)));
    expect(doc.state.global.review?.readAt).toBeNull();
    expect(doc.state.global.attention).toStrictEqual(attention);
  });

  it.each(["revision", "metadata", "DRAFT", "WITHDRAWN", "SUPERSEDED"])("rejects invalid %s without mutating state, including absent legacy review", kind => {
    const doc = registered();
    if (["DRAFT", "WITHDRAWN", "SUPERSEDED"].includes(kind)) doc.state.global.lifecycle = kind as "DRAFT" | "WITHDRAWN" | "SUPERSEDED";
    delete (doc.state.global as Partial<typeof doc.state.global>).review;
    const before = structuredClone(doc.state.global);
    const operation = markUnread({...input(doc), ...(kind === "revision" ? {expectedRevision: 999} : {}), ...(kind === "metadata" ? {actorId: " "} : {})});
    const next = reducer(doc, operation);
    expect(next.operations.global.at(-1)?.error).toBeTruthy();
    expect(next.state.global).toStrictEqual(before);
  });

  it("rejects malformed unread timestamps at the generated action boundary", () => {
    const doc = registered();
    expect(() => markUnread({...input(doc), occurredAt: "invalid"})).toThrow(/Invalid action input/);
  });

  it("materializes an old missing review field without inventing an opened/read timestamp", () => {
    const doc = registered();
    delete (doc.state.global as Partial<typeof doc.state.global>).review;
    const next = apply(doc, markUnread(input(doc)));
    expect(next.state.global.review).toStrictEqual({openedAt: null, readAt: null, feedback: []});
  });

  it("replays serialized pre-unread operations with the original first-read timestamp behavior", () => {
    const historical = JSON.stringify([
      registration(),
      requestReview({expectedRevision: 1, occurredAt: T1, actorId: ACTOR, request: "READ"}),
      markRead({expectedRevision: 2, occurredAt: T2, actorId: ACTOR}),
      markRead({expectedRevision: 3, occurredAt: T3, actorId: ACTOR}),
    ]);
    let replayed = utils.createDocument();
    for (const action of JSON.parse(historical) as Action[]) replayed = apply(replayed, action);
    expect(replayed.state.global.revision).toBe(4);
    expect(replayed.state.global.review).toStrictEqual({openedAt: T2, readAt: T2, feedback: []});
    expect(replayed.state.global.attention.resolvedAt).toBe(T2);
    expect(replayed.state.global.attention.resolution).toBe("READ");
    expect(replayed.operations.global.map(operation => operation.action.type)).toStrictEqual(["REGISTER_REPORT", "REQUEST_REVIEW", "MARK_READ", "MARK_READ"]);
  });
});
