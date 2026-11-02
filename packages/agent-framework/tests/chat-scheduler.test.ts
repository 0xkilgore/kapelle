// Chat agent C-3 (PLAN-SLICE-1 §2/§5, Fable R-1/R-6, D-2): the turn scheduler on the org's shared hosted ledger. A scripted
// FAKE model (tool calls and answers) through the real interactive transport; no network, provider or key. Every cap, stop
// with a request in flight, per-request ledger entries, and recovery after a restart.
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { chatRunner, CHAT_RULES, turnNote, calendarBlock, type ToolHost } from "../src/org/chat/scheduler.js";
import { TurnEnd, CHAT_STOP_REASONS } from "../src/org/chat/conversations.js";
import { INTERACTIVE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";
import { interactiveFromHosted, SLICE1_TURN_CAPS } from "../src/agent-kit/interactive/profile.js";
import { OPENROUTER_PROFILES } from "../src/agent-kit/hosted/openrouter.js";
import { SqliteSpendLedger } from "../src/service/sqlite-effects.js";
import { failureLabel } from "../src/task-delegation/failure-labels.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const P = INTERACTIVE_PROFILES.sonnet;
const usage = (cost: number) => ({ prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost });
type Step = { text?: string | null; calls?: [string, unknown][]; finish?: string; cost?: number } | ((init: any) => Promise<Response> | Response);
const answer = (text: string, cost = 0.004): Step => ({ text, cost });
const tools = (calls: [string, unknown][], cost = 0.003): Step => ({ text: null, calls, finish: "tool_calls", cost });

/** A scripted model: each request takes the next step; every request body is recorded. */
function model(steps: Step[]) {
  const bodies: any[] = [];
  let i = 0;
  const fetch = async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    const s = steps[Math.min(i++, steps.length - 1)];
    if (typeof s === "function") return s(init);
    const tool_calls = s.calls?.map(([name, args], k) => ({ id: `call_${bodies.length}_${k}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
    return new Response(JSON.stringify({ id: "gen-" + bodies.length, model: P.runtime.model, provider: "Amazon Bedrock",
      choices: [{ finish_reason: s.finish ?? "stop", message: { role: "assistant", content: s.text ?? null, ...(tool_calls ? { tool_calls } : {}) } }], usage: usage(s.cost ?? 0.004) }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, bodies };
}
const echoTools = (content = (name: string) => `${name}: members/notes/2026-10-08.v1.md#L2 The cleanup is on Oct 31.`): ToolHost & { seen: string[] } => {
  const seen: string[] = [];
  return { seen, async call(name, args) { seen.push(`${name} ${args}`); return name === "send_email" ? { ok: false, error: "chat_tool_unknown" } : { ok: true, content: content(name) }; } };
};

describe.skipIf(!enabled)("chat turn scheduler", () => {
  // One world for the unit-level runs: its sqlite authority holds the shared ledger table.
  const unit = async (f: (h: { ledger: SqliteSpendLedger; run: (o: { steps: Step[]; tools?: ToolHost; profile?: any; monthlyUsd?: number; abortAfter?: number; nowMs?: () => number; memberActive?: () => boolean; allowUnqualified?: boolean }) =>
    Promise<{ result: { text: string } | null; end: TurnEnd | null; bodies: any[]; requests: any[]; toolCalls: any[]; progress: any[]; ledger: any[] }> }) => Promise<void>) => {
    const w = await transcriptionWorld();
    try {
      const sqlite = w.org.sqlite;
      await f({ ledger: new SqliteSpendLedger(sqlite, { monthlyUsd: 5 }), run: async (o) => {
        const ledger = new SqliteSpendLedger(sqlite, { monthlyUsd: o.monthlyUsd ?? 5 });
        const m = model(o.steps), turnId = "turn_" + randomUUID().replaceAll("-", ""), ac = new AbortController();
        const requests: any[] = [], toolCalls: any[] = [], progress: any[] = [];
        const run = chatRunner({ profile: o.profile ?? P, secretFile: w.cfg.hosted.secretFile, ledger, tools: o.tools ?? echoTools(),
          fetch: (async (u: string, init: any) => { if (o.abortAfter !== undefined && m.bodies.length >= o.abortAfter) { setTimeout(() => ac.abort(), 5);
            return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))); } return m.fetch(u, init); }) as never,
          allowUnqualified: o.allowUnqualified ?? true, ...(o.nowMs ? { nowMs: o.nowMs } : {}) });
        let result = null, end = null;
        try { result = await run({ turnId, conversationId: "conv_x", memberId: "m1", scope: "member", history: [{ role: "user", text: "When is the cleanup?" }] },
          { signal: ac.signal, memberActive: o.memberActive ?? (() => true), progress: (p) => progress.push(p), record: { request: (r) => requests.push(r), toolCall: (r) => toolCalls.push(r) } }); }
        catch (e) { if (!(e instanceof TurnEnd)) throw e; end = e; }
        const rows = sqlite.db.prepare("SELECT key, state, cost_usd, reason FROM effects WHERE key LIKE ? ORDER BY rowid").all(`chat:${turnId}:%`);
        return { result, end, bodies: m.bodies, requests, toolCalls, progress, ledger: rows };
      } });
    } finally { await w.close(); }
  };

  it("a tool loop: tool_calls -> runtime tool -> answer; one settled ledger entry per request; records carry hashes only", () => unit(async ({ run }) => {
    const r = await run({ steps: [tools([["search_org_history", { query: "cleanup" }], ["read_org_file", { path: "members/notes/2026-10-08.v1.md" }]]), answer("Oct 31 [members/notes/2026-10-08.v1.md#L2].")] });
    expect(r.end).toBeNull();
    expect(r.result).toEqual({ text: "Oct 31 [members/notes/2026-10-08.v1.md#L2]." });
    expect(r.bodies).toHaveLength(2);
    // Fable Q-1: the fixed turn line follows the rules (no envelope here: "no draft plan is approved").
    // Owner bug (Oct 26): the runtime's calendar block follows the turn note (today + 62 days with weekdays, the org's zone).
    expect(r.bodies[0].messages).toEqual([{ role: "system", content: CHAT_RULES + "\n" + turnNote(null) + "\n" + calendarBlock(Date.now()) }, { role: "user", content: "When is the cleanup?" }]);
    expect(turnNote(null)).toBe("No draft plan is approved in this conversation: drafts cannot be saved; answer in text.");
    expect(turnNote({ capability: "newsletter", turnsLeft: 4, usdLeft: 1.97 })).toBe("A draft plan is approved for this conversation (newsletter; 4 turns and $1.97 left): save the draft with write_draft_artifact and, for a newsletter, render it with render_newsletter_preview.");
    expect(CHAT_RULES).toContain("Every answer that states a fact ends each such sentence with its path#Lx-Ly marker; search results already carry the markers, copy them."); // Q-2
    expect(r.bodies[1].messages.slice(2).map((m: any) => [m.role, m.tool_call_id ?? null])).toEqual([["assistant", null], ["tool", "call_1_0"], ["tool", "call_1_1"]]);
    expect(r.bodies[1].messages[3].content).toContain("search_org_history: members/notes");
    expect(r.ledger).toEqual([{ key: expect.stringMatching(/:1$/), state: "settled", cost_usd: 0.003, reason: null }, { key: expect.stringMatching(/:2$/), state: "settled", cost_usd: 0.004, reason: null }]);
    expect(r.requests.map((x) => x.n)).toEqual([1, 2]);
    expect(r.toolCalls).toEqual([
      { n: 1, name: "search_org_history", argsSha256: expect.stringMatching(/^sha256:/), resultSha256: expect.stringMatching(/^sha256:/), resultBytes: expect.any(Number), label: null },
      { n: 2, name: "read_org_file", argsSha256: expect.stringMatching(/^sha256:/), resultSha256: expect.stringMatching(/^sha256:/), resultBytes: expect.any(Number), label: null }]);
    expect(JSON.stringify(r.toolCalls)).not.toMatch(/cleanup|members\/notes/);
    expect(r.progress.at(-1)).toMatchObject({ requests: 2, toolCalls: 2, costUsd: 0.007 });
  }));

  it("caps: requests (6), tool calls (12), three refusals, result size, context bytes — each with its label and no further request", () => unit(async ({ run }) => {
    const loop = tools([["search_org_history", { query: "x" }]]);
    const a = await run({ steps: [loop] });
    expect([a.end?.label, a.end?.state, a.bodies.length, a.ledger.every((l: any) => l.state === "settled")]).toEqual(["chat_cap_requests", "stopped", 6, true]);
    const b = await run({ steps: [tools(Array.from({ length: 5 }, () => ["search_org_history", { query: "x" }] as [string, unknown]))] });
    expect([b.end?.label, b.bodies.length, b.toolCalls.length]).toEqual(["chat_cap_tools", 3, 12]);
    const c = await run({ steps: [tools([["send_email", { to: "everyone@exna.test" }]])] });
    expect([c.end?.label, c.bodies.length, c.toolCalls.map((t) => t.label)]).toEqual(["chat_tool_refused", 3, ["chat_tool_unknown", "chat_tool_unknown", "chat_tool_unknown"]]);
    expect(c.bodies[1].messages.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1_0", content: '{"error":"chat_tool_unknown"}' });
    const big = await run({ steps: [loop], tools: echoTools(() => "x".repeat(SLICE1_TURN_CAPS.resultBytes + 1)) });
    expect([big.end?.label, big.toolCalls[0].label, big.toolCalls[0].resultSha256]).toEqual(["chat_tool_refused", "chat_tool_result_too_large", null]);
    const ctx = await run({ steps: [tools([["read_org_file", { path: "a" }], ["read_org_file", { path: "b" }], ["read_org_file", { path: "c" }], ["read_org_file", { path: "d" }], ["read_org_file", { path: "e" }]])],
      tools: echoTools(() => "y".repeat(30_000)) });
    expect([ctx.end?.label, ctx.toolCalls.length]).toEqual(["chat_cap_context", 5]);
  }));

  it("money: the turn's $ cap before send, the org's monthly cap (chat_org_cap), and settlement at the provider's cost", () => unit(async ({ run }) => {
    const pricey = await run({ steps: [{ ...tools([["search_org_history", { query: "x" }]]), cost: 0.45 } as Step] });
    expect([pricey.end?.label, pricey.bodies.length, pricey.ledger.map((l: any) => l.cost_usd)]).toEqual(["chat_cap_usd", 2, [0.45, 0.45]]);
    const org = await run({ steps: [answer("x")], monthlyUsd: 0.01 });
    expect([org.end?.label, org.bodies.length, org.ledger]).toEqual(["chat_org_cap", 0, []]);
    const small = interactiveFromHosted("or-test-chat", OPENROUTER_PROFILES.sonnet, { caps: { ...SLICE1_TURN_CAPS, usd: 0.05 } });
    const tiny = await run({ steps: [answer("x")], profile: small });
    expect([tiny.end?.label, tiny.bodies.length]).toEqual(["chat_cap_usd", 0]);
  }));

  it("stop with a request in flight: aborted, the entry held unsettled, the turn 'unsettled'; wall cap; member removed; R-8 gate", () => unit(async ({ run }) => {
    const s = await run({ steps: [tools([["search_org_history", { query: "x" }]])], abortAfter: 1 });
    expect([s.end?.label, s.end?.state]).toEqual(["hosted_aborted_after_send", "unsettled"]);
    expect(s.ledger.map((l: any) => [l.state, l.reason])).toEqual([["settled", null], ["unsettled", "hosted_aborted_after_send"]]);
    let t = 0;
    const wall = await run({ steps: [tools([["search_org_history", { query: "x" }]])], nowMs: () => (t += 70_000) });
    expect([wall.end?.label, wall.bodies.length]).toEqual(["chat_cap_wall", 1]);
    let active = true;
    const gone = await run({ steps: [tools([["search_org_history", { query: "x" }]])], memberActive: () => { const a = active; active = false; return a; } });
    expect([gone.end?.label, gone.end?.state, gone.bodies.length]).toEqual(["chat_member_inactive", "failed", 1]);
    // R-8 gate: a `pending:` profile makes no request without an injected FAKE fetch; the pinned (qualified) profile does.
    const pendingProfile = interactiveFromHosted("or-test-pending-chat", OPENROUTER_PROFILES.sonnet);
    const pending = await run({ steps: [answer("x")], allowUnqualified: false, profile: pendingProfile });
    expect([pending.end?.label, pending.bodies.length]).toEqual(["chat_profile_not_qualified", 0]);
    const qualified = await run({ steps: [answer("x")], allowUnqualified: false });
    expect([qualified.end, qualified.bodies.length]).toEqual([null, 1]);
  }));

  it("provider outcomes keep the hosted ledger meaning: 429 released, truncation settled at cost, 5xx unsettled", () => unit(async ({ run }) => {
    const json = (v: unknown, status: number) => () => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    const r429 = await run({ steps: [json({ error: { code: 429, message: "slow down" } }, 429)] });
    expect([r429.end?.label, r429.end?.state, r429.ledger.map((l: any) => [l.state, l.reason])]).toEqual(["hosted_http_429:code=429", "failed", [["released", "hosted_http_429:code=429"]]]);
    const trunc = await run({ steps: [{ text: "Partial", finish: "length", cost: 0.02 }] });
    expect([trunc.end?.label, trunc.ledger.map((l: any) => [l.state, l.cost_usd])]).toEqual(["chat_output_truncated", [["settled", 0.02]]]);
    const r5 = await run({ steps: [() => new Response("x", { status: 503 })] });
    expect([r5.end?.label, r5.end?.state, r5.ledger.map((l: any) => l.state)]).toEqual(["hosted_http_5xx", "unsettled", ["unsettled"]]);
    for (const l of CHAT_STOP_REASONS) expect(failureLabel(new Error(l))).toBe(l);
  }));

  it("through the org runtime: a turn answers, the turn row has requests and cost; stop in flight -> unsettled; restart -> unsettled, never replayed", async () => {
    let hang = false;
    const m = model([tools([["search_org_history", { query: "cleanup" }]]), answer("I could not find it in the files.")]);
    const w = await transcriptionWorld({ chat: {}, fetch: async (u, init) => hang ? new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))) : m.fetch(u, init) });
    try {
      const api = (path: string, body: unknown) => w.post(`/o/exna/api/chat/${path}`, body, w.alex);
      // WC-3: an empty folder ends a turn chat_no_files before any request; one unrelated file keeps this test about the loop.
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, "members/notes/2026-10-08.v1.md"), "# October\nThe pool closes Sept 7.\n");
      const conv = (await api("conversation/create", {})).result.conversationId;
      const t1 = (await api("turn/start", { conversationId: conv, clientRequestId: "req-s000001", text: "When is the cleanup?" })).result.turnId;
      for (let i = 0; i < 200 && !(await api("turn/read", { turnId: t1 })).result.terminal; i++) await new Promise((r) => setTimeout(r, 20));
      const r1 = (await api("turn/read", { turnId: t1 })).result;
      // C-4 tools are installed: the search runs over the turn's snapshot (no file mentions the cleanup: no matches), then the answer.
      expect(r1.turn).toMatchObject({ state: "done", requests: 2, toolCalls: 1, costUsd: 0.007 });
      expect(r1.messages.at(-1).text).toBe("I could not find it in the files.");
      expect(w.org.sqlite.db.prepare("SELECT n, label FROM chat_tool_calls WHERE turn_id=?").all(t1)).toEqual([{ n: 1, label: null }]);
      expect(w.org.sqlite.db.prepare("SELECT e.state FROM chat_turn_requests r JOIN effects e ON e.key=r.ledger_key WHERE r.turn_id=? ORDER BY r.n").all(t1)).toEqual([{ state: "settled" }, { state: "settled" }]);
      // Stop while a request is in flight.
      hang = true;
      const t2 = (await api("turn/start", { conversationId: conv, clientRequestId: "req-s000002", text: "And the time?" })).result.turnId;
      for (let i = 0; i < 100 && (await api("turn/read", { turnId: t2 })).result.turn.requests < 1; i++) await new Promise((r) => setTimeout(r, 20));
      await api("turn/stop", { turnId: t2 });
      for (let i = 0; i < 200 && !(await api("turn/read", { turnId: t2 })).result.terminal; i++) await new Promise((r) => setTimeout(r, 20));
      expect((await api("turn/read", { turnId: t2 })).result.turn).toMatchObject({ state: "unsettled", stopReason: "chat_stopped_by_member" });
      expect(w.org.sqlite.db.prepare("SELECT e.state, e.reason FROM chat_turn_requests r JOIN effects e ON e.key=r.ledger_key WHERE r.turn_id=?").all(t2)).toEqual([{ state: "unsettled", reason: "hosted_aborted_after_send" }]);
      // An unsettled turn does not block the next one; a restart mid-request leaves it unsettled and does not replay it.
      const t3 = (await api("turn/start", { conversationId: conv, clientRequestId: "req-s000003", text: "One more" })).result.turnId;
      for (let i = 0; i < 100 && (await api("turn/read", { turnId: t3 })).result.turn.requests < 1; i++) await new Promise((r) => setTimeout(r, 20));
      const sent = m.bodies.length;
      await w.restart();
      expect(w.org.sqlite.db.prepare("SELECT state, stop_reason FROM chat_turns WHERE id=?").get(t3)).toEqual({ state: "unsettled", stop_reason: "chat_turn_interrupted" });
      expect(m.bodies.length).toBe(sent);
      // P-2: polling never trips a hub limiter (the hub has none on api/ routes today; only login, invite and upload are
      // limited). 120 polls back-to-back (a 2-minute turn at 1 s) all answer.
      const polls = await Promise.all(Array.from({ length: 120 }, () => api("turn/read", { turnId: t1 })));
      expect(polls.every((p) => p.ok && p.result.turn.state === "done")).toBe(true);
      const st = (await w.ops("/ops/status")).chat;
      expect(st).toMatchObject({ profileId: "or-sonnet-4-6-us-chat", qualificationRef: "sha256:9240278e1d9979016e6c4bf4b82634ec567af24dc6a2806e8da17b287b8267a7", activeTurns: 0 });
    } finally { await w.close(); }
  }, 120_000);
});
