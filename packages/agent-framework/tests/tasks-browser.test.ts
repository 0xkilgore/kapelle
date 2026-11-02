// TEAM-TASKS-V1 T2b in REAL Chromium under the hub's production CSP (Fable T1 N-1, N-3, N-5): chat -> "Make this a task" carries
// only the typed text; the member picks that chat's text file; the exact disclosure (who can see it) before "Create task";
// "Plan the work"; a reviewer (second browser) approves the exact plan; Result ready -> the result as TEXT; the creator marks it
// done. Markup in a title or result renders as text. A FAKE executor; renders with TASKS_SHOTS.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { TeamTaskEnd, type TeamTaskRun } from "../src/org/teamtasks/store.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT);
const RESULT = "# Thank-you draft\nThank you, MW Real Estate <b>not html</b> [task-uploads/sponsors.md#L2].\n\n- **Sapling** sponsor\n- the `thank-you` card\n\n| Who | When |\n|---|---|\n| Robin | **Nov 8** |";
// Owner (24 Oct): a result is markdown, rendered as formatted text with chat's renderer (DOM nodes, never HTML).
const formatted = async (page: any, scope: string) => {
  const r = page.locator(scope + " .result-text.md").first();
  await r.waitFor();
  expect(await r.locator("p.md-h strong").first().textContent()).toBe("Thank-you draft"); // the heading
  expect(await r.locator("li").count()).toBe(2); expect(await r.locator("li strong").textContent()).toBe("Sapling"); expect(await r.locator("li code").textContent()).toBe("thank-you");
  expect(await r.textContent()).toContain("Thank you, MW Real Estate <b>not html</b> [task-uploads/sponsors.md#L2]."); // markup stays literal text
  expect(await r.locator("b, script, img, a[href^='http']").count()).toBe(0);
  expect(await r.locator("table.md-table th").allTextContents()).toEqual(["Who", "When"]); // a pipe table (results only; chat unchanged)
  expect(await r.locator("table.md-table td").allTextContents()).toEqual(["Robin", "Nov 8"]); expect(await r.locator("table.md-table td strong").count()).toBe(1);
  expect(await r.textContent()).not.toContain("# Thank-you"); expect(await r.textContent()).not.toContain("**");
};

