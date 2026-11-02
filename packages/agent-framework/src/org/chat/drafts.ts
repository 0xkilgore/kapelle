// Chat agent C-5 (PLAN-SLICE-1 §6, Fable §12(a) E-1..E-6): the DRAFT ENVELOPE. A drafting request is shown as a plan card;
// the conversation's starter approves it with chat.draft.approve (session-fresh, receipt); that Authorization opens ONE
// envelope on the conversation, inside which turns may also call write_draft_artifact and render_newsletter_preview.
// - E-1 The card is canonical {capability, scopeRoots, snapshotHash, profileHash, toolCatalogHash, caps, expiresAt}; the
//   approval's artifact digest IS digest(card), and the body carries the card itself, so the body hash covers it too.
// - E-2 One envelope per approval operationId (UNIQUE); a replay of the approval returns the same envelope. Turns inside
//   it count down; exhausted (turns or $), expired (24 h) or closed -> a new card.
// - E-3 The snapshot is PINNED: an envelope turn's snapshot must hash to the card's snapshotHash, else the envelope closes
//   (chat_draft_snapshot_changed) and the turn runs as plain Q&A; a source or scope change is a new card.
// - E-4 A native org Task (sourceRef chat:<conversationId>#<envelopeId>) is created under the SAME operationId (the attribution
//   join), then the envelope row names it. The Task command is idempotent on the operationId, so a crash between the two
//   completes on the retried approval (no second step-up, R-3).
// - E-5 lives in the tools (every version records envelope/turn/snapshot/renderer/sha; sources must resolve).
// - E-6 The envelope grants TOOLS only. Nothing reads it as authority for an effect (no effect tool exists in slice 1).
import { createHash } from "node:crypto";
import { z } from "zod";
import { digest } from "../../content.js";
import { AccessError, type Authorization } from "../../access/org-access.js";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import type { ChatScope } from "./conversations.js";
import { takeSnapshot, type DraftEnvelope } from "./tools.js";

/** Envelope budget (placeholder, Director to confirm): up to 5 drafting turns and $2 per approved plan, within the per-turn
 *  caps and the org's monthly cap. */
export const ENVELOPE_CAPS = Object.freeze({ turns: 5, usd: 2 });
export const ENVELOPE_HOURS = 24;
const sha = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const draftCardSchema = z.object({
  contract: z.literal("kapelle.chat-draft-card/v1"), conversationId: z.string().regex(/^conv_[a-f0-9]{32}$/),
  capability: z.enum(["newsletter", "agenda"]), scopeRoots: z.array(z.string().min(1).max(300)).min(1).max(8),
  snapshotHash: sha, profileHash: sha, toolCatalogHash: sha,
  caps: z.object({ turns: z.number().int().min(1).max(10), usd: z.number().positive().max(5), requestsPerTurn: z.number().int().min(1).max(6), toolsPerTurn: z.number().int().min(0).max(12) }).strict(),
  expiresAt: z.string().datetime(),
}).strict();
export type DraftCard = z.infer<typeof draftCardSchema>;
export const cardHash = (c: DraftCard) => digest(draftCardSchema.parse(c));

