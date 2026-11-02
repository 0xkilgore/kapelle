// J2 option a (Director, Oct 26; chats stay private, a standing owner rule): a member presses "Share with reviewers" on ONE
// newsletter draft (audited); only shared drafts appear in reviewers' list, and only the DRAFT is reachable (its preview, Send me
// a test, publish), never the conversation. Stop sharing closes it again. Synthetic rows; no model.
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import { ChatTools } from "../src/org/chat/tools.js";
import { ACCESS_ACTIONS, STEP_UP } from "../src/access/org-access.js";

describe.skipIf(!process.env.KAPELLE_SCOPED_REACTOR_ROOT)("share a newsletter draft with reviewers (J2 a)", () => {
  it("owner-only share/unshare (audited); reviewers see and preview only shared drafts; the chat stays private", async () => {
    expect([ACCESS_ACTIONS.routine.includes("chat.draft.share"), STEP_UP.session.includes("chat.draft.share")]).toEqual([true, true]);
    const w = await transcriptionWorld({ chat: {} });
    try {
      const api = (p: string, b: unknown, c: string) => w.post(`/o/exna/api/${p}`, b, c);
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true }); writeFileSync(join(w.cfg.folder, "members/notes/n.md"), "# N\nBlock Party.\n");
      // Alex (a contributor) drafts a newsletter in Alex's own chat.
      const conv = (await api("chat/conversation/create", {}, w.alex)).result.conversationId;
      const tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
      const ctx = { turnId: "turn_" + randomUUID().replaceAll("-", ""), conversationId: conv, memberId: "m", scope: "member" as const };
      w.org.sqlite.db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,?,?,?,?)").run("msg_" + randomUUID(), conv, ctx.turnId, "user", "Draft it.", "x", new Date().toISOString());
      await tools.begin(ctx);
      const v = JSON.parse((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "November", sections: [{ heading: "Block Party", body: "It happened." }],
        sources: [{ path: "members/notes/n.md", line: 2 }] } }), ctx) as any).content);
      await tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: 1 }), ctx);
      const preview = { conversationId: conv, artifactId: v.artifactId, version: 1 };
      const get = (c: string) => fetch(`${w.url}/o/exna/preview?conversationId=${conv}&artifactId=${v.artifactId}&version=1`, { headers: { cookie: c } });
      const robinList = async () => (await api("chat/conversation/list", { drafts: true }, w.robin)).result;
      // Not shared: Robin (a reviewer) sees nothing and is refused the preview; Alex sees the draft as not shared.
      expect((await robinList()).sharedDrafts).toEqual([]);
      expect((await api("chat/artifact/preview", preview, w.robin)).error).toBe("chat_conversation_unknown");
      expect((await get(w.robin)).status).not.toBe(200);
      expect((await api("chat/conversation/list", { drafts: true }, w.alex)).result.drafts).toMatchObject([{ artifact_id: v.artifactId, title: "November", shared: false }]);
      // Only the owner can share; another member or a wrong artifact is refused.
      expect((await api("chat/draft/share", { conversationId: conv, artifactId: v.artifactId }, w.robin)).error).toBe("chat_conversation_unknown");
      expect((await api("chat/draft/share", { conversationId: conv, artifactId: "art_" + "0".repeat(32) }, w.alex)).error).toBe("chat_artifact_unknown");
      // Alex shares: Robin sees it (labelled), previews it (action and hub GET); the CHAT stays closed to Robin.
      expect((await api("chat/draft/share", { conversationId: conv, artifactId: v.artifactId }, w.alex)).result).toEqual({ artifactId: v.artifactId, shared: true });
      expect((await robinList()).sharedDrafts).toMatchObject([{ artifact_id: v.artifactId, title: "November", sharedBy: "alex@exna.test", shared: true }]);
      expect((await api("chat/artifact/preview", preview, w.robin)).result.html).toContain("November");
      expect((await get(w.robin)).status).toBe(200);
      expect((await api("chat/conversation/read", { conversationId: conv }, w.robin)).error).toBe("chat_conversation_unknown");
      // A contributor never gets a "shared with reviewers" list, and Alex's own list does not repeat it there.
      expect((await api("chat/conversation/list", { drafts: true }, w.alex)).result.sharedDrafts).toEqual([]);
      // Stop sharing: closed again. Both events are in the chat audit.
      expect((await api("chat/draft/share", { conversationId: conv, artifactId: v.artifactId, share: false }, w.alex)).result.shared).toBe(false);
      expect((await robinList()).sharedDrafts).toEqual([]);
      expect((await api("chat/artifact/preview", preview, w.robin)).error).toBe("chat_conversation_unknown");
      expect(w.org.sqlite.db.prepare("SELECT event, detail FROM chat_audit WHERE conversation_id=? AND event LIKE 'draft_%' ORDER BY rowid").all(conv))
        .toEqual([{ event: "draft_shared", detail: v.artifactId }, { event: "draft_unshared", detail: v.artifactId }]);
    } finally { await w.close(); }
  }, 120_000);
});
