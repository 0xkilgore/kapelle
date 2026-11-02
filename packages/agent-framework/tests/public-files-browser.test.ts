// LIBRARY L2 in real Chromium under the hub's production CSPs: a reviewer's draft that places a shared-drive image. The draft
// preview shows the image through the logged-in route (the preview CSP admits only that route); "Send me a test" opens the
// publish card (each image, size, hash and exact URL; Fable P-1's sentence); approving publishes, prepares and sends the test,
// and the image is then served on the files host. Synthetic pixels, fake providers.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { filesHost, publicFilesWorld } from "./public-files-world.js";
import { publishDigest } from "../src/org/library/public-files.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const decoderOk = existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const enabled = decoderOk && !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT);

describe.skipIf(!enabled)("publish-on-prepare in the browser (L2)", () => {
  it("preview shows the drive image; Send me a test -> the publish card -> approve -> test sent; the files host serves it", async () => {
    const s = await publicFilesWorld();
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.DRIVE_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    try {
      await s.draft(true);
      const c = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await c.newPage(), [name, value] = s.w.robin.split("=");
      await c.addCookies([{ name, value, url: s.w.url }]);
      const errors: string[] = []; page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
      await page.goto(`${s.w.url}/o/exna/#chat`);
      await page.getByRole("button", { name: "Open preview" }).click();
      const frame = page.frameLocator("iframe.preview");
      const img = frame.locator("img[alt='Neighbors on a porch']");
      await img.waitFor({ timeout: 15_000 });
      await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete ? i.naturalWidth : -1), { timeout: 10_000 }).toBe(800);
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(404); // the preview did not publish anything
      // Every image in the preview loads (the default header strip from CP's site, and the drive photo).
      await expect.poll(() => frame.locator("img").evaluateAll((l: HTMLImageElement[]) => l.length > 4 && l.every((i) => i.complete && i.naturalWidth > 0)), { timeout: 30_000 }).toBe(true);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "publish-preview-1440.png"), fullPage: true });
      await page.getByRole("button", { name: "Send me a test" }).click();
      await page.getByRole("heading", { name: "This newsletter uses a photo from the shared drive" }).waitFor();
      await page.getByText("This photo goes online so the email can show it. Anyone with the link can see it.").waitFor();
      // Fable Addendum 4: the exact change is IN the card DOM from the start (collapsed, not fetched on expand); the 14-day rule
      // is outside Details.
      const card = page.locator(".card.publish");
      expect(await card.locator("details").evaluate((d: HTMLDetailsElement) => [d.open, d.textContent])).toEqual([false, expect.stringContaining(s.url)]);
      expect(await card.locator("details").textContent()).toContain("SHA-256 " + s.h);
      expect(await card.locator("details").textContent()).toContain("Preparing publishes this image at files.example.org (anyone with the link can view them).");
      expect(await card.locator("details").textContent()).toMatch(/\(\d{1,3}(,\d{3})* bytes\)/);
      expect(await card.locator("details").textContent()).not.toContain("14 days");
      expect(await card.getByText(/isn't sent within 14 days/).isVisible()).toBe(true);
      expect(await page.getByText(s.url).isVisible()).toBe(false);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "publish-card-1440.png"), fullPage: true });
      await page.getByText("Details", { exact: true }).click();
      await page.getByText(s.url).waitFor();
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "publish-card-details-1440.png"), fullPage: true });
      await page.getByText("Details", { exact: true }).click(); // close it again: the approval binds the full list either way
      expect(await page.getByText(s.url).isVisible()).toBe(false);
      await page.waitForFunction(() => { const i = document.querySelector(".publish-photos img") as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; });
      await page.getByRole("button", { name: "Put 1 photo online and continue" }).click(); // Details closed
      await page.getByText("Test sent to robin@exna.test. Check your inbox.").waitFor({ timeout: 20_000 });
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "publish-done-1440.png"), fullPage: true });
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(200);
      // The approval (made with Details closed) bound the digest of the FULL list.
      expect(s.w.org.sqlite.db.prepare("SELECT artifact_digest FROM access_authorizations WHERE action='newsletter.release.publish'").all()).toEqual([{ artifact_digest: publishDigest([s.h]) }]);
      expect(s.sent.at(-1).body.html).toContain(s.url);
      // An admin sees it is public on the Files page and unpublishes it: the link then answers "gone" (410).
      const ac = await browser.newContext({ viewport: { width: 1440, height: 900 } }), admin = await ac.newPage(), [an, av] = s.w.admin.split("=");
      await ac.addCookies([{ name: an, value: av, url: s.w.url }]);
      await admin.goto(`${s.w.url}/o/exna/#files`);
      await admin.getByText("Public (in a newsletter)").waitFor();
      if (SHOTS) await admin.screenshot({ path: join(SHOTS, "drive-admin-public-1440.png"), fullPage: true });
      admin.once("dialog", (d: any) => d.accept());
      await admin.getByRole("button", { name: "Unpublish" }).click();
      await admin.getByText("Public (in a newsletter)").waitFor({ state: "detached" });
      const cache = (await import("../src/hub/hub.js")).Hub.FILES; const keep = cache.cacheMs; cache.cacheMs = 0;
      try { expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(410); } finally { cache.cacheMs = keep; }
      expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
    } finally { await browser.close(); await s.close(); }
  }, 180_000);
});
