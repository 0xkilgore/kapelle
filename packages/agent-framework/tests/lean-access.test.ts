// Lean runtime step 2 + option A (no passkeys; owner decision 2026-10-16, Fable baseline 8c6f9b26). Two synthetic orgs
// (SQLite runtimes), one shared hub, fake mail. Proves R-1..R-8 under the step-up seam: default-deny tiers; `totp`-tier
// actions refused in-app with nothing written; session-tier challenges single-use and bound to body/digest/operation/
// membershipVersion AND the minting hub session; approvals need a sign-in from the last hour; authn persisted; receipts
// mailed; cross-org, replay and stale-membership attempts refused AT THE RUNTIME; the passkey code still verifies behind
// the seam (org B, `passkey.enroll`); the hub keeps no org content. Fake data only; no network beyond loopback/sockets.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { request } from "node:http";
import { openFrameworkRuntime } from "../src/service/runtime.js";
import type { SqliteAuthority } from "../src/service/sqlite-authority.js";
import { OrgAccess, ACCESS_ACTIONS, ACCESS_TABLE_HASH, STEP_UP, audienceOf, stepUpOf, bodyHash, envelopeBytes, type Envelope } from "../src/access/org-access.js";
import { serveOrgAccess } from "../src/access/socket.js";
import { canonical } from "../src/command-boundary.js";
import { decodeCbor, parseAuthData, WebAuthnError } from "../src/access/webauthn.js";
import { Hub, type HubOrg } from "../src/hub/hub.js";
import { context } from "./fixtures.js";
import { SoftAuthenticator, RP, ORIGIN, b64u } from "./soft-authenticator.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const SENTINEL = { a: "ORG-A-PRIVATE-MINUTES-7d1f", b: "ORG-B-PRIVATE-BUDGET-93ac" };
const shortDir = (p: string) => { const d = realpathSync(mkdtempSync(join("/tmp", p))); chmodSync(d, 0o700); return d; };

const options = (stateRoot: string) => ({ stateRoot, reactorRoot: process.env.KAPELLE_SCOPED_REACTOR_ROOT!, ownerId: "owner", scopeRef: "synthetic-league",
  facts: async () => ({ ...context() }), now: () => context().occurredAt, backend: "sqlite" as const });
async function makeOrg(orgId: "org-a" | "org-b", hubKeys: string, opened: { close(): Promise<void> }[], now?: () => string) {
  const root = shortDir(`ka-${orgId}-`), state = join(root, "s"); mkdirSync(state, { mode: 0o700 }); mkdirSync(join(root, "run"), { mode: 0o700 });
  const rt = await openFrameworkRuntime(options(state) as never); opened.push(rt);
  const sqlite = (rt as unknown as { sqlite: SqliteAuthority }).sqlite;
  const access = new OrgAccess(sqlite, { orgId, rpId: RP, origins: [ORIGIN] }, now);
  const kp = generateKeyPairSync("ed25519");
  access.addEnvelopeKey("k1", kp.publicKey.export({ format: "jwk" }));
  const keyFile = join(hubKeys, `${orgId}.pem`); writeFileSync(keyFile, kp.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const socketPath = join(root, "run", "access.sock");
  const content = orgId === "org-a" ? SENTINEL.a : SENTINEL.b;
  const server = await serveOrgAccess(access, socketPath, {
    routines: { "agent.read": async () => ({ minutes: content }) },
    // A real Framework write behind a step-up: the operationId the challenge was bound to is the allocation id.
    actions: { "proposal.approve": async (_body, z) => rt.authority.allocate(z.operationId, "kapelle/agent-instance", "Approved"),
      "task.adopt": async (b: any) => ({ adopted: b.intakeId }) },
  });
  opened.push({ close: () => new Promise<void>((r) => server.close(() => r())) });
  const hubOrg: HubOrg = { orgId, installationId: sqlite.identity.installationId, socketPath, kid: "k1", keyFile, origin: ORIGIN };
  return { orgId, rt, sqlite, access, key: kp.privateKey, hubOrg, socketPath };
}
type Org = Awaited<ReturnType<typeof makeOrg>>;
function socketCall(path: string, route: string, payload: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const r = request({ socketPath: path, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      const c: Buffer[] = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(c).toString()) }));
    });
    r.on("error", reject); r.end(data);
  });
}
/** What a COMPROMISED hub can do: sign any envelope with an org's key and send it straight to the runtime socket. */
function forged(org: Org, over: Partial<Envelope>, body: unknown, key = org.key) {
  const env: Envelope = { v: 1, orgId: org.orgId, installationId: org.sqlite.identity.installationId, kid: "k1", memberId: "hub", membershipVersion: org.access.membershipVersion(),
    action: "member.lookup", bodyHash: bodyHash(body), requestId: randomBytes(18).toString("base64url"), expiry: new Date(Date.now() + 60_000).toISOString(), session: null, ...over };
  return { envelope: env, signature: sign(null, envelopeBytes(env), key).toString("base64url"), body };
}
/** A session claim as a (compromised) hub would put it in a member envelope. */
const S = (ref = "f".repeat(64), authAt = new Date().toISOString()) => ({ ref, authAt });

