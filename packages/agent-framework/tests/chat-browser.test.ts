// Chat agent C-6b (Fable C-4..C-6a review N-2, C-1..C-3 N-1): the member's flow in REAL Chromium under the hub's production CSP
// with a scripted interactive model (no network): add a text file to the chat -> "Draft a newsletter" -> the plan card ->
// "Approve plan" (session-fresh) -> the turn runs (polled every 1 s for its whole length) -> the draft version card ->
// "Preview" in a fully sandboxed iframe. Renders at 1440/390 with CHAT_SHOTS. Runs when Playwright is installed.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { INTERACTIVE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && existsSync(PLAYWRIGHT);
const NOTES = "members/notes/2026-10-08.v1.md";

/** A scripted interactive model: write the newsletter, render it, then answer; each answer takes ~1.2 s (polling is observed). */
function model() {
  const bodies: any[] = [];
  const fetch = async (_u: string, init: any) => {
    const b = JSON.parse(init.body); bodies.push(b);
    await new Promise((r) => setTimeout(r, 1200));
    const tools = b.messages.filter((m: any) => m.role === "tool"), last = tools.at(-1);
    let message: any;
    if (!b.tools || !tools.length) message = { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_draft_artifact",
      arguments: JSON.stringify({ kind: "newsletter", content: { title: "November in Example Park", sections: [{ heading: "Block Party", body: "Over 300 neighbors came out.\n\n- Thanks to 24 volunteers" }],
        sources: [{ path: NOTES, line: 2 }] } }) } }] };
    else if (JSON.parse(last.content).saved) { const s = JSON.parse(last.content);
      message = { role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "render_newsletter_preview", arguments: JSON.stringify({ artifactId: s.artifactId, version: s.version }) } }] }; }
    else message = { role: "assistant", content: "Here's the draft newsletter [members/notes/2026-10-08.v1.md#L2]." };
    return new Response(JSON.stringify({ id: "g" + bodies.length, model: INTERACTIVE_PROFILES.sonnet.runtime.model, provider: "Amazon Bedrock",
      choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }], usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000, cost: 0.003 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, bodies };
}

