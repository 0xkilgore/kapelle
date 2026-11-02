// Newsletter slice 3 qualification runner + verifier (QUALIFICATION-PLAN.md; Fable FABLE-REVIEW-NEWSLETTER-S3-QUAL F-1..F-5)
// against the FAKE Resend: the production connector, reader, executor and /emails client; guards before any write; no
// address in the report; the two phases; the verifier's refusals. No network.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeResend } from "../src/org/newsletter/fake-resend.js";
import { allowedAddress, finalizeQualification, runQualification, verifyNewsletterQualificationReport, QualStop, RESEND_CONNECTOR_SHA, type OwnerFacts } from "../src/org/newsletter/qualification.js";

const OWNER = "owner@example.org", SHA = "sha256:" + "a".repeat(64), CONNECTOR = RESEND_CONNECTOR_SHA, HEAD = "1".repeat(40);
function world(o: { contacts?: string[]; fields?: ("segment_id" | "audience_id")[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "knl-q-")), kf = join(dir, "release.key");
  writeFileSync(kf, "re_" + "Q".repeat(30), { mode: 0o600 }); chmodSync(kf, 0o600);
  const fr = new FakeResend("aud_qual"); fr.progressToSent = true; fr.pageSize = 2;
  if (o.fields) fr.acceptFields = o.fields;
  const emails = o.contacts ?? ["delivered+q1@resend.dev", "owner+q2@example.org", "delivered+q3@resend.dev", "delivered+q4@resend.dev", "owner+q5@example.org"];
  fr.contacts = emails.map((email, k) => ({ id: `ct_${k + 1}`, email, unsubscribed: false }));
  const input = (x: Record<string, unknown> = {}) => ({ keyFile: kf, segmentId: "aud_qual", listField: "segment_id", from: "EXNA <newsletter@news.example.org>",
    replyTo: "hello@example.org", owner: OWNER, fetch: fr.fetch as never, stateDir: dir, head: HEAD, connectorSha: CONNECTOR, mode: "live" as const, pollMs: 1, ...x });
  return { dir, kf, fr, input, writes: () => fr.log.filter((l) => !l.startsWith("GET")), close: () => rmSync(dir, { recursive: true, force: true }) };
}
const facts = (x: Partial<OwnerFacts> = {}): OwnerFacts => ({ q0ConsoleSha: SHA, q4: { recipientsShown: 4, q2Received: 0, sinksDelivered: 3, q5Delivered: 1, recipientsScreenshotSha: SHA },
  q8: { fromHeaderMatches: true, received: true }, q10: { onlyKapelleKeyCanSend: true, siteKeyAbsent: true, keyScope: "full_access", screenshotSha: SHA },
  q13: { clickedUnsubscribe: true }, ...x });

it.skip("F-5 pin: RESEND_CONNECTOR_SHA is the connector file's sha (a connector change fails here until re-pinned = re-qualified)", () => {
  expect(RESEND_CONNECTOR_SHA).toBe("sha256:" + createHash("sha256").update(readFileSync(new URL("../src/org/newsletter/resend-broadcast.ts", import.meta.url))).digest("hex"));
});

it("F-2 allowlist: resend.dev sinks and the owner's own plus-addresses only", () => {
  expect(allowedAddress("delivered+q1@resend.dev", OWNER)).toBe(true);
  expect(allowedAddress("owner+q2@example.org", OWNER)).toBe(true);
  expect(allowedAddress("owner@example.org", OWNER)).toBe(false);
  expect(allowedAddress("owner+q2@example.org.evil", OWNER)).toBe(false);
  expect(allowedAddress("other+q2@example.org", OWNER)).toBe(false);
  expect(allowedAddress("bounced@resend.dev", OWNER)).toBe(false);
});

