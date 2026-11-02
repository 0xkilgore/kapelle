// Lean runtime step 4, stage D: the adopted 1:1 member reply path — SHADOW ONLY (Fable step-4 R-3, R-4, R-5).
//
// R-5 Shadow is STRUCTURAL, not a flag: this module has no transport parameter, no send method and no network access;
// its outbox table's CHECK admits only 'reserved' and 'shadowed' (a 'sent' row cannot exist); the only transition is
// reserved -> shadowed. Enabling real sends is a separate, Fable-gated step (step 5) with a different effect kind.
// R-4 The standing policy is a versioned artifact approved by an admin (`policy.approve`; option A: via Ops until TOTP, artifact digest =
// policy hash). It pins the catalog profile hash, the members reader-policy hash, the caps, `mode: shadow` and the
// step-2 action-table hash; any mismatch with the running host PAUSES replies. Policy hash + profile hash are in every row.
// R-3 Only a verified, accepted intake record from an active member listed in the policy can trigger; Auto-Submitted
// (other than "no"), Precedence bulk/list/junk, our own Message-IDs in References beyond the follow-up cap, STOP,
// the org kill flag and rate caps all refuse. EVERY trigger decision, refusals included, is one journal row; one row
// per intake (UNIQUE), so a crash/redelivery never produces a second reply.
// Generation reads the `members` audience only (the members Q&A agent), and the rendered bytes go only to the member's
// stored verified address (never From/Reply-To; no CC/BCC/Reply-All); headers are model-free.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonical, digest } from "../content.js";
import { assert } from "../validation.js";
import { secretContentFound, READER_POLICY_HASH } from "../agent-kit/scope-assembler.js";
import { ACCESS_TABLE_HASH, AccessError, type Authorization } from "../access/org-access.js";
import type { SqliteAuthority } from "../service/sqlite-authority.js";