describe.skipIf(!enabled)("chat in a real browser", () => {
  it("upload -> draft plan card -> approve -> draft version -> sandboxed preview; 1 s polling over the whole turn", async () => {
    const m = model();
    const w = await transcriptionWorld({ chat: {}, fetch: m.fetch as never });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.CHAT_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await ctx.newPage(), [name, value] = w.alex.split("=");
      await ctx.addCookies([{ name, value, url: w.url }]);
      const errors: string[] = []; page.on("console", (x: any) => { if (x.type() === "error") errors.push(x.text()); });
      const reads: number[] = []; page.on("response", (r: any) => { if (r.url().endsWith("/api/chat/turn/read")) reads.push(r.status()); });
      // THREE-JOBS J1: a member lands on Home; the top bar is the jobs (Home · Newsletter · Meetings here: no website in this org),
      // Help, and the account menu (the email, no role word); no capability panel.
      await page.goto(`${w.url}/o/exna/`);
      await page.locator(".jobs").waitFor();
      expect(await page.locator(".jobs-tabs a").allTextContents()).toEqual(["Home", "Newsletter", "Meetings"]);
      expect(await page.locator(".nav .help-link").textContent()).toBe("Help"); // USABILITY v1: Help for everyone
      expect(await page.locator(".nav-menu.account summary").textContent()).toBe("alex@exna.test");
      expect(await page.getByText("Capabilities").count()).toBe(0);
      await page.goto(`${w.url}/o/exna/#chat`);
      // WC-3: nothing connected yet: a plain sentence and a link to Files (no model request), kept after the redraw.
      await page.getByRole("button", { name: "New chat" }).click();
      await page.locator("#chat-text").fill("How many came to Block Party?");
      await page.getByRole("button", { name: "Send" }).click();
      await page.getByText("No files are connected yet.").waitFor({ timeout: 15_000 });
      expect(await page.getByRole("link", { name: "Open Files" }).getAttribute("href")).toBe("#files");
      // WC-4: the first message titles the chat (header and list); the starter renames it.
      await page.getByRole("heading", { name: "How many came to Block Party?" }).waitFor();
      expect(await page.locator("a.conv strong").first().textContent()).toBe("How many came to Block Party?");
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "chat-no-files-1440.png"), fullPage: true });
      await page.getByRole("button", { name: "Rename" }).click();
      await page.getByRole("textbox", { name: "Chat title" }).fill("Block Party <b>numbers</b>");
      await page.getByRole("button", { name: "Save" }).click();
      await page.getByRole("heading", { name: "Block Party <b>numbers</b>" }).waitFor(); // text, never markup
      expect(await page.locator(".conv-head b").count()).toBe(0);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "chat-title-1440.png"), fullPage: true });
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, NOTES), "# October\nBlock Party drew over 300 neighbors; 24 volunteers.\n");
      await page.getByRole("button", { name: "New chat" }).click();
      await page.locator(".conv-head").waitFor({ state: "detached" }); // the new, untitled chat is drawn (bare: no heading)
      expect(await page.getByRole("heading", { name: "New chat" }).count()).toBe(0); // owner (Oct 23): an empty chat is a bare page
      await page.locator("a.conv").nth(1).waitFor(); // the new view is drawn (the old one first shows "Loading…")
      expect(await page.locator("a.conv").count()).toBe(2);
      await page.getByText("Only you can read this conversation.", { exact: false }).waitFor();
      // Upload a text file to this chat (it stays in this chat until shared).
      await page.setInputFiles("#chat-file", { name: "volunteers.md", mimeType: "text/markdown", buffer: Buffer.from("# Volunteers\nSam, Ana, Robin\n") });
      await page.getByText("📎 volunteers.md").waitFor();
      await page.getByText("Only this chat").waitFor();
      // The plan card, computed by the runtime; approve it.
      await page.getByRole("button", { name: "Draft the next newsletter" }).click(); // USABILITY v1 starter
      await page.getByRole("heading", { name: "Draft plan" }).waitFor();
      await page.getByText("Up to 5 turns and $2.00", { exact: false }).waitFor();
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "chat-plan-1440.png"), fullPage: true });
      await page.getByRole("button", { name: "Approve plan" }).click();
      // The turn runs: write v1, render it, answer. Then the draft card from rows.
      await page.getByText("Newsletter draft · version 1").waitFor({ timeout: 30_000 });
      await page.getByText("Here's the draft newsletter", { exact: false }).waitFor();
      expect(await page.getByText("[members/notes", { exact: false }).count()).toBe(0); // the marker is a chip, not text
      expect(await page.locator(".msg.assistant a.cite-chip").first().textContent()).toMatch(/^Oct 8 meeting notes · line 2$/);
      await page.getByText("Draft plan approved", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Preview" }).click();
      const frame = page.locator("iframe.preview");
      await frame.waitFor();
      expect(await frame.getAttribute("sandbox")).toBe("");
      // Package E (Fable E-11): the frame loads its own URL (no srcdoc); the response's own CSP lets v3's inline styles apply.
      expect(await frame.getAttribute("srcdoc")).toBeNull();
      expect(await frame.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(await frame.getAttribute("src")).toMatch(/^\/o\/exna\/preview\?conversationId=conv_[a-f0-9]{32}&artifactId=art_[a-f0-9]{32}&version=1$/);
      const inner = page.frameLocator("iframe.preview");
      await inner.getByText("November in Example Park").first().waitFor();
      // STYLED: a known element's computed style equals its inline value (refused inline styles would leave the default).
      expect(await inner.locator("h2").first().evaluate((e: any) => getComputedStyle(e).color)).toBe("rgb(23, 24, 70)"); // #171846, the theme's primaryDark
      await page.getByText("Links work in the test email, not in this preview.").waitFor();
      if (SHOTS) for (const wd of [1440, 390]) { await page.setViewportSize({ width: wd, height: 900 }); await page.screenshot({ path: join(SHOTS, `chat-draft-${wd}.png`), fullPage: true }); }
      // Fable N-1: the whole turn (three model requests of ~1.2 s) was polled about once a second, every poll answered.
      expect(reads.length).toBeGreaterThanOrEqual(3);
      expect(reads.every((s) => s === 200)).toBe(true);
      expect(m.bodies).toHaveLength(3);
      // WC-5 (Fable R-11): an agent reply's markdown subset as elements; markup, links and identifiers stay text.
      const last = w.org.sqlite.db.prepare("SELECT conversation_id, turn_id FROM chat_messages ORDER BY seq DESC LIMIT 1").get() as { conversation_id: string; turn_id: string };
      const md = "**Block Party** drew *over 300* neighbors.\nSecond line.\n\n- Bring `gloves`\n- See https://example.org/x <img src=x onerror=alert(1)>\n\n1. First\n\nsearch_org_history and 2 * 3 * 4 and *unclosed";
      w.org.sqlite.db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,'assistant',?,?,?)")
        .run("msg_" + "e".repeat(32), last.conversation_id, last.turn_id, md, "0".repeat(64), new Date().toISOString());
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.reload(); // owner (Oct 23): a visit lands on a fresh chat; the draft chat is the newest in the sidebar
      await page.locator("a.conv:not(.on)").first().click();
      const reply = page.locator(".msg.assistant .md").last();
      await reply.locator("strong", { hasText: "Block Party" }).waitFor();
      expect(await reply.locator("em").allTextContents()).toEqual(["over 300"]);
      expect(await reply.locator("code").allTextContents()).toEqual(["gloves"]);
      expect(await reply.locator("ul > li").count()).toBe(2);
      expect(await reply.locator("ol > li").allTextContents()).toEqual(["First"]);
      expect(await reply.locator("p").first().locator("br").count()).toBe(1);
      expect(await reply.locator("img, a, script").count()).toBe(0);
      expect(await reply.textContent()).toContain("https://example.org/x <img src=x onerror=alert(1)>");
      expect(await reply.textContent()).toContain("search_org_history and 2 * 3 * 4 and *unclosed");
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "chat-markdown-1440.png"), fullPage: true });
      // Polish P-1 (Fable R-1..R-4): markers become chips (bare, bracketed, ranges; identical ones collapse; invalid ones
      // stay text); chips are the only links; a chip opens Files at the cited line.
      const cites = "Public safety: 71 offenses. members/website/meeting-notes/2026-10-08-october-2026.md#L9. Down from 89. members/website/meeting-notes/2026-10-08-october-2026.md#L9\n" +
        "- Cleanup Oct 31 [members/notes/2026-10-08.v1.md#L2], see members/website/newsletters/2026-10-07-october-neighborhood-newsletter.md#L3-L5\n" +
        "Bad: members/../secrets.md#L1 and [reviewers-private/x y.md#L2] and members/website/events.md#L0x";
      w.org.sqlite.db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,'assistant',?,?,?)")
        .run("msg_" + "f".repeat(32), last.conversation_id, last.turn_id, cites, "0".repeat(64), new Date().toISOString());
      await page.reload(); await page.locator("a.conv:not(.on)").first().click(); // a visit lands on a fresh chat
      const cr = page.locator(".msg.assistant .md").last();
      await cr.locator("a.cite-chip").first().waitFor();
      expect(await cr.locator("a.cite-chip").allTextContents()).toEqual(["Oct 8 meeting notes · line 9", "Oct 8 meeting notes · line 2", "Oct 7 newsletter · lines 3–5"]);
      expect(await cr.locator("a").count()).toBe(3);
      for (const h of await cr.locator("a").evaluateAll((as: Element[]) => as.map((a) => a.getAttribute("href")))) expect(h!.startsWith("#files?")).toBe(true);
      expect(await cr.locator("a.cite-chip").first().getAttribute("title")).toBe("members/website/meeting-notes/2026-10-08-october-2026.md");
      const crText = (await cr.textContent())!;
      expect(crText).not.toContain("members/website/meeting-notes");
      expect(crText).toContain("Bad: members/../secrets.md#L1 and [reviewers-private/x y.md#L2] and members/website/events.md#L0x"); // literal
      expect(crText).toContain("71 offenses. Oct 8 meeting notes · line 9. Down from 89.");
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "chat-chips-1440.png"), fullPage: true });
      // P-1 N-1: the chip date is pinned (en-US, UTC): a German browser far east of UTC still reads "Oct 8".
      const de = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "de-DE", timezoneId: "Pacific/Kiritimati" }), dp = await de.newPage();
      await de.addCookies([{ name, value, url: w.url }]);
      await dp.goto(`${w.url}/o/exna/#chat`); await dp.locator("a.conv:not(.on)").first().click(); // a visit lands on a fresh chat
      await dp.locator(".msg.assistant .md").last().locator("a.cite-chip").first().waitFor();
      expect(await dp.locator(".msg.assistant .md").last().locator("a.cite-chip").first().textContent()).toBe("Oct 8 meeting notes · line 9");
      await de.close();
      // P-2 (Fable R-5): "###" -> a bold heading line (no h1-h6), "---" / "***" alone -> hr, "* item" stays a list item.
      const blocks = "### Public safety\n71 offenses this year.\n---\n## Events **soon**\n***\n* Tree planting\n#nospace stays text";
      w.org.sqlite.db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,'assistant',?,?,?)")
        .run("msg_" + "d".repeat(32), last.conversation_id, last.turn_id, blocks, "0".repeat(64), new Date().toISOString());
      await page.reload(); await page.locator("a.conv:not(.on)").first().click(); // a visit lands on a fresh chat
      const br = page.locator(".msg.assistant .md").last();
      await br.locator("p.md-h").first().waitFor();
      expect(await br.locator("p.md-h > strong").allTextContents()).toEqual(["Public safety", "Events soon"]);
      expect(await br.locator("p.md-h strong strong").allTextContents()).toEqual(["soon"]);
      expect(await br.locator("hr").count()).toBe(2);
      expect(await br.locator("ul > li").allTextContents()).toEqual(["Tree planting"]);
      expect(await br.locator("h1, h2, h3, h4, h5, h6").count()).toBe(0);
      expect(await br.textContent()).toContain("#nospace stays text");
      expect(await br.textContent()).not.toMatch(/###|^---/m);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "chat-blocks-1440.png"), fullPage: true });
      // Package A2 (the owner's first live edit: a "What changed" table showed as raw pipes): chat answers render pipe tables as DOM.
      const tbl = "What changed:\n\n| Section | Change |\n|---|---|\n| Header | **New** photos |\n| Happy Hour | Removed <b>x</b> |";
      w.org.sqlite.db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,'assistant',?,?,?)")
        .run("msg_" + "b".repeat(32), last.conversation_id, last.turn_id, tbl, "0".repeat(64), new Date().toISOString());
      await page.reload(); await page.locator("a.conv:not(.on)").first().click();
      const tr = page.locator(".msg.assistant .md").last();
      await tr.locator("table.md-table").waitFor();
      expect(await tr.locator("table.md-table th").allTextContents()).toEqual(["Section", "Change"]);
      expect(await tr.locator("table.md-table td").allTextContents()).toEqual(["Header", "New photos", "Happy Hour", "Removed <b>x</b>"]);
      expect(await tr.locator("table.md-table td strong").count()).toBe(1); expect(await tr.locator("b").count()).toBe(0);
      expect(await tr.textContent()).not.toContain("|");
      // Owner (24 Oct, first live test): a numbered list split by blank lines and indented lines is ONE list (it showed "1." on every
      // item), a list resumed after text keeps its number, and a marker wrapped in backticks is a chip with no stray ` around it.
      const lists = "1. Block Party recap\n\n2. Tree planting `[members/notes/2026-10-08.v1.md#L2]`.\n   Bring gloves.\n\n3. Meeting\n\nAfter the list.\n5. Resumed `[handbook:v2#L5]`";
      w.org.sqlite.db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,'assistant',?,?,?)")
        .run("msg_" + "c".repeat(32), last.conversation_id, last.turn_id, lists, "0".repeat(64), new Date().toISOString());
      await page.reload(); await page.locator("a.conv:not(.on)").first().click(); // a visit lands on a fresh chat
      const lr = page.locator(".msg.assistant .md").last();
      await lr.locator("a.cite-chip").first().waitFor();
      expect(await lr.locator("ol").count()).toBe(2);
      expect(await lr.locator("ol").first().locator("> li").count()).toBe(3);
      expect(await lr.locator("ol").first().getAttribute("start")).toBeNull();
      expect(await lr.locator("ol").nth(1).getAttribute("start")).toBe("5");
      expect(await lr.locator("ol").first().locator("> li").nth(1).textContent()).toBe("Tree planting. Oct 8 meeting notes · line 2Bring gloves.");
      expect(await lr.locator("a.cite-chip").allTextContents()).toEqual(["Oct 8 meeting notes · line 2", "Handbook v2 · line 5"]);
      expect(await lr.textContent()).not.toContain("`");
      expect(await lr.locator("code").count()).toBe(0);
      await page.locator(".msg.assistant .md", { hasText: "Public safety: 71 offenses." }).locator("a.cite-chip", { hasText: "line 2" }).click();
      await page.locator("pre.file .ln.hit").waitFor();
      expect(await page.locator("pre.file .ln.hit").textContent()).toBe("Block Party drew over 300 neighbors; 24 volunteers.");
      expect(page.url()).toContain("#files?path=members%2Fnotes%2F2026-10-08.v1.md&line=2");
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "files-line-1440.png"), fullPage: true });
      // A path the member cannot read gives the usual refusal words (no special case).
      await page.goto(`${w.url}/o/exna/#files?path=members%2Fwebsite%2Fnope.md&line=1`);
      await page.getByText("That file can't be found.").waitFor();
      expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
      // Files page: the upload is listed for its owner with provenance.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${w.url}/o/exna/#files`);
      await page.getByRole("heading", { name: "Shared drive" }).waitFor();
      await page.getByText("volunteers.md").first().waitFor();
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "files-1440.png"), fullPage: true });
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
