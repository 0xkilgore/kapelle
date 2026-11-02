// PACKAGE P (never silent) in real Chromium under the production CSP: when the member's latest drafting message gave a link that
// no version saved in that turn carries, the conversation says so in plain words under the reply. Synthetic rows (no model).
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import { ChatTools } from "../src/org/chat/tools.js";

const PLAYWRIGHT = "/Users/owner/Code/kapelle-capability-profile/node_modules/playwright/index.mjs";
const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT && existsSync(PLAYWRIGHT);

describe.skipIf(!enabled)("member link gap in the browser (P)", () => {
  it("an edit card says what it touched; a link left out at the member's request says so with the reason; the backstop line names a missing link", async () => {
    const w = await transcriptionWorld({ chat: {} });
    const { chromium } = await import(PLAYWRIGHT as string);
    const browser = await chromium.launch();
    const SHOTS = process.env.P_SHOTS; if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    try {
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, "members/notes/2026-10-08.v1.md"), "# October\nBlock Party drew over 300 neighbors.\n");
      const conv = (await w.post("/o/exna/api/chat/conversation/create", {}, w.robin)).result.conversationId;
      // A real upload makes the chat non-empty (listed in Recent), as a member's activity would.
      expect((await w.post("/o/exna/api/chat/upload", { conversationId: conv, fileName: "notes.md", text: "# Notes\nBlock Party.\n" }, w.robin)).ok).toBe(true);
      const db = w.org.sqlite.db, tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
      const msg = (turnId: string, role: string, text: string) => db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,?,?,?,?)")
        .run("msg_" + randomUUID(), conv, turnId, role, text, "x", new Date().toISOString());
      const t1 = "turn_" + randomUUID().replaceAll("-", ""), t2 = "turn_" + randomUUID().replaceAll("-", ""), t3 = "turn_" + randomUUID().replaceAll("-", "");
      const old = "https://forms.example/old";
      msg(t1, "user", "Draft the newsletter from the notes and link the sign-up form " + old);
      const c1 = { turnId: t1, conversationId: conv, memberId: "m", scope: "member" as const };
      await tools.begin(c1);
      const v1 = JSON.parse((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "November",
        sections: [{ heading: "Block Party", body: "Over 300 neighbors came.", links: [{ text: "Sign up", url: old }] }], sources: [{ path: "members/notes/2026-10-08.v1.md", line: 2 }] } }), c1) as any).content);
      msg(t1, "assistant", "I saved the draft.");
      // Turn 2: the member drops the link; the edit records it in leaveOut with the reason (the card says so, never silently).
      msg(t2, "user", "Remove the sign-up link " + old + ", sign-up is closed.");
      const c2 = { turnId: t2, conversationId: conv, memberId: "m", scope: "member" as const };
      await tools.begin(c2);
      const v2 = JSON.parse((await tools.call("edit_draft_artifact", JSON.stringify({ artifactId: v1.artifactId, parentVersion: 1, parentSha256: v1.sha256,
        edits: [{ op: "set_list", field: "sections[0].links", old: [{ text: "Sign up", url: old }], new: [] }], leaveOut: [{ url: old, reason: "you said sign-up is closed" }] }), c2) as any).content);
      expect(v2).toMatchObject({ saved: true, version: 2 });
      msg(t2, "assistant", "Removed.");
      // Turn 3 (the backstop line): a version counted to this turn that lacks the member's new link and has no leaveOut for it.
      msg(t3, "user", "Add the volunteer link https://forms.example/volunteer to the Block Party section.");
      msg(t3, "assistant", "I couldn't add that.");
      db.prepare("INSERT INTO chat_artifact_versions(artifact_id,version,sha256,bytes,envelope_id,turn_id,snapshot_hash,renderer_version,html_sha256,created_at) SELECT artifact_id,3,sha256,bytes,envelope_id,?,snapshot_hash,NULL,NULL,created_at FROM chat_artifact_versions WHERE artifact_id=? AND version=2")
        .run(t3, v1.artifactId);
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await c.newPage(), [name, value] = w.robin.split("=");
      await c.addCookies([{ name, value, url: w.url }]);
      const errors: string[] = []; page.on("console", (m: any) => { if (m.type() === "error") errors.push(m.text()); });
      await page.goto(`${w.url}/o/exna/#home`);
      await page.locator(".recent-list a").first().click();
      await page.getByText("Edited: sections[0].links (from version 1)").waitFor({ timeout: 15_000 });
      const lines = async () => (await page.locator(".notice.link-gap").allTextContents()).map((t: string) => t.replace(/\s+/g, " ").trim());
      await expect.poll(lines).toEqual(["Left out: https://forms.example/old: you said sign-up is closed", "Your link https://forms.example/volunteer isn't in this draft."]);
      if (SHOTS) await page.screenshot({ path: join(SHOTS, "member-link-gap-1440.png"), fullPage: true });
      expect(errors.filter((e) => /Content Security Policy|Refused/.test(e))).toEqual([]);
    } finally { await browser.close(); await w.close(); }
  }, 120_000);
});
