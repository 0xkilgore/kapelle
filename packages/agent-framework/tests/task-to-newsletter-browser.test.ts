// Fable FABLE-REVIEW-SCHEDULE-TO-DRAFT-BRIEF.md A-5 (option A, the owner's first scheduled run): END TO END in real Chromium under
// the hub's production CSP. A Result ready card -> "Turn into a newsletter draft" -> a NEW chat holding the result as an attachment
// -> the newsletter plan card (nothing sent before approval, A-1) -> the member approves -> the fixed request (A-2) -> a draft with
// Open preview. Also: a result over 48 KB stops in plain words before any chat is created (A-3); a contributor sees no button (A-4).
// FAKE task executor and a scripted interactive model; synthetic data.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import type { TeamTaskRun } from "../src/org/teamtasks/store.js";
import { INTERACTIVE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT);
const NOTES = "members/notes/2026-10-08.v1.md";
const RESULT = "# Newsletter draft for 2026-10-26\nThe cleanup is on Oct 31 [members/notes/2026-10-08.v1.md#L2].\n";
const REQUEST = "Turn the attached team-task result into this month's newsletter draft. Keep its facts and citations.";

/** A scripted interactive model: write the newsletter, render it, then answer. Records each request body. */
function model() {
  const bodies: any[] = [];
  const fetch = async (_u: string, init: any) => {
    const b = JSON.parse(init.body); bodies.push(b);
    const tools = b.messages.filter((m: any) => m.role === "tool"), last = tools.at(-1);
    let message: any;
    if (!tools.length) message = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_draft_artifact",
      arguments: JSON.stringify({ kind: "newsletter", content: { title: "November in Example Park", sections: [{ heading: "Cleanup", body: "The cleanup is on Oct 31." }],
        sources: [{ path: NOTES, line: 2 }] } }) } }] };
    else if (JSON.parse(last.content).saved) { const s = JSON.parse(last.content);
      message = { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "render_newsletter_preview", arguments: JSON.stringify({ artifactId: s.artifactId, version: s.version }) } }] }; }
    else message = { role: "assistant", content: "Here's the draft [members/notes/2026-10-08.v1.md#L2]." };
    return new Response(JSON.stringify({ id: "g" + bodies.length, model: INTERACTIVE_PROFILES.sonnet.runtime.model, provider: "Amazon Bedrock",
      choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000, cost: 0.003 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, bodies };
}

describe.skipIf(!enabled)("task result -> newsletter draft (option A)", () => {
  it("result -> button -> chat with the attachment -> plan -> approve -> draft with Open preview; over 48 KB stops; a contributor sees no button", async () => {
    const m = model();
    const w = await transcriptionWorld({ chat: {}, fetch: m.fetch as never, teamTasks: true, teamTaskExecutor: { id: "fake-v1", async run(r: TeamTaskRun) {
      r.writeResult(r.plan.instructions.includes("very long") ? "# Long\n" + "x".repeat(50 * 1024) + "\n" : RESULT); } } });
    mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
    writeFileSync(join(w.cfg.folder, NOTES), "# October meeting\nThe cleanup is on Oct 31 at 9 am.\n");
    const task = async (title: string) => {
      const t = (await w.post("/o/exna/api/teamtask/create", { clientRequestId: "req-" + randomUUID().slice(0, 8), title }, w.alex)).result;
      const p = (await w.post("/o/exna/api/teamtask/propose", { taskId: t.taskId, expectedRevision: 1 }, w.alex)).result;
      expect((await w.act(w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest)).ok).toBe(true);
      return t.taskId as string;
    };
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.TASKS_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const open = async (cookie: string) => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = cookie.split("=");
      await c.addCookies([{ name, value, url: w.url }]); return page; };
    const convCount = async () => (await w.post("/o/exna/api/chat/conversation/list", {}, w.robin)).result.conversations.length;
    try {
      const taskId = await task("Newsletter draft for 2026-10-26");
      const robin = await open(w.robin);
      await robin.goto(`${w.url}/o/exna/#tasks?id=${taskId}`);
      await robin.getByText("Result ready").first().waitFor({ timeout: 15_000 });
      // A-4: a contributor (the task's creator, not a reviewer) sees the result but no button.
      const alex = await open(w.alex);
      await alex.goto(`${w.url}/o/exna/#tasks?id=${taskId}`);
      await alex.getByText("Result ready").first().waitFor({ timeout: 15_000 });
      expect(await alex.getByRole("button", { name: "Turn into a newsletter draft" }).count()).toBe(0);
      // A-1: the button creates the chat, attaches the result and SHOWS the plan; nothing is sent before approval.
      const before = await convCount(), requests0 = m.bodies.length;
      await robin.getByRole("button", { name: "Turn into a newsletter draft" }).click();
      await robin.waitForURL(/#chat$/);
      const approve = robin.getByRole("button", { name: "Approve plan to start drafting" });
      await approve.waitFor();
      expect(await robin.locator(".card.plan h3").textContent()).toBe("Turn the task result into a newsletter draft");
      expect(await convCount()).toBe(before + 1);
      const conv = (await w.post("/o/exna/api/chat/conversation/list", {}, w.robin)).result.conversations[0].conversationId;
      const r0 = (await w.post("/o/exna/api/chat/conversation/read", { conversationId: conv }, w.robin)).result;
      expect(r0.uploads.map((u: any) => u.name)).toEqual([expect.stringMatching(/^task-result-\d{4}-\d{2}-\d{2}\.md$/)]);
      expect([r0.messages, r0.envelope ?? null, m.bodies.length]).toEqual([[], null, requests0]); // no turn, no plan approved, no request
      if (SHOTS) await robin.screenshot({ path: join(SHOTS, "task-to-newsletter-plan-1440.png"), fullPage: true });
      // Approve -> the fixed request (A-2) -> a draft version with Open preview.
      await approve.click();
      await robin.getByRole("button", { name: "Open preview" }).waitFor({ timeout: 30_000 });
      expect(await robin.getByText("Newsletter draft · version 1").count()).toBe(1);
      const r1 = (await w.post("/o/exna/api/chat/conversation/read", { conversationId: conv }, w.robin)).result;
      expect(r1.messages.find((x: any) => x.role === "user").text).toBe(REQUEST);
      // The turn's frozen snapshot holds the attachment beside the notes (the agent can read and cite it as any attached notes).
      expect((w.org.sqlite.db.prepare("SELECT files FROM chat_turn_snapshots ORDER BY rowid DESC LIMIT 1").get() as { files: number }).files).toBe(2);
      if (SHOTS) await robin.screenshot({ path: join(SHOTS, "task-to-newsletter-draft-1440.png"), fullPage: true });
      // A-3: over 48 KB stops in plain words before any chat is created.
      const long = await task("A very long result");
      await robin.goto(`${w.url}/o/exna/#tasks?id=${long}`);
      await robin.getByText("Result ready").first().waitFor({ timeout: 15_000 });
      const n = await convCount();
      await robin.getByRole("button", { name: "Turn into a newsletter draft" }).click();
      await robin.getByText("This result is too long to carry into a chat (over 48 KB). Open a new chat and attach the parts you need instead.").waitFor();
      expect(await convCount()).toBe(n);
      expect(robin.url()).toMatch(/#tasks/);
    } finally { await browser.close(); await w.close(); }
  }, 180_000);
});