export const replyPolicySchema = z.object({
  contract: z.literal("kapelle.member-reply-policy/v1"), version: z.number().int().positive(), mode: z.literal("shadow"),
  // The From display name members see, pinned in the approved policy (never the org id, never model text).
  senderName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 .,'&()-]{0,78}$/),
  // Fable S-1: the policy names MEMBERS, never addresses. The destination is always the member's verified email in
  // access_members (magic-link verified at admission), resolved at approval and again at the would-send recheck.
  members: z.array(z.object({ memberId: z.string().regex(/^m-[0-9a-f-]{36}$/) }).strict()).min(1).max(500),
  sourceAudience: z.literal("members"), catalogProfileHash: z.string().regex(/^sha256:[a-f0-9]{64}$/), readerPolicyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  actionTableHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  caps: z.object({ perMemberPerDay: z.number().int().min(1).max(50), perOrgPerDay: z.number().int().min(1).max(1000), followUps: z.number().int().min(0).max(5), maxChars: z.number().int().min(200).max(4000) }).strict(),
  retentionDays: z.number().int().min(1).max(3650),
}).strict();
export type ReplyPolicy = z.infer<typeof replyPolicySchema>;
export const policyHash = (p: ReplyPolicy) => digest(replyPolicySchema.parse(p));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS member_reply_policy(hash TEXT PRIMARY KEY, json TEXT NOT NULL, approved_by TEXT NOT NULL, approved_at TEXT NOT NULL, active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;
CREATE TABLE IF NOT EXISTS member_reply_state(member_id TEXT PRIMARY KEY, stopped_at TEXT) STRICT;
CREATE TABLE IF NOT EXISTS member_replies(reply_id TEXT PRIMARY KEY, intake_id TEXT NOT NULL UNIQUE, member_id TEXT, decision TEXT NOT NULL CHECK(decision IN ('shadowed','refused','paused')),
  reason TEXT, policy_hash TEXT, policy_version INTEGER, catalog_profile_hash TEXT, at TEXT NOT NULL,
  recipient TEXT, subject TEXT, question_sha256 TEXT, citations TEXT, bytes TEXT, bytes_sha256 TEXT, model TEXT, cost_usd REAL, ledger_session TEXT) STRICT;
-- R-5: a member-reply outbox row can only ever be reserved or shadowed; 'sent' is unrepresentable for this kind.
CREATE TABLE IF NOT EXISTS member_reply_outbox(reply_id TEXT PRIMARY KEY REFERENCES member_replies(reply_id), state TEXT NOT NULL CHECK(state IN ('reserved','shadowed')), at TEXT NOT NULL) STRICT;`;

export type ReplyHost = {
  orgId: string; folder: string; replyDomain: string; catalogProfileHash: () => string;
  memberActive: (memberId: string) => boolean;
  /** The members-audience Q&A (frozen members snapshot, citations validated); returns the answer turn. */
  ask: (memberId: string, question: string) => Promise<{ status: string; answer: string | null; citations: { path: string; startLine: number; valid: boolean }[]; model: string | null; costUsd: number | null }>;
  /** Ledger session ids recorded during the ask (for the audit). */
  ledgerSessions: () => string[];
};

export class MemberReplies {
  private readonly now: () => string;
  constructor(private readonly a: SqliteAuthority, private readonly host: ReplyHost, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString()); a.db.exec(SCHEMA);
    // G-1 columns on a store created before them: the raw answer's hash and the dropped-citation record.
    const cols = (a.db.prepare("PRAGMA table_info(member_replies)").all() as { name: string }[]).map((c) => c.name);
    for (const [c, t] of [["answer_sha256", "TEXT"], ["citations_dropped", "INTEGER"], ["citations_dropped_reasons", "TEXT"]] as const)
      if (!cols.includes(c)) a.db.exec(`ALTER TABLE member_replies ADD COLUMN ${c} ${t}`);
  }
  /** R-4: an admin (option A: Ops) approves the exact policy (artifact digest = its hash); the previous policy is deactivated. */
  approvePolicy(z: Authorization, policy: ReplyPolicy) {
    const parsed = replyPolicySchema.safeParse(policy);
    if (!parsed.success) throw new AccessError("reply_policy_invalid"); // e.g. an address field: policies name members only (S-1)
    const p = parsed.data, h = policyHash(p);
    if (!(z.action === "policy.approve" && z.artifactDigest === h && z.bodyHash === digest(p))) throw new AccessError("reply_policy_approval_mismatch");
    this.a.write(() => {
      for (const m of p.members) if (!this.verifiedAddress(m.memberId)) throw new AccessError("reply_policy_member_not_active");
      this.a.db.prepare("UPDATE member_reply_policy SET active=0 WHERE active=1").run();
      this.a.db.prepare("INSERT INTO member_reply_policy(hash,json,approved_by,approved_at,active) VALUES (?,?,?,?,1) ON CONFLICT(hash) DO UPDATE SET active=1").run(h, canonical(p), z.memberId, this.now());
    });
    return { policyHash: h, version: p.version };
  }
  /** The member's verified email (access_members), or null when the member is not active. */
  private verifiedAddress(memberId: string) {
    return (this.a.db.prepare("SELECT email FROM access_members WHERE member_id=? AND status='active'").get(memberId) as { email: string } | undefined)?.email ?? null;
  }
  setKill(on: boolean) { this.a.write(() => this.a.db.prepare("INSERT INTO access_meta(key,value) VALUES ('replyKill', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(on ? "1" : "0")); }
  private killed() { return (this.a.db.prepare("SELECT value FROM access_meta WHERE key='replyKill'").get() as { value: string } | undefined)?.value === "1"; }
  /** R-4: the approved pins against the running host (catalog profile, reader policy, access table). */
  private pinsMatch(p: ReplyPolicy) {
    return p.catalogProfileHash === this.host.catalogProfileHash() && p.readerPolicyHash === READER_POLICY_HASH && p.actionTableHash === ACCESS_TABLE_HASH;
  }
  /** Ops status (no policy text): is a policy active, and do its pins match this host? A mismatch pauses every trigger
   *  (policy_pin_mismatch) until a policy is re-approved, e.g. after an upgrade that moved the access table hash. */
  policyStatus() {
    const active = this.a.read(() => this.activePolicy());
    return active ? { active: true, pinMatches: this.pinsMatch(active.policy) } : { active: false, pinMatches: null };
  }
  private activePolicy() {
    const r = this.a.db.prepare("SELECT hash, json FROM member_reply_policy WHERE active=1").get() as { hash: string; json: string } | undefined;
    return r ? { hash: r.hash, policy: replyPolicySchema.parse(JSON.parse(r.json)) } : null;
  }
  /** One journal row per trigger decision (refusals included). Idempotent per intake. */
  private journal(intakeId: string, row: Record<string, unknown>) {
    const replyId = "reply_" + createHash("sha256").update(`${this.host.orgId}\0${intakeId}\0reply\0${1}`).digest("hex").slice(0, 32);
    this.a.write(() => {
      if (this.a.db.prepare("SELECT 1 FROM member_replies WHERE intake_id=?").get(intakeId)) return;
      const cols = { reply_id: replyId, intake_id: intakeId, at: this.now(), ...row };
      this.a.db.prepare(`INSERT INTO member_replies(${Object.keys(cols).join(",")}) VALUES (${Object.keys(cols).map(() => "?").join(",")})`).run(...(Object.values(cols) as (string | number | null)[]));
    });
    return replyId;
  }
  existing(intakeId: string) {
    return this.a.read(() => this.a.db.prepare("SELECT r.*, o.state AS outbox FROM member_replies r LEFT JOIN member_reply_outbox o USING(reply_id) WHERE r.intake_id=?").get(intakeId)) as Record<string, unknown> | undefined;
  }

  /** Process one accepted intake (called after the intake commit). Never sends; at most one row per intake. */
  async onIntake(intakeId: string) {
    const prior = this.existing(intakeId);
    if (prior) return prior; // redelivery / crash recovery: the decision already exists, nothing is regenerated
    const rec = this.a.read(() => this.a.db.prepare("SELECT * FROM intake_records WHERE intake_id=?").get(intakeId)) as
      { state: string; installation_id: string; member_id: string | null; message_id: string | null; payload_hash: string; received_at: string; files: string | null } | undefined;
    // P-2(a): a reviewer's web submission is never a reply trigger (no journal row either: there is no email to answer).
    if (rec?.installation_id === "web-reviewer") return undefined as never;
    const refuse = (reason: string, extra: Record<string, unknown> = {}) => { this.journal(intakeId, { decision: "refused", reason, member_id: rec?.member_id ?? null, ...extra }); return this.existing(intakeId)!; };
    if (!rec || rec.state !== "accepted" || !rec.member_id) return refuse("trigger_not_verified_intake");
    const active = this.activePolicy();
    if (!active) return refuse("trigger_no_policy");
    const { hash: pHash, policy } = active, base = { policy_hash: pHash, policy_version: policy.version, catalog_profile_hash: this.host.catalogProfileHash() };
    // R-4: the running host must still match the approved pins; otherwise pause.
    if (!this.pinsMatch(policy)) {
      this.journal(intakeId, { decision: "paused", reason: "policy_pin_mismatch", member_id: rec.member_id, ...base }); return this.existing(intakeId)!;
    }
    if (this.a.read(() => this.killed())) return refuse("trigger_org_killed", base);
    const listed = policy.members.find((m) => m.memberId === rec.member_id);
    const address = this.a.read(() => this.verifiedAddress(rec.member_id!));
    if (!listed || !address || !this.host.memberActive(rec.member_id)) return refuse("trigger_member_not_permitted", base);
    // Content-free trigger checks on the submitted message (headers from the provider-parsed payload's message file).
    const msg = readFileSync(join(this.host.folder, "reviewers-private", "intake", intakeId, "message.md"), "utf8");
    const subject = (/^Subject: (.*)$/m.exec(msg)?.[1] ?? "").replace(/[\r\n]+/g, " ").slice(0, 200);
    const body = msg.split("\n\n").slice(1).join("\n\n").trim();
    const headers = this.headersOf(intakeId);
    const auto = (headers["auto-submitted"] ?? "no").toLowerCase();
    if (auto !== "no") return refuse("trigger_auto_submitted", base);
    if (/^(bulk|list|junk)$/i.test((headers["precedence"] ?? "").trim())) return refuse("trigger_bulk_precedence", base);
    const ours = (headers["references"] ?? "").split(/\s+/).filter((r) => r.includes(`@${this.host.replyDomain}>`)).length;
    if (ours > policy.caps.followUps) return refuse("trigger_follow_up_cap", base);
    if (/^\s*STOP\s*$/i.test(body.split("\n")[0] ?? "")) {
      this.a.write(() => this.a.db.prepare("INSERT INTO member_reply_state(member_id,stopped_at) VALUES (?,?) ON CONFLICT(member_id) DO UPDATE SET stopped_at=excluded.stopped_at").run(rec.member_id, this.now()));
      return refuse("member_stopped", base);
    }
    if (this.a.read(() => this.a.db.prepare("SELECT stopped_at FROM member_reply_state WHERE member_id=? AND stopped_at IS NOT NULL").get(rec.member_id))) return refuse("member_stopped", base);
    const day = this.now().slice(0, 10);
    const count = (w: string, ...p: string[]) => (this.a.read(() => this.a.db.prepare(`SELECT COUNT(*) AS n FROM member_replies WHERE decision='shadowed' AND substr(at,1,10)=? ${w}`).get(day, ...p)) as { n: number }).n;
    if (count("AND member_id=?", rec.member_id) >= policy.caps.perMemberPerDay) return refuse("trigger_member_rate_cap", base);
    if (count("") >= policy.caps.perOrgPerDay) return refuse("trigger_org_rate_cap", base);

    // Reserve (durable) BEFORE generation; a crash leaves 'reserved' and never regenerates (see recoverAtStart).
    const replyId = this.journal(intakeId, { decision: "refused", reason: "generation_in_progress", member_id: rec.member_id, ...base });
    this.a.write(() => this.a.db.prepare("INSERT INTO member_reply_outbox(reply_id,state,at) VALUES (?, 'reserved', ?)").run(replyId, this.now()));
    const before = new Set(this.host.ledgerSessions());
    const turn = await this.host.ask(rec.member_id, body.slice(0, 2000) || subject);
    const sessions = this.host.ledgerSessions().filter((s) => !before.has(s));
    const answer = String(turn.answer ?? "");
    // G-1 (Fable, attempt-4 read-back): "an abstention carries no citation" is a runtime invariant, decided here, before the
    // journal, the grading and the rendering. Heading citations and citations on an abstaining clause support nothing and
    // are dropped; the journal keeps the kept set, how many were dropped and why, and the raw answer's hash.
    const guarded = guardCitations(answer, (turn.citations ?? []) as GuardCitation[], (p) => this.notesLines(p));
    const finish = (decision: "shadowed" | "refused", reason: string | null, extra: Record<string, unknown> = {}) => {
      this.a.write(() => {
        this.a.db.prepare(`UPDATE member_replies SET decision=?, reason=?, recipient=?, subject=?, question_sha256=?, citations=?, model=?, cost_usd=?, ledger_session=?, bytes=?, bytes_sha256=?, at=?,
          answer_sha256=?, citations_dropped=?, citations_dropped_reasons=? WHERE reply_id=?`)
          .run(decision, reason, (extra.recipient as string) ?? null, subject, createHash("sha256").update(body).digest("hex"), JSON.stringify(guarded.kept), turn.model, turn.costUsd,
            sessions.join(",") || null, (extra.bytes as string) ?? null, (extra.bytesSha as string) ?? null, this.now(),
            answer ? createHash("sha256").update(answer).digest("hex") : null, guarded.dropped.length, JSON.stringify(guarded.dropped.map((d) => d.reason)), replyId);
        if (decision === "shadowed") this.a.db.prepare("UPDATE member_reply_outbox SET state='shadowed', at=? WHERE reply_id=? AND state='reserved'").run(this.now(), replyId);
      });
      return this.existing(intakeId)!;
    };
    if (turn.status !== "ANSWERED" || !answer.trim()) return finish("refused", "reply_not_answered");
    if (secretContentFound(answer)) return finish("refused", "reply_secret_content");
    if (/https?:\/\/|<[a-z][^>]*>|\bwww\./i.test(answer)) return finish("refused", "reply_link_or_markup");
    // No addresses in reply text: a source (or a manipulated model) cannot steer the member toward another recipient.
    if (/[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}/i.test(answer)) return finish("refused", "reply_contains_address");
    if (answer.length > policy.caps.maxChars) return finish("refused", "reply_too_long");
    if ((turn.citations ?? []).some((c) => !c.valid)) return finish("refused", "reply_citation_invalid");
    // Recheck immediately before the would-send point: membership, kill flag and the policy itself.
    const still = this.activePolicy(), now = this.a.read(() => this.verifiedAddress(rec.member_id!));
    if (!this.host.memberActive(rec.member_id) || this.a.read(() => this.killed()) || !still || still.hash !== pHash || now !== address) return finish("refused", "recheck_failed");
    const bytes = renderReply({ senderName: policy.senderName, replyId, replyDomain: this.host.replyDomain, to: now, subject, inReplyTo: rec.message_id ?? "", text: answer,
      citations: guarded.kept.filter((c) => c.valid).map((c) => ({ path: c.path })), date: this.now() });
    return finish("shadowed", null, { recipient: now, bytes, bytesSha: createHash("sha256").update(bytes).digest("hex") });
  }
  /** The lines of one approved member notes file (immutable versions), or null for anything else. */
  private notesLines(path: string) {
    if (!/^\d{4}-\d{2}-\d{2}\.v\d+\.md$/.test(path)) return null;
    try { return readFileSync(join(this.host.folder, "members", "notes", path), "utf8").split("\n"); } catch { return null; }
  }
  /** At start-up: a reservation whose generation was interrupted is closed, never regenerated (one reply per trigger). */
  recoverAtStart() {
    this.a.write(() => {
      for (const r of this.a.db.prepare("SELECT reply_id FROM member_reply_outbox WHERE state='reserved'").all() as { reply_id: string }[])
        this.a.db.prepare("UPDATE member_replies SET decision='refused', reason='reply_interrupted_not_regenerated', at=? WHERE reply_id=? AND decision='refused' AND reason='generation_in_progress'").run(this.now(), r.reply_id);
    });
  }
  /** Start-up sweep: an accepted intake whose decision never got journalled (crash between the intake commit and the
   *  trigger) is processed exactly once now, so every trigger ends with a journal row. Returns the intake ids swept. */
  async resumeAtStart() {
    this.recoverAtStart();
    const missing = this.a.read(() => this.a.db.prepare(`SELECT i.intake_id FROM intake_records i LEFT JOIN member_replies r ON r.intake_id = i.intake_id
      WHERE i.state='accepted' AND r.intake_id IS NULL AND i.installation_id <> 'web-reviewer' ORDER BY i.received_at, i.intake_id`).all()) as { intake_id: string }[];
    for (const m of missing) await this.onIntake(m.intake_id);
    return missing.map((m) => m.intake_id);
  }
  private headersOf(intakeId: string): Record<string, string> {
    const rec = this.a.db.prepare("SELECT files FROM intake_records WHERE intake_id=?").get(intakeId) as { files: string | null } | undefined;
    const h = rec?.files ? (JSON.parse(rec.files).headers ?? {}) : {};
    return Object.fromEntries(Object.entries(h as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
  }
  /** Audience-filtered audit (spec §4): reviewers/admins see every row; a member sees only their own. Bytes stay here. */
  audit(viewer: { memberId: string; role: string }) {
    const rows = this.a.read(() => this.a.db.prepare("SELECT r.*, o.state AS outbox FROM member_replies r LEFT JOIN member_reply_outbox o USING(reply_id) ORDER BY r.at").all()) as Record<string, unknown>[];
    return ["admin", "reviewer"].includes(viewer.role) ? rows : rows.filter((r) => r.member_id === viewer.memberId);
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-08.v1.md" -> "Oct 8, 2026 meeting notes" (deterministic; no locale). Anything else -> "the approved notes". */
export function notesSourceName(path: string) {
  const m = /(\d{4})-(\d{2})-(\d{2})\.v(\d+)\.md$/.exec(path);
  if (!m || +m[2] < 1 || +m[2] > 12) return "the approved notes";
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]} meeting notes${m[4] !== "1" ? ` (version ${+m[4]})` : ""}`;
}
/** A clause that says the notes can't answer (live attempt 3: a real model abstained AND cited the notes' title line). */
export const ABSTENTION = /\b(?:can['\u2019]t|can ?not|am unable to|unable to) answer\b|\bnotes\s+(?:do(?:es)?\s+not|do(?:es)?n['\u2019]t)\s+(?:say|mention|cover|include)\b/i;
const MARKER = /\[[^\]\s]+\.md#L\d+(?:-L?\d+)?\]/g;
/** F-6: does any citation marker support a FACT? Each marker belongs to the clause just before it (clauses end at . ! ? ;
 *  or a ", but"/" but" join); a marker on an abstaining clause supports nothing. So "I can't answer X, but the cleanup is on
 *  Oct 31 [L2]" keeps its Source line, while "I can't answer that from the notes. [L1]" gets none. */
