// Fable B-2 on the H1 brief (FABLE-REVIEW-H1-BUILD-BRIEF.md): with the handbook ABSENT, the first request's system prompt and
// messages for a chat turn, a listed-source task and an inline task are byte-identical to affac339's. The fixtures were captured
// at affac339 (GOLDEN_WRITE=1 writes them; never set in CI). Fake provider; no network.
import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { SqliteAuthority, openSqliteDatabase } from "../src/service/sqlite-authority.js";
import { SqliteSpendLedger } from "../src/service/sqlite-effects.js";
import { INTERACTIVE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";
import { chatRunner } from "../src/org/chat/scheduler.js";
import { teamTaskExecutor, TEAMTASK_INLINE_BYTES, TEAMTASK_WALL_MS, TEAMTASK_MAX_OUTPUT_TOKENS } from "../src/org/teamtasks/executor.js";
import { teamTaskRecommendation } from "../src/org/teamtasks/contract.js";

const DIR = fileURLToPath(new URL("./fixtures/agent-prompts-affac339/", import.meta.url));
const P = INTERACTIVE_PROFILES.sonnet;
async function capture() {
  const d = realpathSync(mkdtempSync("/tmp/kgold-")); chmodSync(d, 0o700);
  const key = join(d, "k"); writeFileSync(key, "sk-test-golden\n", { mode: 0o600 });
  const a = new SqliteAuthority(openSqliteDatabase(join(d, "a.sqlite"), { create: true }), { binding: "g", authorityId: randomUUID(), driveId: randomUUID(), installationId: randomUUID() }, { create: true });
  const ledger = new SqliteSpendLedger(a, { monthlyUsd: 5 });
  const bodies: any[] = [];
  const fetch = (async (_u: string, init: any) => { bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: "g", model: P.runtime.model, provider: "Amazon Bedrock", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "The cleanup is on Oct 31 [members/notes/2026-10-08.md#L2]." } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, cost: 0.001 } }), { status: 200, headers: { "content-type": "application/json" } }); }) as never;
  // Owner bug (Oct 26): chat's system text carries the runtime calendar (today's date): taken out here and checked separately.
  const shape = (b: any) => ({ messages: b.messages.map((m: any) => m.role === "system" ? { ...m, content: String(m.content).replace(/\nCalendar \(America\/Chicago\): today is [^\n]*/, "") } : m),
    tools: b.tools?.map((t: any) => t.function.name) ?? null, tool_choice: b.tool_choice ?? null, calendar: b.messages[0]?.role === "system" && /\nCalendar \(America\/Chicago\): today is \d{4}-\d{2}-\d{2} \w{3}\. Next days: /.test(b.messages[0].content) });
  const out: Record<string, unknown> = {};
  // Chat turn (no draft plan).
  const chat = chatRunner({ profile: P, secretFile: key, ledger, fetch, tools: { async call() { return { ok: false, error: "chat_tool_failed" }; }, async begin() { return { envelope: null }; }, end() {} } as never });
  await chat({ turnId: "turn_g", conversationId: "conv_g", memberId: "mem_g", scope: "member", history: [{ role: "user", text: "When is the cleanup?" }] },
    { signal: new AbortController().signal, memberActive: () => true, progress: () => {}, record: { request: () => {}, toolCall: () => {} } });
  out.chat = shape(bodies.at(-1));
  // Team tasks: listed (sources over the inline size) and inline.
  const ex = teamTaskExecutor({ profile: P, secretFile: key, ledger, fetch });
  const rec = teamTaskRecommendation({ title: "Draft next month's newsletter", notes: "From the approved notes." });
  const run = (attemptId: string, sources: { path: string; text: string }[]) => ex.run({ attemptId, taskId: "tt_" + "b".repeat(32),
    plan: { instructions: rec.instructions, sources: { manifestHash: "sha256:" + "c".repeat(64), roots: ["members"] },
      budget: { requests: P.turn.requests, toolCalls: P.turn.toolCalls, wallMs: TEAMTASK_WALL_MS, maxOutputTokens: TEAMTASK_MAX_OUTPUT_TOKENS, usd: P.turn.usd } } as never,
    signal: new AbortController().signal, grants: [], sources: () => sources, writeResult: () => {}, stillAuthorized: () => true, authorization: () => null } as never);
  const note = { path: "members/notes/2026-10-08.md", text: "# Notes\nThe cleanup is on Oct 31.\n" };
  await run("tta_" + "1".repeat(32), [note, { path: "members/notes/big.md", text: "# Big\n" + "x".repeat(TEAMTASK_INLINE_BYTES) + "\n" }]);
  const listed = shape(bodies.at(-1)); listed.messages[0].content = listed.messages[0].content.replace(/x{1000,}/g, "<X*64KiB>"); out["task-listed"] = listed;
  await run("tta_" + "2".repeat(32), [note]);
  out["task-inline"] = shape(bodies.at(-1));
  return out;
}
// Package F delta A (Fable FABLE-REVIEW-PACKAGE-F-DELTA-A.md): against the SAME affac339 fixtures, the first requests move by exactly
// the A-6 chat rules line (chat only) and the catalog's new tool name (every request that sends the catalog); nothing else.
const A6 = "Only describe what this app and your tools can actually do. If you can't do something, say so plainly and say what you can do instead. Never invent a button, page, upload or other feature.";
const AFTER = "You cannot send email, publish, deploy or change members or settings. No tool for that exists; say so if asked.";
// Owner bug (Oct 26): the calendar rules line follows the member-input line (chat only).
const CAL_LINE = "Use the calendar below for today's date, weekdays and dates; never work out a weekday or a date yourself.";
// PACKAGE P (brief bdd6ae2b): the member-input line follows the drafts line (chat only).
const DRAFTS = "Drafts (newsletter, agenda) are saved only with write_draft_artifact inside an approved draft plan; a member approves the plan in the app.";
// P2 (owner, Oct 26: "approve it in the Tasks section"): the drafts line names the real approval path (chat only).
const DRAFTS_P2 = "Drafts (newsletter, agenda) are saved only with write_draft_artifact inside an approved draft plan. The member approves it on the plan card in this chat (it appears when they ask here for a draft, or from Draft the next newsletter on the Newsletter page), never in Tasks; without an approved plan, say so.";
const P_LINE = "When the member asks for a draft or an edit, their own words in this conversation are instructions you follow within these rules and the handbook: include the links, dates and wording they give. A fact you add still needs a cited source."; // Fable PP-5
it("B-2 + Package F + P: chat / listed task / inline task first requests equal affac339 except the A-6 and P rules lines and the list_site_images + edit_draft_artifact tool names", async () => {
  const got = await capture();
  if (process.env.GOLDEN_WRITE === "1") { mkdirSync(DIR, { recursive: true }); for (const [k, v] of Object.entries(got)) writeFileSync(join(DIR, k + ".json"), JSON.stringify(v, null, 1) + "\n"); }
  const want = (k: string) => {
    const w = JSON.parse(readFileSync(join(DIR, k + ".json"), "utf8"));
    // PACKAGE P: + edit_draft_artifact right after write_draft_artifact; chat gains the member-input rule line after the drafts line.
    if (w.tools) w.tools = k === "task-listed" ? ["read_org_file", "search_org_history"] // evidence-inheritance (A): a task gets only its two tools
      : [...w.tools.flatMap((n: string) => n === "write_draft_artifact" ? [n, "edit_draft_artifact"] : [n]), "list_site_images"];
    if (k === "chat") { expect(w.messages[0].content.split(AFTER).length).toBe(2); w.messages[0].content = w.messages[0].content.replace(AFTER, AFTER + "\n" + A6);
      expect(w.messages[0].content.split(DRAFTS).length).toBe(2); w.messages[0].content = w.messages[0].content.replace(DRAFTS, DRAFTS_P2 + "\n" + P_LINE + "\n" + CAL_LINE); }
    w.calendar = k === "chat"; // chat carries the calendar block (checked by shape); tasks do not (the task view is unchanged)
    return JSON.stringify(w, null, 1) + "\n";
  };
  for (const k of ["chat", "task-listed", "task-inline"]) expect([k, JSON.stringify(got[k], null, 1) + "\n"]).toEqual([k, want(k)]);
  // ON (the handbook loaded): the handbook variant carries the line exactly once and differs from the OFF rules only as H1 made it.
  const { CHAT_RULES, CHAT_RULES_HANDBOOK } = await import("../src/org/chat/scheduler.js");
  expect([CHAT_RULES.split(A6).length, CHAT_RULES_HANDBOOK.split(A6).length]).toEqual([2, 2]);
  const { HANDBOOK_PRECEDENCE, HANDBOOK_CITES } = await import("../src/org/handbook/context.js");
  const off = CHAT_RULES.replace("\n" + A6, "");
  expect(CHAT_RULES_HANDBOOK.replace("\n" + A6, "")).toBe(off.replace("Answer only from the organization's files, which you read with read_org_file and search_org_history. If the files do not say,",
    "Answer only from the handbook, the system map and the organization's files, which you read with read_org_file and search_org_history. If they do not say,") + "\n" + HANDBOOK_PRECEDENCE + "\n" + HANDBOOK_CITES);
});
