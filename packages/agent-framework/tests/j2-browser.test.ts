// J2 in real Chromium under the production CSP (owner, Oct 26): the Home job icons; the Newsletter page = ONLY Drafts (my drafts
// from any chat, newest first, Open preview) and Sent; the Files page = the shared drive first, the website's source files and the
// task results closed at the bottom; the Website page's "Add photos" (shared-drive photos: one event picture, the rest gallery)
// and the proposal card's thumbnails. Synthetic data, a scripted model, a fake GitHub, the real decoder.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import { hosted } from "./org-meeting-kit.js";
import { FakeGithub } from "../src/org/website/fake-github.js";
import { ChatTools } from "../src/org/chat/tools.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT)
  && existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const EVENTS = JSON.stringify({ events: [], galleryPhotos: ["/images/gallery/IMG_1.jpg"] }, null, 2) + "\n";
const EVENT = { id: "happy-hour-2026-11", title: "Happy Hour", date: "2026-11-19", time: "6:00 PM", location: "Plane Jane", address: "", description: "Neighbors meet.", type: "social" };

describe.skipIf(!enabled)("J2 in the browser", () => {
  it("icons, Newsletter = Drafts + Sent, Files order, Add photos -> a proposal with the picture and gallery thumbnails", async () => {
    const sharp = createRequire(new URL("../decoder/package.json", import.meta.url))("sharp");
    const gh = new FakeGithub(undefined, { "src/data/events.json": EVENTS, "src/data/meeting-notes.json": JSON.stringify({ meetings: [] }, null, 2) + "\n" });
    const model = async () => new Response(JSON.stringify({ id: "g", model: hosted.runtime.responseModels?.at(-1) ?? hosted.runtime.model, provider: (hosted.runtime.providerNames ?? hosted.runtime.providers)[0],
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ ops: [{ op: "upsert_event", event: EVENT }] }) } }],
      usage: { prompt_tokens: 9000, completion_tokens: 200, total_tokens: 9200, cost: 0.03 } }), { status: 200, headers: { "content-type": "application/json" } });
    const w = await transcriptionWorld({ chat: {}, teamTasks: true, fetch: model as never, githubFetch: gh.fetch, website: { dailyApply: 5 }, websitePoll: { everyMs: 20, maxMs: 200 },
      images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true } } });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.J2_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const shot = async (page: any, name: string) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, name), fullPage: true }); };
    try {
      const api = (p: string, b: unknown, c = w.robin) => w.post(`/o/exna/api/${p}`, b, c);
      // Files: notes, a shared file, the website copy's source files.
      for (const [p, t] of [["members/notes/2026-10-08.v1.md", "# October\nBlock Party drew 1,400 neighbors.\n"], ["members/shared/volunteers.md", "# Volunteers\nSue, Kara.\n"],
        ["members/website/events.md", "# Events\n"], ["members/website/site-images.md", "# Site images\n"], ["members/website/newsletters/2026-10-07-october.md", "# October newsletter\n"]] as const) {
        mkdirSync(join(w.cfg.folder, p, ".."), { recursive: true }); writeFileSync(join(w.cfg.folder, p), t);
      }
      // Two drive photos.
      const photo = async (colour: string, name: string) => {
        const src = await sharp({ create: { width: 640, height: 480, channels: 3, background: colour } }).jpeg().toBuffer();
        const t = await api("image/upload", { drive: true, fileName: name + ".jpg", size: src.length, contentType: "image/jpeg" });
        return (await (await fetch(`${w.url}/o/exna/upload/${t.result.uploadId}`, { method: "PUT", headers: { "content-type": "image/jpeg", cookie: w.robin }, body: new Uint8Array(src) })).json() as any).sha256 as string;
      };
      await photo("#2a6", "Porch party"); await photo("#a62", "Park cleanup");
      // A newsletter draft in Robin's chat (rendered), and none in Alex's.
      const conv = (await api("chat/conversation/create", {})).result.conversationId;
      const tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
      const ctx = { turnId: "turn_" + randomUUID().replaceAll("-", ""), conversationId: conv, memberId: "m", scope: "member" as const };
      w.org.sqlite.db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,?,?,?,?)").run("msg_" + randomUUID(), conv, ctx.turnId, "user", "Draft the newsletter.", "x", new Date().toISOString());
      await tools.begin(ctx);
      const v = JSON.parse((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "November: Happy Hour and the Holiday Party",
        sections: [{ heading: "Block Party", body: "1,400 neighbors came." }], sources: [{ path: "members/notes/2026-10-08.v1.md", line: 2 }] } }), ctx) as any).content);
      await tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: 1 }), ctx);
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = w.robin.split("=");
      await c.addCookies([{ name, value, url: w.url }]);
      const errors: string[] = []; page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
      // Home: three cards, each with its icon (decorative).
      await page.goto(`${w.url}/o/exna/#home`); await page.locator(".jobs").waitFor();
      expect(await page.locator(".job svg.job-icon[aria-hidden=true]").count()).toBe(3);
      expect(await page.locator(".job strong").allTextContents()).toEqual(["Website", "Newsletter", "Meetings"]);
      await shot(page, "home-icons-1440.png");
      // Newsletter: Drafts (my draft, Open preview) and Sent; nothing else.
      await page.goto(`${w.url}/o/exna/#newsletter`); await page.getByRole("heading", { name: "Drafts" }).waitFor();
      expect(await page.locator("main h2").allTextContents()).toEqual(["Drafts", "Sent"]);
      expect(await page.locator(".nl-draft strong").first().textContent()).toBe("November: Happy Hour and the Holiday Party");
      await page.locator(".nl-draft").getByRole("button", { name: "Open preview" }).click();
      await page.locator(".nl-draft iframe.preview").waitFor();
      expect((await page.locator("main section").nth(1).locator("a").allTextContents()).map((t: string) => t.trim())).toEqual([expect.stringMatching(/Oct 7, 2026 · october$/), "Open"]);
      await shot(page, "newsletter-drafts-sent-1440.png");
      // J2 option a: the owner shares the draft with reviewers (and can stop); the tag says so.
      await page.locator(".nl-draft").getByRole("button", { name: "Share with reviewers" }).click();
      await page.locator(".nl-draft .tag", { hasText: "Shared with reviewers" }).waitFor();
      expect(await page.locator(".nl-draft").getByRole("button", { name: "Stop sharing" }).count()).toBe(1);
      await shot(page, "newsletter-shared-1440.png");
      // Files: drive images and shared files first; website source files and task results closed.
      await page.goto(`${w.url}/o/exna/#files`); await page.getByRole("heading", { name: "Shared drive" }).waitFor();
      expect((await page.locator(".folder h3").allTextContents()).slice(0, 2)).toEqual(["Images", "Shared files"]);
      const src = page.locator("details.site-source");
      expect([await src.count(), await src.evaluate((d: any) => d.open)]).toEqual([1, false]);
      expect(await page.getByText("events.md", { exact: true }).isVisible()).toBe(false);
      await shot(page, "files-order-1440.png");
      await src.locator("summary").click();
      expect(await page.getByText("events.md", { exact: true }).isVisible()).toBe(true);
      // Website: Add photos -> one event picture + one gallery photo -> the proposal shows both.
      await page.goto(`${w.url}/o/exna/#website`); await page.locator("#website-text").waitFor();
      expect(await page.locator("#website-text").evaluate((t: any) => getComputedStyle(t).fontFamily)).not.toMatch(/monospace|Menlo/);
      await page.locator("#website-text").fill("Add the Nov 19 happy hour at Plane Jane, 6 pm.");
      await page.getByRole("button", { name: "Add photos" }).click();
      await page.locator(".shelf .pick").first().waitFor();
      await page.locator(".shelf .pick", { hasText: "Porch party" }).click();
      await page.getByRole("button", { name: "Add more photos" }).click();
      await page.locator(".shelf .pick", { hasText: "Park cleanup" }).click();
      await page.locator(".photo-row", { hasText: "Porch party" }).getByLabel("The event's picture").check();
      await expect.poll(() => page.locator(".photo-row", { hasText: "Park cleanup" }).getByLabel("The event's picture").isDisabled()).toBe(true); // one picture (after the redraw)
      await shot(page, "website-add-photos-1440.png");
      await page.getByRole("button", { name: "Ask the agent to draft this change" }).click();
      await page.getByText("The event's picture", { exact: true }).last().waitFor({ timeout: 20_000 });
      await page.getByText("Added to the photo gallery").waitFor();
      expect(await page.locator(".gallery-attach img").count()).toBe(1);
      await shot(page, "website-proposal-photos-1440.png");
      expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 240_000);
});
