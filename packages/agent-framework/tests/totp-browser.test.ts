// Newsletter send slice 1, S1-b (Fable R-6): the authenticator enrollment page in REAL Chromium under the hub's production
// CSP. The token is read once from the fragment and removed before any request; enroll.start is called once; the secret,
// link and QR are text nodes and canvas pixels; after confirm the secret is gone from the page. The secret is the test
// world's random (synthetic) seed. Renders with TOTP_SHOTS. Runs when Playwright is installed.
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import { base32Decode, hotp, totpStep } from "../src/access/totp.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && existsSync(PLAYWRIGHT);

describe.skipIf(!enabled)("authenticator enrollment page in a real browser", () => {
  it("token read once and removed; QR on a canvas; secret as text; two codes confirm; the secret leaves the page", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ktotp-b-")), kf = join(dir, "totp.key");
    writeFileSync(kf, randomBytes(32).toString("base64"), { mode: 0o600 }); chmodSync(kf, 0o600);
    const w = await transcriptionWorld({ newsletter: { totpKeyFile: kf } });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.TOTP_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    try {
      const link = (await w.ops("/ops/totp/enroll", { email: "robin@exna.test" })).link as string;
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await ctx.newPage(), [name, value] = w.robin.split("=");
      await ctx.addCookies([{ name, value, url: w.url }]);
      const errors: string[] = []; page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); });
      const starts: string[] = []; page.on("request", (r: any) => { if (r.url().endsWith("/api/totp/enroll/start")) starts.push(r.url()); });
      await page.goto(`${w.url}/o/exna/${link.slice(link.indexOf("#"))}`);
      await page.getByRole("heading", { name: "Set up your authenticator" }).waitFor();
      await page.locator("canvas.qr").waitFor();
      expect(await page.evaluate(() => location.hash)).toBe("#totp"); // the token is gone from the address bar
      expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);
      const href = await page.getByRole("link", { name: "Open in an authenticator app" }).getAttribute("href");
      expect(href).toMatch(/^otpauth:\/\/totp\/Kapelle%20EXNA:robin%40exna\.test\?secret=[A-Z2-7]{32}&/);
      expect(await page.locator("canvas.qr").evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(100);
      const secret = (await page.locator(".totp .mono").textContent())!;
      expect(secret).toMatch(/^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "totp-enroll-1440.png"), fullPage: true });
      // A wrong pair: the refusal words, the key stays for another try.
      await page.getByRole("textbox", { name: "First code" }).fill("000000");
      await page.getByRole("textbox", { name: "Next code" }).fill("000001");
      await page.getByRole("button", { name: "Confirm" }).click();
      await page.getByText("Those codes didn't match.", { exact: false }).waitFor();
      const seed = base32Decode(secret.replaceAll(" ", "")), c2 = totpStep(Date.now());
      await page.getByRole("textbox", { name: "First code" }).fill(hotp(seed, c2 - 1));
      await page.getByRole("textbox", { name: "Next code" }).fill(hotp(seed, c2));
      await page.getByRole("button", { name: "Confirm" }).click();
      await page.getByText("Your authenticator is set up.", { exact: false }).waitFor();
      const body = (await page.locator("body").textContent())!;
      expect(body).not.toContain(secret);
      expect(await page.locator("canvas.qr, a[href^='otpauth:']").count()).toBe(0);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "totp-done-1440.png"), fullPage: true });
      expect(starts).toHaveLength(1);
      // Reloading never re-sends the token (it is gone): the page asks for a link instead.
      await page.reload();
      await page.getByText("Open the setup link an admin gave you.", { exact: false }).waitFor();
      expect(starts).toHaveLength(1);
      expect((await w.ops("/ops/status", {})).totp).toMatchObject({ active: 1, pending: 0 });
      expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});
