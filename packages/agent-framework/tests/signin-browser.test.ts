// CP prod bug 2026-10-16 (owner: "can't click into the Your email box"): with no session, the page's member.me call got a 401,
// post() re-rendered on ANY 401, render() called member.me again -> an endless loop that rebuilt the sign-in form thousands
// of times a second (6188 member.me requests in 2 s), so the box never kept focus. Real Chromium against the hub's own
// production headers (CSP default-src 'none'; script-src 'self'; ...; Caddy adds only HSTS). Runs when Playwright is installed.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { transcriptionWorld } from "./transcription-world.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && existsSync(PLAYWRIGHT);
// Package E (Fable E-11): frame-src 'self' so the draft preview frame can load its own same-origin URL (its response has its own CSP).
const PROD_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

describe.skipIf(!enabled)("sign-in page in a real browser", () => {
  it("signed out: one member.me call, the email box takes clicks and typing; a session that ends mid-use shows sign-in once", async () => {
    const w = await transcriptionWorld({ intakeNone: true });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      let me = 0; const headers: Record<string, string>[] = [];
      page.on("request", (r: any) => { if (r.url().endsWith("/api/member/me")) me++; });
      page.on("response", (r: any) => { if (r.url().endsWith("/o/exna/")) headers.push(r.headers()); });
      const errors: string[] = []; page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
      await page.goto(`${w.url}/o/exna/`);
      await page.getByLabel("Your email").waitFor();
      await page.waitForTimeout(1500);
      expect(headers[0]["content-security-policy"]).toBe(PROD_CSP);
      expect(me).toBe(1);
      await page.getByLabel("Your email").click({ timeout: 3000 });
      await page.keyboard.type("owner@example.org");
      expect(await page.getByLabel("Your email").inputValue()).toBe("owner@example.org");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("email");
      await page.getByRole("button", { name: "Email me a sign-in link" }).click();
      await page.getByText("If that address belongs to a member, a sign-in link is on its way.").waitFor();
      expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
      // Signed in, then the session ends (the member is removed): the sign-in view appears once, and stays usable.
      const ctx = await browser.newContext(), alex = await ctx.newPage(), [name, value] = w.alex.split("=");
      await ctx.addCookies([{ name, value, url: w.url }]);
      let me2 = 0; alex.on("request", (r: any) => { if (r.url().endsWith("/api/member/me")) me2++; });
      await alex.goto(`${w.url}/o/exna/#notes`);
      await alex.waitForSelector("#nav a");
      // Owner feedback: with no approved notes, the Notes page explains the path (a contributor is told to ask a reviewer).
      await alex.getByRole("heading", { name: "No meeting notes have been approved yet" }).waitFor();
      await alex.getByText("Ask a reviewer or admin to add the latest meeting notes.").waitFor();
      expect(await alex.getByRole("link", { name: "Go to Review" }).count()).toBe(0);
      const rctx = await browser.newContext(), robin = await rctx.newPage(), [rn, rv] = w.robin.split("=");
      await rctx.addCookies([{ name: rn, value: rv, url: w.url }]);
      await robin.goto(`${w.url}/o/exna/#notes`);
      await robin.getByText("A reviewer adds the meeting notes on the Review page", { exact: false }).waitFor();
      await robin.getByRole("link", { name: "Go to Review" }).click();
      await robin.getByRole("heading", { name: "Add meeting notes" }).waitFor();
      expect((await w.ops("/ops/member/remove", { email: "alex@exna.test" })).ok).toBe(true);
      // The first request after removal is refused (access_member_inactive) and the hub drops the session; the next is a 401.
      await alex.evaluate(() => { location.hash = "#activity"; }); await alex.waitForTimeout(300);
      await alex.evaluate(() => { location.hash = "#notes"; });
      await alex.getByLabel("Your email").waitFor({ timeout: 5000 });
      await alex.waitForTimeout(1500);
      expect(me2).toBeLessThanOrEqual(3);
      await alex.getByLabel("Your email").fill("alex@exna.test");
      expect(await alex.getByLabel("Your email").inputValue()).toBe("alex@exna.test");
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
