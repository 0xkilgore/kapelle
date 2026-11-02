// SCHEDULED-TASKS-V1 S2 in REAL Chromium under the hub's production CSP: the Tasks page shows the schedules (status, next runs,
// budget, recent runs), the "<schedule> for <date> is ready" notice (the schedule's own name and date, inside its audience; never result text), "Approved by schedule" on the run, the checked draft in
// Files -> Task results (audience-rechecked: a member never sees a reviewers-only draft or its notice), and Pause / Resume /
// Pause all. A FAKE executor; schedules are set up over the API (the editor is S3). Renders with TASKS_SHOTS.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import type { TeamTaskRun } from "../src/org/teamtasks/store.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT);
const DRAFT = "# Newsletter draft\nThe cleanup is on Oct 31 [members/notes/2026-10-08.md#L2]. <b>not html</b>";

describe.skipIf(!enabled)("Schedules in a real browser (S2)", () => {
  it("status, notice, approved-by-schedule, Files -> Task results with audience recheck, pause / resume / pause all", async () => {
    const w = await transcriptionWorld({ chat: {}, teamTasks: true, teamTaskSchedules: { run: "on", envelopeUsd: 5 },
      teamTaskExecutor: { id: "fake-v1", async run(r: TeamTaskRun) { r.writeResult(r.plan.audience === "members" ? DRAFT : "# Private intake summary"); } } });
    mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
    writeFileSync(join(w.cfg.folder, "members", "notes", "2026-10-08.md"), "# Notes\nThe cleanup is on Oct 31.\n");
    mkdirSync(join(w.cfg.folder, "reviewers-private", "intake"), { recursive: true });
    writeFileSync(join(w.cfg.folder, "reviewers-private", "intake", "a.md"), "# Intake\nPrivate.\n");
    const schedule = async (title: string, audience: string, root: string) => {
      const v = (await w.post("/o/exna/api/teamtask/schedule/propose", { title, audience, template: { title: title + " {{date}}", notes: "" }, sources: { roots: [root], rule: "current" }, recurrence: { weekday: 1 } }, w.robin)).result;
      expect((await w.act(w.robin, "teamtask.schedule.approve", { scheduleId: v.scheduleId, version: 1 }, v.digest)).ok).toBe(true);
      expect((await w.act(w.robin, "teamtask.schedule.run_now", { scheduleId: v.scheduleId }, null)).result).toMatchObject({ state: "admitted" });
      await w.org.teamTasks!.idle();
      return v;
    };
    const priv = await schedule("Intake summary", "reviewers-private", "reviewers-private/intake");
    const mem = await schedule("Newsletter draft", "members", "members/notes");
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.TASKS_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const errors: string[] = [];
    const open = async (cookie: string) => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = cookie.split("=");
      page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e: any) => errors.push("pageerror " + e.message));
      await c.addCookies([{ name, value, url: w.url }]); return page; };
    try {
      // A member (Kara's role): the members' schedule and its notice only; nothing of the reviewers-only one.
      const alex = await open(w.alex);
      await alex.goto(`${w.url}/o/exna/#tasks`);
      const card = alex.locator("#schedules");
      await card.getByRole("heading", { name: "Schedules" }).waitFor();
      await card.getByText("Newsletter draft", { exact: true }).waitFor();
      expect(await card.getByText("Intake summary").count()).toBe(0);
      await card.getByText(/^Mondays at 6:00 AM · next [A-Z][a-z]{2} \d{1,2}$/).waitFor(); // one plain line; no zone, one next run
      expect(await card.getByText(/America|UTC|resets on/).count()).toBe(0);
      expect(await card.getByRole("button", { name: /Pause/ }).count()).toBe(0); // not the creator, not a reviewer
      const notices = alex.getByRole("region", { name: "Schedule notices" });
      expect(await notices.getByRole("link", { name: /^Newsletter draft for [A-Z][a-z]{2} \d{1,2} is ready$/ }).count()).toBe(1); // named and dated
      expect(await notices.textContent()).not.toMatch(/Intake summary|Private intake/); // the reviewers-only notice (and its name) is not here
      expect(await notices.textContent()).not.toContain("cleanup"); // never result text
      await card.locator("details.schedule-history summary").click();
      await card.getByText("Run now · Draft ready", { exact: false }).waitFor();
      await card.getByText(/this month \$\d\.\d\d of \$5\.00 \(resets monthly\)/).waitFor(); // the details live behind "Recent runs"
      if (SHOTS) await alex.screenshot({ path: join(SHOTS, "schedules-member-1440.png"), fullPage: true });
      await notices.getByRole("link", { name: /^Newsletter draft for .+ is ready$/ }).click();
      await alex.locator("#task-detail").getByText("Approved by schedule · this exact plan", { exact: false }).waitFor();
      expect(await alex.locator(".result-text.md p.md-h strong").textContent()).toBe("Newsletter draft"); // formatted (owner, 24 Oct)
      expect(await alex.locator(".result-text.md").textContent()).toContain("The cleanup is on Oct 31. "); // the "." moved before the chip
      expect(await alex.locator(".result-text.md").textContent()).toContain("<b>not html</b>");
      // Director/Fable (af493adf N-2): no stray "." after the cite chip.
      expect(await alex.locator(".result-text.md .cite-chip").first().evaluate((n: Element) => (n.nextSibling?.textContent ?? "").trimStart().startsWith("."))).toBe(false);
      expect(await alex.locator(".result-text.md b").count()).toBe(0);
      // Files -> Task results: the members' draft (not done yet), never the reviewers-only one; reads are rechecked by the runtime.
      await alex.goto(`${w.url}/o/exna/#files`);
      await alex.getByRole("heading", { name: "Task results" }).waitFor();
      await alex.locator("details.task-results > summary").click(); // J2 (owner): task results sit closed at the bottom of Files
      await alex.getByText("Scheduled draft · ready, not done yet").waitFor();
      expect(await alex.getByText(/intake-summary/i).count()).toBe(0);
      await alex.locator(".folder", { hasText: "Task results" }).getByRole("button", { name: "Open" }).click();
      await alex.getByText("Scheduled draft, not marked done yet").waitFor();
      expect(await alex.locator(".viewer .result-text.md").textContent()).toContain("<b>not html</b>");
      const privTask = (await w.post("/o/exna/api/teamtask/schedule/read", { scheduleId: priv.scheduleId }, w.robin)).result.occurrences[0].taskId;
      expect((await w.post("/o/exna/api/teamtask/read", { taskId: privTask }, w.alex)).error).toBe("teamtask_audience_not_permitted");
      expect((await w.post("/o/exna/api/teamtask/schedule/read", { scheduleId: priv.scheduleId }, w.alex)).error).toBe("teamtask_audience_not_permitted");
      if (SHOTS) await alex.screenshot({ path: join(SHOTS, "schedules-files-1440.png"), fullPage: true });
      // A reviewer: both schedules and both notices; Pause one, Resume it (session-fresh, the schedule digest); Pause all / Resume all.
      const robin = await open(w.robin);
      await robin.goto(`${w.url}/o/exna/#tasks`);
      const rc = robin.locator("#schedules");
      await rc.getByText("Intake summary", { exact: true }).waitFor();
      const rn = robin.getByRole("region", { name: "Schedule notices" });
      expect(await rn.getByRole("link", { name: /^(Newsletter draft|Intake summary) for .+ is ready$/ }).count()).toBe(2);
      if (SHOTS) await robin.screenshot({ path: join(SHOTS, "schedules-reviewer-1440.png"), fullPage: true });
      const one = rc.locator(`[data-schedule="${mem.scheduleId}"]`);
      await one.getByRole("button", { name: "Pause", exact: true }).click();
      await one.getByText("Paused", { exact: true }).waitFor();
      expect(await one.getByText("Paused.", { exact: true }).count()).toBe(0); // no second "Paused." under the tag
      expect((await w.post("/o/exna/api/teamtask/schedule/read", { scheduleId: mem.scheduleId }, w.robin)).result.state).toBe("paused");
      await rc.locator(`[data-schedule="${mem.scheduleId}"]`).getByRole("button", { name: "Resume" }).click();
      await rc.locator(`[data-schedule="${mem.scheduleId}"]`).getByText("Active", { exact: true }).waitFor();
      await rc.getByRole("button", { name: "Pause all schedules" }).click();
      await rc.getByText("All schedules are paused. Nothing starts on its own until a reviewer resumes them.").waitFor();
      expect((await w.post("/o/exna/api/teamtask/schedule/list", {}, w.robin)).result.pausedAll).toBe(true);
      if (SHOTS) await robin.screenshot({ path: join(SHOTS, "schedules-paused-all-1440.png"), fullPage: true });
      await rc.getByRole("button", { name: "Resume all schedules" }).click();
      await rc.getByRole("button", { name: "Pause all schedules" }).waitFor();
      // Narrow screens: no sideways scroll.
      await alex.goto(`${w.url}/o/exna/#tasks`);
      await alex.locator("#schedules").waitFor();
      await alex.setViewportSize({ width: 390, height: 900 });
      expect(await alex.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      if (SHOTS) await alex.screenshot({ path: join(SHOTS, "schedules-member-390.png"), fullPage: true });
      expect(await alex.getByText(/teamtask_|didn't work \(/).count()).toBe(0);
      expect(errors.filter((e) => /Content Security Policy|Refused|pageerror/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
