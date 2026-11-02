// IMAGES-V1 I2b in REAL Chromium under the hub's production CSP, with a FAKE provider and the REAL decoder: "Read this flyer"
// tells the member the flyer goes to the hosted model BEFORE anything is sent (a line by the button; one click reads); the proposal reads
// "From the flyer — check this" with each field editable beside the printed wording, an unprinted year left for the member,
// the description marked as a draft; saving stores the checked values. Renders with FLYER_SHOTS.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { IMAGE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && existsSync(PLAYWRIGHT) && existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const sharp = enabled ? createRequire(new URL("../decoder/package.json", import.meta.url))("sharp") : null;
const ANSWER = { fields: { title: { raw: "block party", value: "Block Party" }, date: { raw: "Saturday Nov 8", value: null }, time: { raw: "2-5 PM", value: "2:00 PM - 5:00 PM" },
  location: { raw: "Community Center", value: "Community Center" }, address: { raw: null, value: null }, description: { raw: "Games, food, music", value: "Games, food and music for neighbors." } },
  notes: "The year is not printed." };

describe.skipIf(!enabled)("Read this flyer in a real browser (I2b)", () => {
  it("notice before sending; Cancel sends nothing; check and save the proposed fields", async () => {
    const flyerRequests: unknown[] = [];
    const fetch = async (_u: string, i: any) => { const b = JSON.parse(i.body);
      if (Array.isArray(b.messages?.[1]?.content)) { flyerRequests.push(b); await new Promise((r) => setTimeout(r, 300));
        return new Response(JSON.stringify({ id: "gen-1", model: IMAGE_PROFILES.sonnet.runtime.model, provider: "Amazon Bedrock",
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(ANSWER) } }],
          usage: { prompt_tokens: 2100, completion_tokens: 180, total_tokens: 2280, cost: 0.0091 } }), { status: 200, headers: { "content-type": "application/json" } }); }
      return new Response("{}", { status: 503 }); };
    const w = await transcriptionWorld({ chat: {}, fetch: fetch as never, images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true }, extract: true } });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.FLYER_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    try {
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = w.alex.split("=");
      const errors: string[] = []; page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e: any) => errors.push("pageerror " + e.message));
      await c.addCookies([{ name, value, url: w.url }]);
      await page.goto(`${w.url}/o/exna/#chat`);
      await page.getByRole("button", { name: "New chat" }).click();
      await page.locator(".starter").first().waitFor();
      const flyer = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#f4e3b0" } }).jpeg().toBuffer();
      await page.locator("#chat-image").setInputFiles({ name: "block-party.jpg", mimeType: "image/jpeg", buffer: flyer });
      await page.getByRole("button", { name: "Read this flyer" }).waitFor({ timeout: 20_000 });
      // Owner (Oct 23): one step. The notice is shown BEFORE the click (a small line by the button); nothing is sent until the click.
      await page.getByText("Reading sends this flyer to the configured hosted model (Claude, through OpenRouter, with no data retention). Nothing is published.").waitFor();
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "flyer-notice-1440.png"), fullPage: true });
      expect(flyerRequests).toHaveLength(0);
      await page.getByRole("button", { name: "Read this flyer" }).click();
      await page.getByText("From the flyer — check this").waitFor({ timeout: 20_000 });
      expect(flyerRequests).toHaveLength(1);
      expect(await page.getByRole("button", { name: "Read this flyer" }).count()).toBe(0); // one proposal per image
      expect(await page.getByLabel("Title").inputValue()).toBe("Block Party");
      expect(await page.getByLabel("Date (YYYY-MM-DD)").inputValue()).toBe("");
      await page.getByText("The year isn't printed: enter the full date yourself.").waitFor();
      await page.getByText("Printed: “Saturday Nov 8”").waitFor();
      await page.getByText("A draft based on the flyer, not a quotation.").waitFor();
      expect(await page.getByText("Not printed on the flyer").count()).toBe(1); // the address
      await page.getByText("Not checked yet").waitFor();
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "flyer-proposal-1440.png"), fullPage: true });
      // Owner (Oct 23): no Save button; each field saves when you leave it. A wrong date shape is refused in words; the right one saves.
      expect(await page.getByRole("button", { name: /Save(?! to shared drive)/ }).count()).toBe(0); // LIBRARY L1: the chat image's "Save to shared drive" is not a fields Save
      await page.getByLabel("Date (YYYY-MM-DD)").fill("Nov 8"); await page.getByLabel("Date (YYYY-MM-DD)").blur();
      await page.getByText("Check the details: a date is YYYY-MM-DD").waitFor();
      await page.getByLabel("Date (YYYY-MM-DD)").fill("2026-11-08"); await page.getByLabel("Date (YYYY-MM-DD)").blur();
      await page.getByText("Saved.").waitFor();
      await page.getByLabel("Address").fill("1 Main St"); await page.getByLabel("Address").blur();
      await page.getByText("Checked by you").waitFor();
      for (let i = 0; i < 50 && !JSON.parse((w.org.sqlite.db.prepare("SELECT checked FROM image_proposals").get() as any).checked ?? "{}").address; i++) await new Promise((x) => setTimeout(x, 20));
      const row = w.org.sqlite.db.prepare("SELECT checked FROM image_proposals").get() as any;
      expect(JSON.parse(row.checked)).toMatchObject({ title: "Block Party", date: "2026-11-08", address: "1 Main St", location: "Community Center" });
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "flyer-checked-1440.png"), fullPage: true });
      expect(await page.getByRole("button", { name: "Add to the website" }).count()).toBe(0); // I3: contributors never promote to the website
      // Help says how, when reading is on.
      await page.goto(`${w.url}/o/exna/#help`);
      await page.getByText("To get its event details, press “Read this flyer”.", { exact: false }).waitFor();
      await page.goto(`${w.url}/o/exna/#chat`); // owner (Oct 23): a visit lands on a fresh chat; the flyer chat is in the sidebar
      await page.locator("a.conv:not(.on)").first().click();
      await page.getByText("From the flyer — check this").waitFor();
      await page.setViewportSize({ width: 390, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "flyer-checked-390.png"), fullPage: true });
      expect(errors.filter((e) => /Content Security Policy|Refused|pageerror/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
