import { it, expect } from "vitest";
import { qualifyFailure, gradeCitations } from "./qualify-report.js";

it("the report's failure label is the dispatch's own label (Ops, live attempt 2), with status, ledger and the full detail", () => {
  const live2 = "meeting_draft_not_published: EXECUTION_REJECTED:hosted_http_402:code=402 ledger:released:hosted_http_402:code=402";
  expect(qualifyFailure(live2)).toEqual({ label: "hosted_http_402:code=402", status: "EXECUTION_REJECTED", ledger: "released:hosted_http_402:code=402", detail: live2 });
  expect(qualifyFailure("meeting_draft_not_published: EXECUTION_UNCERTAIN:provider_receipt_unconfirmed ledger:unsettled:hosted_transport_failed"))
    .toMatchObject({ label: "provider_receipt_unconfirmed", status: "EXECUTION_UNCERTAIN", ledger: "unsettled:hosted_transport_failed" });
  expect(qualifyFailure("meeting_draft_not_published: EXECUTION_REJECTED:hosted_monthly_cap_exceeded ledger:none")).toMatchObject({ label: "hosted_monthly_cap_exceeded", ledger: "none" });
  expect(qualifyFailure("hosted_http_404:code=404")).toMatchObject({ label: "hosted_http_404:code=404", status: null });
  expect(qualifyFailure("Cannot read properties of undefined (reading 'documentId')")).toMatchObject({ label: "harness_error", detail: "unprintable" });
});

it("golden citation grading: expected within actual, admissible file only, at most 3; abstention means zero (attempt 3 shapes)", () => {
  const A = "2026-10-08.v1.md", B = "2026-11-03.v1.md";
  // confirmed-date, live attempt 3: cited L2 (expected) + L3 (the "time needs confirmation" line) -> passes now.
  expect(gradeCitations([[A, 2], [A, 3]], [[A, 2]], A)).toBe(true);
  expect(gradeCitations([[B, 2], [B, 3]], [[B, 2]], B)).toBe(true);
  expect(gradeCitations([[A, 2]], [[A, 2]], A)).toBe(true);
  // tentative-offer / unapproved-expense, live attempt 3: abstained but cited the title line -> still FAILS (hard rule).
  expect(gradeCitations([[A, 1]], [], A)).toBe(false);
  expect(gradeCitations([], [], A)).toBe(true);
  // Missing the expected line, another file, or more than 3 citations -> fail.
  expect(gradeCitations([[A, 3]], [[A, 2]], A)).toBe(false);
  expect(gradeCitations([[A, 2], [B, 2]], [[A, 2]], A)).toBe(false);
  expect(gradeCitations([[A, 2], [A, 3], [A, 4], [A, 1]], [[A, 2]], A)).toBe(false);
  expect(gradeCitations([[A, 2], [A, 3], [A, 4]], [[A, 2]], A)).toBe(true);
});
