// Newsletter send slice 1, S1-c (PLAN-NEWSLETTER-SLICE1; Fable F-1, F-4..F-7, R-1..R-4, R-8, R-9; answers 2-3): the in-app
// TOTP step-up for newsletter.send and the fixture-only release core. No provider, no test sending, no network beyond loopback.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { evaluateRelease, recipientsDigest, type ReleaseFacts } from "../src/org/newsletter/release.js";
import { NEWSLETTER_REASONS, RELEASE_STATES } from "../src/org/newsletter/labels.js";
import { ACCESS_ACTIONS, STEP_UP, TOTP_IN_APP, bodyHash, stepUpOf } from "../src/access/org-access.js";
import { base32Decode, hotp, totpStep } from "../src/access/totp.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";
import { transcriptionWorld } from "./transcription-world.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const D = "sha256:" + "a".repeat(64), NOW = "2026-10-20T15:00:00.000Z";
const base = (): ReleaseFacts => ({
  now: NOW, installationId: "inst-1",
  release: { slug: "2026-10-21-october", digest: D, contentDigest: D, state: "prepared", imageUrls: ["https://site.example/a.png"], recipientsSha: recipientsDigest(["c1", "c2"]), approvedRecipients: ["c1", "c2"] },
  approver: { email: "alex@example.org", permitted: true }, lastTest: { digest: D, to: "alex@example.org", receivedAt: "2026-10-20T10:00:00.000Z", path: "release", state: "sent" }, attested: true,
  preflight: { ok: true, images: [{ url: "https://site.example/a.png", ok: true }] }, history: { complete: true, digests: ["sha256:" + "b".repeat(64)], slugs: { "2026-10-07-october": "sha256:" + "b".repeat(64) } },
  transfer: { installationId: "inst-1", frozenAt: "2026-10-19T00:00:00.000Z", oldAudienceRetiredAt: null }, suppressionSyncAt: "2026-10-20T09:00:00.000Z",
  currentRecipients: ["c1", "c2"], releasesThisMonth: 0, releasesPerMonth: 4, killed: false, unsettled: 0 });

it("R-9 evaluateRelease is pure and table-driven: [] when every gate passes; one fixed label per failed gate", () => {
  expect(evaluateRelease(base())).toEqual([]);
  const cases: [string, (f: ReleaseFacts) => void][] = [
    ["newsletter_killed", (f) => { f.killed = true; }],
    ["newsletter_uncertain_release", (f) => { f.unsettled = 1; }],
    ["newsletter_release_state", (f) => { f.release!.state = "approved"; }],
    ["newsletter_approver_not_permitted", (f) => { f.approver.permitted = false; }],
    ["newsletter_slug_invalid", (f) => { f.release!.slug = "october"; }],
    ["newsletter_slug_reused", (f) => { f.history.slugs["2026-10-21-october"] = "sha256:" + "c".repeat(64); }],
    ["newsletter_history_incomplete", (f) => { f.history.complete = false; }],
    ["newsletter_duplicate", (f) => { f.history.digests.push(D); }],
    ["newsletter_test_missing", (f) => { f.lastTest = null; }],
    ["newsletter_test_mismatch", (f) => { f.lastTest!.digest = "sha256:" + "d".repeat(64); }],
    ["newsletter_test_preview_only", (f) => { f.lastTest!.path = "preview"; }],   // S2-a conflict 1: a preview never unlocks a release
    ["newsletter_test_unknown", (f) => { f.lastTest!.state = "unknown"; }],
    ["newsletter_attestation_required", (f) => { f.attested = false; }],          // R-5
    ["newsletter_duplicate", (f) => { f.release!.digest = "sha256:" + "8".repeat(64); f.history.digests.push(D); }], // same CONTENT, other recipients
    ["newsletter_test_wrong_recipient", (f) => { f.lastTest!.to = "someone@example.org"; }],
    ["newsletter_test_stale", (f) => { f.lastTest!.receivedAt = "2026-10-19T14:59:00.000Z"; }],
    ["newsletter_test_stale", (f) => { f.lastTest!.receivedAt = "2026-10-20T15:05:00.000Z"; }], // from the future
    ["newsletter_preflight_failed", (f) => { f.preflight = null; }],
    ["newsletter_preflight_failed", (f) => { f.preflight!.ok = false; }],
    ["newsletter_images_unserved", (f) => { f.preflight!.images = [{ url: "https://site.example/a.png", ok: false }]; }],
    // Package E (Fable E-2): the test's preflight saw other bytes than prepare bound: "replaced", not "gone".
    ["newsletter_image_changed", (f) => { f.release!.images = [{ url: "https://site.example/a.png", sha256: "sha256:" + "1".repeat(64) }];
      f.preflight!.images = [{ url: "https://site.example/a.png", ok: true, sha256: "sha256:" + "2".repeat(64) }]; }],
    ["newsletter_transfer_missing", (f) => { f.transfer = null; }],
    ["newsletter_installation_not_authorized", (f) => { f.transfer!.installationId = "other"; }],
    ["newsletter_suppression_stale", (f) => { f.suppressionSyncAt = "2026-10-19T14:00:00.000Z"; }],
    ["newsletter_suppression_stale", (f) => { f.suppressionSyncAt = null; }],
    ["newsletter_recipients_unknown", (f) => { f.currentRecipients = null; }],
    ["newsletter_recipients_changed", (f) => { f.currentRecipients = ["c1", "c2", "c3"]; }],
    ["newsletter_recipients_changed", (f) => { f.release!.approvedRecipients = ["c1", "c2", "c9"]; }], // the stored set no longer matches its digest
    ["newsletter_release_cap", (f) => { f.releasesThisMonth = 4; }],
  ];
  for (const [label, mutate] of cases) { const f = base(); mutate(f); expect(evaluateRelease(f), label).toContain(label); }
  // Removals are allowed (N shrinks); a retired old audience lifts the suppression gate; a missing release short-circuits.
  expect(evaluateRelease({ ...base(), currentRecipients: ["c1"] })).toEqual([]);
  expect(evaluateRelease({ ...base(), suppressionSyncAt: null, transfer: { ...base().transfer!, oldAudienceRetiredAt: "2026-10-19T00:00:00.000Z" } })).toEqual([]);
  expect(evaluateRelease({ ...base(), release: null })).toEqual(["newsletter_release_unknown"]);
  for (const l of NEWSLETTER_REASONS) { expect(failureLabel(new Error(l)), l).toBe(l); expect(persistedReason(l)).toBe(l); }
});

