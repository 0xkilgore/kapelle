// Lean runtime step 2 (Fable C-1; step-2 plan R-1..R-8): membership and action authorization AT THE ORG RUNTIME.
// The shared hub issues identity and signs envelopes. Under option A (below) its email-link session IS the step-up for the
// `session` tiers, so a compromised hub can act as a signed-in member within those tiers; it still cannot reach a `totp`
// action, change members, policy or caps, or reuse a challenge outside the session that minted it. Everything
// here lives in the org's own authority.sqlite and changes in one synchronous write transaction (step 1 rules).
//
// - R-1 a fixed, hashed, default-deny action table; its hash is in every audit row.
// - R-2 envelopes carry `kid` (runtime-held verifiers, active/retired, rotated by Ops at the runtime) and bind the org id
//   AND this store's installationId, so an envelope for another installation (restore, clone) or org is refused.
// - R-3 a runtime-minted challenge is bound to member/action/bodyHash/artifactDigest/membershipVersion AND the Framework
//   operationId it authorizes; consumption + authorization are one transaction; a retry of that operationId needs no
//   second step-up; a refusal or revision conflict after consumption needs a new review and a new challenge.
// - Option A (owner decision 2026-10-16, Fable baseline 8c6f9b26; RELAXES C-1): no passkeys for now. Each action has a
//   STEP-UP tier (STEP_UP, default-deny, hashed into ACCESS_TABLE_HASH): `session` = the email-link hub session;
//   `session-fresh` = that session was signed in within STEP_UP.freshMinutes; `totp` = refused in-app until an
//   authenticator-app step exists (the owner-only Ops socket provides these meanwhile); `passkey` = the WebAuthn code,
//   kept behind the seam and used by no installed action. A session-tier challenge is also bound to the hub session that
//   minted it (a hash of the session id, in the signed envelope), and every Authorization records how it was made (authn).
// - R-5 invitations are minted here (hash stored), by Ops only under option A; the first admin joins from an Ops one-time
//   email link. Stated residual: a compromised hub that controls the mail transport can accept an invite for an address
//   it controls (it sees the token). Detection: Ops' own invite record plus the 'admitted' audit row.
//   Audit VISIBILITY is not yet audience-filtered (auditRows() is an Ops/runtime-local read); member-facing audit views
//   arrive with the UI and must filter by role and org.
// - R-8 revocation is enforced here by membershipVersion (bumped on removal/role change) in every envelope and challenge;
//   the hub's session drop/refresh is best-effort.
import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from "node:crypto";
import { canonical } from "../command-boundary.js";
import { assert } from "../validation.js";
import type { SqliteAuthority } from "../service/sqlite-authority.js";
import { b64u, verifyAssertion, verifyRegistration, WebAuthnError } from "./webauthn.js";
import { groupedSecret, hotp, newSeed, otpauthUri, totpStep, verifyTotp, TOTP } from "./totp.js";
import { openSeed, qrRows, readTotpKey, sealSeed, type SealedSeed } from "./totp-factors.js";
import { timingSafeEqual } from "node:crypto";

export const ACCESS_ACTIONS = Object.freeze({
  contract: "kapelle.access-actions/v1",
  // LIBRARY L2: the hub's public files route asks for one content hash (no member; the runtime answers 200/404/410/500).
  service: ["member.lookup", "receipt.failed", "files.public.read"],
  routine: ["agent.read", "agent.ask", "draft.create", "draft.read", "challenge.mint", "intake.token.issue", "intake.token.revoke", "notes.read", "notes.get", "audit.read",
    "intake.list", "plan.prepare", "draft.list", "member.me", "approval.list", "media.upload", "transcript.list", "transcript.read", "intake.upload",
    "chat.conversation.create", "chat.conversation.list", "chat.conversation.read", "chat.turn.start", "chat.turn.read", "chat.turn.stop", "chat.draft.card",
    "chat.upload", "chat.upload.share", "chat.artifact.preview", "files.list", "files.read", "chat.conversation.rename", "chat.draft.share",
    "website.request", "website.read", "website.list", "website.preview.check", "website.content.refresh", "website.discard", "totp.enroll.start", "totp.enroll.confirm",
    "newsletter.release.prepare", "newsletter.test", "newsletter.release.view", "image.upload", "image.read", "image.extract", "image.proposal.save",
    "teamtask.create", "teamtask.propose", "teamtask.read", "teamtask.list", "teamtask.disclose",
    "teamtask.schedule.propose", "teamtask.schedule.read", "teamtask.schedule.list", "teamtask.schedule.pause", "teamtask.schedule.pause.all",
    "handbook.read", "handbook.propose", "files.upload", "files.delete", "files.image.read", "image.drive.save"],
  consequential: ["proposal.approve", "task.adopt", "message.send", "site.deploy", "member.invite", "member.remove", "member.role", "passkey.enroll",
    "notes.approve", "policy.approve", "transcript.start", "transcript.accept", "transcript.discard", "transcription.policy.approve", "chat.draft.approve", "website.apply",
    "newsletter.send", "teamtask.approve", "teamtask.cancel", "teamtask.complete",
    // LIBRARY L2 (Fable Addendum 3): preparing a release that carries shared-drive images publishes them; an admin unpublishes.
    "newsletter.release.publish", "files.unpublish",
    "teamtask.schedule.approve", "teamtask.schedule.resume", "teamtask.schedule.run_now",
    "handbook.approve"],
});
/** Option A step-up tiers. Every action in ACCESS_ACTIONS (routine and consequential) is in exactly one tier; the service
 *  action is the hub's own. `session` tier can read, ask, adopt and run plans inside the hosted caps; it cannot change WHO
 *  receives mail (members, policy, intake addresses) or HOW MUCH can be spent (caps live in Ops config). */
export const STEP_UP = Object.freeze({
  contract: "kapelle.step-up/v1",
  freshMinutes: 60,
  session: ["agent.read", "agent.ask", "draft.create", "draft.read", "challenge.mint", "notes.read", "notes.get", "audit.read", "intake.list", "plan.prepare",
    "draft.list", "member.me", "approval.list", "task.adopt", "media.upload", "transcript.list", "transcript.read", "transcript.accept", "transcript.discard",
    // P-2(a): a reviewer's web text submission (reviewers-private only, no reply trigger).
    "intake.upload",
    // Chat agent C-2: a turn spends inside the per-turn $1 cap, the member's daily allowance and the org's monthly cap (D-2, P-1).
    "chat.conversation.create", "chat.conversation.list", "chat.conversation.read", "chat.turn.start", "chat.turn.read", "chat.turn.stop", "chat.draft.card",
    // C-6a: text uploads to the member's own chat, an explicit share to the org, previews, and the read-only Files page.
    "chat.upload", "chat.upload.share", "chat.artifact.preview", "files.list", "files.read",
    // J2 option a (Director): the owner shares one newsletter draft with reviewers, or stops (audited; chats stay private).
    "chat.draft.share",
    // WC-4 (Fable R-10): the starter renames their own conversation.
    "chat.conversation.rename",
    // Website pack v0 (Fable R-1): a request spends one hosted request (daily cap 20); nothing reaches GitHub until website.apply.
    "website.request", "website.read", "website.list", "website.preview.check",
    // Chat content WC-2 (Fable R-8): a reviewer's refresh of the read-only website copy (GETs only; 12 per org per 24 h).
    "website.content.refresh",
    // Owner (Oct 23): a reviewer discards a never-approved proposal (no GitHub call, no spend; refused once approved).
    "website.discard",
    // Newsletter slice 2: freeze a release from a draft; "Send me a test" to one's own address (cooldown + caps).
    "newsletter.release.prepare", "newsletter.test", "newsletter.release.view",
    // IMAGES-V1 I1: attach one flyer/image to one's own chat (a single-use streamed upload) and read it back (owner only).
    "image.upload", "image.read",
    // IMAGES-V1 I2: read one's own flyer with the pinned image profile (one hosted request inside per-member/org daily caps and
    // the org's monthly cap), and save one's checked values. Nothing is published.
    "image.extract", "image.proposal.save",
    // TEAM-TASKS-V1 T1: create a team task from typed text, request a plan (prepare-only, no model run), read within the audience.
    // T2b: the exact "Make this a task" disclosure (nothing written) before create.
    "teamtask.create", "teamtask.propose", "teamtask.read", "teamtask.list", "teamtask.disclose",
    // SCHEDULED-TASKS-V1 S1: propose a schedule (nothing runs), read/list within the audience, pause one (creator or reviewer),
    // pause all (reviewers/admins; the handler checks roles). Stopping never spends.
    "teamtask.schedule.propose", "teamtask.schedule.read", "teamtask.schedule.list", "teamtask.schedule.pause", "teamtask.schedule.pause.all",
    // AGENT-HANDBOOK-V1 H2: read the approved handbook (any member) and preview an edit (reviewers; nothing is written).
    "handbook.read", "handbook.propose",
    // LIBRARY L1 (Fable P-4): the shared drive. Upload a text file or (via image.upload {drive}) an image; read a drive image's
    // thumbnail; save one's own chat image to the drive; reviewers/admins remove (the handler checks roles). Nothing is public.
    "files.upload", "files.delete", "files.image.read", "image.drive.save"],
  // transcript.start spends and discloses voices to the provider (Fable R-3).
  // chat.draft.approve opens a spending draft envelope on the member's own conversation (Fable E-1).
  // website.apply opens a DRAFT PR under the connected identity (Fable R-1: draft, daily cap, receipts to admins, no merge).
  // Newsletter slice 1, S1-b (Fable answer 1): enrolling an authenticator is a ROUTINE action in this tier: a recent email-link
  // sign-in plus the Ops-minted single-use token; it approves no artifact.
  // TEAM-TASKS-V1: approving one run, cancelling (may stop running work) and marking a verified result done.
  "session-fresh": ["proposal.approve", "notes.approve", "transcript.start", "chat.draft.approve", "website.apply", "totp.enroll.start", "totp.enroll.confirm",
    "teamtask.approve", "teamtask.cancel", "teamtask.complete",
    // SCHEDULED-TASKS-V1 S1: a standing schedule (new authority for up to 90 days), resuming it, and a manual run attached to it.
    "teamtask.schedule.approve", "teamtask.schedule.resume", "teamtask.schedule.run_now",
    // AGENT-HANDBOOK-V1 H2: activating a handbook version changes what the agent is told in every chat and task, and pauses schedules.
    "handbook.approve",
    // LIBRARY L2 (Fable L-4 / P-1): publishing drive images at prepare (the card lists each image and its exact URL), and an
    // admin's unpublish (410; a hash a sent newsletter used needs the override the card names).
    "newsletter.release.publish", "files.unpublish"],
  totp: ["policy.approve", "intake.token.issue", "intake.token.revoke", "member.invite", "member.remove", "member.role", "message.send", "site.deploy",
    "transcription.policy.approve",
    // Newsletter slice 1 (S1-c): the one totp action completed IN THE APP with an authenticator code (TOTP_IN_APP).
    "newsletter.send"],
  passkey: ["passkey.enroll"],
});
export type StepUp = "session" | "session-fresh" | "totp" | "passkey";
/** Default deny: an action without a tier is refused. */
export function stepUpOf(action: string): StepUp {
  for (const t of ["session", "session-fresh", "totp", "passkey"] as const) if ((STEP_UP[t] as readonly string[]).includes(action)) return t;
  throw new AccessError("access_action_unknown");
}
/** R-1 + option A: the action table AND its step-up tiers, so a tier change is visible in every audit row and policy pin. */
export const ACCESS_TABLE_HASH = "sha256:" + createHash("sha256").update(canonical({ actions: ACCESS_ACTIONS, stepUp: STEP_UP })).digest("hex");
export type Audience = "service" | "routine" | "consequential";
/** R-1: default deny. An action not in the table is refused, never treated as routine. */
export function audienceOf(action: string): Audience {
  for (const a of ["service", "routine", "consequential"] as const) if ((ACCESS_ACTIONS[a] as readonly string[]).includes(action)) return a;
  throw new AccessError("access_action_unknown");
}
export class AccessError extends Error { constructor(readonly reason: string, readonly detail: string | null = null) { super(reason); this.name = "AccessError"; } }
const deny = (ok: unknown, reason: string): void => { if (!ok) throw new AccessError(reason); };
export const bodyHash = (body: unknown) => "sha256:" + createHash("sha256").update(canonical(body ?? null)).digest("hex");
const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const ROLES = ["admin", "reviewer", "contributor"] as const;
export type Role = (typeof ROLES)[number];
/** `session` (member envelopes): `ref` = hash of the hub session id (binds a challenge to the session that minted it) and
 *  `authAt` = when that session was signed in by email link (freshness). Null for the hub's own service envelopes. */
