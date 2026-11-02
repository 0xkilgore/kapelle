// SCHEDULED-TASKS-V1 S3 in REAL Chromium under the hub's production CSP: the weekly editor (start from one of the three named
// templates or write your own), the review card a reviewer approves by its exact digest, and Run now. A member's editor offers
// only member-visible collections; a 9:00 run shows the chat-wait note; markup in a name stays text. A FAKE executor; renders
// (desktop and phone) with TASKS_SHOTS.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import type { TeamTaskRun } from "../src/org/teamtasks/store.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT);

describe.skipIf(!enabled)("Schedule editor and review card in a real browser (S3)", () => {
  it("template -> review card -> a reviewer approves -> Run now -> draft ready; events template; member sees member collections only", async () => {
    const w = await transcriptionWorld({ chat: {}, teamTasks: true, teamTaskSchedules: { run: "on", envelopeUsd: 5 },
      teamTaskExecutor: { id: "fake-v1", async run(r: TeamTaskRun) { r.writeResult("# Draft\nFrom " + r.sources().map((f) => f.path).join(", ")); } } });
    const file = (rel: string, text: string) => { mkdirSync(join(w.cfg.folder, rel, ".."), { recursive: true }); writeFileSync(join(w.cfg.folder, rel), text); };
    file("members/notes/2026-10-08.md", "# Notes\nThe cleanup is on Oct 31.\n");
    file("members/website/events.md", "# Events\n- Nov 8: Block Party\n");
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.TASKS_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const errors: string[] = [];
    const open = async (cookie: string) => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = cookie.split("=");
      page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e: any) => errors.push("pageerror " + e.message));
      await c.addCookies([{ name, value, url: w.url }]); return page; };
    // Renders: scroll to the top first (a full-page shot draws the sticky header where the page was scrolled to).
    const shot = async (page: any, name: string) => { if (!SHOTS) return;
      for (const [vw, vh, tag] of [[1440, 900, "desktop-1440"], [390, 844, "phone-390"]] as const) {
        await page.setViewportSize({ width: vw, height: vh }); await page.evaluate(() => window.scrollTo(0, 0)); await new Promise((x) => setTimeout(x, 150));
        await page.screenshot({ path: join(SHOTS, name + "-" + tag + ".png"), fullPage: true }); }
      await page.setViewportSize({ width: 1440, height: 900 }); };
    try {
      // A member writes a schedule from the Monday template.
      const alex = await open(w.alex);
      await alex.goto(`${w.url}/o/exna/#tasks`);
      await alex.locator("#schedules").getByText("No schedules yet.").waitFor();
      await alex.locator("details#new-schedule > summary").click();
      expect(await alex.locator("#sch-template").inputValue()).toBe("newsletter");
      expect(await alex.locator("#sch-title").inputValue()).toBe("Monday newsletter draft");
      expect(await alex.locator("#sch-draft-title").inputValue()).toBe("Newsletter draft for {{date}}"); // filled in, behind "Edit instructions"
      expect(await alex.locator("#sch-draft-title").isVisible()).toBe(false);
      expect(await alex.locator("#sch-end").isVisible()).toBe(false); // "More options"
      // Fable A-6 (the owner's schedule said "Ends Oct 30"): the editor's default end date is the 90-day horizon (today + 89 days, the
      // runtime caps 90), so a 5-day end was chosen or inherited through Review again (which keeps the end date by design), not a default.
      const expectEnd = await alex.evaluate(() => { const d = new Date(); d.setDate(d.getDate() + 89); return d.toISOString().slice(0, 10); });
      expect(await alex.locator("#sch-end").inputValue()).toBe(expectEnd);
      expect(await alex.locator("#new-schedule").getByText(/up to 8 minutes/).count()).toBe(0); // the limits are on the review card
      expect(await alex.locator("#sch-time").inputValue()).toBe("06:00");
      expect(await alex.getByLabel("Approved member notes").isChecked()).toBe(true);
      expect(await alex.getByLabel(/new or changed since the last finished draft/).isChecked()).toBe(true);
      expect(await alex.getByText(/reviewers only/).count()).toBe(0); // a member's editor offers member-visible collections only
      expect(await alex.locator("#sch-audience").count()).toBe(0);
      await alex.locator("#sch-time").fill("09:00");
      await alex.getByText("A run at this time can make a live chat answer wait up to 8 minutes. 6:00 AM is the default.").waitFor();
      await alex.locator("#sch-time").fill("06:00");
      expect(await alex.getByText("A run at this time can make a live chat answer wait").count()).toBe(0);
      await shot(alex, "s3-01-editor-member-template");
      await alex.locator("#sch-instructions summary").click();
      expect(await alex.locator("#sch-notes").evaluate((n: Element) => getComputedStyle(n).fontFamily)).not.toMatch(/mono/i); // the normal font
      await shot(alex, "s3-01b-editor-instructions-open");
      await alex.getByRole("button", { name: "Review schedule" }).click();
      const card = alex.locator("#schedule-review");
      await card.getByRole("heading", { name: "Monday newsletter draft" }).waitFor();
      await card.getByText("Waiting for approval", { exact: true }).waitFor();
      await card.getByText("Mondays at 6:00 AM", { exact: true }).waitFor();
      expect(await card.locator("dd ul li").count()).toBe(3); // the next three runs
      await card.getByText("Approved member notes · only files new or changed since the last finished draft").waitFor();
      expect(await card.locator("pre.plan").textContent()).toContain("Title: Newsletter draft for {{date}}");
      await card.getByText("A reviewer approves the schedule before anything runs.").waitFor();
      await card.getByText("The agent setup is pinned; if it changes, the schedule pauses.").waitFor(); // Fable S3 N-1
      expect(await card.getByRole("button", { name: "Approve schedule" }).count()).toBe(0);
      await shot(alex, "s3-02-review-card-member");
      // A reviewer opens it from the list and approves exactly this version (session-fresh challenge, the schedule digest).
      const robin = await open(w.robin);
      await robin.goto(`${w.url}/o/exna/#tasks`);
      await robin.locator("#schedules").getByText("Waiting for approval", { exact: true }).waitFor();
      await robin.getByRole("link", { name: "Review and approve" }).click();
      await robin.locator("#schedule-review").getByRole("button", { name: "Approve schedule" }).waitFor();
      await shot(robin, "s3-03-review-card-reviewer");
      await robin.locator("#schedule-review").getByRole("button", { name: "Approve schedule" }).click();
      const row = robin.locator("#schedules .schedule", { hasText: "Monday newsletter draft" });
      await row.getByText("Active", { exact: true }).waitFor();
      const list = (await w.post("/o/exna/api/teamtask/schedule/list", {}, w.robin)).result;
      expect(list.schedules[0]).toMatchObject({ state: "active", approvedBy: expect.any(String), definition: { proposedBy: expect.any(String), recurrence: { weekday: 1, time: "06:00" } } });
      // Run now (reviewers; session-fresh): an extra run inside the monthly budget -> the notice and the draft.
      await row.locator("details.schedule-history summary").click();
      await row.getByRole("button", { name: "Run now" }).click();
      await w.org.teamTasks!.idle();
      await robin.getByRole("region", { name: "Schedule notices" }).getByRole("link", { name: /^Monday newsletter draft for .+ is ready$/ }).waitFor({ timeout: 15_000 });
      await shot(robin, "s3-04-approved-run-now");
      // The Friday events template (the current list each week; an explicit 14-day window), reviewers-only audience available.
      await robin.locator("details#new-schedule > summary").click();
      expect(await robin.getByText("Intake submissions (reviewers only)").count()).toBe(1);
      await robin.locator("#sch-template").selectOption("upcoming-events");
      expect(await robin.locator("#sch-day").inputValue()).toBe("5");
      expect(await robin.getByLabel("Website events list").isChecked()).toBe(true);
      expect(await robin.getByLabel(/new or changed since the last finished draft/).isChecked()).toBe(false);
      await robin.getByRole("button", { name: "Review schedule" }).click();
      const ev = robin.locator("#schedule-review");
      await ev.getByText("Fridays at 6:00 AM", { exact: true }).waitFor();
      await ev.getByText("Website events list · the current files, every week").waitFor();
      expect(await ev.locator("pre.plan").textContent()).toContain("from {{date}} through {{until}} (inclusive)");
      await shot(robin, "s3-05-review-card-events");
      // Your own: markup in a name renders as text; an empty source choice is refused in plain words.
      await robin.goto(`${w.url}/o/exna/#tasks`);
      await robin.locator("details#new-schedule > summary").click();
      await robin.locator("#sch-template").selectOption("");
      await robin.locator("#sch-title").fill("<img src=x onerror=alert(1)> weekly");
      await robin.locator("#sch-instructions summary").click();
      await robin.locator("#sch-draft-title").fill("Weekly {{date}}");
      await robin.getByRole("button", { name: "Review schedule" }).click();
      await robin.locator("#new-schedule").getByText("Choose at least one set of files it can use.").waitFor();
      await robin.getByLabel("Files shared from chat").check();
      await robin.locator("#sch-draft-title").fill("Weekly {{secret}}");
      await robin.getByRole("button", { name: "Review schedule" }).click();
      await robin.locator("#new-schedule").getByText(/^Check the schedule: a name, a one-line draft title/).waitFor(); // schedule words, not the task form's
      await robin.locator("#sch-draft-title").fill("Weekly {{date}}");
      expect(await robin.getByText(/didn't work \(/).count()).toBe(0);
      await robin.getByRole("button", { name: "Review schedule" }).click();
      await robin.locator("#schedule-review").getByRole("heading", { name: "<img src=x onerror=alert(1)> weekly" }).waitFor();
      expect(await robin.locator("main img").count()).toBe(0);
      await robin.setViewportSize({ width: 390, height: 900 });
      expect(await robin.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(errors.filter((e) => /Content Security Policy|Refused|pageerror/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
