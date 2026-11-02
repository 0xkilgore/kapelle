// USABILITY v1 (owner feedback 2026-10-19 + Fable QUICK-START (a)-(c)) in REAL Chromium under the hub's production CSP, with a
// scripted model (no network): citation chips for a path without a line and for bare "#L9–L17" markers; the draft version card
// right under its reply ("Open preview"); starter tasks that prefill (nothing sent); a draft request typed with no approved
// plan opens the plan card instead of plain Q&A; the Help page; the website hand-off from chat; plain Manage labels.
// Runs when Playwright is installed.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { transcriptionWorld } from "./transcription-world.js";
import { FakeGithub } from "../src/org/website/fake-github.js";
import { ChatTools } from "../src/org/chat/tools.js";
import { INTERACTIVE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && existsSync(PLAYWRIGHT);
const PATH = "members/website/meeting-notes/2026-10-08-october-2026.md";
// The owner's screen (Oct 19): a path in backticks inside parentheses, then bare "#L…" markers with an en dash.
const REPLY = `The newsletter draft has been saved! All sourced from the **October 8, 2026 meeting notes** (\`${PATH}\`):\n\n` +
  "1. **Public Safety Report** — 71 offenses, down from 89. #L9–L17\n2. **Block Party** — 1,400 attendees. #L21–L25\n3. **December Gathering** — Dec. 10. #L48";

async function world(o: { intakeNone?: boolean; liveShape?: boolean } = {}) {
  // liveShape: data files in the shape of the live site (the pack's pinned schema); otherwise a minimal fixture whose events
  // lack id/description/type, which the pack refuses as website_base_shape_changed.
  const event = { title: "Block Party", date: "2026-11-08", time: "2:00 PM", location: "Community Center", address: "1 Main St",
    ...(o.liveShape ? { id: "block-party", description: "Games and food.", type: "community" } : {}) };
  const meeting = { date: "2026-10-08", slug: "october-2026", title: "Monthly Meeting Notes — October 8, 2026", ...(o.liveShape ? { id: "2026-10" } : {}),
    sections: [{ heading: "Public Safety", body: "Year to date: 71 offenses, down from 89." }] };
  const gh = new FakeGithub(undefined, { "src/data/meeting-notes.json": JSON.stringify({ meetings: [meeting] }),
    "src/data/events.json": JSON.stringify({ events: [event], pastEvents: [] }) });
  // ~1.2 s per answer, so a member can type while a reply is still running (the redraw must keep their text).
  const fetch = async () => { await new Promise((r) => setTimeout(r, 1200)); return new Response(JSON.stringify({ id: "g1", model: INTERACTIVE_PROFILES.sonnet.runtime.model, provider: "Amazon Bedrock",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: REPLY } }], usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000, cost: 0.003 } }),
    { status: 200, headers: { "content-type": "application/json" } }); };
  const w = await transcriptionWorld({ label: "Example Park", chat: {}, website: {}, githubFetch: gh.fetch, fetch: fetch as never, ...(o.intakeNone ? { intakeNone: true } : {}) });
  await w.org.websiteContent!.idle();
  for (let i = 0; i < 100 && !w.org.websiteContent!.status().commit; i++) await new Promise((r) => setTimeout(r, 20));
  return w;
}
const turns = (w: any) => (w.org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM chat_turns").get() as { n: number }).n;

describe.skipIf(!enabled)("USABILITY v1 in a real browser", () => {
  it("chips for path-only and bare #L markers; the draft card under its reply with Open preview; starters prefill; the trap opens the plan; Help; website hand-off", async () => {
    const w = await world();
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    try {
      // A reviewer's reply with a draft version saved in THAT turn.
      const api = (p: string, b: unknown, c = w.robin) => w.post(`/o/exna/api/${p}`, b, c);
      const conv = (await api("chat/conversation/create", {})).result.conversationId;
      const t = (await api("chat/turn/start", { conversationId: conv, clientRequestId: "req-usability-001", text: "Please draft the newsletter." })).result.turnId;
      for (let i = 0; i < 200 && !(await api("chat/turn/read", { turnId: t })).result.terminal; i++) await new Promise((r) => setTimeout(r, 20));
      const tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
      const ctx = { turnId: t, conversationId: conv, memberId: "m", scope: "member" as const };
      await tools.begin(ctx);
      const v = JSON.parse(((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "October in Example Park",
        sections: [{ heading: "Public Safety", body: "Year to date: 71 offenses, down from 89." }], sources: [{ path: PATH, line: 7 }] } }), ctx)) as any).content);
      await tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: v.version }), ctx);

      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage();
      const errors: string[] = []; page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); }); page.on("pageerror", (e: any) => errors.push("pageerror " + e.message));
      const [name, value] = w.robin.split("="); await c.addCookies([{ name, value, url: w.url }]);
      await page.goto(`${w.url}/o/exna/#chat`);
      // Owner (Oct 23): every visit lands on a FRESH, bare chat (starters + box, no heading, no messages); earlier chats are in the sidebar.
      await page.locator(".starter").first().waitFor();
      expect([await page.locator(".msg").count(), await page.locator(".conv-head").count(), await page.locator("#chat-text").count()]).toEqual([0, 0, 1]);
      if (process.env.CHAT_LANDING_SHOTS) { const { mkdirSync } = await import("node:fs"); mkdirSync(process.env.CHAT_LANDING_SHOTS, { recursive: true });
        for (const wd of [1440, 390]) { await page.setViewportSize({ width: wd, height: 900 }); await page.screenshot({ path: `${process.env.CHAT_LANDING_SHOTS}/chat-landing-${wd}.png`, fullPage: true }); }
        await page.setViewportSize({ width: 1440, height: 900 }); }
      await page.locator("a.conv:not(.on)").first().click();
      const reply = page.locator(".msg.assistant .md").last();
      await reply.locator("a.cite-chip").first().waitFor();
      expect(await reply.locator("a.cite-chip").allTextContents()).toEqual(["Oct 8 meeting notes", "Oct 8 meeting notes · lines 9–17", "Oct 8 meeting notes · lines 21–25", "Oct 8 meeting notes · line 48"]);
      const text = (await reply.textContent())!;
      expect(text).not.toContain("members/website"); expect(text).not.toMatch(/#L\d/);
      expect(await reply.locator("a.cite-chip").nth(1).getAttribute("href")).toBe("#files?" + new URLSearchParams({ path: PATH, line: "9" }));
      expect(await reply.locator("a.cite-chip").first().getAttribute("href")).toBe("#files?" + new URLSearchParams({ path: PATH }));
      // (b) The version card sits right after the reply that made it, inside the conversation; "Open preview" opens the sandbox.
      expect(await page.locator(".msgs > .msg.assistant + .card.artifact").count()).toBe(1);
      await page.getByRole("button", { name: "Open preview" }).click();
      await page.locator("iframe.preview").waitFor();
      expect(await page.locator("iframe.preview").getAttribute("sandbox")).toBe("");
      expect(await page.getByRole("button", { name: "Close preview" }).count()).toBe(1);

      // Starters on a new chat: the reviewer sees the website one; a prefill puts words in the box and sends nothing.
      await page.getByRole("button", { name: "New chat" }).click();
      await page.getByText("What would you like to do?").waitFor();
      expect(await page.locator(".starter strong").allTextContents()).toEqual(["Draft the next newsletter", "Prepare a meeting agenda", "Add or change an event on the website",
        "What happened at the last meeting?", "Summarize the public safety report", "Help: what can you do?"]);
      const before = turns(w);
      await page.locator(".starter", { hasText: "Summarize the public safety report" }).click();
      expect(await page.locator("#chat-text").inputValue()).toBe("Summarize the public safety report from the latest meeting notes.");
      expect(turns(w)).toBe(before);
      // (a) The trap: a draft request typed with no approved plan opens the plan card; nothing is sent until the member chooses.
      await page.locator("#chat-text").fill("Please draft the November newsletter from the October meeting.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByText("To save a draft, approve this plan first").waitFor();
      expect(await page.getByRole("button", { name: "Approve plan to start drafting" }).count()).toBe(1);
      expect(turns(w)).toBe(before);
      await page.getByRole("button", { name: "Just ask it as a question" }).click();
      await page.locator(".msg.user", { hasText: "Please draft the November newsletter" }).waitFor({ timeout: 15_000 });
      expect(turns(w)).toBe(before + 1);
      await page.locator(".msg.assistant").first().waitFor({ timeout: 15_000 }); // that reply finishes before the next chat (one turn at a time)
      // Fable F-1: approving from the trap sends the typed words once; the box is empty afterwards (no re-send on the next Send).
      await page.getByRole("button", { name: "New chat" }).click();
      await page.locator(".starter").first().waitFor();
      await page.locator("#chat-text").fill("Please write the newsletter for November.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByRole("button", { name: "Approve plan to start drafting" }).click();
      await page.locator(".msg.user", { hasText: "Please write the newsletter for November." }).waitFor({ timeout: 15_000 });
      await page.locator(".msg.assistant").first().waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => !document.querySelector(".working"));
      expect(await page.locator("#chat-text").inputValue()).toBe("");
      expect(await page.locator(".card.plan.on").count()).toBe(1); // the approved plan's line
      // Fable N-1: a question that mentions a draft verb and the newsletter is not intercepted.
      await page.getByRole("button", { name: "New chat" }).click();
      await page.locator(".starter").first().waitFor();
      await page.locator("#chat-text").fill("When did we start the newsletter?");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.locator(".msg.user", { hasText: "When did we start the newsletter?" }).waitFor({ timeout: 15_000 });
      expect(await page.getByText("To save a draft, approve this plan first").count()).toBe(0);
      await page.locator(".msg.assistant").first().waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => !document.querySelector(".working"));
      // A plain question is not intercepted.
      await page.getByRole("button", { name: "New chat" }).click();
      await page.locator(".starter").first().waitFor(); // the new chat is drawn (typing earlier would land in the old box)
      await page.locator("#chat-text").fill("When is Block Party?");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.locator(".msg.user", { hasText: "When is Block Party?" }).waitFor({ timeout: 15_000 });
      expect(await page.getByText("To save a draft, approve this plan first").count()).toBe(0);
      // Typing while that reply finishes: the redraw keeps what was typed (it used to drop it).
      await page.locator("#chat-text").fill("Add the tree planting on Saturday Nov 8, 9 am at Riverside Park to events");
      await page.locator(".msg.assistant").first().waitFor({ timeout: 15_000 });
      await page.waitForFunction(() => !document.querySelector(".working"));
      expect(await page.locator("#chat-text").inputValue()).toBe("Add the tree planting on Saturday Nov 8, 9 am at Riverside Park to events");

      // (c) Reviewers carry what they typed to the Website request form.
      await page.locator("summary[aria-label=\"More actions\"]").click(); // owner (Oct 23): the actions live in the "+" menu
      await page.getByRole("link", { name: "Propose a website change" }).click();
      await page.getByRole("heading", { name: "Propose a change" }).waitFor();
      expect(await page.locator("#website-text").inputValue()).toBe("Add the tree planting on Saturday Nov 8, 9 am at Riverside Park to events");
      // Website: readable titles only, no raw file names.
      await page.getByText("On the website now").waitFor();
      expect(await page.locator("main").textContent()).not.toMatch(/\.md\b/);

      // Help: for everyone; the daily limit comes from the runtime.
      await page.getByRole("link", { name: "Help" }).click();
      await page.getByRole("heading", { name: "How to use Example Park" }).waitFor();
      for (const h of ["Ask a question", "Draft, preview and test a newsletter", "Change the website (events, meeting notes)", "Who approves what", "Limits", "Two kinds of meeting notes"])
        expect(await page.getByRole("heading", { name: h }).count(), h).toBe(1);
      expect(await page.locator("main").textContent()).toMatch(/20 chat turns per person per day/);
      await c.close();

      // A member: no website starter, no website hand-off; Help says to ask a reviewer.
      const m = await browser.newContext({ viewport: { width: 390, height: 900 } }), mp = await m.newPage(), [n2, v2] = w.alex.split("=");
      await m.addCookies([{ name: n2, value: v2, url: w.url }]);
      await mp.goto(`${w.url}/o/exna/#chat`);
      await mp.getByRole("button", { name: "New chat" }).click();
      await mp.getByText("What would you like to do?").waitFor();
      expect(await mp.locator(".starter strong").allTextContents()).not.toContain("Add or change an event on the website");
      expect(await mp.getByRole("link", { name: "Propose a website change" }).count()).toBe(0);
      // THREE-JOBS J1: on a phone the jobs fold into one "Jobs" menu; Help and the account menu stay.
      expect(await mp.locator(".jobs-menu .menu a").allTextContents()).toEqual(["Home", "Website", "Newsletter", "Meetings"]);
      expect(await mp.locator(".jobs-tabs").isVisible()).toBe(false);
      expect(await mp.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390); // nothing scrolls sideways on a phone
      await mp.goto(`${w.url}/o/exna/#help`);
      await mp.getByText("Ask a reviewer: they propose website changes here").waitFor();
      await m.close();
      expect(errors.filter((e) => /Content Security Policy|Refused|pageerror/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 180_000);

  it("Manage and Activity: plain labels; no member-email wording without email intake", async () => {
    const w = await world({ intakeNone: true });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    try {
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = w.admin.split("=");
      await c.addCookies([{ name, value, url: w.url }]);
      await page.goto(`${w.url}/o/exna/#manage`);
      await page.getByRole("link", { name: "Approved meeting notes" }).waitFor();
      const text = (await page.locator("main").textContent())!;
      expect(text).toContain("separate from the website's meeting notes");
      expect(text).toContain("Who approved which plan");
      expect(text).not.toMatch(/emails/i);
      await page.getByRole("link", { name: "Activity" }).click();
      await page.getByText("Who approved which plan, and how they signed in.").waitFor();
      expect(await page.locator("main").textContent()).not.toMatch(/Shadow mode|emails/i);
    } finally { await browser.close(); await w.close(); }
  }, 120_000);

  it("Director (Oct 19): data files that no longer match the pack pause website changes in plain words; admins and reviewers see a banner; no internal role names", async () => {
    const w = await world();
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    try {
      const r = await w.post("/o/exna/api/website/request", { text: "Add the tree planting on Saturday Nov 8, 9 am at Riverside Park to events" }, w.robin);
      expect(r.ok).toBe(true);
      await w.org.website!.idle();
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = w.admin.split("=");
      await c.addCookies([{ name, value, url: w.url }]);
      await page.goto(`${w.url}/o/exna/#manage`);
      await page.getByText("Website changes are paused: the website's data files changed").waitFor();
      await page.goto(`${w.url}/o/exna/#website`);
      await page.getByText("Website changes are paused for now: the website's data changed and the setup needs an update.", { exact: false }).waitFor();
      expect(await page.getByText("Website changes are paused: the website's data files changed").count()).toBe(1);
      for (const route of ["#website", "#manage", "#help", "#members"]) {
        await page.goto(`${w.url}/o/exna/${route}`); await page.waitForTimeout(400);
        expect(await page.locator("main").textContent(), route).not.toMatch(/\b(Ops|Product)\b/);
      }
    } finally { await browser.close(); await w.close(); }
  }, 120_000);

  it("the live data shape (34624b6f) is accepted: a request is prepared, no paused banner", async () => {
    const w = await world({ liveShape: true });
    try {
      await w.post("/o/exna/api/website/request", { text: "Add the tree planting on Saturday Nov 8, 9 am at Riverside Park to events" }, w.robin);
      await w.org.website!.idle();
      const list = (await w.post("/o/exna/api/website/list", {}, w.robin)).result.requests;
      expect(list[0].label).not.toBe("website_base_shape_changed");
    } finally { await w.close(); }
  }, 120_000);
});