it("access: newsletter.send is the ONLY in-app totp action; every other totp action stays Ops-only", () => {
  expect(TOTP_IN_APP).toEqual(["newsletter.send"]);
  expect(stepUpOf("newsletter.send")).toBe("totp");
  expect(ACCESS_ACTIONS.consequential).toContain("newsletter.send");
  expect(STEP_UP.totp).toEqual(expect.arrayContaining(["site.deploy", "member.invite", "policy.approve", "newsletter.send"]));
});

describe.skipIf(!enabled)("newsletter.send with an authenticator code (S1-c)", () => {
  async function setup(o: { approvers?: string[]; releasesPerMonth?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "knl-")), kf = join(dir, "totp.key");
    writeFileSync(kf, randomBytes(32).toString("base64"), { mode: 0o600 }); chmodSync(kf, 0o600);
    const audience = { ids: ["c-1", "c-2", "c-3"] as string[] | null };
    const w = await transcriptionWorld({ newsletter: { totpKeyFile: kf, approvers: o.approvers ?? ["robin@exna.test"], releasesPerMonth: o.releasesPerMonth ?? 4 },
      newsletterRecipients: () => audience.ids });
    const nl = w.org.newsletter!, db = () => w.org.sqlite.db;
    const enroll = async (cookie: string, email: string) => {
      const link = (await w.ops("/ops/totp/enroll", { email })).link as string, token = new URLSearchParams(link.split("#totp?")[1]).get("token");
      const s = (await w.post("/o/exna/api/totp/enroll/start", { token }, cookie)).result, seed = base32Decode(s.secret.replaceAll(" ", "")), c = totpStep(Date.now());
      expect((await w.post("/o/exna/api/totp/enroll/confirm", { code1: hotp(seed, c - 1), code2: hotp(seed, c) }, cookie)).ok).toBe(true);
      return seed;
    };
    const release = (slug = "2026-10-21-october") => nl.prepare({ slug, subject: "October in Example Park", testSubject: "[TEST] October in Example Park",
      from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org", html: `<h1>${slug}</h1>`, text: slug, renderer: "kapelle.newsletter-renderer/v2",
      images: [{ url: "https://site.example/a.png", sha256: "sha256:" + "e".repeat(64) }], listId: "aud-1" });
    // S2-a: the test and preflight bind the CONTENT digest; the approval body names the test and the attestation (R-5).
    const ready = (r: { contentDigest: string; testId?: string }, to = "robin@exna.test") => {
      r.testId = nl.recordTest({ digest: r.contentDigest, to, receivedAt: new Date().toISOString() });
      nl.recordPreflight({ digest: r.contentDigest, ok: true, images: [{ url: "https://site.example/a.png", ok: true }] });
    };
    nl.importHistory([{ digest: "sha256:" + "b".repeat(64), slug: "2026-10-07-october", source: "historical" }], true);
    nl.recordTransfer({ installationId: w.org.sqlite.identity.installationId, frozenAt: new Date().toISOString(), attestedBy: "owner" });
    nl.recordSuppressionSync(new Date().toISOString(), "sha256:" + "f".repeat(64));
    const mint = (cookie: string, r: { releaseId: string; digest: string; testId?: string }, operationId = "op-nl-" + randomUUID()) =>
      w.post("/o/exna/challenge", { action: "newsletter.send", body: { releaseId: r.releaseId, testId: r.testId, attested: true }, artifactDigest: r.digest, operationId }, cookie).then((x: any) => ({ ...x, operationId }));
    const act = (cookie: string, r: { releaseId: string; digest: string; testId?: string }, ch: { challengeId: string; operationId: string }, code: string) =>
      w.post("/o/exna/act", { challengeId: ch.challengeId, action: "newsletter.send", body: { releaseId: r.releaseId, testId: r.testId, attested: true }, artifactDigest: r.digest, operationId: ch.operationId, totp: { code } }, cookie);
    const factor = (email: string) => db().prepare("SELECT last_counter, failures, locked_at FROM totp_factors WHERE state='active' AND member_id=(SELECT member_id FROM access_members WHERE email=?)").get(email) as any;
    const challenge = (id: string) => db().prepare("SELECT consumed_at, expires_at FROM access_challenges WHERE id=?").get(id) as any;
    return { dir, w, nl, db, audience, enroll, release, ready, mint, act, factor, challenge, close: async () => { await w.close(); rmSync(dir, { recursive: true, force: true }); } };
  }

  it("mint refusals; a wrong code keeps the challenge and counts; the right code approves in ONE txn; replay and one-code-two-challenges refused; receipts", async () => {
    const s = await setup();
    try {
      const { w, nl, db } = s, r1 = s.release();
      expect(r1.recipientCount).toBe(3);
      // Mint refusals (no challenge row is left behind by any of them).
      expect((await s.mint(w.robin, r1)).error).toBe("totp_not_enrolled");
      const seed = await s.enroll(w.robin, "robin@exna.test"), t0 = s.factor("robin@exna.test").last_counter;
      expect((await s.mint(w.robin, r1)).error).toBe("newsletter_test_missing"); // F-4: no challenge without the approver's own recent [TEST]
      s.ready(r1, "admin@exna.test");
      expect((await s.mint(w.robin, r1)).error).toBe("newsletter_test_wrong_recipient");
      s.ready(r1);
      expect((await s.mint(w.robin, { ...r1, digest: "sha256:" + "0".repeat(64) })).error).toBe("newsletter_release_changed");
      // S2-a conflict 1: a PREVIEW test (agent@ key) never unlocks a challenge; R-5: the attestation is part of the body.
      (r1 as any).testId = nl.recordTest({ digest: r1.contentDigest, to: "robin@exna.test", receivedAt: new Date().toISOString(), path: "preview" });
      expect((await s.mint(w.robin, r1)).error).toBe("newsletter_test_preview_only");
      s.ready(r1);
      expect((await w.post("/o/exna/challenge", { action: "newsletter.send", body: { releaseId: r1.releaseId, testId: (r1 as any).testId }, artifactDigest: r1.digest,
        operationId: "op-nl-noattest-1" }, w.robin)).error).toBe("newsletter_attestation_required");
      await s.enroll(w.admin, "admin@exna.test");
      expect((await s.mint(w.admin, r1)).error).toBe("newsletter_approver_not_permitted"); // answer 3: approvers are named
      expect((await w.post("/o/exna/challenge", { action: "site.deploy", body: {}, artifactDigest: null, operationId: "op-site-0001" }, w.admin)).error).toBe("access_step_up_required");
      expect((await w.post("/o/exna/challenge", { action: "member.invite", body: { email: "x@y.test", role: "contributor" }, artifactDigest: null, operationId: "op-inv-00001" }, w.admin)).error).toBe("access_step_up_required");
      expect(nl.setKill(true)).toEqual({ on: true });
      expect((await s.mint(w.robin, r1)).error).toBe("newsletter_killed");
      nl.setKill(false);
      expect(db().prepare("SELECT COUNT(*) AS n FROM access_challenges WHERE action='newsletter.send'").get()).toEqual({ n: 0 });
      // A challenge: two minutes, bound to the digest.
      const ch = await s.mint(w.robin, r1);
      expect(ch.ok).toBe(true);
      expect(Date.parse(ch.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);
      // R-8: a code failure does NOT consume the challenge; it counts (in the refusal transaction) and is audited by kind.
      expect((await s.act(w.robin, r1, ch, "000000")).error).toBe("totp_code_invalid");
      expect(s.challenge(ch.challengeId).consumed_at).toBeNull();
      expect(s.factor("robin@exna.test")).toMatchObject({ failures: 1, last_counter: t0 });
      expect((await s.act(w.robin, r1, ch, hotp(seed, t0))).error).toBe("totp_code_invalid"); // the enrollment's own last code: replayed
      expect(s.factor("robin@exna.test").failures).toBe(2);
      const reasons = (w.org.access.auditRows() as any[]).filter((a) => a.action === "newsletter.send" && a.outcome === "refused").map((a) => a.reason);
      expect(reasons).toEqual(["totp_code_invalid:wrong", "totp_code_invalid:replayed"]);
      // Another MEMBER presenting the challenge is refused without burning it (an outsider cannot destroy a pending approval);
      // the same member from ANOTHER session is the R-8 binding failure: it burns the challenge, before any code is checked.
      const ch2 = await s.mint(w.robin, r1);
      expect((await s.act(w.admin, r1, ch2, hotp(seed, t0 + 1))).error).toBe("access_challenge_binding");
      expect(s.challenge(ch2.challengeId).consumed_at).toBeNull();
      const robinId = (db().prepare("SELECT member_id FROM access_members WHERE email='robin@exna.test'").get() as any).member_id;
      const robin2 = ((w.hub.hub as any).openSession("exna", { memberId: robinId, email: "robin@exna.test", membershipVersion: w.org.access.membershipVersion() }) as string).split(";")[0];
      expect((await s.act(robin2, r1, ch2, hotp(seed, t0 + 1))).error).toBe("access_challenge_session_mismatch");
      expect(s.challenge(ch2.challengeId).consumed_at).not.toBeNull();
      expect(s.factor("robin@exna.test")).toMatchObject({ failures: 2, last_counter: t0 }); // not a code failure
      // The right code (T+1 > last_counter): authorization, counter, challenge and the `approved` effect together.
      const ch3 = await s.mint(w.robin, r1), code = hotp(seed, t0 + 1);
      const ok = await s.act(w.robin, r1, ch3, code);
      expect(ok).toMatchObject({ ok: true, authorization: { action: "newsletter.send", authn: "totp", artifactDigest: r1.digest }, result: { releaseId: r1.releaseId, state: "approved" } });
      expect(s.factor("robin@exna.test")).toMatchObject({ last_counter: t0 + 1, failures: 0 });
      expect(s.challenge(ch3.challengeId).consumed_at).not.toBeNull();
      expect(db().prepare("SELECT step_up, authn, body_hash FROM access_authorizations WHERE operation_id=?").get(ch3.operationId)).toEqual({ step_up: "totp", authn: "totp", body_hash: bodyHash({ releaseId: r1.releaseId, testId: (r1 as any).testId, attested: true }) });
      expect(db().prepare("SELECT state, operation_id, approved_by FROM newsletter_effects").all()).toEqual([{ state: "approved", operation_id: ch3.operationId,
        approved_by: (db().prepare("SELECT member_id FROM access_members WHERE email='robin@exna.test'").get() as any).member_id }]);
      // R-1: the code is in no stored hash and no audit row.
      const withCode = bodyHash({ challengeId: ch3.challengeId, action: "newsletter.send", body: { releaseId: r1.releaseId, testId: (r1 as any).testId, attested: true }, artifactDigest: r1.digest, operationId: ch3.operationId, totp: { code } });
      const dump = JSON.stringify([db().prepare("SELECT * FROM access_authorizations").all(), db().prepare("SELECT * FROM access_challenges").all(), w.org.access.auditRows()]);
      expect(dump).not.toContain(withCode);
      expect(dump).not.toMatch(/"code"|totp\W*code/i); // "totp" appears only as the authn value
      expect((w.org.access.auditRows() as any[]).some((a) => Object.values(a).some((v) => v === code))).toBe(false);
      // Receipts: the approver and every other active admin.
      for (let i = 0; i < 50 && !w.mail.some((m: any) => m.kind === "receipt" && m.receipt?.action === "newsletter.send"); i++) await new Promise((r) => setTimeout(r, 20));
      expect(w.mail.filter((m: any) => m.kind === "receipt" && m.receipt?.action === "newsletter.send").map((m: any) => m.to).sort()).toEqual(["admin@exna.test", "robin@exna.test"]);
      // Replay of the same code on another release, and an approved release cannot be approved again.
      const r2 = s.release("2026-11-04-november"); s.ready(r2);
      const ch4 = await s.mint(w.robin, r2);
      expect((await s.act(w.robin, r2, ch4, code)).error).toBe("totp_code_invalid"); // one code never authorizes two challenges
      expect((await s.mint(w.robin, r1)).error).toBe("newsletter_release_state");
      // R-9: slice 1 writes no state but prepared/approved.
      expect((db().prepare("SELECT DISTINCT state FROM newsletter_releases ORDER BY state").all() as any[]).map((x) => x.state)).toEqual(["approved", "prepared"]);
      expect((db().prepare("SELECT DISTINCT state FROM newsletter_effects").all() as any[]).map((x) => x.state)).toEqual(["approved"]);
      expect(RELEASE_STATES).toContain("provider_accepted");
      expect((await w.ops("/ops/status", {})).newsletter).toMatchObject({ killed: false, releases: { approved: 1, prepared: 1 }, unsettled: 0, transferRecorded: true, providerConfigured: false });
    } finally { await s.close(); }
  });

  it("five wrong codes lock and void; a gate failure after a good code voids the challenge, rolls everything back and is not a TOTP failure; skew; mint cap; re-mint voids; monthly cap", async () => {
    const s = await setup({ releasesPerMonth: 1 });
    try {
      const { w, db, audience } = s, seed = await s.enroll(w.robin, "robin@exna.test"), t0 = s.factor("robin@exna.test").last_counter;
      const r1 = s.release(); s.ready(r1);
      // Gate failure inside the verification txn (a subscriber added after mint): nothing committed but the void.
      const ch = await s.mint(w.robin, r1);
      audience.ids = ["c-1", "c-2", "c-3", "c-4"];
      expect((await s.act(w.robin, r1, ch, hotp(seed, t0 + 1))).error).toBe("newsletter_recipients_changed");
      expect(s.challenge(ch.challengeId).consumed_at).not.toBeNull();
      expect(s.factor("robin@exna.test")).toMatchObject({ last_counter: t0, failures: 0 }); // the counter advance rolled back too
      expect(db().prepare("SELECT COUNT(*) AS n FROM access_authorizations WHERE action='newsletter.send'").get()).toEqual({ n: 0 });
      expect(db().prepare("SELECT COUNT(*) AS n FROM newsletter_effects").get()).toEqual({ n: 0 });
      audience.ids = ["c-1", "c-2"]; // a removal is fine (N shrinks)
      // Re-mint for the same operationId voids the open one (R-3).
      const a = await s.mint(w.robin, r1), b = await s.mint(w.robin, r1, a.operationId);
      expect(s.challenge(a.challengeId).consumed_at).not.toBeNull();
      expect(s.challenge(b.challengeId).consumed_at).toBeNull();
      // Clock skew (R-4): an accepted counter far ahead of the clock fails closed and shows in /ops/status.
      db().prepare("UPDATE totp_factors SET last_counter=? WHERE state='active'").run(t0 + 10);
      expect((await s.act(w.robin, r1, b, hotp(seed, t0 + 1))).error).toBe("totp_clock_skew");
      expect((await w.ops("/ops/status", {})).totp).toMatchObject({ clockSkew: true });
      db().prepare("UPDATE totp_factors SET last_counter=? WHERE state='active'").run(t0);
      // Five wrong codes: locked, the challenge voided, minting refused until Ops re-enrolls.
      const c = await s.mint(w.robin, r1);
      for (let i = 0; i < 5; i++) expect((await s.act(w.robin, r1, c, "00000" + i)).error).toBe("totp_code_invalid");
      expect(s.factor("robin@exna.test")).toMatchObject({ failures: 5, locked_at: expect.any(String) });
      expect(s.challenge(c.challengeId).consumed_at).not.toBeNull();
      expect((await s.mint(w.robin, r1)).error).toBe("totp_factor_locked");
      expect((await w.ops("/ops/status", {})).totp).toMatchObject({ locked: 1 });
      // Ops re-enrollment clears it; the release is approved with the next code.
      const seed2 = await s.enroll(w.robin, "robin@exna.test"), t1 = s.factor("robin@exna.test").last_counter;
      const d = await s.mint(w.robin, r1);
      expect((await s.act(w.robin, r1, d, hotp(seed2, t1 + 1))).ok).toBe(true);
      // Monthly cap (releasesPerMonth 1): the next release cannot even mint.
      const r2 = s.release("2026-11-04-november"); s.ready(r2);
      expect((await s.mint(w.robin, r2)).error).toBe("newsletter_release_cap");
      // Mint cap: 10 per member per hour.
      db().prepare("DELETE FROM newsletter_effects").run(); db().prepare("UPDATE newsletter_releases SET state='prepared'").run();
      let refused = "";
      for (let i = 0; i < 12 && !refused; i++) { const x = await s.mint(w.robin, r2); if (!x.ok) refused = x.error; }
      expect(refused).toBe("totp_mint_rate_limited");
    } finally { await s.close(); }
  });

  it("an unsettled release blocks every release; without a newsletter block newsletter.send is not configured; N-2: expired link, removal revokes", async () => {
    const s = await setup();
    try {
      const { w, db } = s, seed = await s.enroll(w.robin, "robin@exna.test"), t0 = s.factor("robin@exna.test").last_counter;
      const r1 = s.release(); s.ready(r1);
      // A slice-2 state on another release (an uncertain send) holds every release of the org (F-7).
      db().prepare("INSERT INTO newsletter_releases(id,slug,digest,package,recipients,state,operation_id,created_at,approved_at) VALUES ('nr_" + "9".repeat(32) + "','2026-09-01-x','sha256:" + "9".repeat(64) + "','{}','[]','send_attempted','op-x',?,?)").run(new Date().toISOString(), new Date().toISOString());
      db().prepare("INSERT INTO newsletter_effects(release_id,operation_id,approved_by,state,at) VALUES ('nr_" + "9".repeat(32) + "','op-x','m','send_attempted',?)").run(new Date().toISOString());
      expect((await s.mint(w.robin, r1)).error).toBe("newsletter_uncertain_release");
      expect((await w.ops("/ops/status", {})).newsletter).toMatchObject({ unsettled: 1 });
      void seed; void t0;
      // N-2: an enrollment link past its 15 minutes.
      const link = (await w.ops("/ops/totp/enroll", { email: "admin@exna.test" })).link as string, token = new URLSearchParams(link.split("#totp?")[1]).get("token");
      db().prepare("UPDATE totp_enrollments SET expires_at=? WHERE consumed_at IS NULL").run(new Date(Date.now() - 1000).toISOString());
      expect((await w.post("/o/exna/api/totp/enroll/start", { token }, w.admin)).error).toBe("totp_enroll_token_invalid");
      // N-2: removing a member revokes their factor (Ops removal); the audit names Ops revoke truthfully (N-1).
      expect((await w.ops("/ops/member/remove", { email: "robin@exna.test" })).ok).toBe(true);
      expect((db().prepare("SELECT state, revoked_reason FROM totp_factors ORDER BY created_at DESC LIMIT 1").get())).toEqual({ state: "revoked", revoked_reason: "member-removed" });
      expect((await w.ops("/ops/totp/revoke", { email: "admin@exna.test" })).ok).toBe(true);
      expect((w.org.access.auditRows() as any[]).filter((a) => a.action === "totp.revoke").length).toBe(1);
    } finally { await s.close(); }
    const w2 = await transcriptionWorld();
    try {
      expect((await w2.post("/o/exna/challenge", { action: "newsletter.send", body: { releaseId: "nr_" + "1".repeat(32) }, artifactDigest: "sha256:" + "1".repeat(64), operationId: "op-nl-00000001" }, w2.robin)).error)
        .toBe("totp_not_configured");
    } finally { await w2.close(); }
  });
});
