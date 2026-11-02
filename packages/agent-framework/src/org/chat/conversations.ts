// Chat agent C-2 (PLAN-SLICE-1 §3, Fable R-2 / R-5 / §12(b)(c), P-1; D-1 owner-confirmed 2026-10-16: chats are PRIVATE).
// Conversations, messages and turns are per-org records in the org's own SQLite authority; the hub holds nothing.
// - A turn is asynchronous: chat.turn.start returns {turnId} at once and the turn runs in the background; the UI polls
//   chat.turn.read with a message cursor. A repeated clientRequestId from the same member returns the SAME turn (a reconnect
//   never starts a second paid run); reusing it for different text is refused.
// - One active turn per org (chat_turn_busy); a per-member daily turn allowance (P-1, org config, default 20 per 24 h).
// - Visibility is stored on the conversation at creation: 'private' (the starter only), or 'private+admins' only when the
//   org's adminsReadAll flag (default OFF) was on at creation. An admin read of another member's conversation also needs the
//   flag on NOW, and is audited ('admin-read'). Reviewers never read others' conversations. Checked on every read and poll;
//   an unreadable conversation is indistinguishable from an unknown one.
// - Scope is set once at creation: 'member' (members/ roots), or 'reviewer' (adds reviewers-private intake and transcripts),
//   which only a reviewer or admin may choose. It never changes; a different scope is a new conversation.
// - Turn stop reasons are fixed labels, persisted through the worker vocabulary (failure-labels CODES), never error text.
// - Retention (D-4): a sweep tombstones conversations idle for retentionDays (text deleted, ids + hashes + turn rows kept).
// - A runtime restart never re-runs a turn: queued/running turns end 'failed' with chat_turn_interrupted (C-3 refines a turn
//   with a request already sent to 'unsettled').
import { createHash, randomUUID } from "node:crypto";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { AccessError } from "../../access/org-access.js";
import { failureLabel, persistedReason } from "../../task-delegation/failure-labels.js";

export { CHAT_STOP_REASONS } from "./labels.js";
export type ChatScope = "member" | "reviewer";
export type ChatMember = { memberId: string; role: string };
export type TurnState = "queued" | "running" | "done" | "stopped" | "failed" | "unsettled";
export const TERMINAL: readonly TurnState[] = ["done", "stopped", "failed", "unsettled"];
/** How a turn ended when it did not simply answer: a fixed label and the state it leaves (a sent request with an unknown
 *  outcome leaves the turn 'unsettled'; that money stays accounted). */
export class TurnEnd extends Error {
  constructor(readonly label: string, readonly state: "stopped" | "failed" | "unsettled", readonly text: string | null = null) { super(label); this.name = "TurnEnd"; }
}
export type TurnRecord = {
  /** One model request of the turn and its ledger key (the ledger row holds its state and cost). */
  request: (r: { n: number; ledgerKey: string }) => void;
  /** One tool call: hashes, size and a fixed label (null = ok); never arguments or results. */
  toolCall: (r: { n: number; name: string; argsSha256: string; resultSha256: string | null; resultBytes: number; label: string | null }) => void;
};
/** The C-3 scheduler implements this. It reports progress, returns the final assistant text, or throws TurnEnd / Error(label). */
export type TurnRunner = (t: { turnId: string; conversationId: string; memberId: string; scope: ChatScope; history: { role: "user" | "assistant"; text: string }[] },
  ctx: { signal: AbortSignal; memberActive: () => boolean; progress: (p: { requests?: number; toolCalls?: number; costUsd?: number; note?: string }) => void; record: TurnRecord })
  => Promise<{ text: string }>;
export type ChatConfig = { adminsReadAll: boolean; dailyTurnsPerMember: number; retentionDays: number };

