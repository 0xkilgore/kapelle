// Fable QUALIFICATION-LIVE-1 F-1/F-2: a hosted refusal that reaches the TaskWorker is persisted VERBATIM (never 'unlabeled'),
// on the terminal path (a 4xx by status, with OpenRouter's numeric code) and the uncertain path (transport failure), and the
// spend ledger records the same label as the release reason. Fake provider only; nothing leaves the machine.
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { failureLabel, persistedReason, REASON_PATTERN, HOSTED_ADAPTER_REASONS } from "../src/task-delegation/failure-labels.js";
import { HOSTED_FAILURE_REASONS } from "../src/agent-kit/hosted/transport.js";
import { OPENROUTER_PROFILES } from "../src/agent-kit/hosted/openrouter.js";
import { makeWorld } from "./org-fixture.js";
import { meetingKit, meetingCycle } from "./org-meeting-kit.js";
import { script } from "./org-meeting-script.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const MEETING = { meeting: "# Synthetic meeting\nConfirmed: cleanup Oct 31.", notes: "# Notes\nThe cleanup is on Oct 31.\n", date: "2026-10-08", title: "Synthetic meeting" };

it("every hosted label persists verbatim through the worker vocabulary (with or without an HTTP :code suffix)", () => {
  for (const l of [...HOSTED_FAILURE_REASONS, ...HOSTED_ADAPTER_REASONS]) {
    expect(failureLabel(new Error(l)), l).toBe(l);
    expect(persistedReason(failureLabel(new Error(l))), l).toBe(l);
    expect(REASON_PATTERN.test(l), l).toBe(true);
  }
  expect(failureLabel(new Error("hosted_http_404:code=404"))).toBe("hosted_http_404:code=404");
  expect(failureLabel(new Error("hosted_http_400:code=400"))).toBe("hosted_http_400:code=400");
  expect(failureLabel(new Error("hosted_http_999:code=404"))).toBe("unlabeled");          // unknown base: not admitted
  expect(failureLabel(new Error("hosted_http_404:code=404 extra"))).toBe("unlabeled");    // no free text
  // Ops (Flash-Lite attempt 5): which reasoning signal fired, content-free, kept verbatim; anything else is not admitted.
  for (const l of ["hosted_reasoning_refused", "hosted_reasoning_refused:field=reasoning", "hosted_reasoning_refused:field=reasoning_content", "hosted_reasoning_refused:tokens=17",
    "hosted_reasoning_refused:field=reasoning_details,n=2", "hosted_reasoning_refused:field=reasoning_details,n=2,tokens=12"]) expect(failureLabel(new Error(l)), l).toBe(l);
  for (const l of ["hosted_reasoning_refused:field=thinking", "hosted_reasoning_refused:tokens=abc", "hosted_reasoning_refused:field=reasoning text"]) expect(failureLabel(new Error(l)), l).toBe("unlabeled");
});

describe.skipIf(!enabled)("hosted refusals through the real TaskWorker", () => {
  const run = async (fetchFor: () => (url: string, init: any) => Promise<Response>, monthlyUsd = 30) => {
    const w = await makeWorld(["org-a"], meetingKit(script, { profile: OPENROUTER_PROFILES.sonnet, fetch: fetchFor as never, monthlyUsd }));
    try {
      const o = w.orgs["org-a"] as any;
      const error = await meetingCycle(w, o, MEETING).then(() => null, (e) => String(e instanceof Error ? e.message : e));
      // What the worker PERSISTED (the attempt journal Fable read on disk), not just the status text.
      const journals = (readdirSync(o.root, { recursive: true }) as string[]).filter((f) => f.endsWith("task-executions.sqlite"));
      const journal = journals.flatMap((f) => { const db = new DatabaseSync(join(o.root, f), { readOnly: true });
        try { return (db.prepare("SELECT body FROM attempts").all() as { body: string }[]).map((r) => { const a = JSON.parse(r.body); return { phase: a.phase, uncertainReason: a.uncertainReason ?? null, terminal: a.terminalRejection?.reason ?? null }; }); }
        finally { db.close(); } });
      return { error, journal, ledger: o.sqlite.db.prepare("SELECT state, reason FROM effects WHERE kind='hosted-inference'").all() };
    } finally { await w.close(); }
  };
  it("terminal: an HTTP 404 with OpenRouter's code is REJECTED with hosted_http_404:code=404; the reservation is released with that reason", async () => {
    const r = await run(() => async () => new Response(JSON.stringify({ error: { code: 404, message: "No endpoints found matching your data policy" } }), { status: 404, headers: { "content-type": "application/json" } }));
    expect(r.error).toBe("meeting_draft_not_published: EXECUTION_REJECTED:hosted_http_404:code=404 ledger:released:hosted_http_404:code=404");
    expect(r.ledger).toEqual([{ state: "released", reason: "hosted_http_404:code=404" }]);
    expect(r.journal).toEqual([{ phase: "rejected", uncertainReason: null, terminal: "hosted_http_404:code=404" }]); // was 'unlabeled' (live attempt 1)
    expect(r.error).not.toMatch(/No endpoints|unlabeled/); // the provider's message never travels, the label does
  }, 120_000);
  it("terminal: a 400 without a JSON body is REJECTED with the bare status label", async () => {
    const r = await run(() => async () => new Response("bad", { status: 400, headers: { "content-type": "text/plain" } }));
    expect(r.error).toBe("meeting_draft_not_published: EXECUTION_REJECTED:hosted_http_400 ledger:released:hosted_http_400");
  }, 120_000);
  it("uncertain: a transport failure after send is UNCERTAIN with hosted_transport_failed and the reservation held", async () => {
    const r = await run(() => async () => { throw new TypeError("socket hang up"); });
    // The status keeps its fixed contract reason for UNCERTAIN; the persisted journal and the ledger carry the hosted label.
    expect(r.error).toBe("meeting_draft_not_published: EXECUTION_UNCERTAIN:provider_receipt_unconfirmed ledger:unsettled:hosted_transport_failed");
    expect(r.journal).toEqual([{ phase: "uncertain", uncertainReason: "hosted_transport_failed", terminal: null }]);
  }, 120_000);
  it("pre-send: the monthly cap is REJECTED with hosted_monthly_cap_exceeded and nothing is sent", async () => {
    let sent = 0;
    const r = await run(() => async () => { sent++; return new Response("{}", { status: 500 }); }, 0.01);
    expect(sent).toBe(0);
    expect(r.error).toMatch(/^meeting_draft_not_published: EXECUTION_REJECTED:(hosted_monthly_cap_exceeded|rejection_limit) ledger:none$/);
  }, 120_000);
});
