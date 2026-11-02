import type { Action } from "document-model";
import { describe, expect, it } from "vitest";

import { addFeedback, dismissAttention, markOpened, markRead, requestReview, resolveAttention } from "../gen/attention/creators.js";
import { registerReport } from "../gen/content/creators.js";
import { reducer } from "../gen/reducer.js";
import type { ReportRegistryDocument } from "../gen/types.js";
import { utils } from "../utils.js";

const PRODUCER = "codex-vetra-proof";
const REVIEWER = "kapelle-operator";
const REGISTERED_AT = "2026-08-22T20:03:00.000Z";

function apply(document: ReportRegistryDocument, action: Action): ReportRegistryDocument {
  const next = reducer(document, action);
  const operation = next.operations.global.at(-1);
  expect(operation?.error ?? null).toBeNull();
  return next;
}

function registeredDocument(lifecycle: "DRAFT" | "FINAL" = "FINAL"): ReportRegistryDocument {
  return apply(utils.createDocument(), registerReport({
    id: "synthetic-report-001",
    reportRef: "report://synthetic/review-proof",
    title: "Synthetic review proof",
    producer: { kind: "AGENT", id: PRODUCER, label: "Synthetic proof" },
    content: {
      storage: "INLINE_MARKDOWN",
      mimeType: "text/markdown",
      contentHash: "sha256:synthetic-proof",
      byteSize: 17,
      markdown: "# Synthetic proof",
      filename: "synthetic-proof.md",
    },
    lifecycle,
    actorId: PRODUCER,
    occurredAt: REGISTERED_AT,
  }));
}

describe("Vetra-generated Report Registry review runtime", () => {
  it("applies Kapelle's exact opened, read, and feedback envelopes", () => {
    let document = registeredDocument();
    document = apply(document, markOpened({
      expectedRevision: 1,
      occurredAt: "2026-08-22T20:04:00.000Z",
      actorId: REVIEWER,
    }));
    document = apply(document, markRead({
      expectedRevision: 2,
      occurredAt: "2026-08-22T20:04:01.000Z",
      actorId: REVIEWER,
    }));
    document = apply(document, addFeedback({
      feedbackId: "feedback-proof-001",
      bodyMarkdown: "Please clarify the synthetic conclusion.",
      expectedRevision: 3,
      occurredAt: "2026-08-22T20:04:02.000Z",
      actorId: REVIEWER,
    }));

    expect(document.state.global.revision).toBe(4);
    expect(document.state.global.review).toStrictEqual({
      openedAt: "2026-08-22T20:04:00.000Z",
      readAt: "2026-08-22T20:04:01.000Z",
      feedback: [{
        id: "feedback-proof-001",
        actorId: REVIEWER,
        bodyMarkdown: "Please clarify the synthetic conclusion.",
        createdAt: "2026-08-22T20:04:02.000Z",
        route: { status: "UNROUTED", destination: null, routedAt: null, error: null },
      }],
    });
  });

  it.each([
    ["DISMISSED", dismissAttention] as const,
    ["RESOLVED", resolveAttention] as const,
  ])("records exact %s attention evidence", (resolution, terminalAction) => {
    let document = registeredDocument();
    document = apply(document, requestReview({
      request: "DECIDE",
      reasonCode: "synthetic-proof",
      reason: "Exercise terminal review semantics",
      expectedRevision: 1,
      occurredAt: "2026-08-22T20:05:00.000Z",
      actorId: PRODUCER,
    }));
    document = apply(document, terminalAction({
      expectedRevision: 2,
      occurredAt: "2026-08-22T20:05:01.000Z",
      actorId: REVIEWER,
    }));

    expect(document.state.global.revision).toBe(3);
    expect(document.state.global.attention.resolution).toBe(resolution);
    expect(document.state.global.attention.resolvedAt).toBe("2026-08-22T20:05:01.000Z");
  });

  it("materializes review state on a legacy generated-model document", () => {
    const legacy = registeredDocument();
    delete (legacy.state.global as Partial<typeof legacy.state.global>).review;

    const document = apply(legacy, markOpened({
      expectedRevision: 1,
      occurredAt: "2026-08-22T20:06:00.000Z",
      actorId: REVIEWER,
    }));

    expect(document.state.global.review).toStrictEqual({
      openedAt: "2026-08-22T20:06:00.000Z",
      readAt: null,
      feedback: [],
    });
  });

  it.each([
    ["stale revision", (document: ReportRegistryDocument) => markOpened({
      expectedRevision: 999,
      occurredAt: "2026-08-22T20:06:00.000Z",
      actorId: REVIEWER,
    })],
    ["malformed metadata", (document: ReportRegistryDocument) => markOpened({
      expectedRevision: document.state.global.revision,
      occurredAt: "2026-08-22T20:06:00.000Z",
      actorId: " ",
    })],
  ])("keeps legacy state pure after rejected %s", (_name, makeAction) => {
    const legacy = registeredDocument();
    delete (legacy.state.global as Partial<typeof legacy.state.global>).review;
    const before = structuredClone(legacy.state.global);

    const document = reducer(legacy, makeAction(legacy));

    expect(document.operations.global.at(-1)?.error).toBeTruthy();
    expect(document.state.global).toStrictEqual(before);
  });

  it("rejects reviewer actions on DRAFT reports without changing state or revision", () => {
    const draft = registeredDocument("DRAFT");
    const before = structuredClone(draft.state.global);

    const document = reducer(draft, markRead({
      expectedRevision: draft.state.global.revision,
      occurredAt: "2026-08-22T20:07:00.000Z",
      actorId: REVIEWER,
    }));

    expect(document.operations.global.at(-1)?.error).toContain("must be FINAL");
    expect(document.state.global).toStrictEqual(before);
  });

  it("keeps legacy state pure when review-request fields fail validation", () => {
    const legacy = registeredDocument();
    delete (legacy.state.global as Partial<typeof legacy.state.global>).review;
    const before = structuredClone(legacy.state.global);

    const document = reducer(legacy, requestReview({
      request: "DECIDE",
      reasonCode: null,
      reason: "x".repeat(4_001),
      reviewBy: null,
      expiresAt: null,
      expectedRevision: legacy.state.global.revision,
      occurredAt: "2026-08-22T20:08:00.000Z",
      actorId: PRODUCER,
    }));

    expect(document.operations.global.at(-1)?.error).toContain("maximum length");
    expect(document.state.global).toStrictEqual(before);
  });
});
