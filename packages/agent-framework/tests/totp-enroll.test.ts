// Newsletter send slice 1, S1-b (PLAN-NEWSLETTER-SLICE1; Fable F-2, R-5, R-7; answers 1-2): the per-org key file, sealed
// seeds, the Ops-minted enrollment link, enroll start/confirm on a fresh session, revocation, restore elsewhere, and that
// no seed or secret is stored anywhere in clear. Real org runtime + hub; synthetic members; no network beyond loopback.
import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTotpKey, sealSeed, openSeed, qrRows, TOTP_REASONS } from "../src/access/totp-factors.js";
import { base32Decode, base32Encode, hotp, totpStep } from "../src/access/totp.js";
import { ACCESS_ACTIONS, STEP_UP, stepUpOf } from "../src/access/org-access.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";
import { render } from "../deploy/kapelle-admin.js";
import { transcriptionWorld } from "./transcription-world.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const keyFile = (dir: string, name = "totp.key", key = randomBytes(32)) => { const p = join(dir, name); writeFileSync(p, key.toString("base64") + "\n", { mode: 0o600 }); chmodSync(p, 0o600); return p; };

it("R-5 key file at use: regular, not a symlink, 0600, exactly 32 bytes of base64; kid = 16 hex of its sha256", () => {
  const d = mkdtempSync(join(tmpdir(), "ktotp-key-"));
  try {
    const key = randomBytes(32), good = keyFile(d, "good.key", key);
    expect(readTotpKey(good)).toEqual({ key, kid: createHash("sha256").update(key).digest("hex").slice(0, 16) });
    const bad = (name: string, body: string, mode = 0o600) => { const p = join(d, name); writeFileSync(p, body, { mode }); chmodSync(p, mode); return p; };
    for (const p of [join(d, "missing.key"), bad("open.key", key.toString("base64"), 0o644), bad("short.key", randomBytes(31).toString("base64")),
      bad("long.key", randomBytes(33).toString("base64")), bad("hex.key", key.toString("hex")), bad("junk.key", "x".repeat(44))])
      expect(() => readTotpKey(p), p).toThrow("totp_key_unavailable");
    symlinkSync(good, join(d, "link.key"));
    expect(() => readTotpKey(join(d, "link.key"))).toThrow("totp_key_unavailable");
    for (const l of TOTP_REASONS) { expect(failureLabel(new Error(l)), l).toBe(l); expect(persistedReason(l)).toBe(l); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});

it("F-2 sealed seeds: AES-256-GCM with AAD org|member|factor; another org, member, factor, key or a tampered tag never opens", () => {
  const key = randomBytes(32), seed = randomBytes(20), ids = { orgId: "exna", memberId: "m-1", factorId: "tf_1" };
  const s = sealSeed(key, seed, ids);
  expect(openSeed(key, s, ids).equals(seed)).toBe(true);
  expect(Buffer.from(s.ct, "base64").equals(seed)).toBe(false);
  expect(sealSeed(key, seed, ids).iv).not.toBe(s.iv); // a fresh IV each time
  for (const other of [{ ...ids, orgId: "other" }, { ...ids, memberId: "m-2" }, { ...ids, factorId: "tf_2" }]) expect(() => openSeed(key, s, other)).toThrow("totp_key_unavailable");
  expect(() => openSeed(randomBytes(32), s, ids)).toThrow("totp_key_unavailable");
  const tag = Buffer.from(s.tag, "base64"); tag[0] ^= 1;
  expect(() => openSeed(key, { ...s, tag: tag.toString("base64") }, ids)).toThrow("totp_key_unavailable");
  // The vendored QR: a square module grid (21 + 4k), deterministic.
  const rows = qrRows("otpauth://totp/Kapelle%20EXNA:a%40b.c?secret=GEZDGNBVGY3TQOJQ&issuer=Kapelle%20EXNA&algorithm=SHA1&digits=6&period=30");
  expect(rows.length).toBe(rows[0].length);
  expect((rows.length - 21) % 4).toBe(0);
  expect(rows.every((r) => /^[01]+$/.test(r))).toBe(true);
});

it("access table: enroll start/confirm are routine actions in the session-fresh tier; render adds the key file only with the newsletter block", () => {
  for (const a of ["totp.enroll.start", "totp.enroll.confirm"]) { expect(ACCESS_ACTIONS.routine).toContain(a); expect(stepUpOf(a)).toBe("session-fresh"); }
  expect(STEP_UP.totp).toContain("site.deploy"); // unchanged: Ops-only
  const root = mkdtempSync(join(tmpdir(), "ktotp-render-"));
  try {
    const base = { org: "exna", label: "Example Park", domain: "agent.example.org", monthlyUsd: 15, root, intake: "none" as const };
    const without = render(base);
    expect(without.secretsExpected.some((p) => p.endsWith("totp.key"))).toBe(false);
    expect(JSON.parse(readFileSync(without.orgConfig, "utf8")).newsletter).toBeUndefined();
    const withNl = render({ ...base, newsletter: { enable: "on" } });
    expect(withNl.secretsExpected.map((p) => p.replace(root, ""))).toContain("/etc/kapelle/secrets/exna/totp.key");
    expect(JSON.parse(readFileSync(withNl.orgConfig, "utf8")).newsletter).toEqual({ totpKeyFile: root + "/etc/kapelle/secrets/exna/totp.key", approvers: [],
      releasesPerMonth: 4, testsPerDay: 12, testsPerMemberPerDay: 6, listId: "unassigned", listField: "segment_id" }); // no approvers rendered = nobody can release (fail closed)
    expect(() => render({ ...base, newsletter: { enable: "" } })).toThrow("render_newsletter_enable_required");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe.skipIf(!enabled)("authenticator enrollment (S1-b)", () => {
  it("Ops link -> start (once, member-bound, fresh) -> two successive codes activate; failures count; nothing in clear; revoke, re-enroll, restore elsewhere", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ktotp-w-")), kf = keyFile(dir);
    const w = await transcriptionWorld({ newsletter: { totpKeyFile: kf } });
    try {
      const db = () => w.org.sqlite.db, api = (p: string, b: unknown, c = w.robin) => w.post(`/o/exna/api/${p}`, b, c);
      const mint = async (email = "robin@exna.test") => { const r = await w.ops("/ops/totp/enroll", { email }); expect(r.ok, JSON.stringify(r)).toBe(true); return r; };
      const tokenOf = (link: string) => new URLSearchParams(link.split("#totp?")[1]).get("token")!;
      // Ops: only active admins/reviewers; the link carries the token in the fragment.
      expect((await w.ops("/ops/totp/enroll", { email: "alex@exna.test" })).error).toBe("access_role_not_permitted");
      expect((await w.ops("/ops/totp/enroll", { email: "nobody@exna.test" })).error).toBe("access_member_unknown");
      const l1 = await mint();
      expect(l1.link).toMatch(/^https:\/\/[^/]+\/o\/exna\/#totp\?token=[A-Za-z0-9_-]{43}$/);
      expect(db().prepare("SELECT COUNT(*) AS n FROM totp_enrollments WHERE token_hash=?").get(createHash("sha256").update(tokenOf(l1.link)).digest("hex"))).toEqual({ n: 1 });
      // Refusals before start: someone else's token; a malformed one; a stale sign-in (session-fresh tier).
      expect((await api("totp/enroll/start", { token: tokenOf(l1.link) }, w.admin)).error).toBe("totp_enroll_token_invalid");
      expect((await api("totp/enroll/start", { token: "x" })).error).toBe("totp_enroll_token_invalid");
      const age = (c: string, ms: number) => { (w.hub.hub as any).sessions.get(createHash("sha256").update(c.split("=")[1]).digest("hex")).authAt -= ms; };
      age(w.robin, 61 * 60_000);
      expect((await api("totp/enroll/start", { token: tokenOf(l1.link) })).error).toBe("access_session_not_fresh");
      age(w.robin, -61 * 60_000);
      // Start: once. The URI, grouped secret and QR come back once; a second start with the same token is refused.
      const s1 = (await api("totp/enroll/start", { token: tokenOf(l1.link) })).result;
      expect(s1).toMatchObject({ uri: expect.stringMatching(/^otpauth:\/\/totp\/Kapelle%20EXNA:robin%40exna\.test\?secret=[A-Z2-7]{32}&issuer=Kapelle%20EXNA&algorithm=SHA1&digits=6&period=30$/),
        secret: expect.stringMatching(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/), digits: 6, periodSeconds: 30 });
      expect(s1.qr.length).toBeGreaterThan(20);
      expect((await api("totp/enroll/start", { token: tokenOf(l1.link) })).error).toBe("totp_enroll_token_invalid");
      const seed = base32Decode(s1.secret.replaceAll(" ", "")), code = (c: number) => hotp(seed, c), t = () => totpStep(Date.now());
      // Nothing in clear: not the seed, not its base32, not the URI, in the DB file, its WAL, the audit or anywhere under the world.
      const secret32 = base32Encode(seed), hay = (p: string): string[] => { try { const st = statSync(p); return st.isDirectory() ? readdirSync(p).flatMap((n) => hay(join(p, n))) : st.isFile() ? [p] : []; } catch { return []; } };
      for (const f of hay(w.base)) { const b = readFileSync(f); expect(b.includes(seed), f).toBe(false); expect(b.includes(Buffer.from(secret32)), f).toBe(false); expect(b.includes(Buffer.from("otpauth://")), f).toBe(false); }
      expect(JSON.stringify(w.org.access.auditRows())).not.toContain(secret32);
      // Confirm: codes must be successive (c, c+1); wrong ones count; the fifth voids the pending factor.
      expect((await api("totp/enroll/confirm", { code1: code(t() - 2), code2: code(t()) })).error).toBe("totp_enroll_codes_invalid");
      expect((await api("totp/enroll/confirm", { code1: code(t()), code2: code(t() - 1) })).error).toBe("totp_enroll_codes_invalid");
      expect(db().prepare("SELECT failures FROM totp_factors WHERE state='pending'").get()).toEqual({ failures: 2 });
      const c2 = t();
      expect((await api("totp/enroll/confirm", { code1: code(c2 - 1), code2: code(c2) })).result).toMatchObject({ active: true });
      expect(db().prepare("SELECT state, last_counter, failures FROM totp_factors WHERE state='active'").get()).toEqual({ state: "active", last_counter: c2, failures: 0 });
      expect((await w.ops("/ops/status", {})).totp).toMatchObject({ configured: true, keyAvailable: true, active: 1, pending: 0, locked: 0, otherKid: 0 });
      // R-7: a re-enrollment never touches the active factor until its confirm, then replaces it in one transaction.
      const l2 = await mint(), s2 = (await api("totp/enroll/start", { token: tokenOf(l2.link) })).result;
      expect(db().prepare("SELECT state, COUNT(*) AS n FROM totp_factors WHERE member_id=(SELECT member_id FROM access_members WHERE email='robin@exna.test') AND state<>'revoked' GROUP BY state ORDER BY state").all())
        .toEqual([{ state: "active", n: 1 }, { state: "pending", n: 1 }]);
      for (let i = 0; i < 5; i++) expect((await api("totp/enroll/confirm", { code1: "000000", code2: "000001" })).error).toBe("totp_enroll_codes_invalid");
      expect((await api("totp/enroll/confirm", { code1: "000000", code2: "000001" })).error).toBe("totp_enroll_not_pending"); // voided after five
      expect((await w.ops("/ops/status", {})).totp).toMatchObject({ active: 1, pending: 0 }); // the old one still stands
      const l3 = await mint(), s3 = (await api("totp/enroll/start", { token: tokenOf(l3.link) })).result, seed3 = base32Decode(s3.secret.replaceAll(" ", "")), c3 = t();
      expect(s2.secret).not.toBe(s3.secret);
      expect((await api("totp/enroll/confirm", { code1: hotp(seed3, c3 - 1), code2: hotp(seed3, c3) })).result.active).toBe(true);
      expect((db().prepare("SELECT revoked_reason FROM totp_factors WHERE state='revoked' ORDER BY created_at").all() as any[]).map((r) => r.revoked_reason))
        .toEqual(["replaced", "enroll-failed"]);
      // A link is bound to the membershipVersion it was minted at: a membership change makes an unused link invalid.
      const l4 = await mint();
      expect((await w.ops("/ops/member/invite", { email: "new@exna.test", role: "contributor" })).ok).toBe(true); // no version bump on invite
      expect((await w.ops("/ops/member/role", { email: "alex@exna.test", role: "reviewer" })).ok).toBe(true);    // bumps the version
      expect((await api("totp/enroll/start", { token: tokenOf(l4.link) })).error).toBe("totp_enroll_token_invalid");
      // Restore on another host (a different key file): the factor is unavailable, never re-encrypted; Ops sees it.
      writeFileSync(kf, randomBytes(32).toString("base64"), { mode: 0o600 });
      expect((await w.ops("/ops/status", {})).totp).toMatchObject({ keyAvailable: true, active: 1, otherKid: 1 });
      const l5 = await mint(), s5 = (await api("totp/enroll/start", { token: tokenOf(l5.link) })).result;
      writeFileSync(kf, randomBytes(32).toString("base64"), { mode: 0o600 }); // rotated between start and confirm
      expect((await api("totp/enroll/confirm", { code1: "000000", code2: "000001" })).error).toBe("totp_key_unavailable");
      void s5;
      rmSync(kf);
      expect((await w.ops("/ops/totp/enroll", { email: "robin@exna.test" })).error).toBe("totp_key_unavailable");
      expect((await w.ops("/ops/status", {})).totp).toMatchObject({ configured: true, keyAvailable: false });
      // Revocation: Ops revoke, demotion to contributor and removal revoke every factor.
      keyFile(dir);
      expect((await w.ops("/ops/totp/revoke", { email: "robin@exna.test" })).revoked).toBeGreaterThanOrEqual(1);
      expect((await w.ops("/ops/status", {})).totp).toMatchObject({ active: 0, pending: 0 });
      const l6 = await mint(), s6 = (await api("totp/enroll/start", { token: tokenOf(l6.link) })).result, seed6 = base32Decode(s6.secret.replaceAll(" ", "")), c6 = t();
      expect((await api("totp/enroll/confirm", { code1: hotp(seed6, c6 - 1), code2: hotp(seed6, c6) })).result.active).toBe(true);
      expect((await w.ops("/ops/member/role", { email: "robin@exna.test", role: "contributor" })).ok).toBe(true);
      expect((await w.ops("/ops/status", {})).totp).toMatchObject({ active: 0 });
      expect((db().prepare("SELECT revoked_reason FROM totp_factors ORDER BY created_at DESC LIMIT 1").get() as any).revoked_reason).toBe("role-contributor");
    } finally { await w.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("without a newsletter block the step-up is off: Ops and members get totp_not_configured", async () => {
    const w = await transcriptionWorld();
    try {
      expect((await w.ops("/ops/totp/enroll", { email: "robin@exna.test" })).error).toBe("totp_not_configured");
      expect((await w.post("/o/exna/api/totp/enroll/start", { token: "a".repeat(43) }, w.robin)).error).toBe("totp_not_configured");
      expect((await w.ops("/ops/status", {})).totp).toMatchObject({ configured: false, keyAvailable: false, active: 0 });
    } finally { await w.close(); }
  });
});
