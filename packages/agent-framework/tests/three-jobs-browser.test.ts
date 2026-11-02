// THREE-JOBS J1 in real Chromium under the hub's production CSP (owner: "those are the three things they can do with chat...
// that should be true of the UI they are seeing"). Desktop: Home · Website · Newsletter · Meetings, Help, the account menu.
// Phone (390 px): the jobs fold into one "Jobs" menu, no horizontal overflow. Home: three job cards, "Ask anything" (a private
// chat; the question is sent), Recent. Old deep links still open their pages; Manage stays reviewer-only. Synthetic data.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { INTERACTIVE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT);
const NOTES = "members/notes/2026-10-08.v1.md";

describe.skipIf(!enabled)("three jobs first (J1)", () => {
  it("desktop + phone nav, Home cards, Ask anything -> a sent private chat, Recent, Meetings, All work & files, old links", async () => {
    const asked: string[] = [];
    const fetch = async (_u: string, init: any) => {
      const b = JSON.parse(init.body); asked.push(b.messages.filter((m: any) => m.role === "user").at(-1)?.content ?? "");
      return new Response(JSON.stringify({ id: "g" + asked.length, model: INTERACTIVE_PROFILES.sonnet.runtime.model, provider: "Amazon Bedrock",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "The cleanup is on Oct 31 [members/notes/2026-10-08.v1.md#L2]." } }],
        usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940, cost: 0.002 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const w = await transcriptionWorld({ chat: {}, fetch: fetch as never, teamTasks: true });
    mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
    writeFileSync(join(w.cfg.folder, NOTES), "# October meeting\nThe cleanup is on Oct 31 at 9 am.\n");
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.JOBS_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const open = async (cookie: string, width: number, height = 900) => { const c = await browser.newContext({ viewport: { width, height } }), page = await c.newPage(), [name, value] = cookie.split("=");
      await c.addCookies([{ name, value, url: w.url }]); const errors: string[] = []; page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); }); return { page, errors }; };
    try {
      // Desktop, a contributor: the jobs bar and Home.
      const alex = await open(w.alex, 1440);
      await alex.page.goto(`${w.url}/o/exna/`);
      await alex.page.locator(".jobs").waitFor();
      expect(await alex.page.locator(".jobs-tabs a").allTextContents()).toEqual(["Home", "Newsletter", "Meetings"]); // no website connected in this org
      expect(await alex.page.locator(".jobs-tabs a[aria-current=page]").textContent()).toBe("Home");
      expect(await alex.page.locator(".job strong").allTextContents()).toEqual(["Newsletter", "Meetings"]);
      expect(await alex.page.getByRole("link", { name: "Help" }).isVisible()).toBe(true);
      await alex.page.locator(".nav-menu.account summary").click();
      expect(await alex.page.locator(".nav-menu.account .menu a").allTextContents()).toEqual(["Your chats", "All work & files"]); // no Manage for a contributor
      await alex.page.keyboard.press("Escape"); await alex.page.locator(".nav-menu.account summary").click();
      // Ask anything: a private chat opens and the question is SENT (one model request with exactly those words).
      await alex.page.locator("#ask-text").fill("When is the cleanup?");
      await alex.page.locator(".ask-go").click();
      await alex.page.waitForURL(/#chat$/);
      await alex.page.getByText("The cleanup is on Oct 31").waitFor({ timeout: 20_000 });
      expect(asked).toEqual(["When is the cleanup?"]);
      // Back Home: Recent lists that chat; it opens it.
      await alex.page.goto(`${w.url}/o/exna/#home`);
      await alex.page.locator(".recent-list a").first().waitFor();
      if (SHOTS) await alex.page.screenshot({ path: join(SHOTS, "home-desktop-1440.png"), fullPage: true });
      await alex.page.locator(".recent-list a").first().click();
      await alex.page.getByText("The cleanup is on Oct 31").waitFor();
      // Meetings: the agenda starter opens a chat with the plan card (nothing approved or sent).
      await alex.page.goto(`${w.url}/o/exna/#meetings`);
      await alex.page.getByRole("heading", { name: "Meetings" }).waitFor();
      expect(await alex.page.locator(".jobs-tabs a[aria-current=page]").textContent()).toBe("Meetings");
      if (SHOTS) await alex.page.screenshot({ path: join(SHOTS, "meetings-desktop-1440.png"), fullPage: true });
      const before = asked.length;
      await alex.page.getByRole("button", { name: "Prepare a meeting agenda" }).click();
      await alex.page.getByRole("button", { name: "Approve plan to start drafting" }).waitFor();
      expect(asked.length).toBe(before);
      // All work & files and the old deep links.
      await alex.page.goto(`${w.url}/o/exna/#work`);
      expect(await alex.page.locator("main a[href^='#']").allTextContents()).toEqual(["← Home", "Your chats", "Tasks", "Shared drive", "Approved meeting notes"]);
      for (const [hash, heading] of [["#files", "Shared drive"], ["#tasks", "Tasks"], ["#help", "How to use EXNA"], ["#newsletter", "Newsletter"]]) {
        await alex.page.goto(`${w.url}/o/exna/${hash}`); await alex.page.getByRole("heading", { name: heading, exact: true }).first().waitFor();
      }
      // A reviewer keeps everything: Manage in the account menu.
      const robin = await open(w.robin, 1440);
      await robin.page.goto(`${w.url}/o/exna/`);
      await robin.page.locator(".nav-menu.account summary").click();
      expect(await robin.page.locator(".nav-menu.account .menu a").allTextContents()).toEqual(["Your chats", "All work & files", "Manage"]);
      await robin.page.locator(".nav-menu.account .menu a", { hasText: "Manage" }).click();
      await robin.page.getByRole("heading", { name: "Manage" }).waitFor();
      // Phone, 390 px: one "Jobs" menu, nothing scrolls sideways.
      const phone = await open(w.alex, 390, 844);
      await phone.page.goto(`${w.url}/o/exna/`);
      await phone.page.locator(".jobs").waitFor();
      expect(await phone.page.locator(".jobs-tabs").isVisible()).toBe(false);
      expect(await phone.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      if (SHOTS) await phone.page.screenshot({ path: join(SHOTS, "home-phone-390.png"), fullPage: true });
      await phone.page.locator(".jobs-menu summary").click();
      expect(await phone.page.locator(".jobs-menu .menu a").allTextContents()).toEqual(["Home", "Newsletter", "Meetings"]);
      if (SHOTS) await phone.page.screenshot({ path: join(SHOTS, "home-phone-menu-390.png") });
      await phone.page.locator(".jobs-menu .menu a", { hasText: "Meetings" }).click();
      await phone.page.getByRole("heading", { name: "Meetings" }).waitFor();
      expect(await phone.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect([...alex.errors, ...robin.errors, ...phone.errors].filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 180_000);

  // The renders as CP has them: the website connected (three job cards), a reviewer, desktop and phone.
  it("renders with the website connected: three job cards, Website page with Home crumb", async () => {
    const w = await transcriptionWorld({ chat: {}, teamTasks: true, website: {}, websiteContent: { start: false } });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.JOBS_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    try {
      for (const [width, height, tag] of [[1440, 900, "desktop-1440"], [390, 844, "phone-390"]] as const) {
        const c = await browser.newContext({ viewport: { width, height } }), page = await c.newPage(), [name, value] = w.robin.split("=");
        await c.addCookies([{ name, value, url: w.url }]);
        await page.goto(`${w.url}/o/exna/`);
        await page.locator(".jobs").waitFor();
        expect(await page.locator(".job strong").allTextContents()).toEqual(["Website", "Newsletter", "Meetings"]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `home-website-${tag}.png`), fullPage: true });
        await page.locator(".job", { hasText: "Website" }).click();
        await page.getByRole("heading", { name: "Website", exact: true }).waitFor();
        expect(await page.getByRole("link", { name: "← Home" }).isVisible()).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `website-${tag}.png`), fullPage: true });
        await c.close();
      }
    } finally { await browser.close(); await w.close(); }
  }, 180_000);
});
