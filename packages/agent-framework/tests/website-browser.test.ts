// Website pack v0, W-4: the reviewer's flow in REAL Chromium under the hub's production CSP, on the FAKE GitHub and a scripted
// hosted model (no network): Review -> "What should change?" -> the agent's proposal (summary + diff) -> "Approve and open a
// draft PR" (session-fresh) -> PR link -> preview link. Renders at 390/1440 when WEBSITE_SHOTS is set. Runs when Playwright exists.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { FakeGithub } from "../src/org/website/fake-github.js";
import { hosted } from "./org-meeting-kit.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && existsSync(PLAYWRIGHT);
const EVENTS = JSON.stringify({ events: [{ id: "block-party-2026", title: "Block Party", date: "2026-10-18", time: "11:00 AM", location: "Example Park", address: "Springfield, TN",
  description: "Thanks, neighbors.", type: "community" }] }, null, 2) + "\n";
const TREE = { id: "tree-planting-nov-2026", title: "Tree planting", date: "2026-11-08", time: "9:00 AM", location: "Riverside Park", address: "Riverside Park, Springfield, TN",
  description: "Gloves and tools provided.", type: "community" };
const modelFetch = async () => new Response(JSON.stringify({ id: "g", model: hosted.runtime.responseModels?.at(-1) ?? hosted.runtime.model, provider: (hosted.runtime.providerNames ?? hosted.runtime.providers)[0],
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ ops: [{ op: "upsert_event", event: TREE }] }) } }],
  usage: { prompt_tokens: 9000, completion_tokens: 200, total_tokens: 9200, cost: 0.03 } }), { status: 200, headers: { "content-type": "application/json" } });

