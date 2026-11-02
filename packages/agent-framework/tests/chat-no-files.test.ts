// Chat content v1, WC-3 (PLAN-CHAT-CONTENT-V1; Fable R-9): a turn over an EMPTY snapshot makes no model request, reserves
// nothing on the ledger, binds no draft envelope turn and does not count against the member's daily allowance; the turn
// row ends failed with the fixed label chat_no_files. Real org runtime + hub; a counting fake model.
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { INTERACTIVE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;

it("chat_no_files is a persisted label", () => { expect(failureLabel(new Error("chat_no_files"))).toBe("chat_no_files"); expect(persistedReason("chat_no_files")).toBe("chat_no_files"); });

describe.skipIf(!enabled)("empty snapshot (WC-3)", () => {
  it("no files: no request, no reservation, not counted; a file connected: the next turn asks the model", async () => {
    let calls = 0;
    const fetch = async () => { calls++; return new Response(JSON.stringify({ id: "g" + calls, model: INTERACTIVE_PROFILES.sonnet.runtime.model, provider: "Amazon Bedrock",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Block Party drew over 300 neighbors. members/notes/2026-10-08.v1.md#L2-L2" } }],
      usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000, cost: 0.003 } }), { status: 200, headers: { "content-type": "application/json" } }); };
    const w = await transcriptionWorld({ chat: { dailyTurnsPerMember: 1 }, fetch });
    try {
      const api = (p: string, b: unknown) => w.post(`/o/exna/api/chat/${p}`, b, w.alex);
      const conv = (await api("conversation/create", {})).result.conversationId;
      const turn = async (id: string) => { const t = (await api("turn/start", { conversationId: conv, clientRequestId: id, text: "How many came to Block Party?" })).result.turnId;
        for (let i = 0; i < 300 && !(await api("turn/read", { turnId: t })).result.terminal; i++) await new Promise((r) => setTimeout(r, 20));
        return (await api("turn/read", { turnId: t })).result.turn; };
      const effects = () => (w.org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM effects WHERE key LIKE 'chat:%'").get() as { n: number }).n;
      // Empty org folder: twice, with an allowance of ONE turn a day: neither counts, neither asks the model.
      for (const id of ["req-nofiles-01", "req-nofiles-02"]) expect(await turn(id)).toMatchObject({ state: "failed", stopReason: "chat_no_files", requests: 0, costUsd: 0 });
      expect(calls).toBe(0);
      expect(effects()).toBe(0);
      expect((await api("conversation/list", {})).result.allowance).toMatchObject({ used: 0, limit: 1, remaining: 1 });
      expect((w.org.sqlite.db.prepare("SELECT state, stop_reason FROM chat_turns ORDER BY started_at").all())).toEqual([
        { state: "failed", stop_reason: "chat_no_files" }, { state: "failed", stop_reason: "chat_no_files" }]);
      // A file is connected: the next turn asks the model, settles one ledger entry and counts.
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, "members/notes/2026-10-08.v1.md"), "# October\nBlock Party drew over 300 neighbors.\n");
      expect(await turn("req-files-0001")).toMatchObject({ state: "done", requests: 1 });
      expect(calls).toBe(1);
      expect(effects()).toBe(1);
      expect((await api("conversation/list", {})).result.allowance).toMatchObject({ used: 1, remaining: 0 });
    } finally { await w.close(); }
  });
});
