// Lean runtime step 4, stage B: email intake at the org runtime (Fable step-4 R-1, R-2) and the two audience roots.
//
// R-1 The (fake) provider signs HMAC-SHA256 per channelInstallationId over `id.timestamp.installationId.body` (the body
//     carries the envelope recipient). The hub verifies first (non-authoritative) and forwards the RAW signed bytes; this
//     runtime re-verifies them with its own copy of that installation's secret. The intake key
//     (orgId, channelInstallationId, providerEventId) is the replay guard: identical payload -> the same record, a
//     different payload under the same key -> refused.
// R-2 Intake tokens are per member AND per installation, independently revocable, stored as hashes. Only the ENVELOPE
//     recipient (data.to, our org's intake domain) counts; a token quoted or forwarded in the body is ignored. A token
//     from another org/installation never resolves here, even for the same human. Tokens attribute submissions only.
// Unknown/revoked/ambiguous submissions are QUARANTINED: metadata only (no body kept), capped by count and bytes with an
// audited eviction; no model call, Task, reply or echo. Accepted submissions become immutable files under
// <orgFolder>/reviewers-private/intake/<intakeId>/ (never `members/`).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { assert } from "../validation.js";
import { verifySvix, resendReceivedSchema, resendToIntake, resendRecipients, type ResendContentPort } from "./resend-inbound.js";
import type { SqliteAuthority } from "../service/sqlite-authority.js";
import { refuseWebsiteRoot } from "./website/content-root.js";

export const AUDIENCES = ["members", "reviewers-private"] as const;
export type Audience = (typeof AUDIENCES)[number];
export class IntakeError extends Error { constructor(readonly reason: string) { super(reason); this.name = "IntakeError"; } }
const refuse = (ok: unknown, reason: string): void => { if (!ok) throw new IntakeError(reason); };
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
export const QUARANTINE_CAPS = { rows: 500, bytes: 5 * 1024 * 1024 };
/** P-2(a) (Director 2026-10-16, Fable CP prod pre-review): a reviewer's web text submission is an intake KIND under this fixed
 *  pseudo-installation. It is never a reply trigger (no email, no recipient, no member reply). */
export const WEB_INSTALLATION = "web-reviewer";
export const WEB_SUBMISSION_MAX_BYTES = 48 * 1024;
const TEXT_TYPES = ["text/plain", "text/markdown"];

/** The fake provider's signature (both the hub and the runtime verify it). */
export function signWebhook(secret: string, installationId: string, id: string, timestamp: string, body: string) {
  return "v1," + createHmac("sha256", secret).update(`${id}.${timestamp}.${installationId}.${body}`).digest("base64");
}
export function verifyWebhook(secret: string, installationId: string, h: { id?: string; timestamp?: string; signature?: string }, body: string, nowMs: number) {
  refuse(typeof h.id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(h.id) && typeof h.timestamp === "string" && /^\d{9,12}$/.test(h.timestamp) && typeof h.signature === "string", "intake_signature_missing");
  refuse(Math.abs(nowMs / 1000 - Number(h.timestamp)) <= 300, "intake_signature_stale");
  const want = Buffer.from(signWebhook(secret, installationId, h.id!, h.timestamp!, body));
  const got = h.signature!.split(" ").map((s) => Buffer.from(s));
  refuse(got.some((g) => g.length === want.length && timingSafeEqual(g, want)), "intake_signature_invalid");
}

const payloadSchema = z.object({
  type: z.literal("email.received"),
  data: z.object({
    email_id: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/),
    message_id: z.string().max(998),
    from: z.string().max(998), to: z.array(z.string().max(320)).min(1).max(50), cc: z.array(z.string().max(320)).max(50).optional(),
    subject: z.string().max(998), text: z.string().max(256 * 1024).optional(), html: z.string().max(512 * 1024).optional(),
    headers: z.record(z.string(), z.string().max(998)).optional(),
    attachments: z.array(z.object({ filename: z.string().max(255), content_type: z.string().max(255), content: z.string().max(400_000) })).max(20).optional(),
  }).passthrough(),
}).passthrough();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS intake_tokens(token_hash TEXT PRIMARY KEY, member_id TEXT NOT NULL, installation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')), created_at TEXT NOT NULL, revoked_at TEXT) STRICT;
CREATE TABLE IF NOT EXISTS intake_records(intake_id TEXT PRIMARY KEY CHECK(intake_id GLOB 'intake_*'), installation_id TEXT NOT NULL, provider_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('accepted','quarantined')), reason TEXT, member_id TEXT, message_id TEXT,
  bytes INTEGER NOT NULL, received_at TEXT NOT NULL, files TEXT, UNIQUE(installation_id, provider_event_id)) STRICT;