export type GuardCitation = { path: string; startLine: number; endLine: number; sha256?: string | null; valid: boolean };
/** Fable G-1: which citations support a stated fact. Each marker belongs to the clause just before it (the F-6 rule). A
 *  citation is dropped when every line it cites is a heading (`#`; headings are never facts) or when every occurrence of it
 *  sits on an abstaining clause. Deterministic and content-free: the reasons are fixed tags. */
export function guardCitations(text: string, citations: GuardCitation[], lines: (path: string) => string[] | null) {
  const support = new Map<string, boolean>(), clauseOf = (i: number) => (text.slice(0, i).replace(/[\s.!?;,]+$/, "").split(/[.!?;]|,?\s+but\s+/i).pop() ?? "");
  for (const m of text.matchAll(/\[([^\]\s#][^\]#]{0,400})#L(\d{1,6})(?:-L?(\d{1,6}))?\]/g)) {
    const key = `${m[1]}#${Number(m[2])}-${Number(m[3] ?? m[2])}`, clause = clauseOf(m.index!);
    support.set(key, (support.get(key) ?? false) || (!!clause.trim() && !ABSTENTION.test(clause)));
  }
  const kept: GuardCitation[] = [], dropped: (GuardCitation & { reason: "heading" | "abstention" })[] = [];
  for (const c of citations) {
    const l = lines(c.path), span = l ? l.slice(c.startLine - 1, c.endLine) : [];
    if (span.length && span.every((x) => /^\s*#/.test(x))) { dropped.push({ ...c, reason: "heading" }); continue; }
    if (!support.get(`${c.path}#${c.startLine}-${c.endLine}`)) { dropped.push({ ...c, reason: "abstention" }); continue; }
    kept.push(c);
  }
  return { kept, dropped };
}
export function citesAFact(text: string) {
  for (const m of text.matchAll(MARKER)) {
    const before = text.slice(0, m.index).replace(/[\s.!?;,]+$/, "");
    const clause = before.split(/[.!?;]|,?\s+but\s+/i).pop() ?? "";
    if (clause.trim() && !ABSTENTION.test(clause)) return true;
  }
  return false;
}
/** The member-facing body: the answer without the machine citation markers, then one plain source line per cited notes file.
 *  (The markers stay in the journal's `citations`; the checks above ran on the raw answer.) Belt and braces behind the
 *  prompt rule: a Source line only when a citation supports a stated fact, never for an abstention, whatever it cited. */
export function replyBody(text: string, citations: { path: string }[]) {
  const body = text.replace(/\s*\[[^\]\s]+\.md#L\d+(?:-L?\d+)?\]/g, "").replace(/[ \t]+\n/g, "\n").trim();
  const sources = citesAFact(text) ? [...new Set(citations.map((c) => notesSourceName(c.path)))] : [];
  return sources.length ? `${body}\n\nSource: ${sources.join("; ")}` : body;
}
/** Model-free RFC 5322 rendering: plain text, stored recipient only, threading bound to the validated intake Message-ID. */
export function renderReply(r: { senderName: string; replyId: string; replyDomain: string; to: string; subject: string; inReplyTo: string; text: string; citations: { path: string }[]; date: string }) {
  const safe = (s: string) => s.replace(/[\r\n]+/g, " ").slice(0, 900);
  const subject = /^re:/i.test(r.subject) ? r.subject : `Re: ${r.subject}`;
  const inReply = /^<[^<>\s]{3,900}>$/.test(r.inReplyTo) ? r.inReplyTo : null;
  return [
    `From: "${safe(r.senderName).replace(/["\\]/g, "")}" <agent@${r.replyDomain}>`, `To: <${safe(r.to)}>`, `Subject: ${safe(subject)}`,
    `Message-ID: <${r.replyId}@${r.replyDomain}>`, ...(inReply ? [`In-Reply-To: ${inReply}`, `References: ${inReply}`] : []),
    `Date: ${new Date(r.date).toUTCString()}`, "Auto-Submitted: auto-replied", "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit", "", replyBody(r.text, r.citations).replace(/\r?\n/g, "\r\n"), "",
  ].join("\r\n");
}
export const newReplyPolicyId = () => randomUUID();
