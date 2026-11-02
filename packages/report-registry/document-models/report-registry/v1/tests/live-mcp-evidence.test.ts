import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FIXTURE = new URL("../../../../tests/fixtures/vetra-generated-review/document.final.json", import.meta.url);
const EXPECTED_SHA256 = "a7958b0e7fbbb773bdd1bbf675a04f9444d3c584555c4463f5ef1f182a60ea17";
const PROXY_EVIDENCE = new URL(
  "../../../../tests/fixtures/vetra-generated-review/reviewer-proxy-evidence.json",
  import.meta.url,
);
const EXPECTED_PROXY_EVIDENCE_SHA256 =
  "361eba39b3ff42d79cd57a670032c1bdf41edd707f7eb6657e6a47105ce3e061";

describe("generated Report Registry live MCP evidence", () => {
  it("preserves the original byte-exact synthetic Vetra result", () => {
    const bytes = readFileSync(FIXTURE);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(EXPECTED_SHA256);
    const document = JSON.parse(bytes.toString("utf8"));

    expect(document.header.documentType).toBe("kilgore/report");
    expect(document.header.revision.global).toBe(8);
    expect(document.state.global.revision).toBe(8);
    expect(document.state.global.review).toStrictEqual({
      readAt: "2026-08-22T20:04:01.000Z",
      feedback: [{
        id: "feedback-proof-001",
        route: { error: null, status: "UNROUTED", routedAt: null, destination: null },
        actorId: "reviewer-proof",
        createdAt: "2026-08-22T20:04:02.000Z",
        bodyMarkdown: "Please clarify the synthetic conclusion.",
      }],
      openedAt: "2026-08-22T20:04:00.000Z",
    });
    expect(document.state.global.attention.resolution).toBe("RESOLVED");
    expect(document.state.global.attention.resolvedAt).toBe("2026-08-22T20:05:03.000Z");
  });

  it("pins all five exact reviewer-proxy envelopes and both terminal effects", () => {
    const bytes = readFileSync(PROXY_EVIDENCE);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe(EXPECTED_PROXY_EVIDENCE_SHA256);
    const evidence = JSON.parse(bytes.toString("utf8"));

    expect(evidence.operations.map((operation: { type: string }) => operation.type))
      .toStrictEqual([
        "MARK_OPENED",
        "MARK_READ",
        "ADD_FEEDBACK",
        "DISMISS_ATTENTION",
        "RESOLVE_ATTENTION",
      ]);
    expect(evidence.operations.every(
      (operation: { upstreamResult: { success: boolean } }) =>
        operation.upstreamResult.success,
    )).toBe(true);
    expect(evidence.operations[2].input.feedbackId)
      .toBe("6f0a0f4b-f6cc-4d73-8e65-46f1ac8ad735");
    expect(evidence.finalResults.dismissed).toMatchObject({
      revision: 3,
      attention: { resolution: "DISMISSED" },
    });
    expect(evidence.finalResults.resolved).toMatchObject({
      revision: 6,
      review: {
        openedAt: "2026-08-22T20:20:02.000Z",
        readAt: "2026-08-22T20:20:03.000Z",
        feedback: [{
          id: "6f0a0f4b-f6cc-4d73-8e65-46f1ac8ad735",
          actorId: "human:chris",
        }],
      },
      attention: { resolution: "RESOLVED" },
    });
  });
});