const ID = { conv: /^conv_[a-f0-9]{32}$/, turn: /^turn_[a-f0-9]{32}$/, client: /^[A-Za-z0-9_-]{8,64}$/ };
const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
const nid = (p: string) => p + "_" + randomUUID().replaceAll("-", "");
export const CHAT_TEXT_MAX = 8000;
/** WC-4 (Fable R-10): one title sanitizer for the automatic title and a rename. Control characters, markdown markers and
 *  link targets removed, whitespace collapsed; longer than `max` = cut at a word boundary with "…". Linear regexes only. */
export function chatTitle(raw: string, max: number) {
  const t = raw.slice(0, 1000)                                       // a title never needs more input; bounds the regex work
    .replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d{1,3}[.)])[ \t]+/gm, "")       // heading, quote and list markers at a line start
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")                         // [text](url) -> text
    .replace(/\*\*|__|~~|`/g, "").replace(/(^|\s)[*_](?=\S)|(?<=\S)[*_](?=[\s.,;:!?)]|$)/g, "$1") // emphasis markers at word edges
    .replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1), sp = cut.lastIndexOf(" ");
  return (sp >= max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "") + "…";
}
export const TITLE_MAX = { auto: 60, rename: 120 };
const POLL_MESSAGES = 50;

export class ChatConversations {
  private readonly running = new Map<string, AbortController>();
  private readonly settled = new Set<Promise<unknown>>();
  private closing = false;
  constructor(private readonly a: SqliteAuthority, private readonly cfg: ChatConfig & { memberActive: (id: string) => boolean; runner: TurnRunner | null;
    /** TEAM-TASKS-V1 N-5: the org's one model slot is shared with team tasks (a running attempt makes chat busy too). */
    otherBusy?: () => boolean },
    private readonly now: () => string = () => new Date().toISOString()) {
    a.db.exec(`CREATE TABLE IF NOT EXISTS chat_conversations(id TEXT PRIMARY KEY, started_by TEXT NOT NULL, visibility TEXT NOT NULL CHECK(visibility IN ('private','private+admins')),
        scope TEXT NOT NULL CHECK(scope IN ('member','reviewer')), title TEXT, created_at TEXT NOT NULL, last_at TEXT NOT NULL, deleted_at TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS chat_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')), text TEXT, sha256 TEXT NOT NULL, at TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS chat_messages_conv ON chat_messages(conversation_id, seq);
      CREATE TABLE IF NOT EXISTS chat_turns(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, client_request_id TEXT NOT NULL, text_sha256 TEXT NOT NULL,
        state TEXT NOT NULL, stop_reason TEXT, requests INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, note TEXT,
        started_at TEXT NOT NULL, ended_at TEXT, UNIQUE(member_id, client_request_id)) STRICT;
      CREATE INDEX IF NOT EXISTS chat_turns_state ON chat_turns(state);
      CREATE TABLE IF NOT EXISTS chat_turn_requests(turn_id TEXT NOT NULL, n INTEGER NOT NULL, ledger_key TEXT NOT NULL UNIQUE, PRIMARY KEY(turn_id, n)) STRICT;
      CREATE TABLE IF NOT EXISTS chat_tool_calls(turn_id TEXT NOT NULL, n INTEGER NOT NULL, name TEXT NOT NULL, args_sha256 TEXT NOT NULL, result_sha256 TEXT, result_bytes INTEGER NOT NULL,
        label TEXT, at TEXT NOT NULL, PRIMARY KEY(turn_id, n)) STRICT;
      CREATE TABLE IF NOT EXISTS chat_audit(at TEXT NOT NULL, event TEXT NOT NULL, conversation_id TEXT, member_id TEXT, detail TEXT) STRICT;`);
  }
  private audit(event: string, conversationId: string | null, memberId: string | null, detail: string | null = null) {
    this.a.db.prepare("INSERT INTO chat_audit(at,event,conversation_id,member_id,detail) VALUES (?,?,?,?,?)").run(this.now(), event, conversationId, memberId, detail);
  }
  private conv(id: unknown) {
    if (typeof id !== "string" || !ID.conv.test(id)) throw new AccessError("chat_conversation_unknown");
    return this.a.db.prepare("SELECT * FROM chat_conversations WHERE id=?").get(id) as { id: string; started_by: string; visibility: string; scope: ChatScope; title: string | null;
      created_at: string; last_at: string; deleted_at: string | null } | undefined;
  }
  /** The starter's own conversation (C-5 draft cards and approvals); unreadable = unknown. */
  own(memberId: string, id: unknown) { return this.readable({ memberId, role: "member" }, id, { ownerOnly: true }).c; }
  /** Who may READ a conversation: its starter; an admin only when it was created admin-readable AND the flag is on now. */
  private readable(m: ChatMember, id: unknown, o: { ownerOnly?: boolean } = {}) {
    const c = this.conv(id);
    if (!c) throw new AccessError("chat_conversation_unknown");
    if (c.started_by === m.memberId) return { c, adminRead: false };
    if (!o.ownerOnly && m.role === "admin" && this.cfg.adminsReadAll && c.visibility === "private+admins") return { c, adminRead: true };
    throw new AccessError("chat_conversation_unknown");
  }
  private turnRow(id: unknown) {
    if (typeof id !== "string" || !ID.turn.test(id)) throw new AccessError("chat_turn_unknown");
    return this.a.db.prepare("SELECT * FROM chat_turns WHERE id=?").get(id) as { id: string; conversation_id: string; member_id: string; state: TurnState; stop_reason: string | null;
      requests: number; tool_calls: number; cost_usd: number; note: string | null; started_at: string; ended_at: string | null } | undefined;
  }

  create(m: ChatMember, b: { scope?: unknown; title?: unknown }) {
    const scope = b?.scope === undefined ? "member" : b.scope;
    if (scope !== "member" && scope !== "reviewer") throw new AccessError("chat_scope_invalid");
    if (scope === "reviewer" && !["admin", "reviewer"].includes(m.role)) throw new AccessError("chat_scope_not_permitted");
    const title = typeof b?.title === "string" ? chatTitle(b.title, TITLE_MAX.rename) || null : null;
    const id = nid("conv"), at = this.now(), visibility = this.cfg.adminsReadAll ? "private+admins" : "private";
    this.a.write(() => {
      this.a.db.prepare("INSERT INTO chat_conversations(id,started_by,visibility,scope,title,created_at,last_at,deleted_at) VALUES (?,?,?,?,?,?,?,NULL)").run(id, m.memberId, visibility, scope, title, at, at);
      this.audit("conversation_created", id, m.memberId, `${scope};${visibility}`);
    });
    return this.summary(this.conv(id)!);
  }
  private summary(c: NonNullable<ReturnType<ChatConversations["conv"]>>) {
    return { conversationId: c.id, scope: c.scope, visibility: c.visibility, title: c.title, createdAt: c.created_at, lastAt: c.last_at, deleted: !!c.deleted_at,
      // D-1 disclosure: shown in the header before the first message.
      disclosure: c.visibility === "private+admins" && this.cfg.adminsReadAll ? "Admins can read this conversation." : "Only you can read this conversation." };
  }
  /** The member's own conversations, newest activity first. */
  list(m: ChatMember) {
    const rows = this.a.db.prepare("SELECT * FROM chat_conversations WHERE started_by=? AND deleted_at IS NULL ORDER BY last_at DESC, id LIMIT 100").all(m.memberId) as any[];
    // Owner (Oct 23): every Chat visit lands on an EMPTY chat; the page reuses one (no turns, uploads or images) before creating one.
    const has = (t: string) => !!this.a.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
    const used = (t: string) => has(t) ? new Set((this.a.db.prepare(`SELECT DISTINCT conversation_id AS id FROM ${t} WHERE member_id=?`).all(m.memberId) as { id: string }[]).map((r) => r.id)) : new Set<string>();
    const busy = [used("chat_turns"), used("chat_uploads"), used("chat_images")];
    return { conversations: rows.map((c) => ({ ...this.summary(c), empty: !busy.some((s) => s.has(c.id)) })), allowance: this.allowance(m.memberId) };
  }
  /** Messages after `since` (a message cursor) and the conversation's recent turns. */
  read(m: ChatMember, b: { conversationId?: unknown; since?: unknown }) {
    const { c, adminRead } = this.readable(m, b?.conversationId);
    if (adminRead) this.a.write(() => this.audit("conversation_read", c.id, m.memberId, "admin-read"));
    const since = Number.isInteger(b?.since) && (b.since as number) >= 0 ? b.since as number : 0;
    const messages = (this.a.db.prepare("SELECT seq, id, turn_id, role, text, sha256, at FROM chat_messages WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?").all(c.id, since, POLL_MESSAGES) as any[])
      .map((r) => ({ seq: r.seq, messageId: r.id, turnId: r.turn_id, role: r.role, text: r.text, sha256: r.sha256, at: r.at }));
    const turns = (this.a.db.prepare("SELECT * FROM chat_turns WHERE conversation_id=? ORDER BY started_at DESC, id LIMIT 20").all(c.id) as any[]).map((t) => this.turnView(t));
    return { conversation: this.summary(c), messages, turns, adminRead };
  }
  private turnView(t: NonNullable<ReturnType<ChatConversations["turnRow"]>>) {
    return { turnId: t.id, conversationId: t.conversation_id, state: t.state, stopReason: t.stop_reason, requests: t.requests, toolCalls: t.tool_calls, costUsd: t.cost_usd,
      note: t.note, startedAt: t.started_at, endedAt: t.ended_at };
  }
  /** P-1: turns started by this member in the last 24 h against the org's allowance. */
  allowance(memberId: string) {
    const since = new Date(Date.parse(this.now()) - 86_400_000).toISOString();
    // WC-3 (Fable R-9): a turn that ended chat_no_files made no request and does not count.
    const used = (this.a.db.prepare("SELECT COUNT(*) AS n FROM chat_turns WHERE member_id=? AND started_at>? AND COALESCE(stop_reason,'')<>'chat_no_files'").get(memberId, since) as { n: number }).n;
    return { used, limit: this.cfg.dailyTurnsPerMember, remaining: Math.max(0, this.cfg.dailyTurnsPerMember - used) };
  }

  /** WC-4 (Fable R-10): the conversation's starter renames it (never an admin reading it); 1..120 characters after the sanitizer. */
  rename(m: ChatMember, b: { conversationId?: unknown; title?: unknown }) {
    const { c } = this.readable(m, b?.conversationId, { ownerOnly: true });
    if (c.deleted_at) throw new AccessError("chat_conversation_unknown");
    const raw = typeof b.title === "string" && b.title.length <= 1000 ? b.title : "", title = chatTitle(raw, Number.MAX_SAFE_INTEGER);
    if (!title || title.length > TITLE_MAX.rename) throw new AccessError("chat_title_invalid");
    this.a.write(() => {
      this.a.db.prepare("UPDATE chat_conversations SET title=? WHERE id=?").run(title, c.id);
      this.audit("conversation_renamed", c.id, m.memberId, `chars=${title.length}`);
    });
    return this.summary(this.conv(c.id)!);
  }

  startTurn(m: ChatMember, b: { conversationId?: unknown; clientRequestId?: unknown; text?: unknown }) {
    const { c } = this.readable(m, b?.conversationId, { ownerOnly: true }); // only the starter talks in a conversation
    if (c.deleted_at) throw new AccessError("chat_conversation_unknown");
    if (typeof b.clientRequestId !== "string" || !ID.client.test(b.clientRequestId)) throw new AccessError("chat_client_request_invalid");
    const text = typeof b.text === "string" ? b.text.replace(/\r\n/g, "\n").trim() : "";
    if (!text || text.length > CHAT_TEXT_MAX) throw new AccessError("chat_text_invalid");
    const clientRequestId = b.clientRequestId, textSha = sha(text);
    const started = this.a.write(() => {
      // A reconnect with the same clientRequestId returns the same turn (never a second run).
      const prior = this.a.db.prepare("SELECT id, conversation_id, text_sha256 FROM chat_turns WHERE member_id=? AND client_request_id=?").get(m.memberId, clientRequestId) as
        { id: string; conversation_id: string; text_sha256: string } | undefined;
      if (prior) {
        if (prior.conversation_id !== c.id || prior.text_sha256 !== textSha) throw new AccessError("chat_client_request_reused");
        return { turnId: prior.id, replayed: true };
      }
      if (this.a.db.prepare("SELECT 1 FROM chat_turns WHERE state IN ('queued','running') LIMIT 1").get() || this.cfg.otherBusy?.()) throw new AccessError("chat_turn_busy");
      if (this.allowance(m.memberId).remaining < 1) throw new AccessError("chat_daily_allowance");
      const id = nid("turn"), at = this.now();
      this.a.db.prepare("INSERT INTO chat_turns(id,conversation_id,member_id,client_request_id,text_sha256,state,started_at) VALUES (?,?,?,?,?,'queued',?)").run(id, c.id, m.memberId, clientRequestId, textSha, at);
      this.a.db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,'user',?,?,?)").run(nid("msg"), c.id, id, text, textSha, at);
      this.a.db.prepare("UPDATE chat_conversations SET last_at=? WHERE id=?").run(at, c.id);
      // WC-4: an untitled conversation takes a deterministic title from its first message (no model call).
      this.a.db.prepare("UPDATE chat_conversations SET title=? WHERE id=? AND title IS NULL").run(chatTitle(text, TITLE_MAX.auto) || null, c.id);
      return { turnId: id, replayed: false };
    });
    if (!started.replayed) this.launch(started.turnId, c.id, m.memberId, c.scope);
    return started;
  }
  private launch(turnId: string, conversationId: string, memberId: string, scope: ChatScope) {
    const ac = new AbortController();
    this.running.set(turnId, ac);
    const p = (async () => {
      await new Promise((r) => setImmediate(r)); // start answers first; the turn runs in the background
      const end = (state: TurnState, stopReason: string | null, text?: string) => this.a.write(() => {
        const cur = this.turnRow(turnId)!;
        if (TERMINAL.includes(cur.state)) return;
        const at = this.now();
        this.a.db.prepare("UPDATE chat_turns SET state=?, stop_reason=?, ended_at=? WHERE id=?").run(state, stopReason === null ? null : persistedReason(failureLabel(new Error(stopReason))), at, turnId);
        if (text !== undefined && text.trim())
          this.a.db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,'assistant',?,?,?)").run(nid("msg"), conversationId, turnId, text, sha(text), at);
        this.a.db.prepare("UPDATE chat_conversations SET last_at=? WHERE id=?").run(at, conversationId);
      });
      // Stopped (by the member, or by close): a request already sent leaves the turn 'unsettled' (never replayed).
      const halted = (unsettled = false) => end(unsettled ? "unsettled" : this.closing ? "failed" : "stopped", this.closing ? "chat_turn_interrupted" : "chat_stopped_by_member");
      try {
        if (ac.signal.aborted) return halted();
        if (!this.cfg.memberActive(memberId)) return end("failed", "chat_member_inactive");
        if (!this.cfg.runner) return end("failed", "chat_runner_not_installed");
        this.a.write(() => this.a.db.prepare("UPDATE chat_turns SET state='running' WHERE id=? AND state='queued'").run(turnId));
        const history = (this.a.db.prepare("SELECT role, text FROM chat_messages WHERE conversation_id=? AND text IS NOT NULL ORDER BY seq").all(conversationId) as { role: "user" | "assistant"; text: string }[]);
        const r = await this.cfg.runner({ turnId, conversationId, memberId, scope, history }, { signal: ac.signal, memberActive: () => this.cfg.memberActive(memberId),
          progress: (p) => this.a.write(() => this.a.db.prepare("UPDATE chat_turns SET requests=COALESCE(?,requests), tool_calls=COALESCE(?,tool_calls), cost_usd=COALESCE(?,cost_usd), note=COALESCE(?,note) WHERE id=?")
            .run(p.requests ?? null, p.toolCalls ?? null, p.costUsd ?? null, p.note === undefined ? null : String(p.note).slice(0, 80), turnId)),
          record: {
            request: (r) => this.a.write(() => this.a.db.prepare("INSERT INTO chat_turn_requests(turn_id,n,ledger_key) VALUES (?,?,?)").run(turnId, r.n, r.ledgerKey)),
            toolCall: (r) => this.a.write(() => this.a.db.prepare("INSERT INTO chat_tool_calls(turn_id,n,name,args_sha256,result_sha256,result_bytes,label,at) VALUES (?,?,?,?,?,?,?,?)")
              .run(turnId, r.n, /^[a-z_][a-z0-9_]{0,63}$/.test(r.name) ? r.name : "invalid", r.argsSha256, r.resultSha256, r.resultBytes,
                r.label === null ? null : persistedReason(failureLabel(new Error(r.label))), this.now())),
          } });
        if (ac.signal.aborted) return halted();
        end("done", null, r.text);
      } catch (e) {
        if (ac.signal.aborted) return halted(e instanceof TurnEnd && e.state === "unsettled");
        if (e instanceof TurnEnd) return end(e.state, e.label, e.text ?? undefined);
        end("failed", failureLabel(e));
      } finally { this.running.delete(turnId); }
    })();
    this.settled.add(p); void p.finally(() => this.settled.delete(p));
  }
  readTurn(m: ChatMember, b: { turnId?: unknown; since?: unknown }) {
    const t = this.turnRow(b?.turnId);
    if (!t || t.member_id !== m.memberId) throw new AccessError("chat_turn_unknown");
    this.readable(m, t.conversation_id, { ownerOnly: true });
    const since = Number.isInteger(b?.since) && (b.since as number) >= 0 ? b.since as number : 0;
    const messages = (this.a.db.prepare("SELECT seq, id, role, text, sha256, at FROM chat_messages WHERE turn_id=? AND seq>? ORDER BY seq LIMIT ?").all(t.id, since, POLL_MESSAGES) as any[])
      .map((r) => ({ seq: r.seq, messageId: r.id, role: r.role, text: r.text, sha256: r.sha256, at: r.at }));
    return { turn: this.turnView(t), messages, terminal: TERMINAL.includes(t.state) };
  }
  stopTurn(m: ChatMember, b: { turnId?: unknown }) {
    const t = this.turnRow(b?.turnId);
    if (!t || t.member_id !== m.memberId) throw new AccessError("chat_turn_unknown");
    if (TERMINAL.includes(t.state)) return { turn: this.turnView(t), stopped: false };
    const ac = this.running.get(t.id);
    if (ac) ac.abort();
    else this.a.write(() => this.a.db.prepare("UPDATE chat_turns SET state='stopped', stop_reason='chat_stopped_by_member', ended_at=? WHERE id=? AND state IN ('queued','running')").run(this.now(), t.id));
    return { turn: this.turnView(this.turnRow(t.id)!), stopped: true };
  }
  /** At start, before any listener: a turn left queued/running by a crash is never re-run. */
  recover() {
    return this.a.write(() => {
      // A turn with a request whose ledger entry is unsettled (the hosted ledger's own start-up recovery ran first) is 'unsettled'.
      const at = this.now();
      const u = this.a.db.prepare(`UPDATE chat_turns SET state='unsettled', stop_reason='chat_turn_interrupted', ended_at=? WHERE state IN ('queued','running')
        AND EXISTS (SELECT 1 FROM chat_turn_requests r JOIN effects e ON e.key=r.ledger_key WHERE r.turn_id=chat_turns.id AND e.state='unsettled')`).run(at).changes;
      return Number(u) + Number(this.a.db.prepare("UPDATE chat_turns SET state='failed', stop_reason='chat_turn_interrupted', ended_at=? WHERE state IN ('queued','running')").run(at).changes);
    });
  }
  /** D-4: tombstone conversations idle longer than retentionDays (text deleted; ids, hashes and turn rows kept). */
  sweep() {
    const cutoff = new Date(Date.parse(this.now()) - this.cfg.retentionDays * 86_400_000).toISOString();
    return this.a.write(() => {
      const old = this.a.db.prepare("SELECT id FROM chat_conversations WHERE deleted_at IS NULL AND last_at<? AND id NOT IN (SELECT conversation_id FROM chat_turns WHERE state IN ('queued','running'))").all(cutoff) as { id: string }[];
      for (const { id } of old) {
        this.a.db.prepare("UPDATE chat_messages SET text=NULL WHERE conversation_id=?").run(id);
        this.a.db.prepare("UPDATE chat_conversations SET deleted_at=?, title=NULL WHERE id=?").run(this.now(), id);
        this.audit("conversation_tombstoned", id, null, `retention_${this.cfg.retentionDays}d`);
      }
      return { tombstoned: old.length };
    });
  }
  /** Polish P-3 (Fable R-6): conversations from before WC-4 have no title. Once per start, in ONE write transaction, up to
   *  500 untitled, not-deleted conversations take chatTitle(first member message by seq, 60); the rest wait for the next
   *  start. A conversation with no member message stays untitled. Never touches last_at or a message row; a rename or a
   *  WC-4 title is never overwritten (WHERE title IS NULL). Returns how many were titled. */
  backfillTitles() {
    return this.a.write(() => {
      const rows = this.a.db.prepare(`SELECT c.id AS id, (SELECT m.text FROM chat_messages m WHERE m.conversation_id=c.id AND m.role='user' ORDER BY m.seq LIMIT 1) AS first
        FROM chat_conversations c WHERE c.title IS NULL AND c.deleted_at IS NULL ORDER BY c.created_at, c.id LIMIT 500`).all() as { id: string; first: string | null }[];
      const set = this.a.db.prepare("UPDATE chat_conversations SET title=? WHERE id=? AND title IS NULL AND deleted_at IS NULL");
      let n = 0;
      for (const r of rows) { const t = r.first ? chatTitle(r.first, TITLE_MAX.auto) : ""; if (t && set.run(t, r.id).changes) n++; }
      return n;
    });
  }
  stats() {
    const q = (s: string) => (this.a.db.prepare(s).get() as { n: number }).n;
    return { conversations: q("SELECT COUNT(*) AS n FROM chat_conversations WHERE deleted_at IS NULL"), tombstoned: q("SELECT COUNT(*) AS n FROM chat_conversations WHERE deleted_at IS NOT NULL"),
      activeTurns: q("SELECT COUNT(*) AS n FROM chat_turns WHERE state IN ('queued','running')"), adminReads: q("SELECT COUNT(*) AS n FROM chat_audit WHERE detail='admin-read'"),
      adminsReadAll: this.cfg.adminsReadAll, dailyTurnsPerMember: this.cfg.dailyTurnsPerMember, retentionDays: this.cfg.retentionDays };
  }
  /** Let background turns finish (close/tests). */
  async idle() { while (this.settled.size) await Promise.allSettled([...this.settled]); }
  /** N-5: true while a chat turn is queued or running (team tasks wait for the org's one model slot). */
  busy() { return !!this.a.db.prepare("SELECT 1 FROM chat_turns WHERE state IN ('queued','running') LIMIT 1").get(); } // plain read: callable inside a write
  /** Abort running turns (close): they end chat_turn_interrupted, never "stopped by member". */
  abortAll() { this.closing = true; for (const ac of this.running.values()) ac.abort(); }
}
