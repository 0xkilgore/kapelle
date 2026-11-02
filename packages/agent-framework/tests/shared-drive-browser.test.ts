// LIBRARY L1 in real Chromium under the hub's production CSP: the Files page is the shared drive. A member adds an image (it
// renders through the logged-in drive route) and a text file; another member sees both; a chat image is saved to the drive
// from the chat; a reviewer removes one. Synthetic pixels; the decoder is the real sanitizer (child mode).
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { transcriptionWorld } from "./transcription-world.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const decoderOk = existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const enabled = decoderOk && !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT);

describe.skipIf(!enabled)("shared drive in the browser (L1)", () => {
  it("add an image and a text file, another member sees them, save a chat image to the drive, a reviewer removes one", async () => {
    const sharp = createRequire(new URL("../decoder/package.json", import.meta.url))("sharp");
    const w = await transcriptionWorld({ chat: {}, images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true } } });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.DRIVE_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const open = async (cookie: string) => { const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = cookie.split("=");
      await c.addCookies([{ name, value, url: w.url }]); const errors: string[] = []; page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); }); return { page, errors }; };
    try {
      const dir = join(w.base, "pick"); mkdirSync(dir);
      const jpg = join(dir, "Porch party.jpg"), png = join(dir, "garden.png"), md = join(dir, "volunteers.md");
      writeFileSync(jpg, await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 230, g: 120, b: 50 } } }).jpeg().toBuffer());
      writeFileSync(png, await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 40, g: 140, b: 90 } } }).png().toBuffer());
      writeFileSync(md, "# Volunteers\nSam, Ali\n");
      const alex = await open(w.alex);
      await alex.page.goto(`${w.url}/o/exna/#files`);
      await alex.page.getByRole("heading", { name: "Shared drive" }).waitFor();
      await alex.page.locator("#drive-upload").setInputFiles(jpg);
      const thumb = alex.page.locator(".drive-images img[alt='Porch party']");
      await thumb.waitFor({ timeout: 20_000 });
      await alex.page.waitForFunction(() => { const i = document.querySelector(".drive-images img") as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; });
      await alex.page.locator("#drive-upload").setInputFiles(md);
      await alex.page.getByText("volunteers.md").first().waitFor();
      expect(await alex.page.getByText("Files your team and the agent can use. Nothing here is public.").count()).toBe(1);
      expect(await alex.page.getByText("images.md").count()).toBe(0); // the agent's list is internal plumbing (Director)
      expect(await alex.page.locator(".card.viewer").isVisible()).toBe(false); // no empty viewer until a file is opened
      if (SHOTS) await alex.page.screenshot({ path: join(SHOTS, "drive-files-closed-1440.png"), fullPage: true });
      await alex.page.getByRole("button", { name: "Open" }).first().click();
      await alex.page.locator(".card.viewer").getByText("# Volunteers").waitFor();
      expect(await alex.page.getByRole("button", { name: "Remove" }).count()).toBe(0); // contributors don't remove
      if (SHOTS) await alex.page.screenshot({ path: join(SHOTS, "drive-files-1440.png"), fullPage: true });
      // Robin (a reviewer) sees both and can remove.
      const robin = await open(w.robin);
      await robin.page.goto(`${w.url}/o/exna/#files`);
      await robin.page.locator(".drive-images img[alt='Porch party']").waitFor();
      await robin.page.waitForFunction(() => { const i = document.querySelector(".drive-images img") as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; });
      await robin.page.getByText("volunteers.md").first().waitFor();
      // A chat image: chat-private until Alex saves it to the drive.
      const conv = (await w.post("/o/exna/api/chat/conversation/create", {}, w.alex)).result.conversationId;
      await alex.page.goto(`${w.url}/o/exna/#chat`);
      await alex.page.locator(".chat-list button, .conversation").first().waitFor({ timeout: 10_000 }).catch(() => {});
      await alex.page.locator("#chat-image").setInputFiles(png);
      await alex.page.locator(".chat-images img").waitFor({ timeout: 20_000 });
      await alex.page.locator(".drive-name").fill("Garden");
      await alex.page.getByRole("button", { name: "Save to shared drive" }).click();
      await alex.page.getByText("Saved to the shared drive.").waitFor();
      if (SHOTS) await alex.page.screenshot({ path: join(SHOTS, "drive-chat-save-1440.png"), fullPage: true });
      expect(conv).toMatch(/^conv_/);
      await robin.page.reload();
      await robin.page.locator(".drive-images img[alt='Garden']").waitFor();
      // Robin removes Porch party.
      robin.page.once("dialog", (d: any) => d.accept());
      await robin.page.locator("figure", { has: robin.page.locator("img[alt='Porch party']") }).getByRole("button", { name: "Remove" }).click();
      await robin.page.locator(".drive-images img[alt='Porch party']").waitFor({ state: "detached" });
      expect(await robin.page.locator(".drive-images img").count()).toBe(1);
      if (SHOTS) await robin.page.screenshot({ path: join(SHOTS, "drive-reviewer-1440.png"), fullPage: true });
      expect([...alex.errors, ...robin.errors].filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 180_000);
});