describe.skipIf(!enabled)("website pack in a real browser", () => {
  it("request -> proposal with diff -> approve -> draft PR link -> preview link", async () => {
    const gh = new FakeGithub(undefined, { "src/data/events.json": EVENTS, "src/data/meeting-notes.json": JSON.stringify({ meetings: [] }, null, 2) + "\n" });
    const w = await transcriptionWorld({ website: {}, githubFetch: gh.fetch, fetch: modelFetch as never, websitePoll: { everyMs: 50, maxMs: 30_000 } });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.WEBSITE_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await ctx.newPage(), [name, value] = w.robin.split("=");
      await ctx.addCookies([{ name, value, url: w.url }]);
      const errors: string[] = []; page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
      await page.goto(`${w.url}/o/exna/#review`);
      await page.getByRole("heading", { name: "Propose a change" }).waitFor(); // USABILITY v1: the section heading
      await page.getByLabel("What should change?").fill("Add the tree planting on Saturday Nov 8, 9 am at Riverside Park to events");
      await page.getByRole("button", { name: "Ask the agent to draft this change" }).click();
      await page.getByRole("button", { name: "Approve and open a draft PR" }).waitFor({ timeout: 15_000 });
      await page.getByRole("heading", { name: "New event: Tree planting · Sun, Nov 8" }).waitFor(); // v0.1 polish: title + date in words (2026-11-08 is a Sunday)
      await page.locator(".changes li", { hasText: "Date: Sunday, Nov 8, 2026" }).waitFor();
      // v0.1: plain-language changes first; the raw diff only under "Technical details" (collapsed).
      await page.getByText("Event: Tree planting", { exact: true }).waitFor();
      await page.locator(".changes .field", { hasText: "Location:" }).waitFor();
      expect(await page.locator("details.tech").getAttribute("open")).toBeNull();
      expect(await page.locator("pre.diff").isVisible()).toBe(false);
      await page.getByText("Technical details").click();
      expect(await page.locator("pre.diff").textContent()).toContain('+       "id": "tree-planting-nov-2026",');
      if (SHOTS) await page.evaluate(() => { (document.querySelector(".top") as HTMLElement).style.position = "static"; }); // full-page captures: no sticky header mid-page (Fable W-4 note)
      if (SHOTS) for (const wd of [1440, 390]) { await page.setViewportSize({ width: wd, height: 900 }); await page.screenshot({ path: join(SHOTS, `website-proposal-${wd}.png`), fullPage: true }); }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole("button", { name: "Approve and open a draft PR" }).click();
      await page.getByRole("link", { name: "Open the pull request" }).waitFor({ timeout: 15_000 });
      expect(await page.getByRole("link", { name: "Open the pull request" }).getAttribute("href")).toBe("https://github.com/0xkilgore/example-org-website/pull/1");
      await page.getByText("Draft PR open").waitFor();
      // v0.1: while Vercel builds there is progress and NO preview link or button.
      await page.getByText("Building preview… usually about a minute").waitFor();
      expect(await page.getByRole("link", { name: "Open the preview" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: /preview/i }).count()).toBe(0);
      expect(await page.locator(".website-body").first().textContent()).not.toMatch(/\bnull\b/); // no stray "null" text
      if (SHOTS) { await page.evaluate(() => { (document.querySelector(".top") as HTMLElement).style.position = "static"; }); await page.screenshot({ path: join(SHOTS, "website-building-1440.png"), fullPage: true }); }
      const branch = gh.pulls[0].head;
      gh.setStatus(gh.refs.get(branch)!, { context: "Vercel – Preview", state: "success", target_url: "https://example-org-website-git-kapelle.vercel.app" });
      await page.getByRole("link", { name: "Open the preview" }).waitFor({ timeout: 15_000 });
      expect(await page.getByRole("link", { name: "Open the preview" }).getAttribute("href")).toBe("https://example-org-website-git-kapelle.vercel.app/events/tree-planting-nov-2026"); // the changed page
      if (SHOTS) { await page.evaluate(() => { (document.querySelector(".top") as HTMLElement).style.position = "static"; }); for (const wd of [1440, 390]) { await page.setViewportSize({ width: wd, height: 900 }); await page.screenshot({ path: join(SHOTS, `website-pr-${wd}.png`), fullPage: true }); } }
      expect(gh.pulls).toHaveLength(1);
      expect(gh.pulls[0].draft).toBe(true);
      // Owner (Oct 23): a new proposal is the ONE prominent card with ONE primary action; the PR'd one moves under "Previous
      // updates" (collapsed; its preview and PR are small links there). A never-approved proposal can be discarded.
      await page.getByLabel("What should change?").fill("Add the tree planting on Saturday Nov 8 again");
      await page.getByRole("button", { name: "Ask the agent to draft this change" }).click();
      // Update the open draft (Fable ACCEPT e483c8dd): the new proposal changes the same event as the open draft PR #1 (same
      // base, runtime branch): ONE action, "Update draft PR #1", which adds this version to that pull request.
      await page.getByRole("button", { name: "Update draft PR #1" }).waitFor({ timeout: 15_000 });
      await page.getByText("Approving adds this version to draft pull request #1 (the same pull request", { exact: false }).waitFor();
      expect(await page.getByRole("link", { name: "Open #1" }).getAttribute("href")).toBe("https://github.com/0xkilgore/example-org-website/pull/1");
      expect(await page.getByRole("button", { name: "Approve and open a draft PR" }).count()).toBe(0);
      if (SHOTS) { await page.evaluate(() => { (document.querySelector(".top") as HTMLElement).style.position = "static"; }); await page.locator("#website").screenshot({ path: join(SHOTS, "website-update-1440.png") }); }
      const prev = page.locator("details.previous");
      expect(await prev.locator("summary").textContent()).toBe("Previous updates (1)");
      expect(await prev.getAttribute("open")).toBeNull();
      expect(await page.locator("#website").locator("a.btn:visible, button.btn:not(.secondary):visible").allTextContents()).toEqual(["Update draft PR #1"]); // ONE solid button: the form's is outlined while a proposal waits
      await prev.locator("summary").click();
      expect(await prev.getByRole("link", { name: "Open the preview" }).getAttribute("class")).toBe("small-link");
      expect(await prev.getByRole("link", { name: "Open the pull request" }).getAttribute("class")).toBe("small-link");
      if (SHOTS) { await page.evaluate(() => { (document.querySelector(".top") as HTMLElement).style.position = "static"; }); for (const wd of [1440, 390]) { await page.setViewportSize({ width: wd, height: 900 }); await page.locator("#website").screenshot({ path: join(SHOTS, `website-latest-${wd}.png`) }); } }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      expect(gh.pulls).toHaveLength(1);
      await page.getByRole("button", { name: "Keep" }).click(); // a second look, nothing discarded
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await page.getByRole("button", { name: "Yes, discard it" }).click();
      await page.getByRole("button", { name: "Update draft PR #1" }).waitFor({ state: "detached" });
      expect(await page.locator("details.previous").count()).toBe(0); // the PR'd proposal is the latest again
      expect(await page.getByRole("link", { name: "Open the preview" }).getAttribute("class")).toBe("btn secondary"); // owner: an outline, not a second solid
      expect(await page.locator("#website").locator("a.btn:not(.secondary):visible, button.btn:not(.secondary):visible").allTextContents()).toEqual(["Ask the agent to draft this change"]);
      expect(gh.pulls).toHaveLength(1);
      // The owner's case: ask again with the time and address, press "Update draft PR #1": the SAME pull request gets the new commit.
      const before = gh.refs.get(gh.pulls[0].head)!;
      await page.getByLabel("What should change?").fill("Add the tree planting on Saturday Nov 8 with the address");
      await page.getByRole("button", { name: "Ask the agent to draft this change" }).click();
      await page.getByRole("button", { name: "Update draft PR #1" }).click();
      await page.getByText("Updated by a later proposal", { exact: false }).waitFor({ timeout: 15_000 });
      expect(gh.pulls).toHaveLength(1);
      expect(gh.commits.get(gh.refs.get(gh.pulls[0].head)!)!.parents).toEqual([before]);
      if (SHOTS) { await page.evaluate(() => { (document.querySelector(".top") as HTMLElement).style.position = "static"; }); await page.locator("details.previous summary").click(); await page.locator("#website").screenshot({ path: join(SHOTS, "website-updated-1440.png") }); }
      // WC-2: the Files page shows the website copy's state; a reviewer refreshes it (unchanged main: the same commit).
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${w.url}/o/exna/#files`);
      // J2 (owner): the website copy and its source files sit under "Website source files", closed by default.
      const openSource = async () => { await page.locator("details.site-source > summary").waitFor({ timeout: 15_000 }); await page.locator("details.site-source").evaluate((d: any) => { d.open = true; }); };
      const line = page.getByText(`Website copy: commit ${gh.refs.get("main")!.slice(0, 7)}`);
      await openSource(); await line.waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "Refresh from website" }).click();
      // The page redraws after a refresh ("Loading…" first, the section closed again): reopen until both are visible.
      await expect.poll(async () => { await openSource(); return (await line.isVisible()) && (await page.getByText("events.md").first().isVisible()); }, { timeout: 15_000 }).toBe(true); // the Files page redraws after a refresh ("Loading…" first): wait, never count at once
      if (SHOTS) { await page.evaluate(() => { (document.querySelector(".top") as HTMLElement).style.position = "static"; }); await page.screenshot({ path: join(SHOTS, "files-website-1440.png"), fullPage: true }); }
      expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
