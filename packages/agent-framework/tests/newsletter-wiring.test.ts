// Newsletter slice 3, S3-c (PLAN-NEWSLETTER-SLICE3; Fable R-2, R-8 and the S3-a wiring requirement): the executor inside the
// org runtime. Only with the EXNA release key + a real list id + the release sender; the newsletter.send mint and prepare
// refresh the audience BEFORE the synchronous guard; the approval returns at once and the executor runs in the background,
// one release at a time, recover() first. A FAKE Resend at the HTTP level (never the network).
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { base32Decode, hotp, totpStep } from "../src/access/totp.js";
import { orgRuntimeConfigSchema } from "../src/org/org-runtime.js";
import { FakeResend } from "../src/org/newsletter/fake-resend.js";
import { transcriptionWorld } from "./transcription-world.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;

it("R-2 config: a release key needs the list id AND the release sender (from + reply-to)", () => {
  const base = { totpKeyFile: "/x/totp.key", releaseKeyFile: "/x/resend-release.key" };
  const nl = (n: Record<string, unknown>) => orgRuntimeConfigSchema.shape.newsletter.safeParse(n);
  expect(nl({ ...base }).success).toBe(false);
  expect(nl({ ...base, listId: "aud_exna" }).success).toBe(false);
  expect(nl({ ...base, listId: "aud_exna", from: "EXNA <newsletter@example.org>" }).success).toBe(false);
  expect(nl({ ...base, listId: "aud_exna", from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org" }).success).toBe(true);
});

describe.skipIf(!enabled)("the executor wired into the org runtime (S3-c)", () => {
  // freshMs: the challenge-time rate bound; 1 ms here so a mint right after a prepare still reads (production: 5 s, own test).
  async function setup(o: { release?: boolean; maxAgeMs?: number; freshMs?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "knl-w-")), kf = join(dir, "totp.key"), rk = join(dir, "resend-release.key");
    writeFileSync(kf, randomBytes(32).toString("base64"), { mode: 0o600 }); chmodSync(kf, 0o600);
    writeFileSync(rk, "re_" + "C".repeat(30), { mode: 0o600 }); chmodSync(rk, 0o600);
    const resend = new FakeResend(); resend.setContacts(3);
    // `hold` parks every provider WRITE until released (to prove the approval never waits on the provider).
    const ctl = { hold: null as Promise<void> | null };
    const providerFetch = async (u: string, i: any) => { if (ctl.hold && i.method === "POST") await ctl.hold; return resend.fetch(u, i); };
    // The runtime's own /emails client (release tests and the incident mail): a fake, recording every message.
    const mails: { headers: Record<string, string>; body: any }[] = [], mailCtl = { status: 200 };
    const mailFetch = async (_u: string, i: any) => { mails.push({ headers: i.headers, body: JSON.parse(i.body) });
      return new Response(JSON.stringify(mailCtl.status === 200 ? { id: "em-" + mails.length } : { name: "fault" }), { status: mailCtl.status }); };
    const w = await transcriptionWorld({ newsletterProviderFetch: providerFetch, newsletterTestFetch: mailFetch, ...(o.maxAgeMs ? { newsletterAudienceMaxAgeMs: o.maxAgeMs } : {}),
      ...(o.freshMs === undefined ? { newsletterChallengeFreshMs: 1 } : o.freshMs ? { newsletterChallengeFreshMs: o.freshMs } : {}), newsletter: { totpKeyFile: kf, approvers: ["robin@exna.test"],
      from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org", ...(o.release === false ? {} : { releaseKeyFile: rk, listId: "aud_exna" }) } });
    const nl = w.org.newsletter!, db = () => w.org.sqlite.db;
    const link = (await w.ops("/ops/totp/enroll", { email: "robin@exna.test" })).link as string, token = new URLSearchParams(link.split("#totp?")[1]).get("token");
    const st = (await w.post("/o/exna/api/totp/enroll/start", { token }, w.robin)).result, seed = base32Decode(st.secret.replaceAll(" ", "")), t0 = totpStep(Date.now());
    expect((await w.post("/o/exna/api/totp/enroll/confirm", { code1: hotp(seed, t0 - 1), code2: hotp(seed, t0) }, w.robin)).ok).toBe(true);
    nl.importHistory([{ digest: "sha256:" + "b".repeat(64), slug: "2026-10-07-october", source: "historical" }], true);
    nl.recordTransfer({ installationId: w.org.sqlite.identity.installationId, frozenAt: new Date().toISOString(), attestedBy: "owner" });
    nl.recordSuppressionSync(new Date().toISOString(), "sha256:" + "f".repeat(64));
    const release = async () => {
      await w.org.newsletterRun?.audience.refresh();
      const r: any = nl.prepare({ slug: "2026-11-04-november", subject: "November", testSubject: "[TEST] November", from: "EXNA <newsletter@example.org>",
        replyTo: "hello@example.org", html: "<p>November</p>", text: "November", renderer: "kapelle.newsletter-renderer/v2", images: [], listId: "aud_exna" });
      r.testId = nl.recordTest({ digest: r.contentDigest, to: "robin@exna.test", receivedAt: new Date().toISOString() });
      nl.recordPreflight({ digest: r.contentDigest, ok: true, images: [] });
      return r as { releaseId: string; digest: string; testId: string; recipientCount: number };
    };
    const body = (r: { releaseId: string; testId: string }) => ({ releaseId: r.releaseId, testId: r.testId, attested: true });
    const mint = (r: { releaseId: string; digest: string; testId: string }, operationId = "op-nl-" + randomUUID()) =>
      w.post("/o/exna/challenge", { action: "newsletter.send", body: body(r), artifactDigest: r.digest, operationId }, w.robin).then((x: any) => ({ ...x, operationId }));
    const act = (r: { releaseId: string; digest: string; testId: string }, ch: { challengeId: string; operationId: string }, code: string) =>
      w.post("/o/exna/act", { challengeId: ch.challengeId, action: "newsletter.send", body: body(r), artifactDigest: r.digest, operationId: ch.operationId, totp: { code } }, w.robin);
    const state = (id: string) => (db().prepare("SELECT state, label FROM newsletter_effects WHERE release_id=?").get(id) as any);
    return { dir, w, nl, db, resend, ctl, mails, mailCtl, seed, t0, release, mint, act, state, close: async () => { await w.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it("Fable S3-a wiring: the mint refreshes the audience before the synchronous guard (an addition or an unreadable audience refuses; fresh and equal proceeds)", async () => {
    const s = await setup();
    try {
      const r = await s.release();
      expect(r.recipientCount).toBe(3);
      // An addition after prepare: the cached set still matches, so only a FRESH read at mint can refuse.
      s.resend.contacts.push({ id: "ct_new", email: "new@example.org", unsubscribed: false });
      expect((await s.mint(r)).error).toBe("newsletter_recipients_changed");
      s.resend.contacts.pop();
      // An unreadable audience at mint: the refresh empties the cache, the guard fails closed.
      s.resend.fault("GET", /^\/audiences\//, 503);
      expect((await s.mint(r)).error).toBe("newsletter_recipients_unknown");
      s.resend.clearFaults();
      const reads = s.resend.log.filter((l) => l === "GET /audiences/{id}/contacts").length;
      const ch = await s.mint(r);
      expect(ch.challengeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(s.resend.log.filter((l) => l === "GET /audiences/{id}/contacts").length).toBeGreaterThan(reads); // this mint read it again
      expect(s.db().prepare("SELECT COUNT(*) AS n FROM access_challenges WHERE action='newsletter.send'").get()).toEqual({ n: 1 });
    } finally { await s.close(); }
  });

  it("Fable S3-a wiring, literally: a STALE cache at mint is refreshed and the mint proceeds (without the refresh the guard would fail closed)", async () => {
    const s = await setup({ maxAgeMs: 300 });
    try {
      const r = await s.release();
      expect(s.w.org.newsletterRun!.audience.current()).toHaveLength(3);
      await new Promise((x) => setTimeout(x, 400));
      expect(s.w.org.newsletterRun!.audience.current()).toBeNull(); // stale: the synchronous guard alone would refuse
      const ch = await s.mint(r);
      expect(ch.challengeId).toMatch(/^[0-9a-f-]{36}$/); // refreshed before the guard -> proceeds
    } finally { await s.close(); }
  });

  it("Fable S3-c1 N-1: the pre-verification refresh is rate-bound (production 5 s): back-to-back challenges cause no extra provider read", async () => {
    const s = await setup({ freshMs: 0 }); // 0 = the production default
    try {
      const r = await s.release();
      await new Promise((x) => setTimeout(x, 20));
      const reads = () => s.resend.log.filter((l) => l === "GET /audiences/{id}/contacts").length, n0 = reads();
      const ch = await s.mint(r);
      expect(ch.challengeId).toMatch(/^[0-9a-f-]{36}$/);
      for (let i = 0; i < 3; i++) await s.mint(r);
      expect(reads() - n0).toBe(0); // the prepare-time read is younger than 5 s: no read before verification at all
    } finally { await s.close(); }
  });

  it("R-8: the approval returns at once; the executor runs the release in the background (recover first) to archive_pending; Ops status shows it", async () => {
    const s = await setup();
    try {
      const st0 = await s.w.ops("/ops/status", {});
      expect(st0.newsletter).toMatchObject({ providerConfigured: true, executor: { running: false, last: null, lastError: null } });
      const r = await s.release(), ch = await s.mint(r);
      // The provider is parked: the /act answer must arrive anyway (the approval is committed; the run is background).
      let go!: () => void; s.ctl.hold = new Promise<void>((x) => { go = x; });
      const a = await s.act(r, ch, hotp(s.seed, s.t0 + 1));
      expect(a.ok).toBe(true);
      expect(["approved", "create_attempted"]).toContain(s.state(r.releaseId).state);
      expect(s.resend.broadcasts).toEqual([]);
      s.ctl.hold = null; go();
      await new Promise((x) => setImmediate(x)); await s.w.org.newsletterRun!.idle();
      expect(s.state(r.releaseId)).toMatchObject({ state: "archive_pending", label: null });
      expect(s.resend.log.filter((l) => l === "POST /broadcasts").length).toBe(1);
      expect(s.resend.log.filter((l) => l === "POST /broadcasts/{id}/send").length).toBe(1);
      expect(s.resend.broadcasts[0]).toMatchObject({ name: expect.stringMatching(/^kapelle:op-nl-/), segment_id: "aud_exna", from: "EXNA <newsletter@example.org>", reply_to: "hello@example.org", status: "queued" });
      const proj = JSON.parse(readFileSync(join(s.w.cfg.stateRoot, "newsletter", "sent.json"), "utf8"));
      expect(proj.rows).toEqual([expect.objectContaining({ releaseId: r.releaseId, state: "archive_pending" })]);
      const st = await s.w.ops("/ops/status", {});
      expect(st.newsletter.executor).toMatchObject({ running: false, last: { releaseId: r.releaseId, state: "archive_pending", label: null }, lastError: null });
      // A later pass (the retry schedule, a restart) changes nothing: no second draft, no second send.
      s.w.org.newsletterRun!.kick(); await s.w.org.newsletterRun!.idle();
      expect(s.resend.log.filter((l) => l.startsWith("POST")).length).toBe(2);
    } finally { await s.close(); }
  });

  it("an uncertain read-back stays draft_known and the next pass (the retry schedule) completes it with ONE draft", async () => {
    const s = await setup();
    try {
      const r = await s.release(), ch = await s.mint(r);
      s.resend.fault("GET", /^\/broadcasts\/bc_/, 503);
      expect((await s.act(r, ch, hotp(s.seed, s.t0 + 1))).ok).toBe(true);
      await new Promise((x) => setImmediate(x)); await s.w.org.newsletterRun!.idle();
      expect(s.state(r.releaseId)).toMatchObject({ state: "draft_known" });
      s.w.org.newsletterRun!.kick(); await s.w.org.newsletterRun!.idle();
      expect(s.state(r.releaseId)).toMatchObject({ state: "archive_pending" });
      expect(s.resend.log.filter((l) => l === "POST /broadcasts").length).toBe(1);
    } finally { await s.close(); }
  });

  it("without the release key: no executor, providerConfigured false, no provider call at start or on approval", async () => {
    const s = await setup({ release: false });
    try {
      expect(s.w.org.newsletterRun).toBeNull();
      expect((await s.w.ops("/ops/status", {})).newsletter).toMatchObject({ providerConfigured: false, executor: null });
      expect(s.resend.log).toEqual([]);
      expect(existsSync(join(s.w.cfg.stateRoot, "newsletter", "sent.json"))).toBe(false);
    } finally { await s.close(); }
  });

  it("R-7 Ops facts: transfer must name THIS installation with exact past instants; suppression-sync is an evidence hash; retirement is one-way; audited by hash", async () => {
    const s = await setup();
    try {
      const inst = s.w.org.sqlite.identity.installationId, now = new Date().toISOString(), soon = new Date(Date.now() + 3_600_000).toISOString();
      const t = { installationId: inst, packVersion: "kapelle.newsletter-pack/v1", policyVersion: "p-2026-10-18", frozenAt: now, attestedBy: "owner" };
      expect((await s.w.ops("/ops/newsletter/transfer", { ...t, installationId: "inst_other" })).error).toBe("newsletter_installation_not_authorized");
      expect((await s.w.ops("/ops/newsletter/transfer", { ...t, frozenAt: soon })).error).toBe("newsletter_transfer_invalid");
      expect((await s.w.ops("/ops/newsletter/transfer", { ...t, frozenAt: "2026-10-18" })).error).toBe("newsletter_transfer_invalid");
      expect((await s.w.ops("/ops/newsletter/transfer", { ...t, extra: 1 })).error).toBe("newsletter_transfer_invalid");
      expect((await s.w.ops("/ops/newsletter/transfer", { ...t, attestedBy: "Alex <c@x>" })).error).toBe("newsletter_transfer_invalid");
      expect(await s.w.ops("/ops/newsletter/transfer", t)).toMatchObject({ ok: true, installationId: inst, frozenAt: now });
      expect((await s.w.ops("/ops/newsletter/suppression-sync", { at: now, evidenceSha256: "abc" })).error).toBe("newsletter_suppression_invalid");
      expect((await s.w.ops("/ops/newsletter/suppression-sync", { at: soon, evidenceSha256: "sha256:" + "a".repeat(64) })).error).toBe("newsletter_suppression_invalid");
      expect((await s.w.ops("/ops/newsletter/suppression-sync", { at: now, evidenceSha256: "sha256:" + "a".repeat(64), emails: [] })).error).toBe("newsletter_suppression_invalid");
      expect((await s.w.ops("/ops/newsletter/suppression-sync", { at: now, evidenceSha256: "sha256:" + "a".repeat(64) })).ok).toBe(true);
      expect((await s.w.ops("/ops/newsletter/old-audience-retired", { at: new Date(Date.parse(now) - 60_000).toISOString() })).error).toBe("newsletter_retire_invalid"); // before the freeze
      const later = new Date(Date.parse(now) + 1).toISOString();
      expect(await s.w.ops("/ops/newsletter/old-audience-retired", { at: later })).toMatchObject({ ok: true, at: later, unchanged: false });
      expect(await s.w.ops("/ops/newsletter/old-audience-retired", { at: later })).toMatchObject({ ok: true, at: later, unchanged: true }); // one-way, idempotent
      // Undoing a retirement needs a NEW transfer record (which clears it).
      expect(await s.w.ops("/ops/newsletter/transfer", { ...t, frozenAt: later })).toMatchObject({ ok: true });
      const meta = JSON.parse((s.db().prepare("SELECT value FROM newsletter_meta WHERE key='transfer'").get() as any).value);
      expect(meta).toMatchObject({ installationId: inst, packVersion: "kapelle.newsletter-pack/v1", frozenAt: later, oldAudienceRetiredAt: null });
      const audit = s.db().prepare("SELECT event, record_sha256, installation_id FROM newsletter_ops_audit ORDER BY rowid").all() as any[];
      expect(audit.map((a) => a.event)).toEqual(["transfer", "suppression_sync", "old_audience_retired", "transfer"]);
      expect(audit.every((a) => /^sha256:[a-f0-9]{64}$/.test(a.record_sha256) && a.installation_id === inst)).toBe(true);
      expect(JSON.stringify(audit)).not.toContain("owner"); // hashes and ids only
    } finally { await s.close(); }
  });

  it("Fable answer 2: a release that needs a person mails every active admin ONCE with the fixed template (no slug, no subject); a mail failure is a label, never a retry", async () => {
    const s = await setup();
    try {
      const admins = s.db().prepare("SELECT member_id, email FROM access_members WHERE role='admin' AND status='active' ORDER BY member_id").all() as any[];
      expect(admins.length).toBeGreaterThan(0);
      // held: an addition between approval and send (the pre-send fence).
      const r = await s.release(), ch = await s.mint(r);
      let go!: () => void; s.ctl.hold = new Promise<void>((x) => { go = x; });
      expect((await s.act(r, ch, hotp(s.seed, s.t0 + 1))).ok).toBe(true);
      s.resend.contacts.push({ id: "ct_new", email: "new@example.org", unsubscribed: false });
      s.ctl.hold = null; go();
      await new Promise((x) => setImmediate(x)); await s.w.org.newsletterRun!.idle();
      expect(s.state(r.releaseId)).toMatchObject({ state: "held", label: "newsletter_recipients_changed" });
      const sent = s.mails.filter((m) => m.headers["idempotency-key"].startsWith("kapelle-nl-incident-"));
      expect(sent.map((m) => m.body.to[0]).sort()).toEqual(admins.map((a) => a.email).sort());
      expect(sent.map((m) => m.headers["idempotency-key"]).sort()).toEqual(admins.map((a) => `kapelle-nl-incident-${r.releaseId}-held-${a.member_id}`).sort());
      const text = sent[0].body.text as string;
      expect(text).toContain(`Release: ${r.releaseId}`);
      expect(text).toContain("State: held");
      expect(text).toContain("Reason: newsletter_recipients_changed");
      expect(text).toContain(`Content digest: ${(s.db().prepare("SELECT digest FROM newsletter_releases WHERE id=?").get(r.releaseId) as any).digest.slice(7, 19)}`);
      for (const m of sent) { expect(m.body.subject).toBe("Kapelle: a newsletter release needs attention"); expect(JSON.stringify(m.body)).not.toMatch(/November|2026-11-04/); expect(m.body.html).toBeUndefined(); }
      expect((s.db().prepare("SELECT incident_mail FROM newsletter_effects WHERE release_id=?").get(r.releaseId) as any).incident_mail).toBe(`held:sent:${admins.length}`);
      expect((await s.w.ops("/ops/status", {})).newsletter.unsettledRows).toEqual([expect.objectContaining({ releaseId: r.releaseId, incidentMail: `held:sent:${admins.length}` })]);
      // The next passes send nothing more for this transition.
      const n = s.mails.length; s.w.org.newsletterRun!.kick(); await s.w.org.newsletterRun!.idle();
      expect(s.mails.length).toBe(n);
      // A failed mail: the label on the row, no retry.
      s.db().prepare("UPDATE newsletter_effects SET state='reconcile_required', label='newsletter_overrun' WHERE release_id=?").run(r.releaseId);
      s.mailCtl.status = 500;
      s.w.org.newsletterRun!.kick(); await s.w.org.newsletterRun!.idle();
      expect((s.db().prepare("SELECT incident_mail FROM newsletter_effects WHERE release_id=?").get(r.releaseId) as any).incident_mail).toBe(`reconcile_required:failed:${admins.length}/${admins.length}:mail_http_500:type=fault`);
      const m = s.mails.length; s.mailCtl.status = 200; s.w.org.newsletterRun!.kick(); await s.w.org.newsletterRun!.idle();
      expect(s.mails.length).toBe(m);
    } finally { await s.close(); }
  });

  it("restore_reconcile_required mails the admins once (fixed template, no release content)", async () => {
    const s = await setup();
    try {
      const dir = join(s.w.cfg.stateRoot, "newsletter");
      writeFileSync(join(dir, "sent.json"), JSON.stringify({ contract: "kapelle.newsletter-manifest/v1", rows: [{ releaseId: "nr_" + "9".repeat(32), slug: "x", digest: "sha256:" + "1".repeat(64),
        operationId: "op", state: "provider_accepted", broadcastId: "bc_1", at: new Date().toISOString() }] }));
      s.w.org.newsletterRun!.kick(); await s.w.org.newsletterRun!.idle();
      expect((await s.w.ops("/ops/status", {})).newsletter.restoreReconcile).toBe(true);
      const sent = s.mails.filter((m) => m.headers["idempotency-key"].startsWith("kapelle-nl-incident-restore-restore_reconcile_required-"));
      expect(sent.length).toBeGreaterThan(0);
      expect(sent[0].body.text).toContain("Reason: newsletter_restore_reconcile");
      s.w.org.newsletterRun!.kick(); await s.w.org.newsletterRun!.idle();
      expect(s.mails.filter((m) => m.headers["idempotency-key"].startsWith("kapelle-nl-incident-restore-")).length).toBe(sent.length);
    } finally { await s.close(); }
  });
});
