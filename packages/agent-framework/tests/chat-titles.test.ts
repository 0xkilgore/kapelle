// Chat content v1, WC-4 (PLAN-CHAT-CONTENT-V1; Fable R-10): a conversation takes a deterministic title from its first
// message (no model call), and its starter (only) can rename it. One sanitizer for both. Real org runtime + hub.
import { describe, it, expect } from "vitest";
import { transcriptionWorld } from "./transcription-world.js";
import { chatTitle, TITLE_MAX } from "../src/org/chat/conversations.js";
import { stepUpOf } from "../src/access/org-access.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;

it("chatTitle: control chars, markdown markers and link targets removed; identifiers kept; cut at a word boundary with …", () => {
  expect(chatTitle("**When** is the [cleanup](https://example.org/x)?\n- bring gloves", 60)).toBe("When is the cleanup? bring gloves");
  expect(chatTitle("# October\n> quoted\n1. First item\n\tsecond\u0000line", 60)).toBe("October quoted First item second line");
  expect(chatTitle("Meeting at 7. Then - after that - snacks", 60)).toBe("Meeting at 7. Then - after that - snacks"); // mid-line markers stay
  expect(chatTitle("What does search_org_history do with *notes*?", 60)).toBe("What does search_org_history do with notes?");
  expect(chatTitle("`code` and ~~old~~ __bold__", 60)).toBe("code and old bold");
  const long = chatTitle("Please draft the November newsletter with the tree planting, the cleanup and the pool closing dates", TITLE_MAX.auto);
  expect(long.length).toBeLessThanOrEqual(TITLE_MAX.auto);
  expect(long).toBe("Please draft the November newsletter with the tree…");
  expect(chatTitle("x".repeat(80), 60)).toBe("x".repeat(59) + "…"); // no space: a hard cut
  expect(chatTitle(" \n\t ", 60)).toBe("");
  expect(chatTitle("a".repeat(5000), 60)).toHaveLength(60); // input bounded
});

describe.skipIf(!enabled)("conversation titles (WC-4)", () => {
  it("first message titles an untitled chat once; a given title stays; rename by the starter only, 1..120 after the sanitizer", async () => {
    const w = await transcriptionWorld({ chat: { adminsReadAll: true } });
    try {
      expect(stepUpOf("chat.conversation.rename")).toBe("session");
      const api = (p: string, b: unknown, c = w.alex) => w.post(`/o/exna/api/chat/${p}`, b, c);
      const conv = (await api("conversation/create", {})).result.conversationId;
      const start = (id: string, text: string, c = conv) => api("turn/start", { conversationId: c, clientRequestId: id, text });
      const title = async (c = conv) => (await api("conversation/read", { conversationId: c })).result.conversation.title;
      expect(await title()).toBeNull();
      expect((await start("req-title-001", "**When** is the [cleanup](https://example.org)?\n- bring gloves")).ok).toBe(true);
      expect(await title()).toBe("When is the cleanup? bring gloves");
      for (let i = 0; i < 200; i++) { const t = (await api("conversation/read", { conversationId: conv })).result.turns[0]; if (!["queued", "running"].includes(t.state)) break; await new Promise((r) => setTimeout(r, 10)); }
      expect((await start("req-title-002", "Something else entirely")).ok).toBe(true);
      expect(await title()).toBe("When is the cleanup? bring gloves"); // set once
      const named = (await api("conversation/create", { title: "Board prep" })).result;
      expect(named.title).toBe("Board prep");
      // Rename: the starter only; an admin who can READ it (adminsReadAll) cannot rename it; another member cannot see it.
      expect((await api("conversation/rename", { conversationId: conv, title: "  Cleanup\nplanning  " })).result.title).toBe("Cleanup planning");
      expect(await title()).toBe("Cleanup planning");
      expect((await api("conversation/read", { conversationId: conv }, w.admin)).result.adminRead).toBe(true);
      expect((await api("conversation/rename", { conversationId: conv, title: "Mine now" }, w.admin)).error).toBe("chat_conversation_unknown");
      expect((await api("conversation/rename", { conversationId: conv, title: "Mine now" }, w.robin)).error).toBe("chat_conversation_unknown");
      for (const bad of ["", "   ", "\u0000\u0001", "**", "x".repeat(121), 42]) expect((await api("conversation/rename", { conversationId: conv, title: bad })).error, String(bad).slice(0, 10)).toBe("chat_title_invalid");
      expect((await api("conversation/rename", { conversationId: conv, title: "y".repeat(120) })).result.title).toHaveLength(120);
      expect(await title()).toHaveLength(120);
    } finally { await w.close(); }
  });

  it("P-3 (Fable R-6): a start titles pre-WC-4 chats from the first member message; renamed, deleted and empty ones untouched; last_at kept; next start 0", async () => {
    const w = await transcriptionWorld({ chat: {} });
    try {
      const api = (p: string, b: unknown) => w.post(`/o/exna/api/chat/${p}`, b, w.alex), db = () => w.org.sqlite.db;
      const settle = async () => { for (let i = 0; i < 300 && db().prepare("SELECT 1 FROM chat_turns WHERE state IN ('queued','running')").get(); i++) await new Promise((r) => setTimeout(r, 10)); };
      const conv = async (text: string | null, id: string) => { const c = (await api("conversation/create", {})).result.conversationId;
        if (text) { expect((await api("turn/start", { conversationId: c, clientRequestId: id, text })).ok).toBe(true); await settle(); } return c; };
      const old = await conv("**When** is the cleanup?\nBring gloves", "req-bf-0001"), renamed = await conv("Something", "req-bf-0002"),
        gone = await conv("Deleted one", "req-bf-0003"), empty = await conv(null, "x");
      expect((await api("turn/start", { conversationId: old, clientRequestId: "req-bf-0004", text: "A later question" })).ok).toBe(true); await settle();
      // Make them look like pre-WC-4 rows: no titles; one renamed since; one deleted.
      db().prepare("UPDATE chat_conversations SET title=NULL WHERE id IN (?,?,?,?)").run(old, renamed, gone, empty);
      db().prepare("UPDATE chat_conversations SET title='Kept name' WHERE id=?").run(renamed);
      db().prepare("UPDATE chat_conversations SET deleted_at=? WHERE id=?").run(new Date().toISOString(), gone);
      const row = (id: string) => db().prepare("SELECT title, last_at, deleted_at FROM chat_conversations WHERE id=?").get(id) as { title: string | null; last_at: string };
      const before = row(old).last_at, msgs = (db().prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n;
      await w.restart();
      expect(row(old)).toMatchObject({ title: "When is the cleanup? Bring gloves", last_at: before }); // the FIRST message
      expect(row(renamed).title).toBe("Kept name");
      expect(row(gone).title).toBeNull();
      expect(row(empty).title).toBeNull();
      expect((db().prepare("SELECT COUNT(*) AS n FROM chat_messages").get() as { n: number }).n).toBe(msgs);
      expect((await w.ops("/ops/status", {})).chat.titlesBackfilled).toBe(1);
      await w.restart();
      expect((await w.ops("/ops/status", {})).chat.titlesBackfilled).toBe(0);
    } finally { await w.close(); }
  });
});
