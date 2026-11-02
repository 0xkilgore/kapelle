// Chat agent C-5 (PLAN-SLICE-1 §6, Fable §12(a) E-1..E-6): the draft envelope. A card computed by the runtime, approved by the
// conversation's starter (session-fresh, digest = card hash, receipt), one envelope per approval operationId, a Records Task
// under the same operationId, turns inside it write versioned drafts against the PINNED snapshot; source change, expiry or
// exhaustion closes it. Real org runtime behind the real hub; scripted FAKE model; synthetic data.
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { INTERACTIVE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";
import { cardHash, ENVELOPE_CAPS } from "../src/org/chat/drafts.js";
import { stepUpOf, audienceOf } from "../src/access/org-access.js";
import { failureLabel } from "../src/task-delegation/failure-labels.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const NOTES = "members/notes/2026-10-08.v1.md";
const NL = (title: string) => ({ title, sections: [{ heading: "Block Party", body: "Over 300 neighbors came out." }], sources: [{ path: NOTES, line: 2 }] });

describe.skipIf(!enabled)("chat draft envelope", () => {
  it("card -> approve (E-1) -> envelope + Task (E-2, E-4) -> drafts in the envelope (E-5) -> source change closes it (E-3)", async () => {
    let steps: any[] = [];
    const bodies: any[] = [];
    const fetch = async (_u: string, init: any) => { bodies.push(JSON.parse(init.body)); const s = steps.shift() ?? { text: "Done." };
      const tool_calls = s.calls?.map(([name, args]: [string, unknown], k: number) => ({ id: `c${bodies.length}_${k}`, type: "function", function: { name, arguments: JSON.stringify(args) } }));
      return new Response(JSON.stringify({ id: "g" + bodies.length, model: INTERACTIVE_PROFILES.sonnet.runtime.model, provider: "Amazon Bedrock",
        choices: [{ finish_reason: tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content: s.text ?? null, ...(tool_calls ? { tool_calls } : {}) } }],
        usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000, cost: 0.003 } }), { status: 200, headers: { "content-type": "application/json" } }); };
    const w = await transcriptionWorld({ chat: {}, fetch });
    try {
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, NOTES), "# October\nBlock Party drew over 300 neighbors.\nTree planting Nov 8.\n");
      const api = (path: string, body: unknown, cookie = w.alex) => w.post(`/o/exna/api/chat/${path}`, body, cookie);
      const conv = (await api("conversation/create", {})).result.conversationId;
      const turn = async (text: string, id: string) => { const t = (await api("turn/start", { conversationId: conv, clientRequestId: id, text })).result.turnId;
        for (let i = 0; i < 300 && !(await api("turn/read", { turnId: t })).result.terminal; i++) await new Promise((r) => setTimeout(r, 20)); return t; };
      // The card is computed by the runtime.
      expect((await api("draft/card", { conversationId: conv, capability: "website" })).error).toBe("chat_draft_capability_invalid");
      expect((await api("draft/card", { conversationId: conv, capability: "newsletter" }, w.robin)).error).toBe("chat_conversation_unknown");
      const { card, cardHash: h } = (await api("draft/card", { conversationId: conv, capability: "newsletter" })).result;
      expect(card).toMatchObject({ contract: "kapelle.chat-draft-card/v1", conversationId: conv, capability: "newsletter", scopeRoots: ["members", `members/uploads/${card.scopeRoots[1].split("/")[2]}/${conv}`],
        snapshotHash: expect.stringMatching(/^sha256:/), toolCatalogHash: INTERACTIVE_PROFILES.sonnet.runtime.toolCatalogHash, caps: { turns: 5, usd: 2, requestsPerTurn: 6, toolsPerTurn: 12 } });
      expect(h).toBe(cardHash(card));
      // E-1: the approval binds exactly this card.
      expect(stepUpOf("chat.draft.approve")).toBe("session-fresh"); expect(audienceOf("chat.draft.approve")).toBe("consequential");
      expect((await w.act(w.alex, "chat.draft.approve", { card }, "sha256:" + "0".repeat(64))).error).toBe("chat_draft_digest_mismatch");
      const richer = { ...card, caps: { ...card.caps, usd: 5 } };
      expect((await w.act(w.alex, "chat.draft.approve", { card: richer }, cardHash(richer))).error).toBe("chat_draft_card_stale");
      expect((await w.act(w.robin, "chat.draft.approve", { card }, h)).error).toBe("chat_conversation_unknown"); // not the starter
      expect((await w.act(w.admin, "chat.draft.approve", { card }, h)).error).toBe("chat_conversation_unknown");
      const ok = await w.act(w.alex, "chat.draft.approve", { card }, h);
      expect(ok.error).toBeUndefined();
      expect(ok).toMatchObject({ ok: true, authorization: { action: "chat.draft.approve", authn: "email-session", artifactDigest: h },
        result: { envelopeId: expect.stringMatching(/^env_[a-f0-9]{32}$/), taskId: expect.any(String), turnsLeft: 5, usdLeft: 2, closed: null } });
      const env = ok.result;
      // A receipt to the approver only (fixed template).
      for (let i = 0; i < 50 && !w.mail.some((m) => m.kind === "receipt" && m.receipt?.action === "chat.draft.approve"); i++) await new Promise((r) => setTimeout(r, 20));
      expect(w.mail.filter((m) => m.kind === "receipt" && m.receipt?.action === "chat.draft.approve").map((m) => m.to)).toEqual(["alex@exna.test"]);
      // E-2: a replay of the same approval returns the same envelope; E-4: the Task under the same operationId, attribution join.
      expect(await w.org.drafts!.approve(ok.authorization, { card })).toMatchObject({ envelopeId: env.envelopeId, taskId: env.taskId });
      expect((w.org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM chat_envelopes").get() as any).n).toBe(1);
      const task: any = await w.org.rt.authority.backend.read(env.taskId, "kilgore/task");
      expect(task.document.state.global).toMatchObject({ sourceRef: `chat:${conv}#${env.envelopeId}` });
      expect(w.org.sqlite.db.prepare("SELECT action, authn, artifact_digest FROM access_authorizations WHERE operation_id=?").get(ok.authorization.operationId))
        .toEqual({ action: "chat.draft.approve", authn: "email-session", artifact_digest: h });
      // Turn 1 in the envelope: write v1, render it, answer.
      steps = [{ calls: [["write_draft_artifact", { kind: "newsletter", content: NL("November in Example Park") }]] },
        { calls: [["render_newsletter_preview", { artifactId: "PLACEHOLDER", version: 1 }]] }, { text: "Here's the draft." }];
      // The model learns the artifact id from the tool result; the script patches it in when the second request is built.
      const realShift = steps.shift.bind(steps);
      steps.shift = () => { const s = realShift(); if (s?.calls?.[0]?.[0] === "render_newsletter_preview") { const last = bodies.at(-1).messages.at(-1); s.calls[0][1].artifactId = JSON.parse(last.content).artifactId; } return s; };
      const t1 = await turn("Draft the November newsletter.", "req-draft-0001");
      expect((await api("turn/read", { turnId: t1 })).result.turn).toMatchObject({ state: "done", toolCalls: 2 });
      // Fable Q-1: inside the bound plan every request of the turn says so (fixed line from the envelope row).
      expect(bodies.at(-1).messages[0].content).toContain("A draft plan is approved for this conversation (newsletter; 4 turns and $");
      expect(w.org.sqlite.db.prepare("SELECT name, label FROM chat_tool_calls WHERE turn_id=? ORDER BY n").all(t1)).toEqual([{ name: "write_draft_artifact", label: null }, { name: "render_newsletter_preview", label: null }]);
      let read = (await api("conversation/read", { conversationId: conv })).result;
      expect(read.envelope).toMatchObject({ envelopeId: env.envelopeId, turnsLeft: 4, closed: null });
      expect(read.artifacts).toEqual([expect.objectContaining({ kind: "newsletter", version: 1, envelope_id: env.envelopeId, turn_id: t1, snapshot_hash: card.snapshotHash, html_sha256: expect.any(String) })]);
      // Turn 2: "change the headline" -> v2 in the same envelope.
      steps = [{ calls: [["write_draft_artifact", { kind: "newsletter", content: NL("Thanks for a great Block Party") }]] }, { text: "Headline changed." }];
      await turn("Change the headline to Thanks for a great Block Party", "req-draft-0002");
      read = (await api("conversation/read", { conversationId: conv })).result;
      expect(read.artifacts.map((a: any) => a.version)).toEqual([1, 2]);
      expect(read.envelope.turnsLeft).toBe(3);
      // E-3: a source change closes the envelope at the next turn; drafting is refused (counted), Q&A still answers.
      writeFileSync(join(w.cfg.folder, NOTES), "# October\nBlock Party drew over 300 neighbors.\nTree planting Nov 8 (moved to 10 am).\n");
      steps = [{ calls: [["write_draft_artifact", { kind: "newsletter", content: NL("Again") }]] }, { text: "I need a new plan approval to save drafts." }];
      const t3 = await turn("Save another version.", "req-draft-0003");
      expect(w.org.sqlite.db.prepare("SELECT label FROM chat_tool_calls WHERE turn_id=?").all(t3)).toEqual([{ label: "chat_tool_needs_draft_plan" }]);
      expect(bodies.at(-1).messages[0].content).toContain("No draft plan is approved in this conversation: drafts cannot be saved; answer in text."); // closed plan
      expect(w.org.sqlite.db.prepare("SELECT closed_reason FROM chat_envelopes WHERE id=?").get(env.envelopeId)).toEqual({ closed_reason: "chat_draft_snapshot_changed" });
      expect((await api("conversation/read", { conversationId: conv })).result.envelope).toBeNull();
      // The old card no longer approves (the snapshot moved): a new card is needed.
      expect((await w.act(w.alex, "chat.draft.approve", { card }, h)).error).toBe("chat_draft_card_stale");
      for (const l of ["chat_draft_expired", "chat_draft_exhausted", "chat_draft_snapshot_changed"]) expect(failureLabel(new Error(l))).toBe(l);
    } finally { await w.close(); }
  }, 120_000);

  it("expiry and exhaustion close the envelope; an expired card is refused; E-6: no effect path", async () => {
    const w = await transcriptionWorld({ chat: {}, fetch: async () => new Response("{}", { status: 503 }) });
    try {
      const api = (path: string, body: unknown) => w.post(`/o/exna/api/chat/${path}`, body, w.alex);
      const conv = (await api("conversation/create", {})).result.conversationId;
      const { card, cardHash: h } = (await api("draft/card", { conversationId: conv, capability: "agenda" })).result;
      const past = { ...card, expiresAt: new Date(Date.now() - 1000).toISOString() };
      expect((await w.act(w.alex, "chat.draft.approve", { card: past }, cardHash(past))).error).toBe("chat_draft_card_expired");
      const env = (await w.act(w.alex, "chat.draft.approve", { card }, h)).result;
      const d = w.org.drafts!, db = w.org.sqlite.db;
      const fakeTurn = (i: number, cost = 0) => { const id = "turn_" + String(i).padStart(32, "0");
        db.prepare("INSERT INTO chat_turns(id,conversation_id,member_id,client_request_id,text_sha256,state,cost_usd,started_at) VALUES (?,?,?,?,?,'done',?,?)").run(id, conv, "m", "req-x-" + String(i).padStart(4, "0"), "sha256:x", cost, new Date().toISOString()); return id; };
      for (let i = 1; i <= ENVELOPE_CAPS.turns; i++) expect(d.bindTurn(fakeTurn(i), conv, card.snapshotHash)?.envelopeId).toBe(env.envelopeId);
      expect(d.bindTurn(fakeTurn(6), conv, card.snapshotHash)).toBeNull();
      expect(db.prepare("SELECT closed_reason FROM chat_envelopes WHERE id=?").get(env.envelopeId)).toEqual({ closed_reason: "chat_draft_exhausted" });
      // $ exhaustion and expiry on fresh envelopes.
      const c2 = (await api("draft/card", { conversationId: conv, capability: "agenda" })).result;
      const e2 = (await w.act(w.alex, "chat.draft.approve", { card: c2.card }, c2.cardHash)).result;
      expect(d.bindTurn(fakeTurn(7, 2.5), conv, c2.card.snapshotHash)?.envelopeId).toBe(e2.envelopeId);
      expect(d.bindTurn(fakeTurn(8), conv, c2.card.snapshotHash)).toBeNull();
      expect(db.prepare("SELECT closed_reason FROM chat_envelopes WHERE id=?").get(e2.envelopeId)).toEqual({ closed_reason: "chat_draft_exhausted" });
      const c3 = (await api("draft/card", { conversationId: conv, capability: "agenda" })).result;
      const e3 = (await w.act(w.alex, "chat.draft.approve", { card: c3.card }, c3.cardHash)).result;
      db.prepare("UPDATE chat_envelopes SET expires_at=? WHERE id=?").run(new Date(Date.now() - 1000).toISOString(), e3.envelopeId);
      expect(d.bindTurn(fakeTurn(9), conv, c3.card.snapshotHash)).toBeNull();
      expect(db.prepare("SELECT closed_reason FROM chat_envelopes WHERE id=?").get(e3.envelopeId)).toEqual({ closed_reason: "chat_draft_expired" });
      // E-6: nothing outside the chat tools reads an envelope; no effect action references chat.
      expect(db.prepare("SELECT COUNT(*) AS n FROM member_reply_outbox").get()).toEqual({ n: 0 });
    } finally { await w.close(); }
  }, 120_000);
});