export type Envelope = { v: 1; orgId: string; installationId: string; kid: string; memberId: string; membershipVersion: number;
  action: string; bodyHash: string; requestId: string; expiry: string; session: { ref: string; authAt: string } | null };
export const envelopeBytes = (e: Envelope) => Buffer.from(canonical(e));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS access_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS access_members(member_id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('admin','reviewer','contributor')),
  status TEXT NOT NULL CHECK(status IN ('active','removed')), created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS access_credentials(credential_id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES access_members(member_id),
  alg INTEGER NOT NULL, jwk TEXT NOT NULL, sign_count INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS access_envelope_keys(kid TEXT PRIMARY KEY, jwk TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','retired')), at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS access_invitations(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL, role TEXT NOT NULL,
  created_by TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT) STRICT;
CREATE TABLE IF NOT EXISTS access_challenges(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('assertion','registration')), challenge TEXT NOT NULL,
  member_id TEXT, invitation_id TEXT, action TEXT NOT NULL, body_hash TEXT NOT NULL, artifact_digest TEXT, operation_id TEXT,
  membership_version INTEGER NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, session_ref TEXT) STRICT;
CREATE TABLE IF NOT EXISTS access_authorizations(operation_id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL UNIQUE, member_id TEXT NOT NULL,
  action TEXT NOT NULL, body_hash TEXT NOT NULL, artifact_digest TEXT, at TEXT NOT NULL,
  authn TEXT NOT NULL DEFAULT 'passkey', step_up TEXT NOT NULL DEFAULT 'passkey') STRICT;
CREATE TABLE IF NOT EXISTS access_replay(request_id TEXT PRIMARY KEY, at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS access_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, org_id TEXT NOT NULL, member_id TEXT, action TEXT NOT NULL,
  audience TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('allowed','refused','admitted')), reason TEXT, request_id TEXT, operation_id TEXT,
  table_hash TEXT NOT NULL, policy_version TEXT, catalog_profile_hash TEXT);
CREATE TABLE IF NOT EXISTS totp_factors(id TEXT PRIMARY KEY, member_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','active','revoked')),
  seed_ct TEXT NOT NULL, seed_iv TEXT NOT NULL, seed_tag TEXT NOT NULL, kid TEXT NOT NULL, last_counter INTEGER NOT NULL DEFAULT -1,
  failures INTEGER NOT NULL DEFAULT 0, locked_at TEXT, expires_at TEXT, created_at TEXT NOT NULL, activated_at TEXT, revoked_at TEXT, revoked_reason TEXT) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS totp_one_pending ON totp_factors(member_id) WHERE state='pending';
