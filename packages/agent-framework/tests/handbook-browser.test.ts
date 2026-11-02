// AGENT-HANDBOOK-V1 H2 in REAL Chromium under the hub's production CSP: Manage -> Agent handbook (write -> preview -> approve),
// an edit's preview (diff, size, the schedule that will pause), the schedule paused -> "Review again" -> approved; a member reads it
// from Help (no editor); a task result's handbook / system-map chips open the exact version line and the run's frozen map.
// A FAKE executor; renders (desktop + phone) with TASKS_SHOTS.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import type { TeamTaskRun } from "../src/org/teamtasks/store.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT);
const HB = "# Who we are\nEXNA is the Example Park Neighborhood Association.\n\n## How we work\n- The agent prepares drafts; people approve and send.\n- Say \"not stated\" when the files do not say.";

describe.skipIf(!enabled)("Agent handbook in a real browser (H2)", () => {
  it("write -> preview -> approve; edit pauses a schedule -> Review again; member reads; chips open the version line and the frozen map", async () => {
    const w = await transcriptionWorld({ chat: {}, teamTasks: true, handbook: { enabled: true }, teamTaskSchedules: { run: "off", envelopeUsd: 5 },
      teamTaskExecutor: { id: "fake-v1", async run(r: TeamTaskRun) { r.writeResult(`# Guide\nDrafts are approved by people [handbook:v2#L5]. The team meets monthly (handbook:v2#7).\nTasks are listed on the Tasks page [system-map:${r.attemptId}#L4].`); } } });
    mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
    writeFileSync(join(w.cfg.folder, "members", "notes", "2026-10-08.md"), "# Notes\nThe cleanup is on Oct 31.\n");
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.TASKS_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const errors: string[] = [];
    const open = async (cookie: string) => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = cookie.split("=");
      page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e: any) => errors.push("pageerror " + e.message));
      await c.addCookies([{ name, value, url: w.url }]); return page; };
    const shot = async (page: any, name: string) => { if (!SHOTS) return;
      for (const [vw, vh, tag] of [[1440, 900, "desktop-1440"], [390, 844, "phone-390"]] as const) {
        await page.setViewportSize({ width: vw, height: vh }); await page.evaluate(() => window.scrollTo(0, 0)); await new Promise((x) => setTimeout(x, 150));
        await page.screenshot({ path: join(SHOTS, name + "-" + tag + ".png"), fullPage: true }); }
      await page.setViewportSize({ width: 1440, height: 900 }); };
    try {
      const robin = await open(w.robin);
      await robin.goto(`${w.url}/o/exna/#manage`);
      await robin.getByRole("link", { name: "Agent handbook" }).click();
      await robin.getByText("No handbook is approved yet. Write the first one below.").waitFor();
      expect(await robin.locator("details#hb-edit").getAttribute("open")).not.toBeNull();
      await robin.locator("#hb-text").fill(HB);
      await shot(robin, "h2-01-write-first");
      await robin.getByRole("button", { name: "Preview changes" }).click();
      const pv = robin.locator("#hb-preview");
      await pv.locator(".hb-size").getByText(/^\d+% of the limit · adds (under \$0\.001|about \$\d\.\d{3}) per answer$/).waitFor(); // Director's wording
      expect(await pv.locator(".d-add").count()).toBeGreaterThan(3);
      await shot(robin, "h2-02-preview-first");
      await pv.getByRole("button", { name: "Approve handbook" }).click();
      await robin.locator("#handbook-text").getByText("In use", { exact: true }).waitFor();
      expect(await robin.locator("#handbook-text .md-h strong").first().textContent()).toBe("Who we are");
      // A schedule pinned to v1; an edit's preview names it; approving pauses it; "Review again" -> the review card -> approved.
      const sv = (await w.post("/o/exna/api/teamtask/schedule/propose", { title: "Monday newsletter draft", template: { title: "Draft {{date}}", notes: "" }, sources: { roots: ["members/notes"], rule: "current" }, recurrence: { weekday: 1 } }, w.robin)).result;
      expect((await w.act(w.robin, "teamtask.schedule.approve", { scheduleId: sv.scheduleId, version: 1 }, sv.digest)).ok).toBe(true);
      // Package F (Ops finding): a second schedule PAUSED BY HAND before the pins move must offer "Review again" after, never a Resume
      // that the server refuses (pin_changed).
      const hv = (await w.post("/o/exna/api/teamtask/schedule/propose", { title: "Thursday reminder", template: { title: "Reminder {{date}}", notes: "" }, sources: { roots: ["members/notes"], rule: "current" }, recurrence: { weekday: 4 } }, w.robin)).result;
      expect((await w.act(w.robin, "teamtask.schedule.approve", { scheduleId: hv.scheduleId, version: 1 }, hv.digest)).ok).toBe(true);
      expect((await w.post("/o/exna/api/teamtask/schedule/pause", { scheduleId: hv.scheduleId }, w.robin)).ok).toBe(true);
      expect((await w.post("/o/exna/api/teamtask/schedule/read", { scheduleId: hv.scheduleId }, w.robin)).result).toMatchObject({ state: "paused", label: "teamtask_schedule_paused" });
      await robin.reload();
      await robin.locator("details#hb-edit > summary").click();
      await robin.locator("#hb-text").fill(HB + "\n- Keep answers short.");
      await robin.getByRole("button", { name: "Preview changes" }).click();
      await pv.getByText("1 schedule will pause until a reviewer reviews it again: Monday newsletter draft.").waitFor();
      expect(await pv.locator(".d-add").allTextContents()).toEqual(["+ - Keep answers short."]);
      await shot(robin, "h2-03-preview-edit-pauses-schedule");
      await pv.getByRole("button", { name: "Approve handbook" }).click();
      await robin.locator("#handbook-text").getByText("Version 2", { exact: true }).waitFor();
      await robin.goto(`${w.url}/o/exna/#tasks`);
      const row = robin.locator("#schedules .schedule", { hasText: "Monday newsletter draft" });
      await row.getByText("Paused", { exact: true }).waitFor();
      await shot(robin, "h2-04-schedule-paused-review-again");
      const hand = robin.locator("#schedules .schedule", { hasText: "Thursday reminder" });
      await hand.getByText("Paused", { exact: true }).waitFor();
      // Fable delta A Addendum 2: Review again next to Resume, for ANY paused schedule; Resume refuses on the moved pin; Review again ->
      // the review card -> approve -> active under the current pins (no run lost).
      expect(await hand.getByRole("button", { name: "Resume" }).count()).toBe(1);
      expect((await w.act(w.robin, "teamtask.schedule.resume", { scheduleId: hv.scheduleId }, (await w.post("/o/exna/api/teamtask/schedule/read", { scheduleId: hv.scheduleId }, w.robin)).result.digest)).error).toBe("teamtask_schedule_pin_changed");
      await hand.getByRole("button", { name: "Review again" }).click();
      await robin.locator("#schedule-review").getByRole("button", { name: "Approve schedule" }).click();
      await robin.locator("#schedules .schedule", { hasText: "Thursday reminder" }).getByText("Active", { exact: true }).waitFor();
      const hr = (await w.post("/o/exna/api/teamtask/schedule/read", { scheduleId: hv.scheduleId }, w.robin)).result;
      expect([hr.state, hr.version, hr.definition.pins.handbook.version]).toEqual(["active", 2, 2]);
      await row.getByRole("button", { name: "Review again" }).click();
      await robin.locator("#schedule-review").getByRole("button", { name: "Approve schedule" }).click();
      await robin.locator("#schedules .schedule", { hasText: "Monday newsletter draft" }).getByText("Active", { exact: true }).waitFor();
      const read = (await w.post("/o/exna/api/teamtask/schedule/read", { scheduleId: sv.scheduleId }, w.robin)).result;
      expect([read.version, read.definition.pins.handbook.version, read.definition.endDate]).toEqual([2, 2, sv.definition.endDate]); // the same end date
      // A member reads it from Help; no editor.
      const alex = await open(w.alex);
      await alex.goto(`${w.url}/o/exna/#help`);
      await alex.getByRole("link", { name: "agent handbook" }).click();
      await alex.locator("#handbook-text").getByText("Version 2", { exact: true }).waitFor();
      expect(await alex.locator("#hb-edit").count()).toBe(0);
      await shot(alex, "h2-05-member-reads");
      // Chips: a task result citing the handbook and the run's map.
      const t = (await w.post("/o/exna/api/teamtask/create", { clientRequestId: "req-" + randomUUID().slice(0, 8), title: "Write a short guide" }, w.alex)).result;
      const p = (await w.post("/o/exna/api/teamtask/propose", { taskId: t.taskId, expectedRevision: 1 }, w.alex)).result;
      expect((await w.act(w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest)).ok).toBe(true);
      await w.org.teamTasks!.idle();
      await alex.goto(`${w.url}/o/exna/#tasks?id=${t.taskId}`);
      const res = alex.locator(".result-text.md");
      await res.getByRole("link", { name: "Handbook v2 · line 5" }).waitFor();
      // Owner (live, Oct 26): a bare marker without brackets or "L" ("handbook:v2#7") is a chip too, not raw text.
      await res.getByRole("link", { name: "Handbook v2 · line 7" }).waitFor();
      expect(await res.getByText("handbook:v2#7").count()).toBe(0);
      expect(await res.locator(".cite-chip").evaluateAll((ns: Element[]) => ns.map((n) => (n.nextSibling?.textContent ?? "").trimStart().startsWith(".")))).toEqual([false, false, false]); // no stray "." (three chips: + the bare handbook:v2#7)
      await shot(alex, "h2-06-result-chips");
      await res.getByRole("link", { name: "System map · line 4" }).click();
      await alex.locator("#map-view .ln.hit").waitFor();
      expect(await alex.locator("#map-view .ln.hit").textContent()).toMatch(/^4  Pages and actions people use/);
      await shot(alex, "h2-07-map-view");
      await alex.goto(`${w.url}/o/exna/#tasks?id=${t.taskId}`);
      await alex.locator(".result-text.md").getByRole("link", { name: "Handbook v2 · line 5" }).click();
      await alex.locator("#handbook-text .ln.hit").waitFor();
      expect(await alex.locator("#handbook-text .ln.hit").textContent()).toMatch(/^5  - The agent prepares drafts/);
      await alex.setViewportSize({ width: 390, height: 900 });
      expect(await alex.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(errors.filter((e) => /Content Security Policy|Refused|pageerror/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
