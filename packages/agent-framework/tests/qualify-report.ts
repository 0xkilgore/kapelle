// The qualification report's failure fields (Ops, live attempt 2): the LABEL is the dispatch's own fixed label (e.g.
// hosted_http_402:code=402), never flattened to "harness_error"; the full harness message is kept as `detail`. Every part is
// built from fixed labels (meetingCycle's message), never provider or model text.
const LABEL = /^[a-z][a-z0-9_]{1,80}(?::[a-z0-9_.,:+=@-]{1,200})?$/; // the worker's REASON_PATTERN shape
export function qualifyFailure(message: string): { label: string; status: string | null; ledger: string | null; detail: string } {
  const m = /^meeting_draft_not_published: ([A-Z_]+):(\S+) ledger:(\S+)$/.exec(message);
  if (m) return { label: LABEL.test(m[2]) ? m[2] : "unlabeled", status: m[1], ledger: m[3], detail: message };
  if (LABEL.test(message)) return { label: message, status: null, ledger: null, detail: message };
  return { label: "harness_error", status: null, ledger: null, detail: /^[A-Za-z][A-Za-z0-9_:.,=@ -]{2,300}$/.test(message) ? message : "unprintable" };
}

/** Golden citation grading (Director decision on Fable's attempt-3 read-back b03502d2). A case that expects citations passes when
 *  every expected citation is among the actual ones, every actual citation is in the case's admissible notes file, and there are
 *  at most 3 (a real model may also cite a relevant neighbouring line). A case that expects an abstention (no citations) is a
 *  HARD rule: zero actual citations. Citations are [file, startLine]. */
export function gradeCitations(actual: [string, number][], expected: [string, number][], admissibleFile: string): boolean {
  if (expected.length === 0) return actual.length === 0;
  const key = (c: [string, number]) => `${c[0]}#${c[1]}`, got = new Set(actual.map(key));
  return actual.length <= 3 && expected.every((c) => got.has(key(c))) && actual.every((c) => c[0] === admissibleFile);
}