describe.skipIf(!enabled)("Tasks in a real browser (T2b)", () => {
  it("Make this a task -> disclosure -> plan -> reviewer approves -> result as text -> done", async () => {
    const w = await transcriptionWorld({ chat: {}, teamTasks: true, teamTaskExecutor: { id: "fake-v1", async run(r: TeamTaskRun) { await new Promise((x) => setTimeout(x, 400));
      if (r.plan.instructions.includes("whole manual")) throw new TeamTaskEnd("chat_tool_calls_too_many", "failed"); // the owner's live failure
      if (r.plan.instructions.includes("long manual")) { r.writeResult("# Manual\nPart one.\n\n(This result was cut off at the length limit.)", "chat_cap_requests"); return; } // a kept partial
      r.writeResult(RESULT); } } });
    mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
    writeFileSync(join(w.cfg.folder, "members", "notes", "2026-10-08.md"), "# Notes\nThe cleanup is on Oct 31.\n");
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.TASKS_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const errors: string[] = [];
    const open = async (cookie: string) => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = cookie.split("=");
      page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e: any) => errors.push("pageerror " + e.message));
      await c.addCookies([{ name, value, url: w.url }]); return page; };
    try {
      const alex = await open(w.alex);
      await alex.goto(`${w.url}/o/exna/#chat`);
      await alex.getByRole("button", { name: "New chat" }).click();
      await alex.locator(".starter").first().waitFor();
      await alex.locator("#chat-file").setInputFiles({ name: "sponsors.md", mimeType: "text/markdown", buffer: Buffer.from("# Sponsors\nMW Real Estate: Sapling.\n") });
      await alex.getByText("sponsors.md").waitFor();
      await alex.locator("#chat-text").fill("Draft the sponsor thank-you\nKeep it short.");
      await alex.locator("summary[aria-label=\"More actions\"]").click(); // owner (Oct 23): the actions live in the "+" menu
      await alex.getByRole("link", { name: "Make this a task" }).click();
      await alex.getByRole("heading", { name: "New task" }).waitFor();
      expect(await alex.locator("#task-title").inputValue()).toBe("Draft the sponsor thank-you");
      expect(await alex.locator("#task-notes").inputValue()).toBe("Keep it short.");
      expect(await alex.getByText("[object ", { exact: false }).count()).toBe(0); // owner bug (Oct 23): no stringified elements
      await alex.getByText("All members can see this task.").waitFor();
      await alex.getByLabel(/sponsors\.md/).check();
      // With a file: what will be copied is shown first (files are copied into the task).
      await alex.locator("#new-task").getByRole("button", { name: "Create task" }).click();
      await alex.getByText("This will be copied into the task and visible to all members:").waitFor();
      await alex.getByRole("region", { name: "What will be shared" }).getByText("sponsors.md · 36 bytes").waitFor();
      if (SHOTS) await alex.screenshot({ path: join(SHOTS, "tasks-disclosure-1440.png"), fullPage: true });
      await alex.getByRole("region", { name: "What will be shared" }).getByRole("button", { name: "Create task" }).click();
      // Owner (Oct 23): created AND planned in that click; a member's task waits for a reviewer.
      await alex.getByText("Plan 1").waitFor();
      await alex.getByText("A reviewer approves the run.").waitFor();
      await alex.locator(".plan-limits", { hasText: "Uses 2 files" }).waitFor();
      expect(await alex.getByText(/Runs on|bounded-runner|fake-v1|or-sonnet|frozen when planned|sha256:/).count()).toBe(0); // no engine internals
      expect(await alex.getByRole("button", { name: "Plan the work" }).count()).toBe(0);
      if (SHOTS) await alex.screenshot({ path: join(SHOTS, "tasks-plan-1440.png"), fullPage: true });
      const taskUrl = alex.url();
      // A reviewer approves the exact plan (session-fresh challenge) in their own browser.
      const robin = await open(w.robin);
      await robin.goto(taskUrl);
      await robin.getByRole("button", { name: "Approve and run" }).click();
      await robin.getByText("Result ready").first().waitFor({ timeout: 15_000 });
      expect(await robin.getByRole("button", { name: "Open the result" }).count()).toBe(0); // Director (Oct 23): the newest result is inline
      await formatted(robin, "#task-detail");
      // Owner brief ("a little complicated"): with a checked result, ONE quiet line (files, the check, check the facts); no second line.
      expect(await robin.locator("#task-detail .result-line").textContent()).toBe("Used 2 files · a draft: check the facts before using it"); // Director: no bytes
      expect(await robin.locator("#task-detail").getByText(/^Checked: /).count()).toBe(0);
      expect(await robin.locator("#task-detail .plan-limits:not(.result-line)").count()).toBe(0);
      expect(await robin.evaluate(() => { const r = document.querySelector(".result-text")!, d = [...document.querySelectorAll("button")].find((b) => b.textContent === "Mark done")!;
        return !!(r.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING); })).toBe(true); // Mark done sits under the result
      expect(await robin.locator(".card.attempt").first().evaluate((n: Element) => /\bnull\b/.test(n.textContent || ""))).toBe(false);
      if (SHOTS) await robin.screenshot({ path: join(SHOTS, "tasks-result-1440.png"), fullPage: true });
      // Director (25 Oct, the owner's first scheduled run): a result -> "Turn into a newsletter draft" -> a NEW chat holding the
      // result as an attached text file (this chat only) -> the newsletter draft plan to approve (the usual path from there).
      await robin.getByRole("button", { name: "Turn into a newsletter draft" }).click();
      await robin.waitForURL(/#chat$/);
      await robin.getByRole("button", { name: "Approve plan to start drafting" }).waitFor();
      expect(await robin.locator(".card.plan h3").textContent()).toBe("Turn the task result into a newsletter draft");
      expect(await robin.locator(".starters-box").count()).toBe(0); // straight to the plan, no starter suggestions
      expect(await robin.locator(".card.plan").getByText("A newsletter", { exact: true }).count()).toBe(1);
      const convs = (await w.post("/o/exna/api/chat/conversation/list", {}, w.robin)).result.conversations;
      const conv = (await w.post("/o/exna/api/chat/conversation/read", { conversationId: convs[0].conversationId }, w.robin)).result;
      expect(conv.uploads.map((u: any) => u.name)).toEqual([expect.stringMatching(/^task-result-\d{4}-\d{2}-\d{2}\.md$/)]);
      expect(conv.messages).toEqual([]); // nothing is sent before the member approves the plan
      await robin.getByText(conv.uploads[0].name, { exact: false }).first().waitFor(); // the attachment shows in the chat
      if (SHOTS) await robin.screenshot({ path: join(SHOTS, "tasks-result-to-newsletter-1440.png"), fullPage: true });
      await robin.goto(taskUrl);
      // T3: Revise or run again -> a NEW plan (Plan 2) with the note and the last checked result as context; a reviewer approves it.
      // Owner (Oct 23): a reviewer's own text-only task is ONE click: create, plan, approve that exact plan (session-fresh), run.
      await robin.goto(`${w.url}/o/exna/#tasks`);
      expect(await robin.locator("details#new-task").getAttribute("open")).toBeNull(); // the Tasks tab is the team's list first
      await robin.locator("details#new-task summary").click();
      await robin.locator("#task-title").fill("List the cleanup volunteers");
      expect(await robin.getByText("[object ", { exact: false }).count()).toBe(0);
      expect(await robin.locator(".task-who select#task-audience").isVisible()).toBe(true);
      if (SHOTS) await robin.screenshot({ path: join(SHOTS, "tasks-new-1440.png"), fullPage: true });
      const before = (await w.post("/o/exna/api/teamtask/list", {}, w.robin)).result.tasks.length;
      await robin.getByRole("button", { name: "Create and run" }).click();
      await robin.getByRole("heading", { name: "List the cleanup volunteers" }).waitFor({ timeout: 15_000 }); // its own page
      await robin.locator("#task-detail").getByText("Result ready").first().waitFor({ timeout: 15_000 });
      expect(await robin.getByRole("region", { name: "What will be shared" }).count()).toBe(0); // text only: no separate step
      const mine = (await w.post("/o/exna/api/teamtask/list", {}, w.robin)).result.tasks;
      expect(mine.length).toBe(before + 1);
      const one = mine.find((t: any) => t.title === "List the cleanup volunteers");
      expect(one.attempts.map((x: any) => x.version)).toEqual([1]);
      // The same consequential approval as before: receipts to the actor and every admin (one per approval so far: 2).
      const approvals = () => w.mail.filter((m: any) => m.kind === "receipt" && m.receipt?.action === "teamtask.approve" && m.to === "admin@exna.test").length;
      for (let i = 0; i < 100 && approvals() < 2; i++) await new Promise((x) => setTimeout(x, 20));
      expect(approvals()).toBe(2);
      if (SHOTS) await robin.screenshot({ path: join(SHOTS, "tasks-oneclick-1440.png"), fullPage: true });
      // Owner live run (Oct 23): a run that stopped on a reading limit says so in plain words, never a raw label.
      await robin.goto(`${w.url}/o/exna/#tasks`);
      await robin.locator("details#new-task summary").click();
      await robin.locator("#task-title").fill("Write the whole manual");
      await robin.getByRole("button", { name: "Create and run" }).click();
      await robin.getByRole("heading", { name: "Write the whole manual" }).waitFor({ timeout: 15_000 });
      await robin.getByText("This task needed more reading than its limit allows. Try a narrower task, or ask for a revision.").waitFor({ timeout: 15_000 });
      expect(await robin.getByText(/chat_|didn't work \(/).count()).toBe(0);
      if (SHOTS) await robin.screenshot({ path: join(SHOTS, "tasks-stopped-1440.png"), fullPage: true });
      // Long output (Fable ab150875 Q2): a kept partial result is marked next to "Result ready".
      await robin.goto(`${w.url}/o/exna/#tasks`);
      await robin.locator("details#new-task summary").click();
      await robin.locator("#task-title").fill("Write the long manual");
      await robin.getByRole("button", { name: "Create and run" }).click();
      await robin.getByRole("heading", { name: "Write the long manual" }).waitFor({ timeout: 15_000 });
      await robin.locator("#task-detail").getByText("Cut off at the length limit", { exact: true }).waitFor({ timeout: 15_000 });
      expect(await robin.locator("#task-detail").getByText("Result ready").count()).toBeGreaterThan(0);
      if (SHOTS) await robin.screenshot({ path: join(SHOTS, "tasks-partial-1440.png"), fullPage: true });
      await robin.goto(taskUrl);
      await robin.getByText("Result ready").first().waitFor();
      await robin.locator("details.revise summary").click(); // collapsed until needed (owner, Oct 23)
      await robin.locator("#revise-note").fill("Shorter, please.");
      await robin.getByRole("button", { name: "Plan the revision" }).click();
      await robin.getByText("Plan 2").waitFor();
      await robin.getByText("Revision: Shorter, please. · uses the earlier result as context").waitFor();
      if (SHOTS) await robin.screenshot({ path: join(SHOTS, "tasks-revise-1440.png"), fullPage: true });
      // The creator marks it done.
      await alex.reload();
      await alex.getByRole("button", { name: "Mark done" }).click();
      await alex.getByText("Done", { exact: true }).first().waitFor();
      // Owner (Oct 23): a done task stays findable: "Completed" on the Tasks list, and its result in Files -> Task results.
      await alex.getByRole("link", { name: "Files → Task results" }).click();
      await alex.getByRole("heading", { name: "Task results" }).waitFor();
      await formatted(alex, ".viewer"); // the deep link opens it, formatted; text, never HTML
      await alex.getByText("draft-the-sponsor-thank-you.md").first().waitFor();
      await alex.getByText("The agent does not read these as sources.").waitFor();
      if (SHOTS) await alex.screenshot({ path: join(SHOTS, "files-task-results-1440.png"), fullPage: true });
      await alex.goto(`${w.url}/o/exna/#tasks`);
      const comp = alex.locator("details#completed");
      expect(await comp.locator("summary").textContent()).toBe("Completed (1)");
      // Owner (24 Oct) + Director/Fable (af493adf N-1): an OPEN task whose last run failed can be run again, so it stays on top with its
      // tag; a CANCELLED task goes to its own quiet collapsed group, after Completed.
      const top = alex.locator(".card", { hasText: "Team tasks" }).locator(":scope > ul.list");
      await top.getByText("Write the whole manual").waitFor();
      expect(await top.locator("li", { hasText: "Write the whole manual" }).getByText("Failed", { exact: true }).count()).toBe(1);
      const gone = (await w.post("/o/exna/api/teamtask/create", { clientRequestId: "req-cancel01", title: "An old idea" }, w.alex)).result;
      expect((await w.act(w.alex, "teamtask.cancel", { taskId: gone.taskId, expectedRevision: gone.revision })).ok).toBe(true);
      await alex.reload();
      const didnt = alex.locator("details#unfinished");
      expect(await didnt.locator("summary").textContent()).toBe("Didn't finish (1)");
      expect(await didnt.getAttribute("open")).toBeNull();
      expect(await top.getByText("An old idea").count()).toBe(0); // not at the top
      expect(await alex.evaluate(() => { const c = document.getElementById("completed")!, u = document.getElementById("unfinished")!; return !!(c.compareDocumentPosition(u) & Node.DOCUMENT_POSITION_FOLLOWING); })).toBe(true);
      await didnt.locator("summary").click();
      await didnt.getByRole("link", { name: "An old idea" }).waitFor();
      expect(await comp.getAttribute("open")).toBeNull();
      await comp.locator("summary").click();
      await comp.getByRole("link", { name: "Draft the sponsor thank-you" }).waitFor();
      if (SHOTS) await alex.screenshot({ path: join(SHOTS, "tasks-completed-1440.png"), fullPage: true });
      // Markup in a title stays text in the list.
      await w.post("/o/exna/api/teamtask/create", { clientRequestId: "req-markup01", title: "<img src=x onerror=alert(1)> agenda" }, w.alex);
      await alex.reload(); // already on #tasks: the same hash does not re-route
      await alex.getByText("<img src=x onerror=alert(1)> agenda").waitFor();
      expect(await alex.locator("#main img, main img").count()).toBe(0);
      await alex.setViewportSize({ width: 390, height: 900 });
      expect(await alex.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      if (SHOTS) await alex.screenshot({ path: join(SHOTS, "tasks-list-390.png"), fullPage: true });
      await alex.goto(`${w.url}/o/exna/#help`);
      await alex.getByText("Tasks are work for the agent that the team can see.", { exact: false }).waitFor();
      expect(errors.filter((e) => /Content Security Policy|Refused|pageerror/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