export class ChatDrafts {
  constructor(private readonly a: SqliteAuthority, private readonly o: { orgId: string; folder: string; profileHash: string; toolCatalogHash: string; turnCaps: { requests: number; toolCalls: number };
    conversation: (memberId: string, conversationId: unknown) => { id: string; scope: ChatScope; deleted_at: string | null };
    createTask: (z: Authorization, b: { documentKey: string; title: string; sourceRef: string }) => Promise<{ taskId: string; accepted: boolean }> },
    private readonly now: () => string = () => new Date().toISOString()) {
    a.db.exec(`CREATE TABLE IF NOT EXISTS chat_envelopes(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, operation_id TEXT NOT NULL UNIQUE,
        card_hash TEXT NOT NULL, capability TEXT NOT NULL, snapshot_hash TEXT NOT NULL, budget_usd REAL NOT NULL, turns INTEGER NOT NULL, expires_at TEXT NOT NULL,
        task_id TEXT NOT NULL, created_at TEXT NOT NULL, closed_at TEXT, closed_reason TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS chat_envelope_turns(turn_id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL) STRICT;`);
  }
  /** Routine: the plan card for a drafting request in the member's own conversation (computed here, never by the model). */
  card(memberId: string, b: { conversationId?: unknown; capability?: unknown }) {
    const c = this.o.conversation(memberId, b?.conversationId);
    if (c.deleted_at) throw new AccessError("chat_conversation_unknown");
    if (b.capability !== "newsletter" && b.capability !== "agenda") throw new AccessError("chat_draft_capability_invalid");
    const snap = takeSnapshot(this.o.folder, c.scope, memberId, c.id);
    const card: DraftCard = { contract: "kapelle.chat-draft-card/v1", conversationId: c.id, capability: b.capability, scopeRoots: snap.roots, snapshotHash: snap.hash,
      profileHash: this.o.profileHash, toolCatalogHash: this.o.toolCatalogHash,
      caps: { turns: ENVELOPE_CAPS.turns, usd: ENVELOPE_CAPS.usd, requestsPerTurn: this.o.turnCaps.requests, toolsPerTurn: this.o.turnCaps.toolCalls },
      expiresAt: new Date(Date.parse(this.now()) + ENVELOPE_HOURS * 3_600_000).toISOString() };
    return { card, cardHash: cardHash(card), files: snap.files.size };
  }
  /** Consequential (session-fresh): approve exactly this card. Returns the envelope (the same one on a replay). */
  async approve(z: Authorization, b: { card?: unknown }) {
    const p = draftCardSchema.safeParse(b?.card);
    if (!p.success) throw new AccessError("chat_draft_card_invalid");
    const card = p.data, h = cardHash(card);
    if (!z.artifactDigest || z.artifactDigest !== h) throw new AccessError("chat_draft_digest_mismatch"); // E-1
    const envelopeId = "env_" + createHash("sha256").update(`${this.o.orgId}\0${z.operationId}`).digest("hex").slice(0, 32);
    const prior = this.a.read(() => this.a.db.prepare("SELECT * FROM chat_envelopes WHERE operation_id=?").get(z.operationId)) as Record<string, unknown> | undefined;
    if (prior) return this.view(prior); // E-2: a replay returns the same envelope, never a second one
    const c = this.o.conversation(z.memberId, card.conversationId); // the starter only; unreadable = unknown
    if (c.deleted_at) throw new AccessError("chat_conversation_unknown");
    if (Date.parse(card.expiresAt) <= Date.parse(this.now()) || Date.parse(card.expiresAt) > Date.parse(this.now()) + ENVELOPE_HOURS * 3_600_000 + 60_000) throw new AccessError("chat_draft_card_expired");
    if (card.profileHash !== this.o.profileHash || card.toolCatalogHash !== this.o.toolCatalogHash) throw new AccessError("chat_draft_card_stale");
    if (card.caps.turns !== ENVELOPE_CAPS.turns || card.caps.usd !== ENVELOPE_CAPS.usd || card.caps.requestsPerTurn !== this.o.turnCaps.requests || card.caps.toolsPerTurn !== this.o.turnCaps.toolCalls)
      throw new AccessError("chat_draft_card_stale");
    const snap = takeSnapshot(this.o.folder, c.scope, z.memberId, c.id);
    if (snap.hash !== card.snapshotHash || JSON.stringify(snap.roots) !== JSON.stringify(card.scopeRoots)) throw new AccessError("chat_draft_card_stale");
    // E-4: the Records Task under the approval's operationId (idempotent), then the envelope naming it.
    const t = await this.o.createTask(z, { documentKey: `chat-draft:${envelopeId}`, title: `${card.capability === "newsletter" ? "Newsletter" : "Agenda"} draft (chat)`,
      sourceRef: `chat:${c.id}#${envelopeId}` });
    if (!t.accepted) throw new AccessError("chat_draft_task_refused");
    this.a.write(() => this.a.db.prepare(`INSERT INTO chat_envelopes(id,conversation_id,member_id,operation_id,card_hash,capability,snapshot_hash,budget_usd,turns,expires_at,task_id,created_at,closed_at,closed_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL) ON CONFLICT(operation_id) DO NOTHING`).run(envelopeId, c.id, z.memberId, z.operationId, h, card.capability, card.snapshotHash,
      card.caps.usd, card.caps.turns, card.expiresAt, t.taskId, this.now()));
    return this.view(this.a.read(() => this.a.db.prepare("SELECT * FROM chat_envelopes WHERE operation_id=?").get(z.operationId)) as Record<string, unknown>);
  }
  private usage(envelopeId: string) {
    return this.a.db.prepare("SELECT COUNT(*) AS turns, COALESCE(SUM(t.cost_usd),0) AS usd FROM chat_envelope_turns e JOIN chat_turns t ON t.id=e.turn_id WHERE e.envelope_id=?").get(envelopeId) as { turns: number; usd: number };
  }
  private view(r: Record<string, unknown>) {
    const u = this.a.read(() => this.usage(String(r.id)));
    return { envelopeId: r.id as string, conversationId: r.conversation_id as string, capability: r.capability as string, cardHash: r.card_hash as string, snapshotHash: r.snapshot_hash as string,
      taskId: r.task_id as string, expiresAt: r.expires_at as string, turnsLeft: Math.max(0, Number(r.turns) - u.turns), usdLeft: Math.max(0, Math.round((Number(r.budget_usd) - u.usd) * 1e6) / 1e6),
      closed: r.closed_at ? (r.closed_reason as string) : null };
  }
  /** The conversation's open envelope, if any (for the header / UI). */
  open(conversationId: string) {
    const r = this.a.read(() => this.a.db.prepare("SELECT * FROM chat_envelopes WHERE conversation_id=? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1").get(conversationId)) as Record<string, unknown> | undefined;
    return r ? this.view(r) : null;
  }
  /** Turn start (ChatTools.begin): bind the turn to the conversation's usable envelope, or run it as plain Q&A. Closes an
   *  envelope that is exhausted, expired, or whose pinned snapshot no longer matches (E-3). */
  bindTurn(turnId: string, conversationId: string, snapshotHash: string): DraftEnvelope | null {
    return this.a.write(() => {
      const r = this.a.db.prepare("SELECT * FROM chat_envelopes WHERE conversation_id=? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1").get(conversationId) as
        { id: string; snapshot_hash: string; budget_usd: number; turns: number; expires_at: string; capability: "newsletter" | "agenda" } | undefined;
      if (!r) return null;
      const u = this.usage(r.id);
      const close = (reason: string) => { this.a.db.prepare("UPDATE chat_envelopes SET closed_at=?, closed_reason=? WHERE id=? AND closed_at IS NULL").run(this.now(), reason, r.id); return null; };
      if (Date.parse(r.expires_at) <= Date.parse(this.now())) return close("chat_draft_expired");
      if (u.turns >= r.turns || u.usd >= r.budget_usd) return close("chat_draft_exhausted");
      if (snapshotHash !== r.snapshot_hash) return close("chat_draft_snapshot_changed");
      this.a.db.prepare("INSERT OR IGNORE INTO chat_envelope_turns(turn_id, envelope_id) VALUES (?,?)").run(turnId, r.id);
      // Q-1: the facts the scheduler's fixed system line states (this turn counts as used).
      return { envelopeId: r.id, snapshotHash: r.snapshot_hash, capability: r.capability, turnsLeft: Math.max(0, r.turns - u.turns - 1), usdLeft: Math.max(0, Math.round((r.budget_usd - u.usd) * 100) / 100) };
    });
  }
  envelopeOfTurn(turnId: string): DraftEnvelope | null {
    const r = this.a.read(() => this.a.db.prepare("SELECT e.id, e.snapshot_hash FROM chat_envelope_turns t JOIN chat_envelopes e ON e.id=t.envelope_id WHERE t.turn_id=?").get(turnId)) as
      { id: string; snapshot_hash: string } | undefined;
    return r ? { envelopeId: r.id, snapshotHash: r.snapshot_hash } : null;
  }
}
