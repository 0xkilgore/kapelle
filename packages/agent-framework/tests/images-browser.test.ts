// IMAGES-V1 I1b in REAL Chromium under the hub's production CSP: "Attach a flyer/image" mints a single-use ticket and streams
// the file through the hub (which buffers nothing); the chat shows the sanitized thumbnail through the authenticated image
// route (image/jpeg, nosniff, no-store); other members, no session and cross-site requests are refused; the hub enforces the
// 4 MiB cap and image types before the runtime. The REAL decoder runs as a child process. Runs when Playwright and the
// decoder package are installed.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { request } from "node:http";
import { transcriptionWorld } from "./transcription-world.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && existsSync(PLAYWRIGHT) && existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const sharp = enabled ? createRequire(new URL("../decoder/package.json", import.meta.url))("sharp") : null;

describe.skipIf(!enabled)("chat image attachments in a real browser (I1b)", () => {
  it("attach -> sanitized thumbnail via the authenticated route; refusals for others, no session, cross-site, size and type", async () => {
    const w = await transcriptionWorld({ chat: {}, images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true } } });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    try {
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = w.alex.split("=");
      const errors: string[] = []; page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e: any) => errors.push("pageerror " + e.message));
      await c.addCookies([{ name, value, url: w.url }]);
      await page.goto(`${w.url}/o/exna/#chat`);
      await page.getByRole("button", { name: "New chat" }).click();
      await page.locator(".starter").first().waitFor();
      const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#36c" } }).png().withExif({ IFD0: { Make: "SecretCam" } }).toBuffer();
      await page.locator("#chat-image").setInputFiles({ name: "flyer.png", mimeType: "image/png", buffer: png });
      await page.getByText("Image attached. Its location and camera details were removed").waitFor({ timeout: 20_000 });
      const thumb = page.locator(".chat-image img");
      await thumb.waitFor();
      await page.waitForFunction(() => { const i = document.querySelector(".chat-image img") as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; });
      expect(await thumb.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight])).toEqual([900, 600]);
      expect(await page.locator(".chat-image figcaption").textContent()).toContain("Only you can see this image");
      const SHOTS = process.env.IMAGE_SHOTS; // renders for review: the chat with an attached flyer
      if (SHOTS) { (await import("node:fs")).mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: SHOTS + "/chat-image-1440.png", fullPage: true }); }
      const src = (await thumb.getAttribute("src"))!;
      expect(src).toMatch(/^\/o\/exna\/image\/img_[a-f0-9]{32}$/);
      // The bytes: a clean JPEG with the fixed headers.
      const r = await page.request.get(w.url + src);
      expect(r.status()).toBe(200);
      expect(r.headers()).toMatchObject({ "content-type": "image/jpeg", "x-content-type-options": "nosniff", "cache-control": "private, no-store" });
      const body = await r.body();
      expect(body.includes("SecretCam")).toBe(false);
      expect((await sharp(body).metadata()).exif).toBeUndefined();
      // Another member, no session, cross-site.
      const [n2, v2] = w.robin.split("=");
      expect((await fetch(w.url + src, { headers: { cookie: `${n2}=${v2}` } })).status).toBe(403);
      expect((await fetch(w.url + src)).status).toBe(401);
      expect((await fetch(w.url + src, { headers: { cookie: `${name}=${value}`, "sec-fetch-site": "cross-site" } })).status).toBe(403);
      // The hub refuses an over-cap or non-image upload before the runtime sees it.
      const conv = (await w.post("/o/exna/api/chat/conversation/create", {}, w.alex)).result.conversationId;
      const t = (await w.post("/o/exna/api/image/upload", { conversationId: conv, size: 100, contentType: "image/png" }, w.alex)).result;
      // The hub answers and cuts WITHOUT reading the body (as for audio), so send only the headers and read the answer.
      const put = (len: number, type: string) => new Promise<any>((res, rej) => {
        const u = new URL(`${w.url}/o/exna/upload/${t.uploadId}`);
        const q = request({ host: u.hostname, port: u.port, path: u.pathname, method: "PUT", headers: { cookie: `${name}=${value}`, "content-type": type, "content-length": String(len) } }, (x) => {
          let b = ""; x.on("data", (d) => { b += d; }); x.on("end", () => { try { res({ status: x.statusCode, ...JSON.parse(b) }); } catch (e) { rej(e); } }); });
        q.on("error", rej); q.flushHeaders();
      });
      expect(await put(4 * 1024 * 1024 + 1, "image/png")).toMatchObject({ status: 413, error: "image_too_large" });
      expect(await put(100, "image/svg+xml")).toMatchObject({ status: 415, error: "hub_content_type_refused" });
      await page.goto(`${w.url}/o/exna/#help`);
      await page.getByRole("heading", { name: "Attach a flyer or image" }).waitFor();
      await page.goto(`${w.url}/o/exna/#chat`); // owner (Oct 23): a visit lands on a fresh chat; the image chat is in the sidebar
      await page.locator("a.conv:not(.on)").first().click();
      await page.locator(".chat-image img").first().waitFor();
      // Phone width: the attach control and the thumbnail fit.
      await page.setViewportSize({ width: 390, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      if (SHOTS) await page.screenshot({ path: SHOTS + "/chat-image-390.png", fullPage: true });
      expect(errors.filter((e) => /Content Security Policy|Refused|pageerror/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
