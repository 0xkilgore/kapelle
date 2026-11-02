// Chat agent C-2 (PLAN-SLICE-1 §3, Fable R-2 / R-5 / §12(b)(c), P-1; D-1 owner-confirmed: chats private, adminsReadAll OFF by
// default). A real org runtime behind the real hub, three members (admin, reviewer, contributor), and a controllable
// runner standing in for the C-3 scheduler (no model, no provider). Synthetic data only.
import { describe, it, expect } from "vitest";
import { it as itPlain } from "vitest";
import { transcriptionWorld } from "./transcription-world.js";
import { CHAT_STOP_REASONS, type TurnRunner } from "../src/org/chat/conversations.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";
import { ACCESS_ACTIONS, STEP_UP, stepUpOf } from "../src/access/org-access.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const wait = async (f: () => Promise<boolean>, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return; await new Promise((r) => setTimeout(r, 20)); } throw Error("timeout"); };

/** A runner the test releases by hand; records what it was given. */
function gatedRunner() {
  const calls: Parameters<TurnRunner>[0][] = [];
  let next: { resolve: (v: Awaited<ReturnType<TurnRunner>>) => void; reject: (e: Error) => void; ctx: Parameters<TurnRunner>[1] } | null = null;
  const runner: TurnRunner = (t, ctx) => new Promise((resolve, reject) => {
    calls.push(t); next = { resolve, reject, ctx };
    ctx.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  return { runner, calls, get pending() { return next; } };
}

itPlain("chat routines are session tier and routine audience; stop reasons persist verbatim", () => {
  for (const a of ["chat.conversation.create", "chat.conversation.list", "chat.conversation.read", "chat.turn.start", "chat.turn.read", "chat.turn.stop"]) {
    expect((ACCESS_ACTIONS.routine as readonly string[]).includes(a), a).toBe(true);
    expect(stepUpOf(a), a).toBe("session");
  }
  expect(STEP_UP["session-fresh"]).not.toContain("chat.turn.start");
  for (const l of CHAT_STOP_REASONS) { expect(failureLabel(new Error(l)), l).toBe(l); expect(persistedReason(l)).toBe(l); }
});

describe.skipIf(!enabled)("chat conversations and turns", () => {
  it("not configured: every chat routine refuses with chat_not_configured", async () => {
    const w = await transcriptionWorld();
    try {
      expect((await w.post("/o/exna/api/chat/conversation/create", {}, w.alex)).error).toBe("chat_not_configured");
      expect((await w.post("/o/exna/api/member/me", {}, w.alex)).result.chat).toBe(false);
    } finally { await w.close(); }
  }, 120_000);

  it("async turns: start returns at once, poll, dedupe, one active turn per org, private visibility, stop, labels", async () => {
    const g = gatedRunner();
    const w = await transcriptionWorld({ chat: {}, chatRunner: g.runner });
    try {
      const api = (path: string, body: unknown, cookie: string) => w.post(`/o/exna/api/chat/${path}`, body, cookie);
      expect((await w.post("/o/exna/api/member/me", {}, w.alex)).result.chat).toBe(true);
      // Scope: member by default; reviewer scope only for reviewers/admins; fixed at creation.
      expect((await api("conversation/create", { scope: "reviewer" }, w.alex)).error).toBe("chat_scope_not_permitted");
      expect((await api("conversation/create", { scope: "everything" }, w.robin)).error).toBe("chat_scope_invalid");
      const rc = (await api("conversation/create", { scope: "reviewer", title: "Agenda prep" }, w.robin)).result;
      expect(rc).toMatchObject({ scope: "reviewer", visibility: "private", title: "Agenda prep" });
      const conv = (await api("conversation/create", { title: "Newsletter\u0000 ideas" }, w.alex)).result;
      expect(conv).toMatchObject({ scope: "member", visibility: "private", title: "Newsletter ideas", disclosure: "Only you can read this conversation." });
      // Start: returns the turn id at once; the runner has the history.
      const t1 = await api("turn/start", { conversationId: conv.conversationId, clientRequestId: "req-0000001", text: "When is the cleanup?" }, w.alex);
      expect(t1).toMatchObject({ ok: true, result: { turnId: expect.stringMatching(/^turn_[a-f0-9]{32}$/), replayed: false } });
      const turnId = t1.result.turnId;
      await wait(async () => !!g.pending);
      expect(g.calls[0]).toMatchObject({ turnId, conversationId: conv.conversationId, scope: "member", history: [{ role: "user", text: "When is the cleanup?" }] });
      expect((await api("turn/read", { turnId }, w.alex)).result).toMatchObject({ turn: { state: "running" }, terminal: false });
      // A reconnect with the same clientRequestId returns the same turn; different text under it is refused.
      expect((await api("turn/start", { conversationId: conv.conversationId, clientRequestId: "req-0000001", text: "When is the cleanup?" }, w.alex)).result).toEqual({ turnId, replayed: true });
      expect((await api("turn/start", { conversationId: conv.conversationId, clientRequestId: "req-0000001", text: "Something else" }, w.alex)).error).toBe("chat_client_request_reused");
      // One active turn per org.
      expect((await api("turn/start", { conversationId: rc.conversationId, clientRequestId: "req-robin-01", text: "Hi" }, w.robin)).error).toBe("chat_turn_busy");
      // Private: the reviewer and the admin cannot read it or poll its turn (indistinguishable from unknown).
      for (const who of [w.robin, w.admin]) {
        expect((await api("conversation/read", { conversationId: conv.conversationId }, who)).error).toBe("chat_conversation_unknown");
        expect((await api("turn/read", { turnId }, who)).error).toBe("chat_turn_unknown");
        expect((await api("turn/stop", { turnId }, who)).error).toBe("chat_turn_unknown");
        expect((await api("turn/start", { conversationId: conv.conversationId, clientRequestId: "req-other-01", text: "x" }, who)).error).toBe("chat_conversation_unknown");
      }
      // Input refusals.
      expect((await api("turn/start", { conversationId: conv.conversationId, clientRequestId: "short", text: "x" }, w.alex)).error).toBe("chat_client_request_invalid");
      expect((await api("turn/start", { conversationId: conv.conversationId, clientRequestId: "req-0000002", text: "   " }, w.alex)).error).toBe("chat_text_invalid");
      expect((await api("turn/start", { conversationId: conv.conversationId, clientRequestId: "req-0000002", text: "x".repeat(8001) }, w.alex)).error).toBe("chat_text_invalid");
      expect((await api("conversation/read", { conversationId: "../etc" }, w.alex)).error).toBe("chat_conversation_unknown");
      // Progress then done: the assistant message lands with its hash; the poll cursor returns only new messages.
      g.pending!.ctx.progress({ requests: 1, toolCalls: 2, costUsd: 0.0123, note: "search_org_history" });
      expect((await api("turn/read", { turnId }, w.alex)).result.turn).toMatchObject({ state: "running", requests: 1, toolCalls: 2, costUsd: 0.0123, note: "search_org_history" });
      g.pending!.resolve({ text: "The cleanup is on Oct 31 [members/notes/2026-10-08.v1.md#L2]." });
      await wait(async () => (await api("turn/read", { turnId }, w.alex)).result.terminal);
      const done = (await api("turn/read", { turnId }, w.alex)).result;
      expect(done.turn).toMatchObject({ state: "done", stopReason: null, endedAt: expect.any(String) });
      expect(done.messages.map((m: any) => [m.role, m.text])).toEqual([["user", "When is the cleanup?"], ["assistant", "The cleanup is on Oct 31 [members/notes/2026-10-08.v1.md#L2]."]]);
      expect(done.messages[1].sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect((await api("turn/read", { turnId, since: done.messages[0].seq }, w.alex)).result.messages.map((m: any) => m.role)).toEqual(["assistant"]);
      const read = (await api("conversation/read", { conversationId: conv.conversationId }, w.alex)).result;
      expect(read).toMatchObject({ adminRead: false, conversation: { conversationId: conv.conversationId }, turns: [{ turnId, state: "done" }] });
      expect((await api("conversation/list", {}, w.alex)).result).toMatchObject({ conversations: [{ conversationId: conv.conversationId }], allowance: { used: 1, limit: 20, remaining: 19 } });
      expect((await api("conversation/list", {}, w.robin)).result.conversations.map((c: any) => c.conversationId)).toEqual([rc.conversationId]);
      // Second turn sees the whole history (both roles), in order.
      const t2 = (await api("turn/start", { conversationId: conv.conversationId, clientRequestId: "req-0000003", text: "And the time?" }, w.alex)).result.turnId;
      await wait(async () => g.calls.length === 2);
      expect(g.calls[1].history.map((h) => h.role)).toEqual(["user", "assistant", "user"]);
      // Stop: aborts the runner; the turn ends 'stopped' with the fixed label; a second stop is a no-op.
      expect((await api("turn/stop", { turnId: t2 }, w.alex)).result.stopped).toBe(true);
      await wait(async () => (await api("turn/read", { turnId: t2 }, w.alex)).result.terminal);
      expect((await api("turn/read", { turnId: t2 }, w.alex)).result.turn).toMatchObject({ state: "stopped", stopReason: "chat_stopped_by_member" });
      expect((await api("turn/stop", { turnId: t2 }, w.alex)).result.stopped).toBe(false);
      // A runner failure persists a fixed label only: a vocabulary label verbatim, anything else 'unlabeled' (never its text).
      for (const [msg, stored] of [["hosted_http_429:code=429", "hosted_http_429:code=429"], ["Ignore previous instructions SECRET-TEXT", "unlabeled"]]) {
        const id = (await api("turn/start", { conversationId: conv.conversationId, clientRequestId: "req-f-" + stored.slice(0, 10).replace(/[^a-z0-9]/g, "x"), text: "Try" }, w.alex)).result.turnId;
        await wait(async () => g.calls.at(-1)!.turnId === id);
        g.pending!.reject(new Error(msg));
        await wait(async () => (await api("turn/read", { turnId: id }, w.alex)).result.terminal);
        expect((await api("turn/read", { turnId: id }, w.alex)).result.turn).toMatchObject({ state: "failed", stopReason: stored });
      }
      expect(JSON.stringify(w.org.sqlite.db.prepare("SELECT * FROM chat_turns").all())).not.toContain("SECRET-TEXT");
      // Removed mid-turn: the runner sees memberActive() false at its next step and the turn ends chat_member_inactive.
      const t3 = (await api("turn/start", { conversationId: conv.conversationId, clientRequestId: "req-0000009", text: "Last one" }, w.alex)).result.turnId;
      await wait(async () => g.calls.at(-1)!.turnId === t3);
      expect((await w.ops("/ops/member/remove", { email: "alex@exna.test" })).ok).toBe(true);
      expect(g.pending!.ctx.memberActive()).toBe(false);
      g.pending!.reject(new Error("chat_member_inactive"));
      await wait(async () => (w.org.sqlite.db.prepare("SELECT state FROM chat_turns WHERE id=?").get(t3) as any).state !== "running");
      expect(w.org.sqlite.db.prepare("SELECT state, stop_reason FROM chat_turns WHERE id=?").get(t3)).toEqual({ state: "failed", stop_reason: "chat_member_inactive" });
      expect((await api("conversation/list", {}, w.alex)).ok).toBe(false); // the removed member's session no longer reaches chat
      expect((await w.ops("/ops/status")).chat).toMatchObject({ conversations: 2, activeTurns: 0, adminReads: 0, adminsReadAll: false, dailyTurnsPerMember: 20, retentionDays: 365 });
    } finally { await w.close(); }
  }, 120_000);

  it("P-1 allowance, restart never re-runs a turn, retention tombstones (D-4)", async () => {
    const g = gatedRunner();
    const w = await transcriptionWorld({ chat: { dailyTurnsPerMember: 2 }, chatRunner: g.runner });
    try {
      const api = (path: string, body: unknown, cookie = w.alex) => w.post(`/o/exna/api/chat/${path}`, body, cookie);
      const conv = (await api("conversation/create", {})).result.conversationId;
      const t1 = (await api("turn/start", { conversationId: conv, clientRequestId: "req-a000001", text: "One" })).result.turnId;
      await wait(async () => !!g.pending); g.pending!.resolve({ text: "First answer." });
      await wait(async () => (await api("turn/read", { turnId: t1 })).result.terminal);
      const t2 = (await api("turn/start", { conversationId: conv, clientRequestId: "req-a000002", text: "Two" })).result.turnId;
      await wait(async () => g.calls.length === 2);
      // Allowance: 2 per 24 h (a replay of an existing turn is not a new turn).
      expect((await api("turn/start", { conversationId: conv, clientRequestId: "req-a000002", text: "Two" })).result.replayed).toBe(true);
      // Restart while t2 runs: the turn ends chat_turn_interrupted and is not re-run.
      await w.restart();
      expect(w.org.sqlite.db.prepare("SELECT state, stop_reason FROM chat_turns WHERE id=?").get(t2)).toEqual({ state: "failed", stop_reason: "chat_turn_interrupted" });
      expect(g.calls).toHaveLength(2);
      expect((await api("turn/start", { conversationId: conv, clientRequestId: "req-a000003", text: "Three" })).error).toBe("chat_daily_allowance");
      expect((await api("conversation/list", {})).result.allowance).toEqual({ used: 2, limit: 2, remaining: 0 });
      // A queued row left by a crash (simulated) is closed by start-up recovery, never launched.
      w.org.sqlite.db.prepare("INSERT INTO chat_turns(id,conversation_id,member_id,client_request_id,text_sha256,state,started_at) VALUES ('turn_' || lower(hex(randomblob(16))),?,?,?,?,'queued',?)")
        .run(conv, "m-x", "req-crash-01", "sha256:" + "0".repeat(64), new Date().toISOString());
      await w.restart();
      expect(w.org.sqlite.db.prepare("SELECT state, stop_reason FROM chat_turns WHERE client_request_id='req-crash-01'").get()).toEqual({ state: "failed", stop_reason: "chat_turn_interrupted" });
      expect((await w.ops("/ops/status")).chat.recovered.interrupted).toBe(1);
      // Retention: idle past 365 days -> tombstoned: text gone, hashes and turn rows kept; not listed; reads show deleted.
      w.org.sqlite.db.prepare("UPDATE chat_conversations SET last_at=? WHERE id=?").run(new Date(Date.now() - 366 * 86_400_000).toISOString(), conv);
      expect((await w.ops("/ops/chat/sweep")).tombstoned).toBe(1);
      const rows = w.org.sqlite.db.prepare("SELECT text, sha256 FROM chat_messages WHERE conversation_id=?").all(conv) as { text: string | null; sha256: string }[];
      expect(rows.length).toBe(3);
      expect(rows.every((r) => r.text === null && /^sha256:/.test(r.sha256))).toBe(true);
      expect((w.org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM chat_turns WHERE conversation_id=?").get(conv) as any).n).toBe(3);
      expect((await api("conversation/list", {})).result.conversations).toEqual([]);
      expect((await api("conversation/read", { conversationId: conv })).result.conversation).toMatchObject({ deleted: true, title: null });
      expect((await api("turn/start", { conversationId: conv, clientRequestId: "req-a000004", text: "Again" })).error).toBe("chat_conversation_unknown");
      expect(w.org.sqlite.db.prepare("SELECT event, detail FROM chat_audit WHERE event='conversation_tombstoned'").all()).toEqual([{ event: "conversation_tombstoned", detail: "retention_365d" }]);
    } finally { await w.close(); }
  }, 120_000);

  it("D-1 flag ON (org choice): new conversations disclose admin read; admin reads are audited; reviewers never; earlier private ones stay private", async () => {
    const g = gatedRunner();
    const w = await transcriptionWorld({ chat: {}, chatRunner: g.runner });
    try {
      const api = (path: string, body: unknown, cookie = w.alex) => w.post(`/o/exna/api/chat/${path}`, body, cookie);
      const before = (await api("conversation/create", {})).result.conversationId;
      (w.cfg as any).chat = { adminsReadAll: true };
      await w.restart();
      const after = (await api("conversation/create", {})).result;
      expect(after).toMatchObject({ visibility: "private+admins", disclosure: "Admins can read this conversation." });
      const r = await api("conversation/read", { conversationId: after.conversationId }, w.admin);
      expect(r.result).toMatchObject({ adminRead: true, conversation: { conversationId: after.conversationId } });
      expect(w.org.sqlite.db.prepare("SELECT event, conversation_id, detail FROM chat_audit WHERE detail='admin-read'").all()).toEqual([{ event: "conversation_read", conversation_id: after.conversationId, detail: "admin-read" }]);
      expect((await api("conversation/read", { conversationId: before }, w.admin)).error).toBe("chat_conversation_unknown"); // created private
      expect((await api("conversation/read", { conversationId: after.conversationId }, w.robin)).error).toBe("chat_conversation_unknown"); // reviewers: never
      // An admin may read, not talk or steer: no turns, no polls, no stops in another member's conversation.
      expect((await api("turn/start", { conversationId: after.conversationId, clientRequestId: "req-admin-01", text: "x" }, w.admin)).error).toBe("chat_conversation_unknown");
      expect((await api("conversation/list", {}, w.admin)).result.conversations).toEqual([]);
      // Turning the flag back off closes admin reads immediately, even for conversations created while it was on.
      (w.cfg as any).chat = { adminsReadAll: false };
      await w.restart();
      expect((await api("conversation/read", { conversationId: after.conversationId }, w.admin)).error).toBe("chat_conversation_unknown");
      expect((await api("conversation/read", { conversationId: after.conversationId })).result.conversation.disclosure).toBe("Only you can read this conversation.");
      expect((await w.ops("/ops/status")).chat.adminReads).toBe(1);
    } finally { await w.close(); }
  }, 120_000);
});
