// TEAM-TASKS-V1 T2a (Fable T1 N-2, N-5): the production executor = the chat's ONE bounded loop, the same pinned profile and
// tool catalog, the org's one hosted ledger (keys teamtask:<attemptId>:<n>), reading only the frozen sources; the org's ONE
// model slot shared with chat; the approval rechecked before every request. Real org runtime + hub; a scripted FAKE provider.
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import { INTERACTIVE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";
import { taskToolCatalogHash, toolCatalogHash } from "../src/agent-kit/interactive/catalog.js";
import { teamTaskExecutor, teamTaskToolHost, isPreambleOnly, citesSnapshot, TEAMTASK_RULES_INLINE, TEAMTASK_INLINE_ASK, TEAMTASK_RULES, TEAMTASK_FINAL, TEAMTASK_INLINE_BYTES, TEAMTASK_CONTINUE, TEAMTASK_CUT_LINE, TEAMTASK_MAX_OUTPUT_TOKENS } from "../src/org/teamtasks/executor.js";
import { interactiveFromHosted, taskProfileHash } from "../src/agent-kit/interactive/profile.js";
import { OPENROUTER_PROFILES } from "../src/agent-kit/hosted/openrouter.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const P = INTERACTIVE_PROFILES.sonnet;
type Step = { text?: string | null; calls?: [string, unknown][]; cost?: number } | ((init: any) => Promise<Response> | Response);
function model(steps: Step[]) {
  const bodies: any[] = []; let i = 0;
  const fetch = async (_u: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    const s = steps[Math.min(i++, steps.length - 1)];
    if (typeof s === "function") return s(init);
    const tool_calls = s.calls?.map(([name, args], k) => ({ id: `call_${bodies.length}_${k}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
    return new Response(JSON.stringify({ id: "gen-" + bodies.length, model: P.runtime.model, provider: "Amazon Bedrock",
      choices: [{ finish_reason: tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: s.text ?? null, ...(tool_calls ? { tool_calls } : {}) } }],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: s.cost ?? 0.004 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, bodies };
}
const DRAFT = "# Newsletter draft\nThe cleanup is on Oct 31 [members/notes/2026-10-08.md#L2].\n\nUnknown or not stated: the time.";

// Fable N-1 on 0091459e: the backstop on its own (the transport's tools-off check makes it unreachable in a run): an inline
// snapshot refuses both reads with the fixed label and never touches the files; a listed (not inline) one still reads.
it("tool host backstop: inline sources refuse read_org_file and search_org_history (teamtask_source_inline); listed sources read", async () => {
  const lines = ["# Notes", "The cleanup is on Oct 31."], files = new Map([["members/notes/a.md", { path: "members/notes/a.md", sha256: "x", bytes: 30, lines }]]);
  let touched = 0;
  const watched = new Proxy(files, { get(t, k, r) { if (k === "get" || k === "values" || k === "has" || k === Symbol.iterator) touched++; const v = Reflect.get(t, k, r); return typeof v === "function" ? v.bind(t) : v; } });
  const snap = (inline: boolean) => ({ snapshot: { hash: "h", roots: ["members"], files: watched as never }, why: () => null, inline });
  const ctx = { turnId: "tta_1", conversationId: "tt_1", memberId: "teamtask", scope: "member" as const, signal: new AbortController().signal };
  const host = teamTaskToolHost(new Map([["tta_1", snap(true)]]));
  expect(await host.call("read_org_file", JSON.stringify({ path: "members/notes/a.md" }), ctx)).toEqual({ ok: false, error: "teamtask_source_inline" });
  expect(await host.call("search_org_history", JSON.stringify({ query: "cleanup" }), ctx)).toEqual({ ok: false, error: "teamtask_source_inline" });
  expect(await host.call("write_draft_artifact", "{}", ctx)).toEqual({ ok: false, error: "teamtask_tool_not_admitted" });
  expect(await host.call("list_site_images", "{}", ctx)).toEqual({ ok: false, error: "teamtask_tool_not_admitted" }); // Package F: chat drafts only
  expect(touched).toBe(0); // the snapshot was never read
  const listed = teamTaskToolHost(new Map([["tta_1", snap(false)]]));
  const r = await listed.call("read_org_file", JSON.stringify({ path: "members/notes/a.md" }), ctx);
  expect(r.ok).toBe(true);
  expect(touched).toBeGreaterThan(0);
});

// The 62cea80c requal: what counts as "only announced a step" (synthetic text; legitimate short results are never caught).
it("citesSnapshot: a <snapshot path>#L<digits> marker for a path IN the snapshot; anything else does not count", () => {
  const paths = ["members/notes/2026-10-08.md", "members/shared/a.md"];
  expect(citesSnapshot("x [members/notes/2026-10-08.md#L2]", paths)).toBe(true);
  expect(citesSnapshot("x [members/shared/a.md#L10-L12]", paths)).toBe(true);
  expect(citesSnapshot("x [members/notes/other.md#L2]", paths)).toBe(false); // not a snapshot path
  expect(citesSnapshot("x members/notes/2026-10-08.md#L", paths)).toBe(false); // no digits
  expect(citesSnapshot("x members/notes/2026-10-08.md#Lx members/notes/2026-10-08.md#L3", paths)).toBe(true); // a later valid one counts
  expect(citesSnapshot("no markers at all", paths)).toBe(false);
});

it("isPreambleOnly: short, no marker, no Unknown section, opening with an announced action", () => {
  for (const t of ["I'll save the newsletter draft now.", "Let me search the organization's files for the budget.", "I will render a preview, then save it.",
    "First, I need to read the notes.", "Now I'll write the manual.", "Sure, I'll get started on that."]) expect([t, isPreambleOnly(t)]).toEqual([t, true]);
  for (const t of ["The cleanup is on Oct 31 [members/notes/2026-10-08.md#L2].", "Unknown or not stated: the 2027 sponsor budget.",
    "Volunteers are needed Sunday, Nov 8.", "I'll be brief: the cleanup is on Oct 31 [members/notes/a.md#L2].", "Let me know if anything is missing.\n\nUnknown or not stated: the time.",
    "I'll " + "x".repeat(700)]) expect([t.slice(0, 40), isPreambleOnly(t)]).toEqual([t.slice(0, 40), false]);
});

it("a pending profile is not an executor: approvals refuse until the profile is qualified", () => {
  const pending = interactiveFromHosted("or-sonnet-4-6-us-chat", OPENROUTER_PROFILES.sonnet);
  expect(teamTaskExecutor({ profile: pending, secretFile: "/nonexistent", ledger: null as never }).qualified).toBe(false);
  expect(teamTaskExecutor({ profile: P, secretFile: "/nonexistent", ledger: null as never })).toMatchObject({ qualified: true, id: "bounded-runner/v1:or-sonnet-4-6-us-chat" });
});

describe.skipIf(!enabled)("team tasks: the production executor (T2a)", () => {
  // big: one more file past the inline size, so the sources are listed (not inlined) and the reading tools stay on (Fable N-1).
  async function setup(steps: Step[], o: { big?: boolean; empty?: boolean } = {}) {
    const m = model(steps);
    const w = await transcriptionWorld({ chat: {}, teamTasks: "run", fetch: m.fetch as never });
    mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
    if (!o.empty) writeFileSync(join(w.cfg.folder, "members", "notes", "2026-10-08.md"), "# Notes\nThe cleanup is on Oct 31.\n");
    if (o.big) writeFileSync(join(w.cfg.folder, "members", "notes", "big.md"), "# Big\n" + "x".repeat(TEAMTASK_INLINE_BYTES) + "\n");
    const api = (p: string, b: unknown, c = w.alex) => w.post(`/o/exna/api/${p}`, b, c);
    const task = async () => { const t = (await api("teamtask/create", { clientRequestId: "req-" + randomUUID().slice(0, 8), title: "Draft next month's newsletter", notes: "From the approved notes." })).result;
      const p = (await api("teamtask/propose", { taskId: t.taskId, expectedRevision: 1 })).result; return { t, p }; };
    const read = async (taskId: string) => (await api("teamtask/read", { taskId })).result;
    const ledger = (attemptId: string) => w.org.sqlite.db.prepare("SELECT key, state, cost_usd FROM effects WHERE key LIKE ? ORDER BY key").all(`teamtask:${attemptId}:%`) as any[];
    const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 300 && !(await f()); i++) await new Promise((r) => setTimeout(r, 20)); };
    return { w, m, api, task, read, ledger, until, close: () => w.close() };
  }

  it("one bounded loop: the chat profile + catalog, frozen sources only, no artifact/effect tool, ledger keys teamtask:<attemptId>:<n>, verified text result", async () => {
    const s = await setup([{ calls: [["search_org_history", { query: "cleanup" }]] }, { calls: [["write_draft_artifact", { kind: "newsletter", content: {} }], ["read_org_file", { path: "members/notes/2026-10-08.md" }]] }, { text: DRAFT }], { big: true });
    try {
      const { t, p } = await s.task();
      // Evidence-inheritance (A): the plan binds the TASK view (two tools; the profile with that catalog), not the chat catalog.
      expect(p.plan.pins).toMatchObject({ executor: "bounded-runner/v1:or-sonnet-4-6-us-chat", toolCatalogHash: taskToolCatalogHash(), profileHash: taskProfileHash(INTERACTIVE_PROFILES.sonnet) });
      writeFileSync(join(s.w.cfg.folder, "members", "notes", "2026-10-08.md"), "# Notes\nCHANGED AFTER THE PLAN.\n");
      expect((await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest)).ok).toBe(true);
      await s.until(async () => ["result_ready", "failed", "needs_reconciliation"].includes((await s.read(t.taskId)).attempts[0].state));
      const a = (await s.read(t.taskId)).attempts[0];
      expect(a).toMatchObject({ state: "result_ready", report: { kind: "text", producer: "org-agent:exna/bounded-runner/v1:or-sonnet-4-6-us-chat" } });
      expect((await s.api("teamtask/read", { taskId: t.taskId, resultId: a.report.resultId })).result.text).toBe(DRAFT);
      // The same profile/catalog as chat; the fixed task rules + the approved instructions; the frozen bytes, not the changed file.
      expect(s.m.bodies).toHaveLength(3);
      expect(s.m.bodies[0].tools.map((x: any) => x.function.name)).toEqual(["read_org_file", "search_org_history"]);
      expect(s.m.bodies[0].messages[0].content).toContain(TEAMTASK_RULES);
      expect(s.m.bodies[0].messages[0].content).toContain(p.plan.instructions);
      const toolMsgs = s.m.bodies[2].messages.filter((x: any) => x.role === "tool").map((x: any) => x.content);
      expect(toolMsgs.join("\n")).toContain("The cleanup is on Oct 31.");
      expect(toolMsgs.join("\n")).not.toContain("CHANGED AFTER THE PLAN");
      expect(toolMsgs).toContain(JSON.stringify({ error: "teamtask_tool_not_admitted" })); // no artifact store, no effect
      expect(s.ledger(p.attemptId)).toEqual([1, 2, 3].map((n) => ({ key: `teamtask:${p.attemptId}:${n}`, state: "settled", cost_usd: 0.004 })));
    } finally { await s.close(); }
  });

  // Owner live run (Oct 23): "Create a user manual" over 15 files ended with nothing (chat_tool_calls_too_many: one answer asked
  // for more reads at once than allowed). Now: small source sets are in the prompt in full; when reading runs out, ONE final
  // request with tools off asks for the best draft, inside the same limits.
  it("the owner's failure: one answer asking for 13 reads -> a final no-tool request -> a result (sources over the inline size)", async () => {
    const R = (n: number) => Array.from({ length: n }, () => ["read_org_file", { path: "members/notes/2026-10-08.md" }] as [string, unknown]);
    const s = await setup([{ calls: R(13) }, { text: "Partial draft.\n" + DRAFT }], { big: true });
    try {
      const { t, p } = await s.task();
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await s.until(async () => !["approved", "running"].includes((await s.read(t.taskId)).attempts[0].state));
      const a = (await s.read(t.taskId)).attempts[0];
      expect(a.state).toBe("result_ready");
      expect((await s.api("teamtask/read", { taskId: t.taskId, resultId: a.report.resultId })).result.text).toBe("Partial draft.\n" + DRAFT);
      expect(s.m.bodies).toHaveLength(2);
      expect(s.m.bodies[0].tool_choice).toBe("auto");
      expect(s.m.bodies[0].messages[0].content).toContain("- members/notes/big.md (2 lines)"); // listed: the reading tools are on
      expect(s.m.bodies[1].tool_choice).toBe("none");
      expect(s.m.bodies[1].tools).toHaveLength(2); // evidence-inheritance (A): only read + search (Package F/P chat tools never reach a task) (refused in tasks); // the catalog still goes (earlier messages may hold tool calls)
      expect(s.m.bodies[1].messages.at(-1)).toEqual({ role: "user", content: TEAMTASK_FINAL });
      expect(s.ledger(p.attemptId).map((x) => x.state)).toEqual(["settled", "settled"]); // the rejected answer was billed and settled
    } finally { await s.close(); }
  });

  // Fable N-1 on the b05ab12e live run (5bbc6d0b): the broad run wrote a big draft, then made an unneeded read and paid a second
  // full request. When every source is inline: tools off on EVERY request, and a read that still comes back is refused with a
  // fixed label before the snapshot is touched. An inlined source costs zero reads.
  it("inline sources: tools off on every request, one request, zero reads; a reply that calls a tool anyway is refused before any tool runs", async () => {
    const s = await setup([{ text: DRAFT }]);
    try {
      const { t, p } = await s.task();
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await s.until(async () => !["approved", "running"].includes((await s.read(t.taskId)).attempts[0].state));
      expect((await s.read(t.taskId)).attempts[0].state).toBe("result_ready");
      expect(s.m.bodies).toHaveLength(1); // one request, no read round trip
      // The 62cea80c requal: NO catalog and no tool_choice at all (the catalog told the model to save/render); the inline rules
      // say there are no tools and the reply is the result; the tool sentences are gone.
      expect(s.m.bodies[0]).not.toHaveProperty("tools");
      expect(s.m.bodies[0]).not.toHaveProperty("tool_choice");
      const sys = s.m.bodies[0].messages[0].content;
      expect(sys.startsWith(TEAMTASK_RULES_INLINE)).toBe(true);
      expect(sys).not.toMatch(/read_org_file|search_org_history|write_draft_artifact|render_newsletter_preview/);
      expect(sys).toContain("<<< members/notes/2026-10-08.md\n1: # Notes\n2: The cleanup is on Oct 31.\n>>>");
      expect(s.m.bodies[0].messages.at(-1)).toEqual({ role: "user", content: TEAMTASK_INLINE_ASK });
    } finally { await s.close(); }
    // A provider that ignores tool_choice and asks to read the inlined file (and to search) anyway: the transport's existing
    // tools-off check refuses that reply (chat_finish_inconsistent, as for the final request) before any tool runs; the run ends
    // failed after ONE billed request, nothing is read and nothing is retried. (The tool host's teamtask_source_inline refusal is
    // the backstop behind it.)
    const x = await setup([{ calls: [["read_org_file", { path: "members/notes/2026-10-08.md" }], ["search_org_history", { query: "cleanup" }]] }, { text: DRAFT }]);
    try {
      const { t, p } = await x.task();
      await x.w.act(x.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await x.until(async () => !["approved", "running"].includes((await x.read(t.taskId)).attempts[0].state));
      expect((await x.read(t.taskId)).attempts[0]).toMatchObject({ state: "failed", label: "chat_finish_inconsistent" });
      expect(x.m.bodies).toHaveLength(1); // one request; no tool result was ever produced
      expect(x.m.bodies[0]).not.toHaveProperty("tools");
      expect(x.ledger(p.attemptId)).toEqual([{ key: `teamtask:${p.attemptId}:1`, state: "settled", cost_usd: 0.004 }]);
    } finally { await x.close(); }
  });

  // The 62cea80c requal (0/4): with tools off, every reply only ANNOUNCED a step and stopped. Such a reply is not a result: the
  // attempt fails with a fixed label, never Result ready (one billed request, no retry).
  it("a preamble-only reply ('I'll save the draft first...') is refused (teamtask_result_preamble), never Result ready", async () => {
    const s = await setup([{ text: "I'll put the draft together and save it for the team first." }]);
    try {
      const { t, p } = await s.task();
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await s.until(async () => !["approved", "running"].includes((await s.read(t.taskId)).attempts[0].state));
      const a = (await s.read(t.taskId)).attempts[0];
      expect(a).toMatchObject({ state: "failed", label: "teamtask_result_preamble", report: null });
      expect(s.m.bodies).toHaveLength(1);
      expect(s.ledger(p.attemptId)).toEqual([{ key: `teamtask:${p.attemptId}:1`, state: "settled", cost_usd: 0.004 }]);
    } finally { await s.close(); }
  });

  // Fable R-C (c9651b4e, 0630a159): THE gate is structural. Files > 0 -> the result (complete or partial) must cite a snapshot
  // path as path#L<digits>, else failed teamtask_result_uncited, no result, one billed request. 0 files -> no check.
  it("R-C: the five texts Fable listed, over a snapshot with files, are refused (uncited, or preamble where it fires first); never Result ready", async () => {
    const five = ["The newsletter draft follows once I save it to the artifact store.", "Here is the plan: I will save the draft, then render the preview.",
      "To begin, the manual will be saved as a draft artifact and a preview rendered.", "Volunteers are needed Sunday, Nov 8.", "I'll save the draft now. ".repeat(40)];
    for (const text of five) {
      const s = await setup([{ text }]);
      try {
        const { t, p } = await s.task();
        await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
        await s.until(async () => !["approved", "running"].includes((await s.read(t.taskId)).attempts[0].state));
        const a = (await s.read(t.taskId)).attempts[0];
        expect([text.slice(0, 30), a.state, a.label, a.report]).toEqual([text.slice(0, 30), "failed", "teamtask_result_uncited", null]);
        expect(s.ledger(p.attemptId)).toEqual([{ key: `teamtask:${p.attemptId}:1`, state: "settled", cost_usd: 0.004 }]);
      } finally { await s.close(); }
    }
  });
  it("R-C: 0 files -> an uncited answer is a result; files > 0 -> a cited 'nothing found' + Unknown is a result; an uncited PARTIAL is refused", async () => {
    const run = async (steps: Step[], o: { empty?: boolean } = {}) => { const s = await setup(steps, o);
      try { const { t, p } = await s.task(); await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
        await s.until(async () => !["approved", "running"].includes((await s.read(t.taskId)).attempts[0].state));
        return { a: (await s.read(t.taskId)).attempts[0], files: p.plan.sources.files };
      } finally { await s.close(); } };
    const none = await run([{ text: "There is nothing to draft from yet; add notes first." }], { empty: true });
    expect([none.files, none.a.state]).toEqual([0, "result_ready"]); // (a) no files, no check
    const cited = await run([{ text: "Nothing relevant was found. Unknown or not stated: the 2027 budget. [members/notes/2026-10-08.md#L2]" }]);
    expect([cited.files, cited.a.state]).toEqual([1, "result_ready"]); // (c)
    const cut = (text: string) => async () => new Response(JSON.stringify({ id: "g", model: P.runtime.model, provider: "Amazon Bedrock",
      choices: [{ finish_reason: "length", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 900, completion_tokens: 16384, total_tokens: 17284, cost: 0.004 } }), { status: 200, headers: { "content-type": "application/json" } });
    const partial = await run(Array.from({ length: 6 }, (_, i) => cut(`Part ${i + 1}, no citation. `)));
    expect([partial.a.state, partial.a.label, partial.a.report]).toEqual(["failed", "teamtask_result_uncited", null]); // (d) partial, uncited
  });

  it("the last request slot is the final answer; the tool cap mid-answer answers the rest with the cap, then the final answer; a final answer that still calls tools fails with the cap", async () => {
    const one = { calls: [["search_org_history", { query: "cleanup" }]] as [string, unknown][] };
    const s = await setup([one, one, one, one, one, { text: DRAFT }], { big: true });
    try {
      const { t, p } = await s.task();
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await s.until(async () => !["approved", "running"].includes((await s.read(t.taskId)).attempts[0].state));
      expect((await s.read(t.taskId)).attempts[0].state).toBe("result_ready");
      expect(s.m.bodies.map((b) => b.tool_choice)).toEqual(["auto", "auto", "auto", "auto", "auto", "none"]); // 6 requests, the plan's limit
      expect(s.m.bodies[5].messages.at(-1)).toEqual({ role: "user", content: TEAMTASK_FINAL });
    } finally { await s.close(); }
    const R = (n: number) => Array.from({ length: n }, () => ["search_org_history", { query: "cleanup" }] as [string, unknown]);
    const c = await setup([{ calls: R(12) }, { calls: R(2) }, { text: DRAFT }], { big: true });
    try {
      const { t, p } = await c.task();
      await c.w.act(c.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await c.until(async () => !["approved", "running"].includes((await c.read(t.taskId)).attempts[0].state));
      expect((await c.read(t.taskId)).attempts[0].state).toBe("result_ready");
      const last = c.m.bodies[2];
      expect(last.tool_choice).toBe("none");
      expect(last.messages.filter((x: any) => x.role === "tool").slice(-2).map((x: any) => x.content)).toEqual([JSON.stringify({ error: "chat_cap_tools" }), JSON.stringify({ error: "chat_cap_tools" })]);
    } finally { await c.close(); }
    const f = await setup([{ calls: R(13) }, { calls: R(1) }], { big: true });
    try {
      const { t, p } = await f.task();
      await f.w.act(f.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await f.until(async () => !["approved", "running"].includes((await f.read(t.taskId)).attempts[0].state));
      expect((await f.read(t.taskId)).attempts[0]).toMatchObject({ state: "failed", label: "chat_tool_calls_too_many" });
      expect(f.m.bodies).toHaveLength(2); // exactly one final request, never a third
    } finally { await f.close(); }
  }, 30_000);

  it("sources over the inline size are listed, not inlined; a chat turn keeps today's behaviour (no final request)", async () => {
    const s = await setup([{ text: DRAFT }, { calls: Array.from({ length: 13 }, () => ["search_org_history", { query: "x" }] as [string, unknown]) }]);
    try {
      writeFileSync(join(s.w.cfg.folder, "members", "notes", "big.md"), "# Big\n" + "x".repeat(TEAMTASK_INLINE_BYTES) + "\n");
      const { t, p } = await s.task();
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await s.until(async () => (await s.read(t.taskId)).attempts[0].state === "result_ready");
      expect(s.m.bodies[0].messages[0].content).toContain("- members/notes/big.md (2 lines)");
      expect(s.m.bodies[0].messages[0].content).not.toContain("<<< ");
      const conv = (await s.api("chat/conversation/create", {})).result.conversationId;
      const turn = (await s.api("chat/turn/start", { conversationId: conv, clientRequestId: "req-final001", text: "Read everything." })).result.turnId;
      await s.until(async () => (await s.api("chat/turn/read", { turnId: turn })).result.terminal);
      expect(s.m.bodies).toHaveLength(2); // the chat turn: one request, no final no-tool request
      expect(s.m.bodies[1].tool_choice).toBe("auto");
    } finally { await s.close(); }
  }, 30_000);

  // Owner live run (Oct 23, tta_b32361e0): a 61 KB "user manual" reply hit the 4,096-token limit and was thrown away. Now a task
  // writes up to 16k per request; a reply cut off at the limit is KEPT and the same draft continues while the limits allow.
  const cutReply = (text: string, cost = 0.004, model = P.runtime.model) => () => new Response(JSON.stringify({ id: "g", model, provider: "Amazon Bedrock",
    choices: [{ finish_reason: "length", message: { role: "assistant", content: text } }], usage: { prompt_tokens: 900, completion_tokens: 900, total_tokens: 1800, cost } }),
    { status: 200, headers: { "content-type": "application/json" } });
  const runTask = async (s: any) => { const { t, p } = await s.task(); await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
    await s.until(async () => !["approved", "running"].includes((await s.read(t.taskId)).attempts[0].state));
    const a = (await s.read(t.taskId)).attempts[0]; return { t, p, a, text: a.report ? (await s.api("teamtask/read", { taskId: t.taskId, resultId: a.report.resultId })).result.text : null }; };
  it("long output: a cut-off reply is kept and continued (tools off, same draft); the task asks for up to 16k tokens, chat stays at 4,096", async () => {
    const s = await setup([cutReply("# Manual\n\nPart one [members/notes/2026-10-08.md#L2], "), { text: "part two." }, cutReply("chat cut")], { big: true });
    try {
      const { p, a, text } = await runTask(s);
      expect([a.state, text, a.partial]).toEqual(["result_ready", "# Manual\n\nPart one [members/notes/2026-10-08.md#L2], part two.", null]); // appended, never restarted; complete
      expect(s.m.bodies.map((b) => [b.max_tokens, b.tool_choice])).toEqual([[TEAMTASK_MAX_OUTPUT_TOKENS, "auto"], [TEAMTASK_MAX_OUTPUT_TOKENS, "none"]]);
      expect(s.m.bodies[1].messages.slice(-2)).toEqual([{ role: "assistant", content: "# Manual\n\nPart one [members/notes/2026-10-08.md#L2], " }, { role: "user", content: TEAMTASK_CONTINUE }]);
      expect(s.ledger(p.attemptId).map((x: any) => x.state)).toEqual(["settled", "settled"]);
      // Chat is unchanged: 4,096, and a cut-off reply still ends the turn (chat_output_truncated), no continuation.
      const conv = (await s.api("chat/conversation/create", {})).result.conversationId;
      const turn = (await s.api("chat/turn/start", { conversationId: conv, clientRequestId: "req-long0001", text: "Hi" })).result.turnId;
      await s.until(async () => (await s.api("chat/turn/read", { turnId: turn })).result.terminal);
      expect(s.m.bodies[2].max_tokens).toBe(4096);
      expect((await s.api("chat/turn/read", { turnId: turn })).result.turn).toMatchObject({ state: "failed", stopReason: "chat_output_truncated" });
      expect(s.m.bodies).toHaveLength(3);
    } finally { await s.close(); }
  }, 30_000);

  it("long output: still cut off when the requests run out -> what was written + the cut-off line, a RESULT (not a failure); a refused continuation keeps it too; the $ cap stops a continuation", async () => {
    const s = await setup([cutReply("A1 [members/notes/2026-10-08.md#L2] "), cutReply("A2 "), cutReply("A3 "), cutReply("A4 "), cutReply("A5 "), cutReply("A6 ")]);
    try {
      const { p, a, text } = await runTask(s);
      expect([a.state, text, a.partial]).toEqual(["result_ready", "A1 [members/notes/2026-10-08.md#L2] A2 A3 A4 A5 A6\n\n" + TEAMTASK_CUT_LINE, "chat_cap_requests"]); // Q2: why it is partial, content-free
      expect(s.ledger(p.attemptId)).toHaveLength(6); // the plan's 6 requests, never a 7th
    } finally { await s.close(); }
    const r = await setup([cutReply("B1 [members/notes/2026-10-08.md#L2] "), cutReply("ignored", 0.004, "some/other-model")]); // the continuation is refused (model mismatch, settled)
    try {
      const { p, a, text } = await runTask(r);
      expect([a.state, text, a.partial]).toEqual(["result_ready", "B1 [members/notes/2026-10-08.md#L2]\n\n" + TEAMTASK_CUT_LINE, "hosted_model_mismatch"]);
      expect(r.ledger(p.attemptId).map((x: any) => x.state)).toEqual(["settled", "settled"]);
    } finally { await r.close(); }
    const u = await setup([cutReply("C1 [members/notes/2026-10-08.md#L2] ", 0.6)]); // after a $0.60 reply a 16k continuation cannot be reserved under the $1 cap
    try {
      const { p, a, text } = await runTask(u);
      expect([a.state, text, a.partial]).toEqual(["result_ready", "C1 [members/notes/2026-10-08.md#L2]\n\n" + TEAMTASK_CUT_LINE, "chat_cap_usd"]);
      expect(u.ledger(p.attemptId)).toHaveLength(1);
    } finally { await u.close(); }
  }, 60_000);

  it("N-5: the org's ONE model slot: a running task makes chat busy; a running chat turn holds the task (claimed after it ends); the list states it", async () => {
    let releaseTask: () => void = () => {}, releaseChat: () => void = () => {};
    const gate = (set: (f: () => void) => void, body: () => Response) => async () => { await new Promise<void>((r) => set(r)); return body(); };
    const ok = (text: string) => new Response(JSON.stringify({ id: "g", model: P.runtime.model, provider: "Amazon Bedrock", choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: 0.004 } }), { status: 200, headers: { "content-type": "application/json" } });
    const s = await setup([gate((f) => { releaseTask = f; }, () => ok(DRAFT)), gate((f) => { releaseChat = f; }, () => ok("Chat answer [members/notes/2026-10-08.md#L2].")), () => ok(DRAFT)]);
    try {
      const { t, p } = await s.task();
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await s.until(async () => (await s.read(t.taskId)).attempts[0].state === "running");
      expect((await s.api("teamtask/list", {})).result.scheduler).toMatchObject({ anotherRunInProgress: true });
      const conv = (await s.api("chat/conversation/create", {})).result.conversationId;
      expect((await s.api("chat/turn/start", { conversationId: conv, clientRequestId: "req-busy0001", text: "When is the cleanup?" })).error).toBe("chat_turn_busy");
      releaseTask(); await s.w.org.teamTasks!.idle();
      expect((await s.read(t.taskId)).attempts[0].state).toBe("result_ready");
      // A chat turn now holds the slot; a newly approved task waits (approved, not claimed), then runs after the turn ends.
      const turn = (await s.api("chat/turn/start", { conversationId: conv, clientRequestId: "req-busy0002", text: "When is the cleanup?" })).result.turnId;
      const t2 = await s.task();
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: t2.p.attemptId }, t2.p.planDigest);
      await new Promise((r) => setTimeout(r, 300));
      expect((await s.read(t2.t.taskId)).attempts[0].state).toBe("approved");
      expect((await s.api("teamtask/list", {})).result.scheduler).toMatchObject({ anotherRunInProgress: true, queued: 1 });
      releaseChat();
      await s.until(async () => (await s.api("chat/turn/read", { turnId: turn })).result.terminal);
      await s.until(async () => (await s.read(t2.t.taskId)).attempts[0].state === "result_ready");
      expect((await s.read(t2.t.taskId)).attempts[0].state).toBe("result_ready");
    } finally { await s.close(); }
  }, 30_000);

  it("rechecked before every request: an approver demoted mid-run stops it; a lost answer after send is uncertain (fence held, no rerun)", async () => {
    let demote: () => Promise<void> = async () => {};
    const s = await setup([async () => { await demote(); return new Response(JSON.stringify({ id: "g", model: P.runtime.model, provider: "Amazon Bedrock",
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_org_history", arguments: "{\"query\":\"cleanup\"}" } }] } }],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: 0.004 } }), { status: 200, headers: { "content-type": "application/json" } }); },
      { text: "should never be asked" }], { big: true });
    try {
      const { t, p } = await s.task();
      demote = async () => { await s.w.ops("/ops/member/role", { email: "robin@exna.test", role: "contributor" }); };
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await s.until(async () => !["approved", "running"].includes((await s.read(t.taskId)).attempts[0].state));
      expect((await s.read(t.taskId)).attempts[0]).toMatchObject({ state: "failed", label: "teamtask_scope_not_permitted" });
      expect(s.m.bodies).toHaveLength(1); // the second request was never sent
      expect(s.ledger(p.attemptId)).toEqual([{ key: `teamtask:${p.attemptId}:1`, state: "settled", cost_usd: 0.004 }]);
    } finally { await s.close(); }
    // Fable T2a N-2: a pause mid-run stops it with ITS label (not "approver no longer a reviewer").
    let pause: () => Promise<void> = async () => {};
    const k = await setup([async () => { await pause(); return new Response(JSON.stringify({ id: "g", model: P.runtime.model, provider: "Amazon Bedrock",
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_org_history", arguments: "{\"query\":\"cleanup\"}" } }] } }],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: 0.004 } }), { status: 200, headers: { "content-type": "application/json" } }); }], { big: true });
    try {
      const { t, p } = await k.task();
      pause = async () => { await k.w.ops("/ops/teamtasks/pause", { on: true }); };
      await k.w.act(k.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await k.until(async () => !["approved", "running"].includes((await k.read(t.taskId)).attempts[0].state));
      expect((await k.read(t.taskId)).attempts[0]).toMatchObject({ state: "failed", label: "teamtask_paused" });
    } finally { await k.close(); }
    const u = await setup([() => { throw new TypeError("socket hang up"); }]);
    try {
      const { t, p } = await u.task();
      await u.w.act(u.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      await u.until(async () => !["approved", "running"].includes((await u.read(t.taskId)).attempts[0].state));
      expect((await u.read(t.taskId)).attempts[0]).toMatchObject({ state: "needs_reconciliation", label: "hosted_transport_failed" });
      expect(u.ledger(p.attemptId)).toEqual([expect.objectContaining({ key: `teamtask:${p.attemptId}:1`, state: "unsettled" })]);
      expect((await u.api("teamtask/propose", { taskId: t.taskId, expectedRevision: 1 })).error).toBe("teamtask_outcome_uncertain");
    } finally { await u.close(); }
  });
});
