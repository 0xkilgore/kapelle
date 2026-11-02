// TEAM-TASKS-V1 T2b (Fable F-1, T1 N-1): "Make this a task" adopts ONLY the member's typed text and, after an exact runtime
// disclosure (sizes, hashes, audience), picked text uploads of their own; the bytes are COPIED into the task store and frozen
// into every plan as task-uploads/<name>; a private chat row is never read later. Chat history, images, flyer proposals and
// draft artifacts are never adoptable. Plus the Ops render flags. Real org runtime + hub; fake executor; synthetic data.
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import { render } from "../deploy/kapelle-admin.js";
import { orgRuntimeConfigSchema } from "../src/org/org-runtime.js";
import type { TeamTaskRun } from "../src/org/teamtasks/store.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;

it("render --team-tasks on [--team-tasks-run on]: needs chat; run off unless 'on'", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ktt-render-")));
  const base = { org: "exna", label: "Example Park", domain: "agent.example.org", monthlyUsd: 15, root, intake: "none" as const };
  const cfg = (o: any) => orgRuntimeConfigSchema.parse(JSON.parse(readFileSync(render({ ...base, ...o }).orgConfig, "utf8")));
  expect(cfg({ chat: { enable: "on" } }).teamTasks).toBeUndefined();
  expect(cfg({ chat: { enable: "on" }, teamTasks: { enable: "on" } }).teamTasks).toEqual({ run: "off" });
  expect(cfg({ chat: { enable: "on" }, teamTasks: { enable: "on", run: "on" } }).teamTasks).toEqual({ run: "on" });
  expect(() => render({ ...base, teamTasks: { enable: "on" } })).toThrow("render_team_tasks_need_chat");
  expect(() => render({ ...base, chat: { enable: "on" }, teamTasks: { enable: "yes" } })).toThrow("render_team_tasks_enable_required");
  expect(() => render({ ...base, chat: { enable: "on" }, teamTasks: { enable: "on", run: "maybe" } })).toThrow("render_team_tasks_run_invalid");
});

describe.skipIf(!enabled)("Make this a task: the disclosure and the copy (T2b)", () => {
  it("disclose -> exact copy (sizes, hashes, audience) -> create bound to that digest; uploads copied, frozen into the plan; nothing else adoptable", async () => {
    const seen: { path: string; text: string }[][] = [];
    const w = await transcriptionWorld({ chat: {}, teamTasks: true, teamTaskExecutor: { id: "fake-v1", async run(r: TeamTaskRun) { seen.push(r.sources()); r.writeResult("draft"); } } });
    try {
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, "members", "notes", "2026-10-08.md"), "# Notes\nThe cleanup is on Oct 31.\n");
      const api = (p: string, b: unknown, c = w.alex) => w.post(`/o/exna/api/${p}`, b, c);
      const conv = (await api("chat/conversation/create", {})).result.conversationId;
      const up = (await api("chat/upload", { conversationId: conv, fileName: "sponsors.md", text: "# Sponsors\nMW Real Estate: Sapling.\n" })).result;
      const conv2 = (await api("chat/conversation/create", {}, w.robin)).result.conversationId;
      const robinUp = (await api("chat/upload", { conversationId: conv2, fileName: "private.md", text: "# Robin only\n" }, w.robin)).result;
      const body = { clientRequestId: "req-adopt0001", title: "Thank the sponsors", notes: "Short note for the newsletter.", uploads: [up.uploadId] };
      const d = (await api("teamtask/disclose", body)).result;
      expect(d.disclosure).toEqual({ contract: "kapelle.teamtask-disclosure/v1", audience: "members", visibleTo: "all members",
        title: { text: "Thank the sponsors", bytes: 18, sha256: expect.stringMatching(/^sha256:/) }, notes: { text: "Short note for the newsletter.", bytes: 30, sha256: expect.stringMatching(/^sha256:/) },
        uploads: [{ uploadId: up.uploadId, name: "sponsors.md", bytes: 36, sha256: up.sha256 }] });
      // Bound to the exact disclosure: no digest, or a digest for other content, creates nothing.
      expect((await api("teamtask/create", body)).error).toBe("teamtask_adoption_refused");
      expect((await api("teamtask/create", { ...body, title: "Changed", disclosureDigest: d.disclosureDigest })).error).toBe("teamtask_adoption_refused");
      // Not adoptable: another member's upload, more than 5, a chat image / flyer / conversation / artifact key.
      expect((await api("teamtask/disclose", { ...body, uploads: [robinUp.uploadId] })).error).toBe("teamtask_adoption_refused");
      expect((await api("teamtask/disclose", { ...body, uploads: Array(6).fill(0).map(() => "up_" + randomUUID().replaceAll("-", "")) })).error).toBe("teamtask_adoption_refused");
      for (const k of ["imageId", "flyerProposalId", "conversationId", "artifactId", "messages"]) expect((await api("teamtask/disclose", { ...body, [k]: "x" })).error).toBe("teamtask_adoption_refused");
      const t = (await api("teamtask/create", { ...body, disclosureDigest: d.disclosureDigest })).result;
      expect(t).toMatchObject({ title: "Thank the sponsors", inputs: [{ name: "sponsors.md", bytes: 36, sha256: up.sha256 }] });
      // The copy is the task's own: changing the chat file later does not change the task.
      writeFileSync(join(w.cfg.folder, up.path), "# Sponsors\nEDITED\n");
      const p = (await api("teamtask/propose", { taskId: t.taskId, expectedRevision: 1 })).result;
      expect(p.plan.sources.files).toBe(2);
      expect((await w.act(w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest)).ok).toBe(true);
      await w.org.teamTasks!.idle();
      expect(seen[0].map((f) => f.path)).toEqual(["members/notes/2026-10-08.md", "task-uploads/sponsors.md"]);
      expect(seen[0][1].text).toBe("# Sponsors\nMW Real Estate: Sapling.\n");
      // Without uploads, typed text alone needs no digest (nothing beyond what was typed is shared).
      expect((await api("teamtask/create", { clientRequestId: "req-adopt0002", title: "Plain task" })).ok).toBe(true);
      // The event records the disclosure (names, sizes, hashes), never the bytes.
      const ev = w.org.sqlite.db.prepare("SELECT detail FROM teamtask_events WHERE task_id=? AND event='created'").get(t.taskId) as { detail: string };
      expect(JSON.parse(ev.detail)).toEqual({ disclosureDigest: d.disclosureDigest, uploads: [{ name: "sponsors.md", bytes: 36, sha256: up.sha256 }] });
    } finally { await w.close(); }
  });
});
