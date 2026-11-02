// IMAGES-V1 I3 in REAL Chromium under the hub's production CSP: a reviewer's checked flyer -> "Add to the website" -> the
// Website form with the details and the image ("This image will become public…", removable) -> "Ask the agent to draft this change" -> the
// card shows the change, the image, its public address and the public warning before approval. FAKE GitHub and models; the
// REAL decoder. Renders with WEBSITE_IMAGE_SHOTS.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { hosted } from "./org-meeting-kit.js";
import { FakeGithub } from "../src/org/website/fake-github.js";
import { IMAGE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT)
  && existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const sharp = enabled ? createRequire(new URL("../decoder/package.json", import.meta.url))("sharp") : null;
const FLYER = { fields: { title: { raw: "block party", value: "Block Party" }, date: { raw: "Saturday, November 8, 2026", value: "2026-11-08" }, time: { raw: "2-5 PM", value: "2:00 PM" },
  location: { raw: "Community Center", value: "Community Center" }, address: { raw: null, value: null }, description: { raw: "Games", value: "Games, food and music." } }, notes: null };
const EVENT = { id: "block-party-2026-11", title: "Block Party", date: "2026-11-08", time: "2:00 PM", location: "Community Center", address: "", description: "Games, food and music.", type: "community" };
const reply = (content: string, model: string, provider: string, usage: unknown) => new Response(JSON.stringify({ id: "g", model, provider,
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage }), { status: 200, headers: { "content-type": "application/json" } });

describe.skipIf(!enabled)("flyer -> website event in a real browser (I3)", () => {
  it("Add to the website -> the Website form with the image and the public warning -> the card shows the image before approval", async () => {
    const gh = new FakeGithub(undefined, { "src/data/events.json": JSON.stringify({ events: [] }, null, 2) + "\n", "src/data/meeting-notes.json": JSON.stringify({ meetings: [] }, null, 2) + "\n" });
    const websiteUsers: string[] = [];
    const fetch = async (_u: string, i: any) => { const b = JSON.parse(i.body);
      if (Array.isArray(b.messages?.[1]?.content)) return reply(JSON.stringify(FLYER), IMAGE_PROFILES.sonnet.runtime.model, "Amazon Bedrock",
        { prompt_tokens: 2100, completion_tokens: 180, total_tokens: 2280, cost: 0.0091, prompt_tokens_details: { image_tokens: 1600 } });
      websiteUsers.push(String(b.messages?.at(-1)?.content ?? ""));
      return reply(JSON.stringify({ ops: [{ op: "upsert_event", event: EVENT }] }), hosted.runtime.responseModels?.at(-1) ?? hosted.runtime.model,
        (hosted.runtime.providerNames ?? hosted.runtime.providers)[0], { prompt_tokens: 9000, completion_tokens: 200, total_tokens: 9200, cost: 0.03 }); };
    const w = await transcriptionWorld({ chat: {}, fetch: fetch as never, githubFetch: gh.fetch, website: {}, images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true }, extract: true } });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.WEBSITE_IMAGE_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    try {
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = w.robin.split("=");
      const errors: string[] = []; page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e: any) => errors.push("pageerror " + e.message));
      await c.addCookies([{ name, value, url: w.url }]);
      await page.goto(`${w.url}/o/exna/#chat`);
      await page.getByRole("button", { name: "New chat" }).click();
      await page.locator(".starter").first().waitFor();
      const flyer = await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#f4e3b0" } }).jpeg().toBuffer();
      await page.locator("#chat-image").setInputFiles({ name: "block-party.jpg", mimeType: "image/jpeg", buffer: flyer });
      await page.getByRole("button", { name: "Read this flyer" }).waitFor({ timeout: 20_000 });
      await page.getByRole("button", { name: "Read this flyer" }).click();
      await page.getByText("From the flyer — check this").waitFor({ timeout: 20_000 });
      // Owner (Oct 23): ONE action: "Add to the website" saves the checked details and carries them over (no separate Save).
      expect(await page.getByRole("button", { name: /Save(?! to shared drive)/ }).count()).toBe(0); // LIBRARY L1: the chat image's "Save to shared drive" is not a fields Save
      expect(w.org.sqlite.db.prepare("SELECT checked FROM image_proposals").get()).toMatchObject({ checked: null });
      if (SHOTS) await page.locator(".card.flyer").screenshot({ path: join(SHOTS, "flyer-card-reviewer-1440.png") });
      await page.getByText("This also saves the details above as checked by you.").waitFor(); // Fable N-1
      await page.getByRole("button", { name: "Add to the website" }).click();
      await page.getByText("The flyer image goes with this request").waitFor();
      expect(await page.locator("#website-text").inputValue()).toBe("Add this event to the website: Block Party on 2026-11-08 at 2:00 PM at Community Center. Description: Games, food and music.");
      await page.getByText("This image will become public on the website when a maintainer publishes (merges) the change.").waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".flyer-attach img")].every((i) => i.complete && i.naturalWidth > 0));
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "website-image-form-1440.png"), fullPage: true });
      await page.getByRole("button", { name: "Ask the agent to draft this change" }).click();
      await page.getByText("Image for this event").waitFor({ timeout: 20_000 });
      await page.getByText(/Public address: \/images\/events\/block-party-2026-11-[a-f0-9]{16}\.jpg/).waitFor();
      await page.getByRole("button", { name: "Approve and open a draft PR" }).waitFor();
      expect(await page.getByText("The flyer image goes with this request").count()).toBe(0); // the form is cleared after sending
      expect(websiteUsers).toHaveLength(1);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "website-image-card-1440.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "website-image-card-390.png"), fullPage: true });
      // Help says how.
      await page.goto(`${w.url}/o/exna/#help`);
      await page.getByText("press “Add to the website”", { exact: false }).waitFor();
      expect(errors.filter((e) => /Content Security Policy|Refused|pageerror/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