describe.skipIf(!enabled)("lean runtime step 2 + option A: step-up per action, email-session tier", () => {
  it("tier table: default deny, every action in exactly one tier, Fable's lists exactly; hashed into the action-table hash", () => {
    const tiers = ["session", "session-fresh", "totp", "passkey"] as const;
    for (const a of [...ACCESS_ACTIONS.routine, ...ACCESS_ACTIONS.consequential]) expect(tiers.filter((t) => (STEP_UP[t] as readonly string[]).includes(a)), a).toHaveLength(1);
    expect(tiers.flatMap((t) => STEP_UP[t]).sort()).toEqual([...ACCESS_ACTIONS.routine, ...ACCESS_ACTIONS.consequential].sort());
    expect([...STEP_UP["session-fresh"]].sort()).toEqual(["chat.draft.approve", "files.unpublish", "handbook.approve", "newsletter.release.publish", "notes.approve", "proposal.approve", "teamtask.approve", "teamtask.cancel", "teamtask.complete", "teamtask.schedule.approve", "teamtask.schedule.resume", "teamtask.schedule.run_now", "totp.enroll.confirm", "totp.enroll.start", "transcript.start", "website.apply"]); // chat E-1, website R-1, TEAM-TASKS-V1, SCHEDULED-TASKS-V1 S1 (C-4), AGENT-HANDBOOK-V1 H2, LIBRARY L2
    expect([...STEP_UP.totp].sort()).toEqual(["intake.token.issue", "intake.token.revoke", "member.invite", "member.remove", "member.role", "message.send", "newsletter.send", "policy.approve", "site.deploy",
      "transcription.policy.approve"]); // newsletter.send: the one in-app totp action (TOTP_IN_APP)
    // Transcription (Fable R-3): upload/list/read/accept/discard ride the session; start is fresh; the policy is totp (Ops).
    for (const a of ["media.upload", "transcript.list", "transcript.read", "transcript.accept", "transcript.discard"]) expect(stepUpOf(a), a).toBe("session");
    expect(STEP_UP.passkey).toEqual(["passkey.enroll"]);
    expect(STEP_UP.freshMinutes).toBe(60);
    expect(() => stepUpOf("anything.else")).toThrow("access_action_unknown");
    expect(ACCESS_TABLE_HASH).toBe("sha256:" + createHash("sha256").update(canonical({ actions: ACCESS_ACTIONS, stepUp: STEP_UP })).digest("hex"));
    expect(ACCESS_TABLE_HASH).not.toBe("sha256:" + createHash("sha256").update(canonical(ACCESS_ACTIONS)).digest("hex")); // pre-option-A pins no longer match
  });

  it("two orgs, one hub: email-link join, session-tier approvals with receipts, totp refused, session binding, freshness, adversarial refusals, no hub content", async () => {
    const opened: { close(): Promise<void> }[] = [];
    const hubKeys = shortDir("ka-hubkeys-"), mail: { orgId: string; to: string; kind: string; link: string; receipt?: any }[] = [];
    try {
      const A = await makeOrg("org-a", hubKeys, opened), B = await makeOrg("org-b", hubKeys, opened);
      let failReceipts: string | null = null; // N-3: when set, the mail port "fails" receipts with this fixed label
      const hub = new Hub([A.hubOrg, B.hubOrg], (m, done) => { mail.push(m); done?.(m.kind === "receipt" ? failReceipts : null); });
      /** Make a session's email-link sign-in `ms` older (the hub's in-memory session record; nothing else changes). */
      const age = (cookie: string, ms: number) => { (hub as any).sessions.get(createHash("sha256").update(cookie.split("=")[1]).digest("hex")).authAt -= ms; return cookie; };
      const server = await hub.listen(); opened.push({ close: () => new Promise<void>((r) => server.close(() => r())) });
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const http = async (path: string, body?: unknown, cookie = "") => {
        const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: r.status, body: await r.json() as any, setCookie: r.headers.get("set-cookie") ?? "" };
      };
      const flush = () => new Promise((r) => setImmediate(r));
      const login = async (org: Org, email: string) => {
        mail.length = 0;
        expect(await http(`/o/${org.orgId}/login`, { email })).toMatchObject({ status: 202 });
        await flush();
        const link = mail.find((m) => m.kind === "login" && m.to === email)!;
        const r = await http(`/o/${org.orgId}/magic?token=${new URL(link.link).searchParams.get("token")}`);
        expect(r.status).toBe(200);
        return r.setCookie.split(";")[0];
      };
      const accept = async (org: Org, token: string) => { const r = await http(`/o/${org.orgId}/invite/accept`, { token }); expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
        return { memberId: r.body.memberId as string, cookie: r.setCookie.split(";")[0] }; };
      const consequential = async (org: Org, cookie: string, action: string, body: unknown, operationId: string, artifactDigest: string | null = null) => {
        const ch = await http(`/o/${org.orgId}/challenge`, { action, body, artifactDigest, operationId }, cookie);
        if (!ch.body.ok) return ch;
        return http(`/o/${org.orgId}/act`, { challengeId: ch.body.challengeId, action, body, artifactDigest, operationId }, cookie);
      };
      const refused = async (p: Promise<{ body: any }>, reason: string) => expect((await p).body.error, reason).toBe(reason);
      const count = (org: Org, table: string) => (org.sqlite.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

      // R-5 / option A bootstrap: Ops hands the first admin a one-time link; joining admits them and opens their session.
      const boot = A.access.bootstrapInvite("admin@a.test");
      expect((await http("/o/org-a/invite/info", { token: boot.token })).body).toMatchObject({ ok: true, role: "admin", firstAdmin: true, email: "admin@a.test" });
      const admin = await accept(A, boot.token), adminCookie = admin.cookie;
      expect((await http("/o/org-a/api/member/me", {}, adminCookie)).body.ok).toBe(true);
      await refused(http("/o/org-a/invite/accept", { token: boot.token }), "access_invite_consumed");
      expect(() => A.access.bootstrapInvite("second@a.test")).toThrow("access_bootstrap_not_empty");

      // R-6: identical answers for member and non-member; mail only for the member.
      mail.length = 0;
      const asMember = await http("/o/org-a/login", { email: "admin@a.test" }), asStranger = await http("/o/org-a/login", { email: "nobody@a.test" });
      expect([asMember.status, asMember.body]).toEqual([asStranger.status, asStranger.body]);
      await flush();
      expect(mail.map((m) => m.to)).toEqual(["admin@a.test"]);
      // Tested invariant (Fable b ruling + N-1): every state change is a same-site JSON POST; no state-changing route answers GET.
      const raw = (path: string, method: string, headers: Record<string, string>, body?: string) => fetch(base + path, { method, headers: { cookie: adminCookie, ...headers }, body }).then(async (r) => ({ status: r.status, body: await r.json() as any }));
      for (const route of ["login", "challenge", "act", "api/member/me", "invite/info", "invite/accept"]) {
        expect(await raw(`/o/org-a/${route}`, "POST", { "content-type": "text/plain" }, "{}"), route).toEqual({ status: 415, body: { ok: false, error: "hub_content_type_refused" } });
        expect(await raw(`/o/org-a/${route}`, "POST", { "content-type": "application/x-www-form-urlencoded" }, "a=1"), route).toMatchObject({ status: 415 });
        expect(await raw(`/o/org-a/${route}`, "POST", { "content-type": "application/json", "sec-fetch-site": "cross-site" }, "{}"), route).toEqual({ status: 403, body: { ok: false, error: "hub_cross_site_refused" } });
      }
      for (const route of ["challenge", "act", "api/member/me", "login", "invite/accept"]) expect((await raw(`/o/org-a/${route}`, "GET", {})).status, route).toBe(404);
      // The passkey ceremony routes are gone from the hub and the runtime socket.
      for (const route of ["invite/begin", "invite/complete"]) expect((await http(`/o/org-a/${route}`, {}, adminCookie)).body.error, route).toBe("hub_not_found");
      // Owner (24 Oct): the bare host is a plain page, never raw JSON; with two orgs it names neither (no redirect, no list).
      const home = await fetch(base + "/", { redirect: "manual" }), html = await home.text();
      expect([home.status, home.headers.get("content-type"), home.headers.get("cache-control")]).toEqual([200, "text/html; charset=utf-8", "no-store"]);
      expect(home.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(html).toContain("Open your organization from the link in your invitation or sign-in email.");
      expect(html).not.toMatch(/org-a|org-b|hub_not_found|<script/);
      for (const route of ["/access/invite/begin", "/access/invite/complete"]) expect((await socketCall(A.socketPath, route, {})).body.error, route).toBe("access_route");

      // Routine read through the hub (envelope only); a session for org A is not a session for org B.
      expect((await http("/o/org-a/api/agent/read", {}, adminCookie)).body).toMatchObject({ ok: true, result: { minutes: SENTINEL.a } });
      expect((await http("/o/org-b/api/agent/read", {}, adminCookie)).status).toBe(401);

      // Control 1: every `totp`-tier action is refused in the app with a fixed label, for an admin too, and nothing is written.
      const writes = () => [count(A, "access_authorizations"), count(A, "access_invitations"), count(A, "access_members"), A.access.membershipVersion()];
      const before0 = writes();
      for (const [action, body] of [["member.invite", { email: "x@a.test", role: "admin" }], ["member.remove", { memberId: admin.memberId }], ["member.role", { memberId: admin.memberId, role: "reviewer" }],
        ["policy.approve", { version: 1 }], ["message.send", {}], ["site.deploy", {}], ["transcription.policy.approve", { version: 1 }]] as const)
        await refused(consequential(A, adminCookie, action, body, `op-totp-${action}`), "access_step_up_required");
      for (const r of ["intake/token/issue", "intake/token/revoke"]) await refused(http(`/o/org-a/api/${r}`, {}, adminCookie), "access_step_up_required");
      // ...also when a compromised hub skips the challenge and goes straight to /access/act with a valid signature.
      await refused(socketCall(A.socketPath, "/access/act", forged(A, { memberId: admin.memberId, action: "member.invite", session: S() },
        { challengeId: "00000000-0000-4000-8000-000000000000", action: "member.invite", body: { email: "evil@x.test", role: "admin" }, operationId: "op-forged-inv-1" })), "access_step_up_required");
      expect(writes()).toEqual(before0);

      // Ops (owner-only socket in production) performs the `totp` tier: invite links, removal, roles.
      const alice = await accept(A, A.access.opsInvite("alice@a.test", "reviewer").token), aliceCookie = alice.cookie;
      expect((await http("/o/org-a/invite/info", { token: A.access.opsInvite("bob@a.test", "contributor").token })).body).toMatchObject({ ok: true, invitedBy: null, firstAdmin: false, role: "contributor" });
      expect(() => A.access.opsInvite("alice@a.test", "admin")).toThrow("access_member_exists");
      expect(() => A.access.opsInvite("x@a.test", "owner" as never)).toThrow("access_invite_invalid");

      // Session-fresh approval (control 3 fresh side), its idempotent retry (R-3), receipts (control 4), authn (control 5).
      const digest = "sha256:" + "ab".repeat(32);
      mail.length = 0;
      const approve = await consequential(A, aliceCookie, "proposal.approve", { proposal: "p-1" }, "op-approve-p1-001", digest);
      expect(approve.body).toMatchObject({ ok: true, authorization: { action: "proposal.approve", replayed: false, authn: "email-session" }, result: { documentId: expect.any(String) } });
      expect(approve.body).not.toHaveProperty("receipt");
      await flush();
      const receipts = mail.filter((m) => m.kind === "receipt");
      expect(receipts.map((m) => m.to).sort()).toEqual(["admin@a.test", "alice@a.test"]); // the approver, and the org's admins for a plan approval
      expect(receipts[0].receipt).toMatchObject({ actor: "alice@a.test", action: "proposal.approve", artifactDigest: digest, operationId: "op-approve-p1-001", authn: "email-session" });
      expect(A.sqlite.db.prepare("SELECT authn, step_up FROM access_authorizations WHERE operation_id='op-approve-p1-001'").get()).toEqual({ authn: "email-session", step_up: "session-fresh" });
      mail.length = 0;
      const retry = await http("/o/org-a/act", { action: "proposal.approve", body: { proposal: "p-1" }, artifactDigest: digest, operationId: "op-approve-p1-001" }, aliceCookie);
      expect(retry.body).toMatchObject({ ok: true, authorization: { replayed: true, authn: "email-session" }, result: { documentId: approve.body.result.documentId } });
      await flush();
      expect(mail.filter((m) => m.kind === "receipt")).toEqual([]); // a replay is not a new approval
      await refused(http("/o/org-a/act", { action: "proposal.approve", body: { proposal: "p-2" }, artifactDigest: digest, operationId: "op-approve-p1-001" }, aliceCookie), "access_operation_conflict");
      // N-3: a receipt the mail port could not send is reported by the hub (service envelope) and audited at the runtime,
      // against the recorded Authorization, per recipient; a report for an unknown operation, or not from the hub, is refused.
      failReceipts = "mail_http_500:type=internal_server_error";
      const failedOp = await consequential(A, aliceCookie, "proposal.approve", { proposal: "p-r" }, "op-receipt-fail-1", digest);
      expect(failedOp.body.ok).toBe(true);
      failReceipts = null;
      let failedRows: Record<string, unknown>[] = [];
      for (let i = 0; i < 100 && failedRows.length < 2; i++) { await new Promise((r) => setTimeout(r, 10)); failedRows = A.access.auditRows().filter((r) => r.action === "receipt.failed" && r.operation_id === "op-receipt-fail-1"); }
      expect(failedRows.map((r) => [r.member_id, r.outcome, r.reason]).sort()).toEqual([[null, "refused", `receipt_send_failed:mail_http_500:type=internal_server_error;to:${admin.memberId}`],
        [null, "refused", `receipt_send_failed:mail_http_500:type=internal_server_error;to:${alice.memberId}`]].sort());
      await refused(socketCall(A.socketPath, "/access/receipt/failed", forged(A, { action: "receipt.failed" }, { operationId: "op-never-happened", to: "alice@a.test", label: "mail_x" })), "access_authorization_unknown");
      await refused(socketCall(A.socketPath, "/access/receipt/failed", forged(A, { action: "receipt.failed", memberId: alice.memberId, session: S() }, { operationId: "op-receipt-fail-1", to: "alice@a.test", label: "mail_x" })), "access_wrong_audience");
      // A session-tier adopt: receipt to the actor only.
      mail.length = 0;
      expect((await consequential(A, aliceCookie, "task.adopt", { intakeId: "intake_x", title: "T" }, "op-adopt-00001")).body).toMatchObject({ ok: true, authorization: { authn: "email-session" } });
      await flush();
      expect(mail.filter((m) => m.kind === "receipt").map((m) => m.to)).toEqual(["alice@a.test"]);

      // Control 6: the challenge completes only from the hub session that minted it; a mismatch burns it.
      const alice2 = await login(A, "alice@a.test");
      const ch = await http("/o/org-a/challenge", { action: "proposal.approve", body: { proposal: "s" }, artifactDigest: null, operationId: "op-sess-000001" }, aliceCookie);
      expect(ch.body).toMatchObject({ ok: true, stepUp: "session-fresh" });
      expect(ch.body).not.toHaveProperty("publicKey");
      await refused(http("/o/org-a/act", { challengeId: ch.body.challengeId, action: "proposal.approve", body: { proposal: "s" }, artifactDigest: null, operationId: "op-sess-000001" }, alice2), "access_challenge_session_mismatch");
      await refused(http("/o/org-a/act", { challengeId: ch.body.challengeId, action: "proposal.approve", body: { proposal: "s" }, artifactDigest: null, operationId: "op-sess-000001" }, aliceCookie), "access_challenge_consumed");
      // Binding (R-3) unchanged: body / digest / operation; a binding refusal is checked before the session and does not burn.
      const bind = await http("/o/org-a/challenge", { action: "proposal.approve", body: { proposal: "bind" }, artifactDigest: digest, operationId: "op-bind-00001" }, aliceCookie);
      await refused(http("/o/org-a/act", { challengeId: bind.body.challengeId, action: "proposal.approve", body: { proposal: "other" }, artifactDigest: digest, operationId: "op-bind-00001" }, aliceCookie), "access_challenge_binding");
      await refused(http("/o/org-a/act", { challengeId: bind.body.challengeId, action: "proposal.approve", body: { proposal: "bind" }, artifactDigest: "sha256:" + "cd".repeat(32), operationId: "op-bind-00001" }, aliceCookie), "access_challenge_binding");
      await refused(http("/o/org-a/act", { challengeId: bind.body.challengeId, action: "proposal.approve", body: { proposal: "bind" }, artifactDigest: digest, operationId: "op-bind-00002" }, aliceCookie), "access_challenge_binding");
      expect((await http("/o/org-a/act", { challengeId: bind.body.challengeId, action: "proposal.approve", body: { proposal: "bind" }, artifactDigest: digest, operationId: "op-bind-00001" }, aliceCookie)).body.ok).toBe(true);

      // Control 3: approvals need a sign-in from the last 60 minutes, checked at mint AND at act; adopt does not; both audited.
      const staleCookie = age(await login(A, "alice@a.test"), 61 * 60_000);
      await refused(http("/o/org-a/challenge", { action: "proposal.approve", body: { proposal: "late" }, artifactDigest: null, operationId: "op-stale-00001" }, staleCookie), "access_session_not_fresh");
      await refused(http("/o/org-a/challenge", { action: "notes.approve", body: { meeting: "x" }, artifactDigest: null, operationId: "op-stale-00002" }, staleCookie), "access_session_not_fresh");
      expect((await consequential(A, staleCookie, "task.adopt", { intakeId: "intake_y", title: "T" }, "op-stale-adopt1")).body.ok).toBe(true);
      const edgeCookie = age(await login(A, "alice@a.test"), 60 * 60_000 - 1500);
      const edge = await http("/o/org-a/challenge", { action: "proposal.approve", body: { proposal: "edge" }, artifactDigest: null, operationId: "op-edge-000001" }, edgeCookie);
      expect(edge.body.ok).toBe(true);
      await new Promise((r) => setTimeout(r, 2000));
      await refused(http("/o/org-a/act", { challengeId: edge.body.challengeId, action: "proposal.approve", body: { proposal: "edge" }, artifactDigest: null, operationId: "op-edge-000001" }, edgeCookie), "access_session_not_fresh");
      const fresh = await consequential(A, await login(A, "alice@a.test"), "proposal.approve", { proposal: "edge" }, "op-edge-000002");
      expect(fresh.body.ok).toBe(true);
      const auditA = A.access.auditRows();
      expect(auditA.filter((r) => r.outcome === "refused" && r.reason === "access_session_not_fresh").map((r) => r.action).sort()).toEqual(["challenge.mint", "challenge.mint", "proposal.approve"]);
      expect(auditA.some((r) => r.outcome === "allowed" && r.action === "proposal.approve" && r.operation_id === "op-edge-000002" && r.reason === "authn:email-session")).toBe(true);

      // Role: a contributor cannot approve.
      const carol = await accept(A, A.access.opsInvite("carol@a.test", "contributor").token);
      await refused(http("/o/org-a/challenge", { action: "proposal.approve", body: {}, operationId: "op-carol-00001" }, carol.cookie), "access_role_not_permitted");

      // A compromised hub (it signs envelopes): it must send a session claim; it can mint and complete a session-tier
      // challenge for a member WITHIN THE SAME claimed session (the C-1 relaxation, stated), but not from another session.
      const v = A.access.membershipVersion();
      await refused(socketCall(A.socketPath, "/access/routine", forged(A, { memberId: alice.memberId, membershipVersion: v, action: "agent.read" }, {})), "access_envelope_session");
      await refused(socketCall(A.socketPath, "/access/routine", forged(A, { memberId: alice.memberId, membershipVersion: v, action: "agent.read", session: S("nothex") }, {})), "access_envelope_session");
      await refused(socketCall(A.socketPath, "/access/routine", forged(A, { memberId: alice.memberId, membershipVersion: v, action: "agent.read", session: S(undefined, new Date(Date.now() + 3_600_000).toISOString()) }, {})), "access_envelope_session");
      const real = await socketCall(A.socketPath, "/access/challenge", forged(A, { memberId: alice.memberId, membershipVersion: v, action: "challenge.mint", session: S("1".repeat(64)) },
        { action: "proposal.approve", body: { proposal: "p-9" }, artifactDigest: null, operationId: "op-forged-0003" }));
      expect(real.body.ok).toBe(true);
      await refused(socketCall(A.socketPath, "/access/act", forged(A, { memberId: alice.memberId, membershipVersion: v, action: "proposal.approve", session: S("2".repeat(64)) },
        { challengeId: real.body.challengeId, action: "proposal.approve", body: { proposal: "p-9" }, artifactDigest: null, operationId: "op-forged-0003" })), "access_challenge_session_mismatch");
      const real2 = await socketCall(A.socketPath, "/access/challenge", forged(A, { memberId: alice.memberId, membershipVersion: v, action: "challenge.mint", session: S("3".repeat(64)) },
        { action: "proposal.approve", body: { proposal: "p-10" }, artifactDigest: null, operationId: "op-forged-0004" }));
      expect((await socketCall(A.socketPath, "/access/act", forged(A, { memberId: alice.memberId, membershipVersion: v, action: "proposal.approve", session: S("3".repeat(64)) },
        { challengeId: real2.body.challengeId, action: "proposal.approve", body: { proposal: "p-10" }, artifactDigest: null, operationId: "op-forged-0004" }))).body.ok).toBe(true); // the stated trade-off
      await refused(socketCall(A.socketPath, "/access/act", forged(A, { memberId: alice.memberId, membershipVersion: v, action: "proposal.approve", session: S() },
        { challengeId: "00000000-0000-4000-8000-000000000000", action: "proposal.approve", body: { proposal: "p-9" }, operationId: "op-forged-0001" })), "access_challenge_unknown");
      // Cross-org, R-2 installation/kid, replay, expiry, body tamper, R-1 unknown action: unchanged.
      const sv = (over: Partial<Envelope>) => forged(A, { memberId: alice.memberId, membershipVersion: v, action: "agent.read", session: S(), ...over }, {});
      await refused(socketCall(B.socketPath, "/access/routine", sv({})), "access_wrong_org");
      await refused(socketCall(A.socketPath, "/access/routine", forged(A, { memberId: alice.memberId, membershipVersion: v, action: "agent.read", session: S() }, {}, B.key)), "access_envelope_signature");
      await refused(socketCall(A.socketPath, "/access/routine", sv({ installationId: B.sqlite.identity.installationId })), "access_wrong_installation");
      await refused(socketCall(A.socketPath, "/access/routine", sv({ kid: "k9" })), "access_envelope_kid_unknown");
      const once = sv({});
      expect((await socketCall(A.socketPath, "/access/routine", once)).body.ok).toBe(true);
      await refused(socketCall(A.socketPath, "/access/routine", once), "access_envelope_replayed");
      await refused(socketCall(A.socketPath, "/access/routine", sv({ expiry: new Date(Date.now() - 1000).toISOString() })), "access_envelope_expired");
      const tampered = forged(A, { memberId: alice.memberId, membershipVersion: v, action: "agent.read", session: S() }, { q: 1 }); tampered.body = { q: 2 };
      await refused(socketCall(A.socketPath, "/access/routine", tampered), "access_body_hash");
      await refused(socketCall(A.socketPath, "/access/routine", sv({ action: "agent.delete-everything" })), "access_action_unknown");
      expect(() => audienceOf("anything.else")).toThrow("access_action_unknown");

      // R-8 via Ops: admit Dave (no bump), remove him (bump): Alice's outstanding challenge is stale, Dave is refused with a live
      // session, an old-version envelope is refused, and Alice's session keeps working (the hub re-checks and refreshes).
      const pending = await http("/o/org-a/challenge", { action: "proposal.approve", body: { proposal: "late" }, operationId: "op-late-000001" }, aliceCookie);
      const before = A.access.membershipVersion();
      const dave = await accept(A, A.access.opsInvite("dave@a.test", "contributor").token);
      expect(A.access.membershipVersion()).toBe(before);
      expect(A.access.opsRemoveMember("dave@a.test")).toMatchObject({ memberId: dave.memberId, membershipVersion: before + 1 });
      await refused(http("/o/org-a/act", { challengeId: pending.body.challengeId, action: "proposal.approve", body: { proposal: "late" }, operationId: "op-late-000001" }, aliceCookie), "access_membership_stale");
      await refused(http("/o/org-a/api/agent/read", {}, dave.cookie), "access_member_inactive");
      await refused(socketCall(A.socketPath, "/access/routine", forged(A, { memberId: dave.memberId, membershipVersion: A.access.membershipVersion(), action: "agent.read", session: S() }, {})), "access_member_inactive");
      await refused(socketCall(A.socketPath, "/access/routine", forged(A, { memberId: alice.memberId, membershipVersion: before, action: "agent.read", session: S() }, {})), "access_membership_stale");
      expect((await http("/o/org-a/api/agent/read", {}, aliceCookie)).body).toMatchObject({ ok: true, result: { minutes: SENTINEL.a } });
      // Ops role changes bump too; the last active admin can be neither removed nor demoted.
      expect(A.access.opsSetRole("carol@a.test", "reviewer")).toMatchObject({ role: "reviewer", membershipVersion: before + 2 });
      expect(() => A.access.opsRemoveMember("admin@a.test")).toThrow("access_last_admin");
      expect(() => A.access.opsSetRole("admin@a.test", "reviewer")).toThrow("access_last_admin");
      expect(() => A.access.opsRemoveMember("nobody@a.test")).toThrow("access_member_unknown");
      expect(A.access.opsMembers().map((m) => [m.email, m.role, m.status])).toEqual([["admin@a.test", "admin", "active"], ["alice@a.test", "reviewer", "active"],
        ["carol@a.test", "reviewer", "active"], ["dave@a.test", "contributor", "removed"]]);
      // Ops authorization for a `totp` action (policy approval path): recorded and attributed; not for session-tier actions.
      expect(A.access.opsAuthorization("policy.approve", { v: 1 }, digest)).toMatchObject({ memberId: "ops", authn: "ops-socket", replayed: false });
      expect(() => A.access.opsAuthorization("proposal.approve", {}, digest)).toThrow("access_ops_action_not_permitted");

      // Passkey code kept behind the seam: org B's first admin enrolls a passkey at the runtime and `passkey.enroll` (the only
      // passkey-tier action) verifies a real assertion; WebAuthn tampering is refused and a failed attempt burns the challenge.
      const bKey = new SoftAuthenticator("ES256"), bBoot = B.access.bootstrapAdmin("admin@b.test");
      expect(B.access.completeRegistration({ challengeId: bBoot.challengeId, credential: bKey.create(bBoot) })).toMatchObject({ role: "admin" });
      const bCookie = await login(B, "admin@b.test");
      const pk = async (n: string, tweak: Parameters<SoftAuthenticator["get"]>[1] = {}, key = bKey) => {
        const c = await http("/o/org-b/challenge", { action: "passkey.enroll", body: { n }, operationId: `op-pk-${n}-0001` }, bCookie);
        expect(c.body).toMatchObject({ ok: true, stepUp: "passkey", publicKey: { challenge: expect.any(String) } });
        return { c, r: await http("/o/org-b/act", { challengeId: c.body.challengeId, assertion: key.get(c.body, tweak), action: "passkey.enroll", body: { n }, operationId: `op-pk-${n}-0001` }, bCookie) };
      };
      await refused(pk("ok").then((x) => x.r), "access_action_not_installed"); // authorized; no handler installed for this action
      expect(B.sqlite.db.prepare("SELECT authn, step_up FROM access_authorizations WHERE operation_id='op-pk-ok-0001'").get()).toEqual({ authn: "passkey", step_up: "passkey" });
      for (const [n, tweak, reason] of [["o", { origin: "https://evil.test" }, "clientdata_origin"], ["r", { rpId: "evil.test" }, "authdata_rp_id"], ["u", { flags: 0x01 }, "authdata_user_verification"],
        ["c", { crossOrigin: true }, "clientdata_cross_origin"], ["s", { count: 1 }, "assertion_sign_count"], ["x", { challenge: b64u(randomBytes(32)) }, "clientdata_challenge"]] as const) {
        const { c, r } = await pk(n, tweak as never);
        expect(r.body.error, n).toBe(reason);
        await refused(http("/o/org-b/act", { challengeId: c.body.challengeId, assertion: bKey.get(c.body), action: "passkey.enroll", body: { n }, operationId: `op-pk-${n}-0001` }, bCookie), "access_challenge_consumed");
      }
      await refused(pk("i", {}, new SoftAuthenticator("EdDSA")).then((x) => x.r), "access_credential_unknown");
      // A member without a passkey gets a fixed refusal for the passkey tier (org A's admin enrolled by email link).
      await refused(http("/o/org-a/challenge", { action: "passkey.enroll", body: {}, operationId: "op-pk-none-001" }, adminCookie), "access_no_passkey");

      // Audit: admissions record how (email link) and by whom; everything carries the action-table hash; N-3 claimed ids.
      const audit = A.access.auditRows();
      expect(audit.every((r) => r.table_hash === ACCESS_TABLE_HASH)).toBe(true);
      expect(audit.filter((r) => r.outcome === "admitted").map((r) => r.reason)).toEqual(["role:admin;authn:email-link;by:ops:bootstrap", "role:reviewer;authn:email-link;by:ops",
        "role:contributor;authn:email-link;by:ops", "role:contributor;authn:email-link;by:ops"]);
      expect(audit.filter((r) => r.outcome === "refused" && r.reason === "access_step_up_required").length).toBeGreaterThanOrEqual(9);
      expect(audit.some((r) => r.outcome === "refused" && r.reason === "access_challenge_session_mismatch")).toBe(true);
      expect(Object.keys(audit[0])).toEqual(expect.arrayContaining(["policy_version", "catalog_profile_hash"]));
      expect(audit.filter((r) => r.outcome === "refused" && r.member_id && r.member_id !== "ops").every((r) => String(r.member_id).startsWith("claimed:"))).toBe(true);
      // N-2: the hub's rate-limit memory is bounded.
      for (let i = 0; i < 10_050; i++) (hub as any).limited(`email:org-a:${i}@x.test`, 5, 600_000);
      expect((hub as any).attempts.size).toBeLessThanOrEqual(10_000);

      // No hub content: nothing on disk but the per-org key files, and no org content in its memory.
      expect(readdirSync(hubKeys).sort()).toEqual(["org-a.pem", "org-b.pem"]);
      for (const f of readdirSync(hubKeys)) expect(readFileSync(join(hubKeys, f), "utf8")).not.toMatch(/ORG-[AB]-PRIVATE/);
      const held = JSON.stringify([...(hub as any).sessions.entries(), ...(hub as any).links.entries(), ...(hub as any).attempts.entries()]);
      expect(held).not.toMatch(/ORG-[AB]-PRIVATE|minutes|budget/);
      expect(statSync(A.socketPath).mode & 0o777).toBe(0o600);
    } finally { for (const o of opened.reverse()) await o.close().catch(() => {}); }
  }, 120_000);

  it("option A columns are added to a store created before it; earlier authorizations read as passkey-made", async () => {
    const opened: { close(): Promise<void> }[] = [];
    try {
      const root = shortDir("ka-mig-"); mkdirSync(join(root, "s"), { mode: 0o700 });
      const rt = await openFrameworkRuntime(options(join(root, "s")) as never); opened.push(rt);
      const sqlite = (rt as unknown as { sqlite: SqliteAuthority }).sqlite;
      sqlite.db.exec(`CREATE TABLE access_challenges(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('assertion','registration')), challenge TEXT NOT NULL,
        member_id TEXT, invitation_id TEXT, action TEXT NOT NULL, body_hash TEXT NOT NULL, artifact_digest TEXT, operation_id TEXT,
        membership_version INTEGER NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT) STRICT;
        CREATE TABLE access_authorizations(operation_id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL UNIQUE, member_id TEXT NOT NULL,
        action TEXT NOT NULL, body_hash TEXT NOT NULL, artifact_digest TEXT, at TEXT NOT NULL) STRICT;
        INSERT INTO access_authorizations VALUES ('op-old-1','c-old-1','m-1','proposal.approve','sha256:x',NULL,'2026-10-01T00:00:00.000Z');`);
      new OrgAccess(sqlite, { orgId: "org-a", rpId: RP, origins: [ORIGIN] });
      expect(sqlite.db.prepare("SELECT authn, step_up FROM access_authorizations WHERE operation_id='op-old-1'").get()).toEqual({ authn: "passkey", step_up: "passkey" });
      expect((sqlite.db.prepare("PRAGMA table_info(access_challenges)").all() as { name: string }[]).map((c) => c.name)).toContain("session_ref");
      new OrgAccess(sqlite, { orgId: "org-a", rpId: RP, origins: [ORIGIN] }); // idempotent on reopen
    } finally { for (const o of opened.reverse()) await o.close().catch(() => {}); }
  });

  it("R-4: the bounded CBOR / authenticator-data parsers refuse malformed, truncated, oversize and indefinite input with fixed reasons", () => {
    const cases: Buffer[] = [Buffer.alloc(0), Buffer.from([0x9f, 0x01, 0xff]), Buffer.from([0x5f]), Buffer.from([0xbf]), Buffer.from([0x1c]), Buffer.from([0x59, 0xff]),
      Buffer.from([0xa2, 0x01, 0x01, 0x01, 0x02]), Buffer.from([0xc1, 0x00]), Buffer.from([0xf9, 0, 0]), Buffer.concat([Buffer.alloc(9, 0x81), Buffer.from([0x01])]), Buffer.alloc(5000, 0x01),
      Buffer.from([0x01, 0x02])];
    for (const c of cases) expect(() => decodeCbor(c), c.toString("hex").slice(0, 20)).toThrow(WebAuthnError);
    for (let i = 0; i < 500; i++) {
      const fuzz = randomBytes(1 + (i % 64));
      try { decodeCbor(fuzz); } catch (e) { expect(e, fuzz.toString("hex")).toBeInstanceOf(WebAuthnError); }
      try { parseAuthData(Buffer.concat([randomBytes(37), fuzz]), 512); } catch (e) { expect(e).toBeInstanceOf(WebAuthnError); }
    }
    expect(() => parseAuthData(Buffer.alloc(36), 512)).toThrow("authdata_size");
    expect(() => parseAuthData(Buffer.alloc(600), 512)).toThrow("authdata_size");
  });
});
