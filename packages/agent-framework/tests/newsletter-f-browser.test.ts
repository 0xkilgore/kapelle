// Package F delta A (Fable A-1): the section-image layout in a real browser. Left/right sit beside the text at the email's width and
// stack on a phone; the Outlook fallback (a client that ignores inline-block columns) shows the image ABOVE the text.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { renderNewsletterV3 } from "../src/org/newsletter/render-cp.js";
import { F_CASES } from "./newsletter-f-cases.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const SHOTS = process.env.UI_RENDER_DIR;

describe.skipIf(!existsSync(PLAYWRIGHT))("newsletter section images in a browser (A-1)", () => {
  it("left/right beside the text at 640 px, stacked at 375 px; image above the text when columns are ignored (Outlook)", async () => {
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      // A local stand-in image (no network): every request answers a 440x300 PNG-sized SVG.
      await page.route("**/*", (r: any) => r.request().url().startsWith("https://www.example.org/")
        ? r.fulfill({ status: 200, contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="440" height="300"><rect width="440" height="300" fill="#3E6E70"/></svg>' }) : r.abort());
      const box = async (sel: string) => page.locator(sel).first().boundingBox();
      for (const k of ["image-left", "image-right"]) {
        for (const [width, side] of [[640, true], [375, false]] as const) {
          await page.setViewportSize({ width, height: 1200 });
          await page.setContent(renderNewsletterV3(F_CASES[k]), { waitUntil: "load" });
          const img = (await box('img[src*="block-party"]'))!, text = (await box("text=Over 300 neighbors"))!;
          if (side) { expect(Math.abs(img.y - text.y), k + " same row").toBeLessThan(40); expect(k === "image-left" ? img.x < text.x : img.x > text.x, k + " side").toBe(true); }
          else expect(img.y + img.height, k + " stacked").toBeLessThanOrEqual(text.y + 1);
          if (SHOTS) await page.screenshot({ path: `${SHOTS}/f-${k}-${width}.png`, fullPage: true });
        }
        // Outlook: the column styles are not honoured; the image comes first in the source, so it sits above the text.
        await page.setViewportSize({ width: 640, height: 1200 });
        await page.setContent(renderNewsletterV3(F_CASES[k]).replace(/display:inline-block;margin:0 -1px;max-width:\d+px;min-width:\d+px;/g, "display:block;"), { waitUntil: "load" });
        const img = (await box('img[src*="block-party"]'))!, text = (await box("text=Over 300 neighbors"))!;
        expect(img.y + img.height, k + " outlook").toBeLessThanOrEqual(text.y + 1);
      }
      for (const k of ["image-above", "lists-mixed"]) if (SHOTS) { await page.setContent(renderNewsletterV3(F_CASES[k]), { waitUntil: "load" }); await page.screenshot({ path: `${SHOTS}/f-${k}-640.png`, fullPage: true }); }
    } finally { await browser.close(); }
  }, 120_000);
});
