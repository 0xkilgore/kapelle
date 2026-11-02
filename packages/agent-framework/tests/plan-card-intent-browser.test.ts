// P2 (owner, Oct 26) in real Chromium under the production CSP: "can you get the newsletter started and i will approve it?" sent
// a plain question (no plan card), and the agent invented "approve it in the Tasks section". The owner's exact sentences now open
// the plan card with NO model request; a plain question still goes to the agent, and a reply about a newsletter with no plan open
// offers "Show the plan", which opens the same card. Synthetic data, a scripted model.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { INTERACTIVE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT);

describe.skipIf(!enabled)("the plan card opens on the owner's wording (P2)", () => {
  it("both owner sentences open the plan card without a model request; a question is sent and its reply offers Show the plan", async () => {
    const asked: string[] = [];
    const fetch = async (_u: string, init: any) => {
      const b = JSON.parse(init.body); asked.push(b.messages.filter((m: any) => m.role === "user").at(-1)?.content ?? "");
      return new Response(JSON.stringify({ id: "g" + asked.length, model: INTERACTIVE_PROFILES.sonnet.runtime.model, provider: "Amazon Bedrock",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "The newsletter goes out after the meeting [members/notes/2026-10-08.v1.md#L2]." } }],
        usage: { prompt_tokens: 900, completion_tokens: 40, total_tokens: 940, cost: 0.002 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const w = await transcriptionWorld({ chat: {}, fetch: fetch as never });
    mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
    writeFileSync(join(w.cfg.folder, "members/notes/2026-10-08.v1.md"), "# October\nThe newsletter goes out after the meeting.\n");
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.P_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    try {
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = w.robin.split("=");
      await c.addCookies([{ name, value, url: w.url }]);
      const errors: string[] = []; page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
      const card = page.getByRole("button", { name: "Approve plan to start drafting" });
      for (const words of ["can you get the newsletter started and i will approve it?", "can we get started on the newsletter"]) {
        await page.goto(`${w.url}/o/exna/#home`);
        await page.locator("#ask-text").fill(words);
        await page.locator(".ask-go").click();
        await card.waitFor({ timeout: 15_000 });
        expect(asked).toEqual([]); // the card, not a model request
      }
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "plan-card-owner-words-1440.png"), fullPage: true });
      // A question about the newsletter is a question: it is sent; the reply then offers the plan card.
      await page.goto(`${w.url}/o/exna/#home`);
      await page.locator("#ask-text").fill("when is the newsletter going out?");
      await page.locator(".ask-go").click();
      await page.getByText("The newsletter goes out after the meeting").waitFor({ timeout: 20_000 });
      expect(asked).toEqual(["when is the newsletter going out?"]);
      const offer = page.locator(".notice.plan-offer");
      await offer.waitFor();
      expect((await offer.textContent())!.replace(/\s+/g, " ").trim()).toBe("To let the agent save a newsletter draft, approve a draft plan here in this chat. Show the plan");
      expect(await card.count()).toBe(0);
      await offer.getByRole("button", { name: "Show the plan" }).click();
      await card.waitFor();
      expect(asked.length).toBe(1); // still nothing sent or approved
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "plan-offer-1440.png"), fullPage: true });
      expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 180_000);
});