CREATE TABLE IF NOT EXISTS intake_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, event TEXT NOT NULL, intake_id TEXT, detail TEXT) STRICT;`;

/** Only the content-free headers the reply-trigger rules need are kept (bounded). */
const TRIGGER_HEADERS = ["auto-submitted", "precedence", "references", "in-reply-to", "list-id"];
function triggerHeaders(h: Record<string, string>) {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).slice(0, 998)]).filter(([k]) => TRIGGER_HEADERS.includes(k)));
}
/** provider 'fake' (tests/local) or 'resend' (Svix-signed metadata webhook + content port). */
export type IntakeInstallation = { installationId: string; secret: string; domain: string; provider?: "fake" | "resend"; resend?: ResendContentPort };
export class OrgIntake {
  private readonly now: () => string;
  constructor(private readonly a: SqliteAuthority, private readonly cfg: { orgId: string; folder: string; installations: IntakeInstallation[] }, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString());
    a.db.exec(SCHEMA);
    // The folder skeleton, including the two standing agents' scopes: members can ask before the first notes exist.
    for (const d of [...AUDIENCES, "members/notes", "reviewers-private/intake"]) mkdirSync(join(cfg.folder, d), { recursive: true, mode: 0o700 });
    const st = lstatSync(cfg.folder);
    assert(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && !cfg.folder.includes("/Dropbox/"), "org_folder_not_private");
  }
  providerOf(installationId: string) { return this.installation(installationId).provider ?? "fake"; }
  /** P-1: `--intake none` has no email installation: every email-intake path refuses with intake_not_configured. */
  get emailConfigured() { return this.cfg.installations.length > 0; }
  private installation(id: string) {
    refuse(this.cfg.installations.length > 0, "intake_not_configured");
    const i = this.cfg.installations.find((x) => x.installationId === id); refuse(i, "intake_installation_unknown"); return i!; }
  /** P-2(a): a reviewer submits meeting notes as text (pasted, or a .md/.txt file read in the browser). Stored exactly like an
   *  accepted email's message (reviewers-private/intake/<id>/message.md + an accepted record), attributed to the member,
   *  untrusted content. A repeated clientRequestId with the same content returns the same record; different content refused. */
  submitWeb(memberId: string, b: { clientRequestId?: unknown; title?: unknown; text?: unknown; fileName?: unknown }) {
    refuse(typeof b?.clientRequestId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(b.clientRequestId), "intake_client_request_invalid");
    const clean = (v: string) => v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    refuse(b.fileName === undefined || (typeof b.fileName === "string" && /^[^/\\\u0000-\u001f]{1,120}\.(md|txt)$/i.test(b.fileName)), "intake_file_type_not_admitted");
    refuse(typeof b.text === "string", "intake_text_required");
    const text = clean(b.text as string).trim();
    refuse(text.length > 0, "intake_text_required");
    refuse(Buffer.byteLength(text) <= WEB_SUBMISSION_MAX_BYTES, "intake_text_too_large");
    const fallback = typeof b.fileName === "string" ? b.fileName.replace(/\.(md|txt)$/i, "") : "Meeting notes";
    const title = (typeof b.title === "string" && clean(b.title).replace(/\n/g, " ").trim() ? clean(b.title).replace(/\n/g, " ").trim() : fallback).slice(0, 200);
    const message = `Subject: ${title}\n\n${text}\n`, eventId = b.clientRequestId as string, payloadHash = sha(message);
    const intakeId = "intake_" + sha(`${this.cfg.orgId}\0${WEB_INSTALLATION}\0${memberId}\0${eventId}`).slice(0, 32);
    const prior = this.a.read(() => this.a.db.prepare("SELECT intake_id, payload_hash FROM intake_records WHERE installation_id=? AND provider_event_id=?").get(WEB_INSTALLATION, `${memberId}:${eventId}`)) as
      { intake_id: string; payload_hash: string } | undefined;
    if (prior) { refuse(prior.payload_hash === payloadHash, "intake_payload_conflict"); return { intakeId: prior.intake_id, state: "accepted", replayed: true }; }
    const dir = join(this.cfg.folder, "reviewers-private", "intake", intakeId);
    refuseWebsiteRoot(this.cfg.folder, dir, (l) => new IntakeError(l)); // Fable R-2
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = join(dir, "message.md"), content = Buffer.from(message);
    if (existsSync(p)) refuse(sha(readFileSync(p)) === sha(content), "intake_file_changed"); else writeFileSync(p, content, { mode: 0o600, flag: "wx" });
    this.a.write(() => {
      this.a.db.prepare("INSERT INTO intake_records(intake_id,installation_id,provider_event_id,payload_hash,state,reason,member_id,message_id,bytes,received_at,files) VALUES (?,?,?,?, 'accepted', NULL, ?, NULL, ?, ?, ?)")
        .run(intakeId, WEB_INSTALLATION, `${memberId}:${eventId}`, payloadHash, memberId, content.length, this.now(),
          JSON.stringify({ files: [{ name: "message.md", sha256: sha(content), bytes: content.length }], refused: [], headers: {}, kind: "web", ...(typeof b.fileName === "string" ? { fileName: b.fileName } : {}) }));
      this.a.db.prepare("INSERT INTO intake_audit(at,event,intake_id,detail) VALUES (?, 'web_submission', ?, ?)").run(this.now(), intakeId, `bytes=${content.length}`);
    });
    return { intakeId, state: "accepted", replayed: false };
  }
  /** Routine (member, authenticated session): issue this member's token for one installation, revoking the previous one. */
  issueToken(memberId: string, installationId: string) {
    const inst = this.installation(installationId), token = randomBytes(24).toString("base64url").replace(/[^A-Za-z0-9]/g, "x");
    this.a.write(() => {
      this.a.db.prepare("UPDATE intake_tokens SET status='revoked', revoked_at=? WHERE member_id=? AND installation_id=? AND status='active'").run(this.now(), memberId, installationId);
      this.a.db.prepare("INSERT INTO intake_tokens(token_hash,member_id,installation_id,status,created_at) VALUES (?,?,?, 'active', ?)").run(sha(token), memberId, installationId, this.now());
    });
    return { address: `intake+${token}@${inst.domain}` };
  }
  revokeTokens(memberId: string, installationId?: string) {
    this.a.write(() => this.a.db.prepare(`UPDATE intake_tokens SET status='revoked', revoked_at=? WHERE member_id=? AND status='active' ${installationId ? "AND installation_id=?" : ""}`)
      .run(...([this.now(), memberId, ...(installationId ? [installationId] : [])] as [string, string])));
  }
  /** Accept one signed delivery. Returns the intake record (new or replayed); never echoes content. */
  /** Fake-provider delivery (the full message is in the signed body). */
  receive(installationId: string, headers: { id?: string; timestamp?: string; signature?: string }, rawBody: string, memberActive: (memberId: string) => boolean) {
    const inst = this.installation(installationId);
    refuse((inst.provider ?? "fake") === "fake", "intake_provider_mismatch");
    verifyWebhook(inst.secret, installationId, headers, rawBody, Date.parse(this.now()));
    refuse(Buffer.byteLength(rawBody) <= 2 * 1024 * 1024, "intake_payload_too_large");
    let parsed: z.infer<typeof payloadSchema>;
    try { parsed = payloadSchema.parse(JSON.parse(rawBody)); } catch { throw new IntakeError("intake_payload_malformed"); }
    return this.accept(inst, sha(rawBody), Buffer.byteLength(rawBody), parsed.data, memberActive);
  }
  /** Resend delivery: re-verify the Svix-signed RAW bytes here (R-1), then fetch content through the port. The replay
   *  key is Resend's email_id; a Svix retry carries the same body, so it replays to the same record. */
  async receiveResend(installationId: string, headers: { id?: string; timestamp?: string; signature?: string }, rawBody: string, memberActive: (memberId: string) => boolean) {
    const inst = this.installation(installationId);
    refuse(inst.provider === "resend" && inst.resend, "intake_provider_mismatch");
    verifySvix(inst.secret, headers, rawBody, Date.parse(this.now()));
    refuse(Buffer.byteLength(rawBody) <= 256 * 1024, "intake_payload_too_large");
    let event;
    try { event = resendReceivedSchema.parse(JSON.parse(rawBody)); } catch { throw new IntakeError("intake_payload_malformed"); }
    // A replay never refetches content: the record decides first.
    const prior = this.a.read(() => this.a.db.prepare("SELECT intake_id, payload_hash, state FROM intake_records WHERE installation_id=? AND provider_event_id=?").get(installationId, event.data.email_id)) as
      { intake_id: string; payload_hash: string; state: string } | undefined;
    if (prior) { refuse(prior.payload_hash === sha(rawBody), "intake_payload_conflict"); return { intakeId: prior.intake_id, state: prior.state, replayed: true }; }
    // Misaddressed / unknown / revoked: quarantined from webhook metadata alone; content is never fetched.
    const to = resendRecipients(event.data);
    if (this.recipient(inst, to, memberActive).reason)
      return this.accept(inst, sha(rawBody), Buffer.byteLength(rawBody), { email_id: event.data.email_id, message_id: "", from: event.data.from, to, cc: [], subject: "", text: "", headers: {}, attachments: [] }, memberActive);
    const normalized = payloadSchema.parse(await resendToIntake(event, inst.resend!));
    return this.accept(inst, sha(rawBody), Buffer.byteLength(rawBody), normalized.data, memberActive);
  }
  /** R-2: the envelope recipient only (exactly one address at this installation's domain); quoted/forwarded text is ignored.
   *  Domain compared case-insensitively; the local part (the token) is case-sensitive and kept as delivered. */
  private recipient(inst: IntakeInstallation, to: string[], memberActive: (memberId: string) => boolean) {
    const installationId = inst.installationId;
    const ours = to.map((t) => t.trim()).filter((t) => t.toLowerCase().endsWith("@" + inst.domain.toLowerCase()));
    let reason: string | null = null, memberId: string | null = null;
    const m = ours.length === 1 ? /^intake\+([A-Za-z0-9]{16,64})@/.exec(ours[0]) : null;
    if (!m) reason = ours.length === 0 ? "intake_not_addressed_here" : ours.length > 1 ? "intake_recipient_ambiguous" : "intake_token_missing";
    else {
      const t = this.a.read(() => this.a.db.prepare("SELECT member_id, installation_id, status FROM intake_tokens WHERE token_hash=?").get(sha(m[1]))) as
        { member_id: string; installation_id: string; status: string } | undefined;
      if (!t || t.installation_id !== installationId) reason = "intake_token_unknown";
      else if (t.status !== "active") reason = "intake_token_revoked";
      else if (!memberActive(t.member_id)) reason = "intake_member_inactive";
      else memberId = t.member_id;
    }
    return { reason, memberId };
  }
  private accept(inst: IntakeInstallation, payloadHash: string, bytes: number, d: z.infer<typeof payloadSchema>["data"], memberActive: (memberId: string) => boolean) {
    const installationId = inst.installationId, eventId = d.email_id;
    const intakeId = "intake_" + sha(`${this.cfg.orgId}\0${installationId}\0${eventId}`).slice(0, 32);
    // Replay guard first: the same event id with the same bytes is the same record; different bytes are refused.
    const prior = this.a.read(() => this.a.db.prepare("SELECT * FROM intake_records WHERE installation_id=? AND provider_event_id=?").get(installationId, eventId)) as
      { intake_id: string; payload_hash: string; state: string; reason: string | null; member_id: string | null } | undefined;
    if (prior) { refuse(prior.payload_hash === payloadHash, "intake_payload_conflict"); return { intakeId: prior.intake_id, state: prior.state, replayed: true }; }
    const { reason, memberId } = this.recipient(inst, d.to, memberActive);
    if (reason) {
      this.a.write(() => {
        this.a.db.prepare("INSERT INTO intake_records(intake_id,installation_id,provider_event_id,payload_hash,state,reason,member_id,message_id,bytes,received_at,files) VALUES (?,?,?,?, 'quarantined', ?, NULL, NULL, ?, ?, NULL)")
          .run(intakeId, installationId, eventId, payloadHash, reason, bytes, this.now());
        this.evictQuarantine();
      });
      return { intakeId, state: "quarantined", replayed: false };
    }
    // Accepted: immutable files under reviewers-private/intake/<intakeId>/ (deterministic paths; a redelivery after a crash rewrites identical bytes).
    const dir = join(this.cfg.folder, "reviewers-private", "intake", intakeId);
    refuseWebsiteRoot(this.cfg.folder, dir, (l) => new IntakeError(l)); // Fable R-2
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files: { name: string; sha256: string; bytes: number }[] = [], refused: { name: string; reason: string }[] = [];
    const put = (name: string, content: Buffer) => {
      const p = join(dir, name);
      if (existsSync(p)) refuse(sha(readFileSync(p)) === sha(content), "intake_file_changed");
      else writeFileSync(p, content, { mode: 0o600, flag: "wx" });
      files.push({ name, sha256: sha(content), bytes: content.length });
    };
    put("message.md", Buffer.from(`Subject: ${d.subject.replace(/[\r\n]+/g, " ")}\n\n${d.text ?? ""}`));
    for (const [i, att] of (d.attachments ?? []).entries()) {
      const name = `attachment-${i + 1}-${att.filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}`, content = Buffer.from(att.content, "base64");
      if (!TEXT_TYPES.includes(att.content_type.split(";")[0].trim().toLowerCase())) refused.push({ name, reason: "intake_attachment_type_not_admitted" });
      else if (content.length > 256 * 1024) refused.push({ name, reason: "intake_attachment_too_large" });
      else put(name + (/\.(md|txt)$/i.test(name) ? "" : ".txt"), content);
    }
    this.a.write(() => {
      this.a.db.prepare("INSERT INTO intake_records(intake_id,installation_id,provider_event_id,payload_hash,state,reason,member_id,message_id,bytes,received_at,files) VALUES (?,?,?,?, 'accepted', NULL, ?, ?, ?, ?, ?)")
        .run(intakeId, installationId, eventId, payloadHash, memberId, d.message_id, bytes, this.now(), JSON.stringify({ files, refused, headers: triggerHeaders(d.headers ?? {}) }));
    });
    return { intakeId, state: "accepted", replayed: false };
  }
  /** Quarantine caps by count and bytes; evict oldest, auditing each eviction (metadata only is ever kept). */
  private evictQuarantine() {
    for (;;) {
      const s = this.a.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM intake_records WHERE state='quarantined'").get() as { n: number; b: number };
      if (s.n <= QUARANTINE_CAPS.rows && s.b <= QUARANTINE_CAPS.bytes) return;
      const oldest = this.a.db.prepare("SELECT intake_id FROM intake_records WHERE state='quarantined' ORDER BY received_at, intake_id LIMIT 1").get() as { intake_id: string };
      this.a.db.prepare("DELETE FROM intake_records WHERE intake_id=?").run(oldest.intake_id);
      this.a.db.prepare("INSERT INTO intake_audit(at,event,intake_id,detail) VALUES (?, 'quarantine_evicted', ?, ?)").run(this.now(), oldest.intake_id, `cap rows=${QUARANTINE_CAPS.rows} bytes=${QUARANTINE_CAPS.bytes}`);
    }
  }
  /** Fable non-blocking: a crash after the intake files were written but before the record committed leaves an orphan
   *  directory. Start-up moves each orphan OUT of the snapshot-able intake tree into reviewers-private/.orphans/ (never
   *  deleted, never in a member audience) and audits it; a redelivery re-creates the record and files normally. */
  sweepOrphans() {
    const intakeDir = join(this.cfg.folder, "reviewers-private", "intake");
    if (!existsSync(intakeDir)) return [];
    const known = new Set((this.a.read(() => this.a.db.prepare("SELECT intake_id FROM intake_records WHERE state='accepted'").all()) as { intake_id: string }[]).map((r) => r.intake_id));
    const moved: string[] = [];
    for (const d of readdirSync(intakeDir)) {
      if (!/^intake_[a-f0-9]{32}$/.test(d) || known.has(d)) continue;
      const dest = join(this.cfg.folder, "reviewers-private", ".orphans"); mkdirSync(dest, { recursive: true, mode: 0o700 });
      renameSync(join(intakeDir, d), join(dest, `${d}-${Date.parse(this.now())}`));
      this.a.write(() => this.a.db.prepare("INSERT INTO intake_audit(at,event,intake_id,detail) VALUES (?, 'orphan_swept', ?, 'files without a committed record')").run(this.now(), d));
      moved.push(d);
    }
    return moved;
  }
  record(intakeId: string) { return this.a.read(() => this.a.db.prepare("SELECT * FROM intake_records WHERE intake_id=?").get(intakeId)) as Record<string, unknown> | undefined; }
  quarantined() { return this.a.read(() => this.a.db.prepare("SELECT intake_id, reason, bytes FROM intake_records WHERE state='quarantined' ORDER BY received_at").all()) as Record<string, unknown>[]; }
}