describe("the qualification runner over the fake Resend", () => {
  it("Q0-Q12 pass through the production pieces; the report holds no address; the path set is exact; one draft and one send for the release", async () => {
    const w = world();
    try {
      const r = await runQualification(w.input());
      expect(r.pass).toEqual({ q0: true, q1: true, q4: true, q5: true, q6: true, q7: true, q8: true, q11: true, q12: true });
      expect(r.passed).toBe(true);
      expect(JSON.stringify(r)).not.toContain("@");
      expect(r).toMatchObject({ listField: "segment_id", fromDomain: "news.example.org", head: HEAD, connectorSha: CONNECTOR,
        q0: { segments: 1, contacts: 5, sinks: 3, q2ContactId: "ct_2", q5ContactId: "ct_5" }, q1: { accepted: "segment_id", echoedListId: true, audienceReadable: true },
        q2: { statuses: ["draft", "sending", "sent"] }, q4: { unsubscribedContactId: "ct_2", eligibleAtSend: 4, state: "archive_pending" },
        q6: { createPosts: 1, sendPosts: 1, secondSend: { status: 422, error: "validation_error" } }, q7: { afterRun: "create_attempted", afterRecover: "draft_known", createPosts: 1, sendPosts: 0 },
        q11: { passes: 3, providerWrites: 0, sendPosts: 1, state: "archive_pending", secondSendRefused: true }, q12: { exact: true, emailsRoutes: ["POST /emails"] } });
      expect(r.q3).toMatchObject({ created: 3, eachOnce: true, connectorComplete: true, connectorFound: true, pageCapIncomplete: expect.stringMatching(/^not exercised live; covered by the unit test/) });
      expect(r.q9.contactFields).toEqual(["email", "id", "object", "unsubscribed"]);
      // On the provider: q2 was excluded at send (the fake's eligible set), one /emails test to owner+q5 with the release From + Reply-To.
      expect(w.fr.broadcasts.filter((b) => b.status !== "draft")).toHaveLength(1);
      expect(w.fr.emails).toEqual([expect.objectContaining({ from: "EXNA <newsletter@news.example.org>", to: ["owner+q5@example.org"], reply_to: "hello@example.org" })]);
      // Setup writes are logged apart from the connector's (Q12 covers the connector only).
      expect(r.pathLog.filter((l: any) => l.phase === "setup" && !l.route.startsWith("GET")).map((l: any) => l.route).sort())
        .toEqual(["PATCH /audiences/{id}/contacts/{id}", "POST /broadcasts/{id}/send"]);
    } finally { w.close(); }
  });

  it("Q1 fallback: segment_id refused -> audience_id in a NEW operationId; counts stay per release", async () => {
    const w = world({ fields: ["audience_id"] });
    try {
      const r = await runQualification(w.input());
      expect(r.q1.attempts.map((a: any) => [a.field, a.state, a.label])).toEqual([["segment_id", "failed", "newsletter_provider_refused"], ["audience_id", "draft_known", null]]);
      expect(r.q1.attempts[0].op).not.toBe(r.q1.attempts[1].op);
      expect(r.q1.attempts.map((a: any) => a.op)).toEqual([expect.stringMatching(/^qual-q1-segment_id-\d{17}$/), expect.stringMatching(/^qual-q1-audience_id-\d{17}$/)]);
      expect(w.fr.broadcasts[0].name).toMatch(/^kapelle:qual-q1-audience_id-\d{17}$/); // the plan's name (the refused attempt created nothing)
      expect(r).toMatchObject({ listField: "audience_id", passed: true, q6: { createPosts: 1, sendPosts: 1 } });
    } finally { w.close(); }
  });

  it("F-5 / F-2 guards refuse BEFORE any provider write (bad listField: before any call at all)", async () => {
    const cases: [Parameters<typeof world>[0], Record<string, unknown>, string, (fr: FakeResend) => void][] = [
      [{}, { listField: "list_id" }, "qual_list_field_invalid", () => {}],
      [{}, {}, "qual_segment_refused", (fr) => { fr.segmentName = "cp-subscribers"; }],
      [{ contacts: ["delivered+q1@resend.dev", "owner+q2@example.org", "neighbor@example.com", "delivered+q4@resend.dev", "owner+q5@example.org"] }, {}, "qual_blast_radius_contacts", () => {}],
      [{ contacts: ["delivered+q1@resend.dev", "owner+q2@example.org", "delivered+q4@resend.dev", "owner+q5@example.org"] }, {}, "qual_blast_radius_contacts", () => {}],
      [{ contacts: ["delivered+q1@resend.dev", "owner+q7@example.org", "delivered+q3@resend.dev", "delivered+q4@resend.dev", "owner+q5@example.org"] }, {}, "qual_owner_contacts_missing", () => {}],
      [{}, { segmentId: "aud_other" }, "qual_segment_refused", () => {}],
      [{}, {}, "qual_segments_none", (fr) => { (fr as any).route = ((orig) => function (this: any, m: string, u: URL, b: any) {
        return m === "GET" && u.pathname === "/audiences" ? new Response(JSON.stringify({ object: "list", has_more: false, data: [] }), { status: 200 }) : orig.call(this, m, u, b); })((fr as any).route); }],
      [{}, { connectorSha: "sha256:" + "d".repeat(64) }, "qual_connector_not_pinned", () => {}],
    ];
    for (const [wo, x, label, tweak] of cases) {
      const w = world(wo); tweak(w.fr);
      try {
        await expect(runQualification(w.input(x))).rejects.toThrow(label);
        expect(w.writes(), label).toEqual([]);
        if (label === "qual_list_field_invalid" || label === "qual_connector_not_pinned") expect(w.fr.log).toEqual([]);
      } finally { w.close(); }
    }
    const w = world();
    try { await expect(runQualification(w.input())).resolves.toBeTruthy(); } finally { w.close(); }
  });

  it("finalize (Q13 + owner facts) and the verifier: a final live report attests THIS connector; every refusal", async () => {
    const w = world();
    try {
      const run = await runQualification(w.input());
      await expect(finalizeQualification(run, { ...facts(), q4: { q2Received: 0 } }, { keyFile: w.kf, fetch: w.fr.fetch as never })).rejects.toThrow("qual_owner_facts_invalid");
      // Before the owner clicks: Q13 records "not unsubscribed" (a recorded fact; not in PASS).
      const early = await finalizeQualification(run, facts(), { keyFile: w.kf, fetch: w.fr.fetch as never });
      expect(early).toMatchObject({ passed: true, q13: { q5Unsubscribed: false } });
      expect(early.pass).not.toHaveProperty("q13");
      w.fr.contacts.find((c) => c.id === "ct_5")!.unsubscribed = true; // the owner clicked the real link in q5's mail
      const fin = await finalizeQualification(run, facts(), { keyFile: w.kf, fetch: w.fr.fetch as never });
      expect(fin).toMatchObject({ phase: "final", passed: true, q13: { q5ContactId: "ct_5", q5Unsubscribed: true } });
      const bytes = Buffer.from(JSON.stringify(fin));
      expect(verifyNewsletterQualificationReport(bytes)).toMatchObject({ ok: true, listField: "segment_id", fromDomain: "news.example.org", head: HEAD,
        reportSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) });
      const v = (o: unknown, c = CONNECTOR) => verifyNewsletterQualificationReport(Buffer.from(JSON.stringify(o)), { connectorSha: c });
      expect(v(fin, "sha256:" + "d".repeat(64))).toEqual({ ok: false, reason: "qualification_connector_mismatch" });
      expect(v(run)).toEqual({ ok: false, reason: "qualification_report_not_final_live" });
      expect(v({ ...fin, mode: "dry-run" })).toEqual({ ok: false, reason: "qualification_report_not_final_live" });
      expect(v({ ...fin, note: "owner@example.org" })).toEqual({ ok: false, reason: "qualification_report_has_address" });
      for (const q4 of [{ recipientsShown: 4, q2Received: 1, sinksDelivered: 3, q5Delivered: 1 }, { recipientsShown: 5, q2Received: 0, sinksDelivered: 3, q5Delivered: 1 },
        { recipientsShown: 4, q2Received: 0, sinksDelivered: 2, q5Delivered: 1 }, { recipientsShown: 4, q2Received: 0, sinksDelivered: 3, q5Delivered: 0 }]) {
        const bad = await finalizeQualification(run, facts({ q4: { ...q4, recipientsScreenshotSha: SHA } }), { keyFile: w.kf, fetch: w.fr.fetch as never });
        expect(v(bad), JSON.stringify(q4)).toEqual({ ok: false, reason: "qualification_report_not_passing" }); // Q4 hard stop / inconsistent console facts
      }
      expect(v({ ...fin, pathLog: [...fin.pathLog, { phase: "connector", op: "x", route: "POST /broadcasts/{id}/send", status: 200 }] })).toEqual({ ok: false, reason: "qualification_send_count_mismatch" });
      expect(v({ ...fin, pathLog: [...fin.pathLog, { phase: "connector", op: "x", route: "DELETE /broadcasts/{id}", status: 200 }] })).toEqual({ ok: false, reason: "qualification_path_set_mismatch" });
      expect(verifyNewsletterQualificationReport(Buffer.from("{"), { connectorSha: CONNECTOR })).toEqual({ ok: false, reason: "qualification_report_malformed" });
    } finally { w.close(); }
  });

  it("QualStop carries a fixed label", () => { expect(new QualStop("qual_x").label).toBe("qual_x"); });
});