CREATE UNIQUE INDEX IF NOT EXISTS totp_one_active ON totp_factors(member_id) WHERE state='active';
CREATE TABLE IF NOT EXISTS totp_enrollments(id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, member_id TEXT NOT NULL, membership_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL, consumed_at TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;`;
/** Newsletter slice 1: the ONLY totp-tier action completed in the app (with an authenticator code). Every other totp-tier
 *  action stays refused in-app and Ops-only (owner decision 7: site.deploy stays Ops-only). Wired in S1-c. */
export const TOTP_IN_APP: readonly string[] = Object.freeze(["newsletter.send"]);
export const TOTP_ENROLL = { linkMinutes: 15, failures: 5 } as const;
/** S1-c (Fable F-1, R-3): a totp challenge lives 2 minutes; at most 10 mints per member per hour; five wrong codes lock. */
export const TOTP_CHALLENGE = { minutes: 2, mintsPerHour: 10, failures: 5 } as const;
/** The release core's hooks (installed by the runtime when a newsletter block exists): `guard` runs inside the mint
 *  transaction, `inTxn` is the LAST step of the verification transaction (same handle; R-2). Both throw fixed labels. */
export type TotpHooks = { guard(ctx: { action: string; memberId: string; body: unknown; artifactDigest: string | null; operationId: string }): void;
  inTxn(ctx: { action: string; memberId: string; body: unknown; artifactDigest: string | null; operationId: string }): void };

/** authn: how the approval was made: "email-session" (option A), "ops-socket" (owner-only Ops), "passkey" (legacy rows). */
export type Authorization = { memberId: string; action: string; bodyHash: string; artifactDigest: string | null; operationId: string; replayed: boolean; authn: string };
const AUTHN: Record<StepUp, string> = { session: "email-session", "session-fresh": "email-session", totp: "totp", passkey: "passkey" };

export class OrgAccess {
  private readonly now: () => string;
  constructor(private readonly a: SqliteAuthority, private readonly cfg: { orgId: string; rpId: string; origins: string[]; label?: string; totpKeyFile?: string | null }, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString());
    deny(/^[a-z0-9][a-z0-9-]{1,62}$/.test(cfg.orgId) && cfg.rpId && cfg.origins.length > 0 && cfg.origins.every((o) => /^https:\/\//.test(o)), "access_config_invalid");
    a.db.exec(SCHEMA);
    // Option A columns on a store created before it (pre-option-A authorizations were passkey-made: the default says so).
    const cols = (t: string) => (a.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols("access_challenges").includes("session_ref")) a.db.exec("ALTER TABLE access_challenges ADD COLUMN session_ref TEXT");
    for (const c of ["authn", "step_up"]) if (!cols("access_authorizations").includes(c)) a.db.exec(`ALTER TABLE access_authorizations ADD COLUMN ${c} TEXT NOT NULL DEFAULT 'passkey'`);
    a.write(() => {
      const meta = this.meta();
      if (!meta.orgId) for (const [k, v] of Object.entries({ orgId: cfg.orgId, rpId: cfg.rpId, origins: JSON.stringify(cfg.origins), membershipVersion: "0" }))
        a.db.prepare("INSERT INTO access_meta(key,value) VALUES (?,?)").run(k, v);
      else deny(meta.orgId === cfg.orgId && meta.rpId === cfg.rpId && meta.origins === JSON.stringify(cfg.origins), "access_identity_mismatch");
    });
  }
  private meta(): Record<string, string> {
    return Object.fromEntries((this.a.db.prepare("SELECT key, value FROM access_meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
  }
  private totpHooks: TotpHooks | null = null;
  /** The runtime installs the release core's guard and in-transaction hook (newsletter block present). */
  installTotpHooks(h: TotpHooks) { this.totpHooks = h; }
  get orgId() { return this.cfg.orgId; }
  get installationId() { return this.a.identity.installationId; }
  membershipVersion() { return this.a.read(() => Number(this.meta().membershipVersion)); }
  private bump() { this.a.db.prepare("UPDATE access_meta SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='membershipVersion'").run(); }
  private audit(r: { memberId?: string | null; action: string; audience?: Audience | null; outcome: "allowed" | "refused" | "admitted"; reason?: string | null; requestId?: string | null; operationId?: string | null }) {
    this.a.db.prepare(`INSERT INTO access_audit(at,org_id,member_id,action,audience,outcome,reason,request_id,operation_id,table_hash,policy_version,catalog_profile_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)`).run(this.now(), this.cfg.orgId, r.memberId ?? null, r.action.slice(0, 64), r.audience ?? null, r.outcome,
      r.reason ?? null, r.requestId ?? null, r.operationId ?? null, ACCESS_TABLE_HASH);
  }
  /** Run a write; a refusal is still audited (in its own transaction, after the rollback). */
  private guarded<T>(action: string, ids: { memberId?: string | null; requestId?: string | null; operationId?: string | null }, fn: () => T, afterRefusal?: () => void): T {
    try { return this.a.write(fn); }
    catch (e) {
      const reason = e instanceof AccessError || e instanceof WebAuthnError ? e.reason : "access_internal_error";
      // Answer 2: the member sees one label; the audit keeps the distinction (e.g. totp_code_invalid:replayed).
      const audited = e instanceof AccessError && e.detail ? `${reason}:${e.detail}` : reason;
      let audience: Audience | null = null; try { audience = audienceOf(action); } catch { /* unknown action is itself the reason */ }
      // N-3: on a refusal the member id is only what the request CLAIMED; label it so the audit never reads as verified.
      // The refusal hook (e.g. burning a challenge after a failed assertion) commits with the audit row, after the rollback.
      try { this.a.write(() => { afterRefusal?.(); this.audit({ ...ids, memberId: ids.memberId ? `claimed:${String(ids.memberId).slice(0, 80)}` : null, action, audience, outcome: "refused", reason: audited }); }); }
      catch { /* audit must not mask the refusal */ }
      throw e instanceof AccessError || e instanceof WebAuthnError ? e : new AccessError(reason);
    }
  }

  // ---- Ops, local only (never through the hub) ----
  /** R-2: envelope verifiers are installed and retired by Ops at the runtime. */
  addEnvelopeKey(kid: string, publicKey: JsonWebKey) {
    deny(/^[A-Za-z0-9_-]{2,64}$/.test(kid) && publicKey.kty === "OKP" && publicKey.crv === "Ed25519" && !("d" in publicKey), "access_envelope_key_invalid");
    this.a.write(() => this.a.db.prepare("INSERT INTO access_envelope_keys(kid,jwk,state,at) VALUES (?,?, 'active', ?)").run(kid, JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicKey.x }), this.now()));
  }
  retireEnvelopeKey(kid: string) { this.a.write(() => deny(this.a.db.prepare("UPDATE access_envelope_keys SET state='retired', at=? WHERE kid=?").run(this.now(), kid).changes === 1, "access_envelope_key_unknown")); }
  /** Passkey code kept behind the step-up seam (option A: not routed). The first admin's passkey enrolment at the runtime. */
  bootstrapAdmin(email: string) {
    return this.guarded("passkey.enroll", {}, () => {
      deny(!(this.a.db.prepare("SELECT 1 FROM access_members").get()), "access_bootstrap_not_empty");
      const id = randomUUID();
      this.a.db.prepare("INSERT INTO access_invitations(id,token_hash,email,role,created_by,expires_at,consumed_at) VALUES (?,?,?,?, 'ops:bootstrap', ?, NULL)")
        .run(id, tokenHash(randomBytes(32).toString("base64url")), email.toLowerCase(), "admin", new Date(Date.parse(this.now()) + 15 * 60_000).toISOString());
      return this.registrationOptions(id, email);
    });
  }

  /** B1 / option A: the FIRST admin joins from a one-time email link that Ops (owner-only socket) hands to them: a normal
   *  invitation (admin role, 24 h, single use, token stored only as its hash), refused once any member exists. */
  bootstrapInvite(email: string) {
    return this.guarded("member.invite", {}, () => {
      deny(!(this.a.db.prepare("SELECT 1 FROM access_members").get()), "access_bootstrap_not_empty");
      deny(typeof email === "string" && /^[^@\s]+@[^@\s]+$/.test(email) && email.length <= 320, "access_invite_invalid");
      const token = randomBytes(32).toString("base64url"), id = randomUUID();
      this.a.db.prepare("INSERT INTO access_invitations(id,token_hash,email,role,created_by,expires_at,consumed_at) VALUES (?,?,?,?, 'ops:bootstrap', ?, NULL)")
        .run(id, tokenHash(token), email.toLowerCase(), "admin", new Date(Date.parse(this.now()) + 86_400_000).toISOString());
      return { token, email: email.toLowerCase(), invitationId: id };
    });
  }
  /** Fable P-R1: Ops revokes an unconsumed invitation (bootstrap or member) by email or invitation id. The token dies at once
   *  (its expiry is set to now: it answers access_invite_expired); audited with the count. Consumed ones are never touched. */
  opsRevokeInvitations(kind: "bootstrap" | "member", by: { email?: unknown; invitationId?: unknown }) {
    return this.guarded("member.invite", { memberId: "ops" }, () => {
      const email = typeof by?.email === "string" ? by.email.toLowerCase() : null, id = typeof by?.invitationId === "string" ? by.invitationId : null;
      deny((email && /^[^@\s]+@[^@\s]+$/.test(email) && email.length <= 320) || (id && /^[A-Za-z0-9-]{8,64}$/.test(id)), "access_invite_invalid");
      const now = this.now(), creator = kind === "bootstrap" ? "created_by = 'ops:bootstrap'" : "created_by <> 'ops:bootstrap'";
      const rows = this.a.db.prepare(`SELECT id FROM access_invitations WHERE ${creator} AND consumed_at IS NULL AND expires_at > ? AND ${email ? "email = ?" : "id = ?"}`)
        .all(now, (email ?? id)!) as { id: string }[];
      deny(rows.length > 0, "access_invite_unknown");
      for (const r of rows) this.a.db.prepare("UPDATE access_invitations SET expires_at=? WHERE id=? AND consumed_at IS NULL").run(now, r.id);
      for (const r of rows) this.audit({ memberId: "ops", action: "member.invite", audience: "consequential", outcome: "refused", reason: `authn:ops-socket;revoked:${kind}`, operationId: r.id });
      return { revoked: rows.length, invitationIds: rows.map((r) => r.id) };
    });
  }

  // ---- Ops: the `totp`-tier actions until an authenticator-app step exists (option A; owner-only socket, never the hub) ----
  private activeMember(email: unknown) {
    deny(typeof email === "string" && /^[^@\s]+@[^@\s]+$/.test(email) && email.length <= 320, "access_member_unknown");
    const m = this.a.db.prepare("SELECT member_id, email, role FROM access_members WHERE email=? AND status='active'").get(String(email).toLowerCase()) as { member_id: string; email: string; role: Role } | undefined;
    deny(m, "access_member_unknown");
    return m!;
  }
  private keepsAnAdmin(memberId: string) {
    deny(!!this.a.db.prepare("SELECT 1 FROM access_members WHERE role='admin' AND status='active' AND member_id<>?").get(memberId), "access_last_admin");
  }
  /** Ops invite: an email-link invitation (7 days, single use; the token goes to Ops, who hands it over out of band). */
  opsInvite(email: string, role: Role) {
    return this.guarded("member.invite", { memberId: "ops" }, () => {
      deny(typeof email === "string" && /^[^@\s]+@[^@\s]+$/.test(email) && email.length <= 320 && ROLES.includes(role), "access_invite_invalid");
      deny(!this.a.db.prepare("SELECT 1 FROM access_members WHERE email=? AND status='active'").get(email.toLowerCase()), "access_member_exists");
      const token = randomBytes(32).toString("base64url"), id = randomUUID();
      this.a.db.prepare("INSERT INTO access_invitations(id,token_hash,email,role,created_by,expires_at,consumed_at) VALUES (?,?,?,?, 'ops', ?, NULL)")
        .run(id, tokenHash(token), email.toLowerCase(), role, new Date(Date.parse(this.now()) + 7 * 86_400_000).toISOString());
      this.audit({ memberId: "ops", action: "member.invite", audience: "consequential", outcome: "allowed", reason: `authn:ops-socket;role:${role}`, operationId: id });
      return { token, email: email.toLowerCase(), role, invitationId: id };
    });
  }
  /** Ops removal: bumps membershipVersion (R-8); never the last active admin. */
  opsRemoveMember(email: string) {
    return this.guarded("member.remove", { memberId: "ops" }, () => {
      const m = this.activeMember(email);
      if (m.role === "admin") this.keepsAnAdmin(m.member_id);
      this.a.db.prepare("UPDATE access_members SET status='removed' WHERE member_id=?").run(m.member_id);
      this.revokeFactors(m.member_id, "member-removed");
      this.bump();
      this.audit({ memberId: "ops", action: "member.remove", audience: "consequential", outcome: "allowed", reason: `authn:ops-socket;removed:${m.member_id}` });
      return { memberId: m.member_id, membershipVersion: Number(this.meta().membershipVersion) };
    });
  }
  /** Ops role change: bumps membershipVersion (a demotion must invalidate outstanding envelopes and challenges). */
  opsSetRole(email: string, role: Role) {
    return this.guarded("member.role", { memberId: "ops" }, () => {
      deny(ROLES.includes(role), "access_role_invalid");
      const m = this.activeMember(email);
      if (m.role === "admin" && role !== "admin") this.keepsAnAdmin(m.member_id);
      this.a.db.prepare("UPDATE access_members SET role=? WHERE member_id=?").run(role, m.member_id);
      if (role === "contributor") this.revokeFactors(m.member_id, "role-contributor"); // R-7: a promotion later needs a new enrollment
      this.bump();
      this.audit({ memberId: "ops", action: "member.role", audience: "consequential", outcome: "allowed", reason: `authn:ops-socket;${m.member_id}:${m.role}->${role}` });
      return { memberId: m.member_id, role, membershipVersion: Number(this.meta().membershipVersion) };
    });
  }
  opsMembers() {
    return this.a.read(() => (this.a.db.prepare("SELECT member_id, email, role, status, created_at FROM access_members ORDER BY created_at").all() as
      { member_id: string; email: string; role: Role; status: string; created_at: string }[]).map((m) => ({ memberId: m.member_id, email: m.email, role: m.role, status: m.status, since: m.created_at })));
  }
  /** Ops performs a `totp`-tier consequential action (e.g. policy.approve over the exact policy digest): an Authorization
   *  recorded and audited like a member's, attributed to "ops" with authn "ops-socket". */
  opsAuthorization(action: string, body: unknown, artifactDigest: string | null): Authorization {
    return this.guarded(action, { memberId: "ops" }, () => {
      deny(stepUpOf(action) === "totp" && audienceOf(action) === "consequential", "access_ops_action_not_permitted");
      deny(artifactDigest == null || /^sha256:[a-f0-9]{64}$/.test(artifactDigest), "access_artifact_digest");
      const operationId = "ops-" + randomUUID();
      this.a.db.prepare("INSERT INTO access_authorizations(operation_id,challenge_id,member_id,action,body_hash,artifact_digest,at,authn,step_up) VALUES (?,?, 'ops', ?,?,?,?, 'ops-socket', 'ops')")
        .run(operationId, "ops:" + operationId, action, bodyHash(body), artifactDigest, this.now());
      this.audit({ memberId: "ops", action, audience: "consequential", outcome: "allowed", reason: "authn:ops-socket", operationId });
      return { memberId: "ops", action, bodyHash: bodyHash(body), artifactDigest, operationId, replayed: false, authn: "ops-socket" };
    });
  }

  // ---- envelopes (service + routine audiences) ----
  private verifyEnvelope(env: Envelope, signature: string, body: unknown, audience: Audience) {
    deny(env && env.v === 1 && typeof signature === "string" && signature.length <= 128, "access_envelope_malformed");
    deny(env.orgId === this.cfg.orgId, "access_wrong_org");
    deny(env.installationId === this.installationId, "access_wrong_installation");
    deny(audienceOf(env.action) === audience, "access_wrong_audience");
    const key = this.a.db.prepare("SELECT jwk, state FROM access_envelope_keys WHERE kid=?").get(env.kid) as { jwk: string; state: string } | undefined;
    deny(key, "access_envelope_kid_unknown");
    deny(key!.state === "active", "access_envelope_kid_retired");
    let ok = false;
    try { ok = verify(null, envelopeBytes(env), createPublicKey({ key: JSON.parse(key!.jwk), format: "jwk" }), Buffer.from(signature, "base64url")); } catch { ok = false; }
    deny(ok, "access_envelope_signature");
    deny(env.bodyHash === bodyHash(body), "access_body_hash");
    const now = Date.parse(this.now()), exp = Date.parse(env.expiry);
    deny(Number.isFinite(exp) && exp > now && exp - now <= 120_000, "access_envelope_expired");
    deny(/^[A-Za-z0-9_-]{16,128}$/.test(env.requestId), "access_envelope_malformed");
    deny(!this.a.db.prepare("SELECT 1 FROM access_replay WHERE request_id=?").get(env.requestId), "access_envelope_replayed");
    // N-1: a replay row only matters while its envelope could still be valid (expiry <= 120 s); keep 10 min, prune older.
    this.a.db.prepare("DELETE FROM access_replay WHERE at < ?").run(new Date(now - 600_000).toISOString());
    this.a.db.prepare("INSERT INTO access_replay(request_id,at) VALUES (?,?)").run(env.requestId, this.now());
    if (audience === "service") { deny(env.memberId === "hub", "access_wrong_audience"); return null; }
    const s = env.session, at = s && typeof s === "object" ? Date.parse(String(s.authAt)) : NaN;
    deny(s && /^[a-f0-9]{64}$/.test(String(s.ref)) && Number.isFinite(at) && at <= now + 5_000, "access_envelope_session");
    const m = this.a.db.prepare("SELECT member_id, role, status FROM access_members WHERE member_id=?").get(env.memberId) as { member_id: string; role: Role; status: string } | undefined;
    deny(m && m.status === "active", "access_member_inactive");
    deny(env.membershipVersion === Number(this.meta().membershipVersion), "access_membership_stale"); // R-8
    return m!;
  }
  /** Service: the hub asks whether an email is an active member. The answer must never reach the requester (R-6, hub side). */
  lookupMember(env: Envelope, sig: string, body: { email: string }) {
    return this.guarded(env?.action ?? "member.lookup", { requestId: env?.requestId }, () => {
      deny(env && body && env.action === "member.lookup" && typeof body.email === "string", "access_wrong_audience");
      this.verifyEnvelope(env, sig, body, "service");
      const m = this.a.db.prepare("SELECT member_id FROM access_members WHERE email=? AND status='active'").get(String(body.email).toLowerCase()) as { member_id: string } | undefined;
      return m ? { active: true as const, memberId: m.member_id, membershipVersion: Number(this.meta().membershipVersion) } : { active: false as const };
    });
  }
  /** LIBRARY L2 (Fable L-2): the hub's public files route, for one content hash. A service envelope (no member, no session). */
  publicFileRead(env: Envelope, sig: string, body: { sha256: string }) {
    return this.guarded(env?.action ?? "files.public.read", { requestId: env?.requestId }, () => {
      deny(env && body && env.action === "files.public.read" && typeof body.sha256 === "string" && /^[a-f0-9]{64}$/.test(body.sha256), "access_wrong_audience");
      this.verifyEnvelope(env, sig, body, "service");
      return { sha256: body.sha256 };
    });
  }
  /** N-3 (option A): the hub reports a receipt it could not send (its mail port's fixed label). Audited against the recorded
   *  Authorization, so a missing receipt (control 4, the detection for a compromised mailbox) is visible to Ops. */
  receiptFailed(env: Envelope, sig: string, body: { operationId: string; to: string; label: string }) {
    return this.guarded(env?.action ?? "receipt.failed", { requestId: env?.requestId, operationId: body?.operationId }, () => {
      deny(env && body && env.action === "receipt.failed" && typeof body.operationId === "string" && typeof body.to === "string", "access_wrong_audience");
      this.verifyEnvelope(env, sig, body, "service");
      deny(!!this.a.db.prepare("SELECT 1 FROM access_authorizations WHERE operation_id=?").get(body.operationId), "access_authorization_unknown");
      const label = typeof body.label === "string" && /^[a-z][a-z0-9_:=.,-]{1,100}$/.test(body.label) ? body.label : "mail_error";
      const to = (this.a.db.prepare("SELECT member_id FROM access_members WHERE email=?").get(String(body.to).toLowerCase()) as { member_id: string } | undefined)?.member_id ?? null;
      // member_id stays null (a refused row's member id is only ever a labelled claim, N-3 of step 2); the recipient is in the reason.
      this.audit({ action: "receipt.failed", audience: "service", outcome: "refused", reason: `receipt_send_failed:${label};to:${to ?? "non-member"}`, requestId: env.requestId, operationId: body.operationId });
      return { recorded: true as const };
    });
  }
  /** Routine audience: reads, questions, drafts. Returns the verified member. */
  routine(env: Envelope, sig: string, body: unknown) {
    return this.guarded(env?.action ?? "routine", { memberId: env?.memberId, requestId: env?.requestId }, () => {
      const m = this.verifyEnvelope(env, sig, body, "routine")!;
      const tier = stepUpOf(env.action);
      deny(tier === "session" || tier === "session-fresh", "access_step_up_required"); // e.g. intake.token.issue: totp tier, Ops only for now
      // S1-b: a session-fresh ROUTINE action (enrolling an authenticator) needs a recent email-link sign-in.
      if (tier === "session-fresh") deny(this.fresh(env), "access_session_not_fresh");
      this.audit({ memberId: m.member_id, action: env.action, audience: "routine", outcome: "allowed", requestId: env.requestId });
      // sessionRef: the hub session's ref (P-3: an upload id is bound to the session that minted it).
      return { memberId: m.member_id, role: m.role, sessionRef: env.session!.ref };
    });
  }

  // ---- consequential: runtime-minted challenges (R-3), step-up per action (option A) ----
  private fresh(env: Envelope) { return Date.parse(this.now()) - Date.parse(env.session!.authAt) <= STEP_UP.freshMinutes * 60_000; }
  mintChallenge(env: Envelope, sig: string, body: { action: string; body: unknown; artifactDigest?: string | null; operationId: string }) {
    return this.guarded("challenge.mint", { memberId: env?.memberId, requestId: env?.requestId, operationId: body?.operationId }, () => {
      deny(env && body && env.action === "challenge.mint", "access_wrong_audience");
      const m = this.verifyEnvelope(env, sig, body, "routine")!;
      deny(audienceOf(body.action) === "consequential", "access_not_consequential");
      const tier = stepUpOf(body.action);
      deny(tier !== "totp" || TOTP_IN_APP.includes(body.action), "access_step_up_required"); // other totp actions stay Ops-only
      deny(typeof body.operationId === "string" && /^[A-Za-z0-9:._-]{8,128}$/.test(body.operationId), "access_operation_id");
      deny(body.artifactDigest == null || /^sha256:[a-f0-9]{64}$/.test(body.artifactDigest), "access_artifact_digest");
      deny(this.permitted(m.role, body.action), "access_role_not_permitted");
      // Told before the reviewer reads anything: an approval needs a recent sign-in (the UI offers a fresh link).
      if (tier === "session-fresh") deny(this.fresh(env), "access_session_not_fresh");
      const creds = tier === "passkey" ? this.a.db.prepare("SELECT credential_id FROM access_credentials WHERE member_id=?").all(m.member_id) as { credential_id: string }[] : [];
      if (tier === "passkey") deny(creds.length > 0, "access_no_passkey");
      if (tier === "totp") this.totpMintChecks(m.member_id, body);
      // N-1: expired, never-used challenges carry no authority; consumed ones stay (they back authorizations and audit).
      this.a.db.prepare("DELETE FROM access_challenges WHERE consumed_at IS NULL AND expires_at < ?").run(new Date(Date.parse(this.now()) - 86_400_000).toISOString());
      const id = randomUUID(), challenge = b64u(randomBytes(32)), expiresAt = new Date(Date.parse(this.now()) + (tier === "totp" ? TOTP_CHALLENGE.minutes : 5) * 60_000).toISOString();
      this.a.db.prepare(`INSERT INTO access_challenges(id,kind,challenge,member_id,invitation_id,action,body_hash,artifact_digest,operation_id,membership_version,expires_at,consumed_at,session_ref)
        VALUES (?,'assertion',?,?,NULL,?,?,?,?,?,?,NULL,?)`).run(id, challenge, m.member_id, body.action, bodyHash(body.body), body.artifactDigest ?? null, body.operationId,
        Number(this.meta().membershipVersion), expiresAt, env.session!.ref);
      this.audit({ memberId: m.member_id, action: "challenge.mint", audience: "routine", outcome: "allowed", requestId: env.requestId, operationId: body.operationId });
      if (tier !== "passkey") return { challengeId: id, stepUp: tier, expiresAt };
      return { challengeId: id, stepUp: tier, publicKey: { challenge, rpId: this.cfg.rpId, userVerification: "required", timeout: 300_000,
        allowCredentials: creds.map((c) => ({ type: "public-key", id: c.credential_id })) } };
    });
  }
  private permitted(role: Role, action: string) {
    if (role === "admin") return true;
    // Any member approves the draft plan in their OWN conversation (the handler checks ownership).
    if (action === "chat.draft.approve") return true;
    // TEAM-TASKS-V1: any member cancels their own unstarted task or marks a verified result of their own task done (the handler
    // checks creator/role and the audience); approving a run is a reviewer's.
    if (action === "teamtask.cancel" || action === "teamtask.complete") return true;
    if (["member.invite", "member.remove", "member.role", "passkey.enroll", "site.deploy", "transcription.policy.approve"].includes(action)) return false;
    // Spec §2: reviewers adopt Tasks, approve plans and member notes, and run transcriptions; contributors submit evidence and ask.
    return role === "reviewer" && ["task.adopt", "proposal.approve", "notes.approve", "message.send", "transcript.start", "transcript.accept", "transcript.discard", "website.apply",
      "newsletter.send", "teamtask.approve", "teamtask.schedule.approve", "teamtask.schedule.resume", "teamtask.schedule.run_now", "handbook.approve",
      "newsletter.release.publish"].includes(action); // newsletter.send: the release core also requires a named approver (config emails)
  }
  /** Perform the action's step-up over a runtime challenge; consume it and record the authorization atomically. */
  authorize(env: Envelope, sig: string, body: { challengeId: string; assertion?: { credentialId: string; clientDataJSON: string; authenticatorData: string; signature: string };
    action: string; body: unknown; artifactDigest?: string | null; operationId: string }): Authorization {
    // Fable ruling (2): once the challenge is found unconsumed and bound to the presenting member, ANY step-up failure
    // (session mismatch, stale sign-in, credential, assertion) consumes it: one attempt per challenge.
    let burn: string | null = null, codeFailed: string | null = null;
    return this.guarded(body?.action ?? "consequential", { memberId: env?.memberId, requestId: env?.requestId, operationId: body?.operationId }, () => {
      deny(env && body && env.action === body.action && typeof body.operationId === "string", "access_wrong_audience");
      const m = this.verifyEnvelope(env, sig, body, "consequential")!;
      const tier = stepUpOf(body.action);
      deny(tier !== "totp" || TOTP_IN_APP.includes(body.action), "access_step_up_required");
      // R-3: the idempotent retry of an already-authorized operation needs no second step-up.
      const prior = this.a.db.prepare("SELECT * FROM access_authorizations WHERE operation_id=?").get(body.operationId) as
        { member_id: string; action: string; body_hash: string; artifact_digest: string | null; authn: string } | undefined;
      if (prior) {
        deny(prior.member_id === m.member_id && prior.action === body.action && prior.body_hash === bodyHash(body.body) && prior.artifact_digest === (body.artifactDigest ?? null), "access_operation_conflict");
        this.audit({ memberId: m.member_id, action: body.action, audience: "consequential", outcome: "allowed", reason: "replayed_authorization", requestId: env.requestId, operationId: body.operationId });
        return { memberId: m.member_id, action: body.action, bodyHash: prior.body_hash, artifactDigest: prior.artifact_digest, operationId: body.operationId, replayed: true, authn: prior.authn };
      }
      // Shape before any lookup: a missing or malformed field is a fixed refusal, never a binding error.
      deny(typeof body.challengeId === "string" && /^[0-9a-f-]{36}$/.test(body.challengeId), "access_challenge_unknown");
      const as = body.assertion;
      if (tier === "passkey") deny(as && ["credentialId", "clientDataJSON", "authenticatorData", "signature"].every((k) => typeof (as as Record<string, unknown>)[k] === "string"), "access_assertion_malformed");
      const c = this.a.db.prepare("SELECT * FROM access_challenges WHERE id=? AND kind='assertion'").get(body.challengeId) as
        { challenge: string; member_id: string; action: string; body_hash: string; artifact_digest: string | null; operation_id: string; membership_version: number;
          expires_at: string; consumed_at: string | null; session_ref: string | null } | undefined;
      deny(c, "access_challenge_unknown");
      deny(c!.consumed_at === null, "access_challenge_consumed");
      deny(Date.parse(c!.expires_at) > Date.parse(this.now()), "access_challenge_expired");
      deny(c!.member_id === m.member_id && c!.action === body.action && c!.operation_id === body.operationId, "access_challenge_binding");
      deny(c!.body_hash === bodyHash(body.body) && c!.artifact_digest === (body.artifactDigest ?? null), "access_challenge_binding");
      deny(c!.membership_version === Number(this.meta().membershipVersion), "access_membership_stale");
      burn = body.challengeId; // from here on, failure consumes the challenge
      if (tier === "passkey") {
        const cred = this.a.db.prepare("SELECT * FROM access_credentials WHERE credential_id=? AND member_id=?").get(as!.credentialId, m.member_id) as
          { alg: number; jwk: string; sign_count: number } | undefined;
        deny(cred, "access_credential_unknown");
        const v = verifyAssertion(as!, { challenge: Buffer.from(c!.challenge, "base64url"), origins: this.cfg.origins, rpId: this.cfg.rpId },
          { alg: cred!.alg, jwk: JSON.parse(cred!.jwk), signCount: cred!.sign_count });
        this.a.db.prepare("UPDATE access_credentials SET sign_count=? WHERE credential_id=?").run(v.signCount, as!.credentialId);
      } else if (tier === "totp") {
        // S1-c (Fable F-1, R-8), all in THIS transaction: (1) binding incl. the session (a mismatch burns the challenge);
        // (2) factor state/kid/lock; (3) clock skew; (4) the code (timingSafeEqual over T-1..T+1); (5) matched > last_counter;
        // a code failure does NOT consume the challenge but counts toward the lock (refusal txn); (6) kill switch + gates via
        // the release core's hook, LAST (a gate failure voids the challenge); (7) the writes.
        deny(c!.session_ref === env.session!.ref, "access_challenge_session_mismatch");
        const key = this.totpKey(), f = this.activeFactor(m.member_id), seed = this.seedOf(f, key), now = Date.parse(this.now());
        deny(totpStep(now) >= f.last_counter - 1, "totp_clock_skew");
        burn = null; codeFailed = f.id;
        const matched = verifyTotp(seed, (body as { totp?: { code?: unknown } }).totp?.code, now);
        if (matched === null) throw new AccessError("totp_code_invalid", "wrong");
        if (matched <= f.last_counter) throw new AccessError("totp_code_invalid", "replayed");
        codeFailed = null; burn = body.challengeId; // from here a failure (a gate) voids the challenge
        this.a.db.prepare("UPDATE totp_factors SET last_counter=?, failures=0 WHERE id=? AND state='active' AND last_counter<?").run(matched, f.id, matched);
      } else {
        // Fable control 6: the challenge completes only from the hub session that minted it; control 3: approvals need a
        // recent email-link sign-in (checked again here: the challenge may have been minted just inside the window).
        deny(c!.session_ref === env.session!.ref, "access_challenge_session_mismatch");
        if (tier === "session-fresh") deny(this.fresh(env), "access_session_not_fresh");
      }
      this.a.db.prepare("UPDATE access_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(this.now(), body.challengeId);
      this.a.db.prepare("INSERT INTO access_authorizations(operation_id,challenge_id,member_id,action,body_hash,artifact_digest,at,authn,step_up) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(body.operationId, body.challengeId, m.member_id, body.action, bodyHash(body.body), body.artifactDigest ?? null, this.now(), AUTHN[tier], tier);
      this.audit({ memberId: m.member_id, action: body.action, audience: "consequential", outcome: "allowed", reason: `authn:${AUTHN[tier]}`, requestId: env.requestId, operationId: body.operationId });
      // R-2: the release core's hook is the LAST step of this transaction (same handle).
      if (tier === "totp") { deny(this.totpHooks, "access_action_not_installed");
        this.totpHooks!.inTxn({ action: body.action, memberId: m.member_id, body: body.body, artifactDigest: body.artifactDigest ?? null, operationId: body.operationId }); }
      return { memberId: m.member_id, action: body.action, bodyHash: bodyHash(body.body), artifactDigest: body.artifactDigest ?? null, operationId: body.operationId, replayed: false, authn: AUTHN[tier] };
    }, () => {
      if (burn) this.a.db.prepare("UPDATE access_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(this.now(), burn);
      // F-1: a wrong or replayed code counts in THIS (refusal) transaction, so the rollback never erases it; the fifth locks
      // the factor and voids the challenge (recovery: Ops re-enrollment).
      if (codeFailed) {
        this.a.db.prepare("UPDATE totp_factors SET failures=failures+1 WHERE id=? AND state='active'").run(codeFailed);
        if (this.a.db.prepare("UPDATE totp_factors SET locked_at=? WHERE id=? AND state='active' AND locked_at IS NULL AND failures>=?").run(this.now(), codeFailed, TOTP_CHALLENGE.failures).changes)
          this.a.db.prepare("UPDATE access_challenges SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(this.now(), body.challengeId);
      }
    });
  }
  /** Fable control 4: who gets a receipt for a performed session-tier action (fixed-template mail, sent by the hub): the
   *  member who did it, plus, for a plan approval, every other active admin (the org's owners). Server-held facts only. */
  receiptFor(z: Authorization) {
    if (z.replayed || !["task.adopt", "proposal.approve", "notes.approve", "transcript.start", "transcript.accept", "chat.draft.approve", "website.apply", "newsletter.send",
      "teamtask.approve", "teamtask.complete", "teamtask.schedule.approve", "teamtask.schedule.resume", "teamtask.schedule.run_now", "handbook.approve",
      "newsletter.release.publish", "files.unpublish"].includes(z.action)) return null;
    return this.a.read(() => {
      const self = this.a.db.prepare("SELECT email FROM access_members WHERE member_id=?").get(z.memberId) as { email: string } | undefined;
      if (!self) return null;
      // The org's admins also get the receipt when money is spent or voices go to a provider (plan approval, transcription).
      const admins = !["proposal.approve", "transcript.start", "website.apply", "newsletter.send", "teamtask.approve", "teamtask.complete",
        "teamtask.schedule.approve", "teamtask.schedule.resume", "teamtask.schedule.run_now", "handbook.approve",
        "newsletter.release.publish", "files.unpublish"].includes(z.action) ? [] : (this.a.db.prepare("SELECT email FROM access_members WHERE role='admin' AND status='active' AND member_id<>? ORDER BY email")
        .all(z.memberId) as { email: string }[]).map((r) => r.email);
      const at = (this.a.db.prepare("SELECT at FROM access_authorizations WHERE operation_id=?").get(z.operationId) as { at: string } | undefined)?.at ?? this.now();
      return { to: [self.email, ...admins], actor: self.email, action: z.action, artifactDigest: z.artifactDigest, operationId: z.operationId, at, authn: z.authn };
    });
  }

  // ---- membership (consequential, executed with an Authorization from authorize()) ----
  private assertAuthorized(z: Authorization, action: string, body: unknown) {
    deny(z.action === action && z.bodyHash === bodyHash(body), "access_authorization_mismatch");
    const row = this.a.db.prepare("SELECT member_id FROM access_authorizations WHERE operation_id=? AND action=? AND body_hash=?").get(z.operationId, action, z.bodyHash);
    deny(row, "access_authorization_unknown");
  }
  /** R-5: the runtime mints the invite token (only its hash is stored); the hub merely relays it through mail. */
  invite(z: Authorization, body: { email: string; role: Role }) {
    return this.guarded("member.invite", { memberId: z.memberId, operationId: z.operationId }, () => {
      this.assertAuthorized(z, "member.invite", body);
      deny(typeof body.email === "string" && /^[^@\s]+@[^@\s]+$/.test(body.email) && ROLES.includes(body.role), "access_invite_invalid");
      const prior = this.a.db.prepare("SELECT id FROM access_invitations WHERE id=?").get(z.operationId);
      deny(!prior, "access_invite_replayed"); // one invitation per authorized operation; a lost token needs a new invite
      const token = randomBytes(32).toString("base64url");
      this.a.db.prepare("INSERT INTO access_invitations(id,token_hash,email,role,created_by,expires_at,consumed_at) VALUES (?,?,?,?,?,?,NULL)")
        .run(z.operationId, tokenHash(token), body.email.toLowerCase(), body.role, z.memberId, new Date(Date.parse(this.now()) + 7 * 86_400_000).toISOString());
      this.audit({ memberId: z.memberId, action: "member.invite", audience: "consequential", outcome: "allowed", operationId: z.operationId });
      return { token, email: body.email.toLowerCase() };
    });
  }
  private registrationOptions(invitationId: string, email: string) {
    const id = randomUUID(), challenge = b64u(randomBytes(32));
    this.a.db.prepare(`INSERT INTO access_challenges(id,kind,challenge,member_id,invitation_id,action,body_hash,artifact_digest,operation_id,membership_version,expires_at,consumed_at)
      VALUES (?,'registration',?,NULL,?,'passkey.enroll',?,NULL,NULL,?,?,NULL)`).run(id, challenge, invitationId, bodyHash({ invitationId }),
      Number(this.meta().membershipVersion), new Date(Date.parse(this.now()) + 5 * 60_000).toISOString());
    return { challengeId: id, publicKey: { challenge, rp: { id: this.cfg.rpId }, user: { name: email.toLowerCase() }, timeout: 300_000,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }],
      authenticatorSelection: { userVerification: "required", residentKey: "preferred" }, attestation: "none" } };
  }
  /** Invite page (read-only, never consumes the token): who invited whom to what, from server-held facts only, so the person
   *  can tell a real invitation from a phish before creating a passkey. Same refusals as acceptance. */
  inviteInfo(token: string) {
    deny(typeof token === "string" && token.length >= 32 && token.length <= 64, "access_invite_unknown");
    const inv = this.a.read(() => this.a.db.prepare("SELECT email, role, created_by, expires_at, consumed_at FROM access_invitations WHERE token_hash=?").get(tokenHash(token))) as
      { email: string; role: Role; created_by: string; expires_at: string; consumed_at: string | null } | undefined;
    deny(inv, "access_invite_unknown");
    deny(inv!.consumed_at === null, "access_invite_consumed");
    deny(Date.parse(inv!.expires_at) > Date.parse(this.now()), "access_invite_expired");
    const inviter = inv!.created_by === "ops:bootstrap" || inv!.created_by === "ops" ? null
      : (this.a.read(() => this.a.db.prepare("SELECT email FROM access_members WHERE member_id=?").get(inv!.created_by)) as { email: string } | undefined)?.email ?? null;
    return { orgLabel: this.cfg.label ?? this.cfg.orgId, role: inv!.role, email: inv!.email, invitedBy: inviter, firstAdmin: inv!.created_by === "ops:bootstrap" };
  }
  /** Option A invite acceptance: the mailed (or Ops-issued) one-time token proves possession of the invited mailbox, exactly
   *  like a sign-in link, and admits the member atomically (token single use). The hub then opens a session for them. */
  acceptInvite(token: string) {
    return this.guarded("member.admit", {}, () => {
      deny(typeof token === "string" && token.length >= 32 && token.length <= 64, "access_invite_unknown");
      const inv = this.a.db.prepare("SELECT id, email, role, created_by, expires_at, consumed_at FROM access_invitations WHERE token_hash=?").get(tokenHash(token)) as
        { id: string; email: string; role: Role; created_by: string; expires_at: string; consumed_at: string | null } | undefined;
      deny(inv, "access_invite_unknown");
      deny(inv!.consumed_at === null, "access_invite_consumed");
      deny(Date.parse(inv!.expires_at) > Date.parse(this.now()), "access_invite_expired");
      if (inv!.created_by === "ops:bootstrap") deny(!this.a.db.prepare("SELECT 1 FROM access_members WHERE status='active'").get(), "access_bootstrap_not_empty");
      const existing = this.a.db.prepare("SELECT member_id, status FROM access_members WHERE email=?").get(inv!.email) as { member_id: string; status: string } | undefined;
      deny(!existing || existing.status === "removed", "access_member_exists");
      const memberId = existing?.member_id ?? "m-" + randomUUID();
      if (existing) this.a.db.prepare("UPDATE access_members SET status='active', role=? WHERE member_id=?").run(inv!.role, memberId);
      else this.a.db.prepare("INSERT INTO access_members(member_id,email,role,status,created_at) VALUES (?,?,?, 'active', ?)").run(memberId, inv!.email, inv!.role, this.now());
      this.a.db.prepare("UPDATE access_invitations SET consumed_at=? WHERE id=?").run(this.now(), inv!.id);
      // Admission does not bump membershipVersion (as before): an added member cannot make anyone's pending approval unsafe.
      this.audit({ memberId, action: "member.admit", outcome: "admitted", reason: `role:${inv!.role};authn:email-link;by:${inv!.created_by === "ops:bootstrap" || inv!.created_by === "ops" ? inv!.created_by : "member"}` });
      return { memberId, email: inv!.email, role: inv!.role, membershipVersion: Number(this.meta().membershipVersion) };
    });
  }
  /** Invite acceptance step 1: the mailed token (possession of the invited mailbox) yields a registration challenge. */
  beginRegistration(token: string) {
    return this.guarded("passkey.enroll", {}, () => {
      deny(typeof token === "string" && token.length >= 32 && token.length <= 64, "access_invite_unknown");
      const inv = this.a.db.prepare("SELECT id, email, expires_at, consumed_at FROM access_invitations WHERE token_hash=?").get(tokenHash(token)) as
        { id: string; email: string; expires_at: string; consumed_at: string | null } | undefined;
      deny(inv, "access_invite_unknown"); // looked up by the token's hash; the raw token is never stored
      deny(inv!.consumed_at === null, "access_invite_consumed");
      deny(Date.parse(inv!.expires_at) > Date.parse(this.now()), "access_invite_expired");
      return this.registrationOptions(inv!.id, inv!.email);
    });
  }
  /** Invite acceptance step 2 (and Ops bootstrap): verify the new passkey and admit the member atomically. */
  completeRegistration(body: { challengeId: string; credential: { clientDataJSON: string; attestationObject: string } }) {
    return this.guarded("passkey.enroll", {}, () => {
      deny(typeof body?.challengeId === "string" && /^[0-9a-f-]{36}$/.test(body.challengeId), "access_challenge_unknown");
      deny(body.credential && typeof body.credential.clientDataJSON === "string" && typeof body.credential.attestationObject === "string", "access_credential_malformed");
      const c = this.a.db.prepare("SELECT * FROM access_challenges WHERE id=? AND kind='registration'").get(body.challengeId) as
        { challenge: string; invitation_id: string; expires_at: string; consumed_at: string | null } | undefined;
      deny(c, "access_challenge_unknown");
      deny(c!.consumed_at === null, "access_challenge_consumed");
      deny(Date.parse(c!.expires_at) > Date.parse(this.now()), "access_challenge_expired");
      const inv = this.a.db.prepare("SELECT * FROM access_invitations WHERE id=?").get(c!.invitation_id) as { email: string; role: Role; consumed_at: string | null; expires_at: string } | undefined;
      deny(inv && inv.consumed_at === null && Date.parse(inv.expires_at) > Date.parse(this.now()), "access_invite_consumed");
      const r = verifyRegistration(body.credential, { challenge: Buffer.from(c!.challenge, "base64url"), origins: this.cfg.origins, rpId: this.cfg.rpId });
      deny(!this.a.db.prepare("SELECT 1 FROM access_credentials WHERE credential_id=?").get(r.credentialId), "access_credential_duplicate");
      const existing = this.a.db.prepare("SELECT member_id, status FROM access_members WHERE email=?").get(inv!.email) as { member_id: string; status: string } | undefined;
      deny(!existing || existing.status === "removed", "access_member_exists");
      const memberId = existing?.member_id ?? "m-" + randomUUID();
      if (existing) this.a.db.prepare("UPDATE access_members SET status='active', role=? WHERE member_id=?").run(inv!.role, memberId);
      else this.a.db.prepare("INSERT INTO access_members(member_id,email,role,status,created_at) VALUES (?,?,?, 'active', ?)").run(memberId, inv!.email, inv!.role, this.now());
      this.a.db.prepare("INSERT INTO access_credentials(credential_id,member_id,alg,jwk,sign_count,created_at) VALUES (?,?,?,?,?,?)")
        .run(r.credentialId, memberId, r.alg, JSON.stringify(r.jwk), r.signCount, this.now());
      this.a.db.prepare("UPDATE access_challenges SET consumed_at=? WHERE id=?").run(this.now(), body.challengeId);
      this.a.db.prepare("UPDATE access_invitations SET consumed_at=? WHERE id=?").run(this.now(), c!.invitation_id);
      // Admission does not bump membershipVersion: only removal/demotion must invalidate outstanding envelopes and
      // challenges (an added member cannot make anyone else's pending approval unsafe).
      this.audit({ memberId, action: "passkey.enroll", audience: "consequential", outcome: "admitted", reason: `role:${inv!.role}` });
      return { memberId, role: inv!.role, credentialId: r.credentialId, membershipVersion: Number(this.meta().membershipVersion) };
    });
  }
  /** Removal (consequential): bumps membershipVersion, which invalidates every outstanding envelope and challenge (R-8). */
  removeMember(z: Authorization, body: { memberId: string }) {
    return this.guarded("member.remove", { memberId: z.memberId, operationId: z.operationId }, () => {
      this.assertAuthorized(z, "member.remove", body);
      deny(body.memberId !== z.memberId, "access_cannot_remove_self");
      deny(this.a.db.prepare("UPDATE access_members SET status='removed' WHERE member_id=? AND status='active'").run(body.memberId).changes === 1, "access_member_inactive");
      this.revokeFactors(body.memberId, "member-removed");
      this.bump();
      this.audit({ memberId: z.memberId, action: "member.remove", audience: "consequential", outcome: "allowed", reason: `removed:${body.memberId}`, operationId: z.operationId });
      return { membershipVersion: Number(this.meta().membershipVersion) };
    });
  }
  // ---- Newsletter slice 1, S1-b: authenticator (TOTP) enrollment (Fable F-2, R-5, R-7; answers 1-2) ----
  /** The key at use; no newsletter block = totp_not_configured; a bad or missing file = totp_key_unavailable. */
  private totpKey() {
    deny(this.cfg.totpKeyFile, "totp_not_configured");
    try { return readTotpKey(this.cfg.totpKeyFile!); } catch { throw new AccessError("totp_key_unavailable"); }
  }
  private seedOf(f: { id: string; member_id: string; kid: string; seed_ct: string; seed_iv: string; seed_tag: string }, key: { key: Buffer; kid: string }) {
    deny(f.kid === key.kid, "totp_key_unavailable"); // R-5: restore elsewhere / rotation: this factor only, never re-encrypted
    try { return openSeed(key.key, { ct: f.seed_ct, iv: f.seed_iv, tag: f.seed_tag }, { orgId: this.cfg.orgId, memberId: f.member_id, factorId: f.id }); }
    catch { throw new AccessError("totp_key_unavailable"); }
  }
  /** Revoke every pending/active factor of a member, expire their open enrollment links and void their open totp challenges. */
  private revokeFactors(memberId: string, reason: string, states: ("pending" | "active")[] = ["pending", "active"]) {
    const now = this.now();
    const n = this.a.db.prepare(`UPDATE totp_factors SET state='revoked', revoked_at=?, revoked_reason=? WHERE member_id=? AND state IN (${states.map(() => "?").join(",")})`)
      .run(now, reason, memberId, ...states).changes;
    if (states.includes("pending")) this.a.db.prepare("UPDATE totp_enrollments SET expires_at=? WHERE member_id=? AND consumed_at IS NULL AND expires_at > ?").run(now, memberId, now);
    if (states.includes("active") && TOTP_IN_APP.length)
      this.a.db.prepare(`UPDATE access_challenges SET consumed_at=? WHERE member_id=? AND consumed_at IS NULL AND action IN (${TOTP_IN_APP.map(() => "?").join(",")})`).run(now, memberId, ...TOTP_IN_APP);
    return n;
  }
  /** Ops mints a single-use enrollment link (15 min) for an active admin or reviewer, bound to the current membershipVersion.
   *  Ops hands it over out of band after verifying the person. A newer link expires the older unused one. */
  opsTotpEnroll(email: string) {
    return this.guarded("totp.enroll.start", { memberId: "ops" }, () => {
      this.totpKey();
      const m = this.activeMember(email);
      deny(m.role === "admin" || m.role === "reviewer", "access_role_not_permitted");
      const now = this.now(), token = randomBytes(32).toString("base64url"), id = randomUUID(), expiresAt = new Date(Date.parse(now) + TOTP_ENROLL.linkMinutes * 60_000).toISOString();
      this.a.db.prepare("UPDATE totp_enrollments SET expires_at=? WHERE member_id=? AND consumed_at IS NULL AND expires_at > ?").run(now, m.member_id, now);
      this.a.db.prepare("INSERT INTO totp_enrollments(id,token_hash,member_id,membership_version,expires_at,consumed_at,created_by,created_at) VALUES (?,?,?,?,?,NULL,'ops',?)")
        .run(id, tokenHash(token), m.member_id, Number(this.meta().membershipVersion), expiresAt, now);
      this.audit({ memberId: "ops", action: "totp.enroll.start", audience: "routine", outcome: "allowed", reason: `authn:ops-socket;link_for:${m.member_id}`, operationId: id });
      return { token, email: m.email, expiresAt, enrollmentId: id };
    });
  }
  opsTotpRevoke(email: string) {
    return this.guarded("totp.revoke", { memberId: "ops" }, () => {
      const m = this.activeMember(email), n = this.revokeFactors(m.member_id, "ops-revoked");
      this.audit({ memberId: "ops", action: "totp.revoke", audience: null, outcome: "allowed", reason: `authn:ops-socket;revoked:${m.member_id};factors:${n}` });
      return { email: m.email, revoked: n };
    });
  }
  /** The member starts enrolling: ONE transaction consumes the token and creates the pending factor (answer 1). The active
   *  factor is never touched here (R-7). The otpauth URI, the grouped secret and the QR modules are returned ONCE. */
  totpEnrollStart(m: { memberId: string }, body: { token?: unknown }) {
    return this.guarded("totp.enroll.start", { memberId: m.memberId }, () => {
      const key = this.totpKey(), now = this.now();
      deny(typeof body?.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(body.token), "totp_enroll_token_invalid");
      const e = this.a.db.prepare("SELECT * FROM totp_enrollments WHERE token_hash=?").get(tokenHash(body.token as string)) as
        { id: string; member_id: string; membership_version: number; expires_at: string; consumed_at: string | null } | undefined;
      deny(e && e.consumed_at === null && Date.parse(e.expires_at) > Date.parse(now) && e.member_id === m.memberId
        && e.membership_version === Number(this.meta().membershipVersion), "totp_enroll_token_invalid");
      const who = this.a.db.prepare("SELECT email, role FROM access_members WHERE member_id=? AND status='active'").get(m.memberId) as { email: string; role: Role } | undefined;
      deny(who && who.role !== "contributor", "access_role_not_permitted");
      this.a.db.prepare("UPDATE totp_enrollments SET consumed_at=? WHERE id=? AND consumed_at IS NULL").run(now, e!.id);
      this.a.db.prepare("UPDATE totp_factors SET state='revoked', revoked_at=?, revoked_reason='replaced-pending' WHERE member_id=? AND state='pending'").run(now, m.memberId);
      const id = "tf_" + randomUUID().replaceAll("-", ""), seed = newSeed();
      const s: SealedSeed = sealSeed(key.key, seed, { orgId: this.cfg.orgId, memberId: m.memberId, factorId: id });
      this.a.db.prepare(`INSERT INTO totp_factors(id,member_id,state,seed_ct,seed_iv,seed_tag,kid,last_counter,failures,locked_at,expires_at,created_at,activated_at,revoked_at,revoked_reason)
        VALUES (?,?,'pending',?,?,?,?,-1,0,NULL,?,?,NULL,NULL,NULL)`).run(id, m.memberId, s.ct, s.iv, s.tag, key.kid, e!.expires_at, now);
      this.audit({ memberId: m.memberId, action: "totp.enroll.start", audience: "routine", outcome: "allowed", operationId: e!.id });
      const uri = otpauthUri({ issuer: `Kapelle ${this.cfg.label ?? this.cfg.orgId}`, account: who!.email, secret: seed });
      return { uri, secret: groupedSecret(seed), qr: qrRows(uri), expiresAt: e!.expires_at, digits: TOTP.digits, periodSeconds: TOTP.stepSec };
    });
  }
  /** Two codes from successive time steps (c, c+1, c+1 within T-1..T+1) activate the pending factor with last_counter = c+1
   *  (so neither enrollment code can ever authorize anything); the old active factor is revoked in the same transaction
   *  (R-7). A failed confirm counts in its own transaction; the fifth voids the pending factor (a new link is needed). */
  totpEnrollConfirm(m: { memberId: string }, body: { code1?: unknown; code2?: unknown }) {
    let failed: string | null = null;
    return this.guarded("totp.enroll.confirm", { memberId: m.memberId }, () => {
      const key = this.totpKey(), now = this.now();
      const f = this.a.db.prepare("SELECT * FROM totp_factors WHERE member_id=? AND state='pending'").get(m.memberId) as
        { id: string; member_id: string; kid: string; seed_ct: string; seed_iv: string; seed_tag: string; expires_at: string } | undefined;
      deny(f && Date.parse(f.expires_at) > Date.parse(now), "totp_enroll_not_pending");
      const seed = this.seedOf(f!, key), t = totpStep(Date.parse(now));
      const ok = (c: unknown) => typeof c === "string" && /^[0-9]{6}$/.test(c);
      const a = Buffer.from(ok(body?.code1) ? body.code1 as string : "------"), b = Buffer.from(ok(body?.code2) ? body.code2 as string : "------");
      let matched: number | null = null;
      for (let c2 = t - TOTP.window; c2 <= t + TOTP.window; c2++) {
        if (c2 < 1) continue;
        const hit = timingSafeEqual(Buffer.from(hotp(seed, c2 - 1)), a) && timingSafeEqual(Buffer.from(hotp(seed, c2)), b);
        if (hit && ok(body?.code1) && ok(body?.code2)) matched = c2;
      }
      if (matched === null) { failed = f!.id; deny(false, "totp_enroll_codes_invalid"); }
      this.revokeFactors(m.memberId, "replaced", ["active"]);
      this.a.db.prepare("UPDATE totp_factors SET state='active', last_counter=?, failures=0, expires_at=NULL, activated_at=? WHERE id=? AND state='pending'").run(matched, now, f!.id);
      this.audit({ memberId: m.memberId, action: "totp.enroll.confirm", audience: "routine", outcome: "allowed", operationId: f!.id });
      return { active: true as const, activatedAt: now };
    }, () => {
      if (!failed) return;
      this.a.db.prepare("UPDATE totp_factors SET failures=failures+1 WHERE id=? AND state='pending'").run(failed);
      this.a.db.prepare("UPDATE totp_factors SET state='revoked', revoked_at=?, revoked_reason='enroll-failed' WHERE id=? AND state='pending' AND failures>=?").run(this.now(), failed, TOTP_ENROLL.failures);
    });
  }
  private activeFactor(memberId: string) {
    const f = this.a.db.prepare("SELECT * FROM totp_factors WHERE member_id=? AND state='active'").get(memberId) as
      { id: string; member_id: string; kid: string; seed_ct: string; seed_iv: string; seed_tag: string; last_counter: number; failures: number; locked_at: string | null } | undefined;
    deny(f, "totp_not_enrolled");
    deny(!f!.locked_at, "totp_factor_locked");
    return f!;
  }
  /** Mint for a totp action (R-3, F-4): an active, unlocked factor whose key opens it; at most 10 mints per member per hour;
   *  one open challenge per (member, operationId): a re-mint consumes (voids) the previous; then the release core's guard. */
  private totpMintChecks(memberId: string, body: { action: string; body: unknown; artifactDigest?: string | null; operationId: string }) {
    const key = this.totpKey(); // not configured / key unavailable before "not enrolled"
    this.seedOf(this.activeFactor(memberId), key);
    const now = Date.parse(this.now()), since = new Date(now - 60 * 60_000 + TOTP_CHALLENGE.minutes * 60_000).toISOString(); // expiry = mint + 2 min
    const n = (this.a.db.prepare(`SELECT COUNT(*) AS n FROM access_challenges WHERE member_id=? AND kind='assertion' AND expires_at > ? AND action IN (${TOTP_IN_APP.map(() => "?").join(",")})`)
      .get(memberId, since, ...TOTP_IN_APP) as { n: number }).n;
    deny(n < TOTP_CHALLENGE.mintsPerHour, "totp_mint_rate_limited");
    deny(this.totpHooks, "access_action_not_installed");
    this.totpHooks!.guard({ action: body.action, memberId, body: body.body, artifactDigest: body.artifactDigest ?? null, operationId: body.operationId });
    this.a.db.prepare("UPDATE access_challenges SET consumed_at=? WHERE member_id=? AND operation_id=? AND consumed_at IS NULL").run(this.now(), memberId, body.operationId);
  }
  /** Ops status: counts and key state only (no seeds, no member data). */
  totpStatus() {
    let keyAvailable = false, kid: string | null = null;
    if (this.cfg.totpKeyFile) try { kid = readTotpKey(this.cfg.totpKeyFile).kid; keyAvailable = true; } catch { /* unavailable */ }
    return this.a.read(() => {
      const q = (s: string, ...p: (string | number)[]) => (this.a.db.prepare(s).get(...p) as { n: number }).n;
      return { configured: !!this.cfg.totpKeyFile, keyAvailable, kid, active: q("SELECT COUNT(*) AS n FROM totp_factors WHERE state='active'"),
        pending: q("SELECT COUNT(*) AS n FROM totp_factors WHERE state='pending'"), locked: q("SELECT COUNT(*) AS n FROM totp_factors WHERE state='active' AND locked_at IS NOT NULL"),
        otherKid: kid ? q("SELECT COUNT(*) AS n FROM totp_factors WHERE state='active' AND kid<>?", kid) : 0,
        // R-4: the clock is behind an accepted code by more than one step (verification fails closed until it is fixed).
        clockSkew: q("SELECT COUNT(*) AS n FROM totp_factors WHERE state='active' AND last_counter > ?", totpStep(Date.parse(this.now())) + 1) > 0 };
    });
  }
  auditRows() { return this.a.read(() => this.a.db.prepare("SELECT * FROM access_audit ORDER BY seq").all() as Record<string, unknown>[]); }
}
