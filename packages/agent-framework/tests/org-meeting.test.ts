// Lean runtime step 4, stage C: the meeting cycle on the org runtime. Email intake -> passkey adopt (org Task) ->
// exact plan approved by passkey -> one hosted (fake) run -> reviewers-private draft Report -> passkey-approved member
// notes as immutable versions in members/ -> member Q&A over members/ only. Two synthetic orgs; fake data.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { makeWorld } from "./org-fixture.js";
import { meetingKit } from "./org-meeting-kit.js";
import { notesDigest } from "../src/org/notes.js";
import { script } from "./org-meeting-script.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
export const MEETING = [
  "# EXNA Demo — October meeting (synthetic)",
  "Confirmed: neighborhood cleanup on Saturday Oct 31.",
  "Flyer says 10am; Robin's note says 9am. Needs confirmation.",
  "Sam might be able to help with supplies (tentative offer).",
  "Idea: spend $200 on supplies (not approved).",
  "REVIEWERS-ONLY speaker note: SENTINEL-RP-SPEAKER-4f2a Pat was upset about the budget.",
].join("\n");
export const MEMBER_NOTES = ["# October meeting — member notes", "The neighborhood cleanup is on Saturday Oct 31.", "The start time is being confirmed (flyer and notes differ).", "Volunteers welcome."].join("\n") + "\n";
describe.skipIf(!enabled)("org meeting cycle (step 4 stage C)", () => {
  it("intake -> adopt -> plan -> hosted draft -> reviewed member notes -> member Q&A", async () => {
    const w = await makeWorld(["org-a", "org-b"], meetingKit(script));
    try {
      const A = w.orgs["org-a"] as any;
      await w.bootstrap(A);
      const robin = await w.invite(A, "robin@a.test", "reviewer"), alex = await w.invite(A, "alex@a.test", "contributor");
      const addr = w.issueAddress(w.orgs["org-a"], alex);
      expect((await w.deliver(A, { to: [addr], subject: "October meeting", text: MEETING }, { id: "msg_oct_meeting_01" })).status).toBe(200);
      const intakeId = (A.sqlite.db.prepare("SELECT intake_id FROM intake_records WHERE state='accepted'").get() as { intake_id: string }).intake_id;

      // Adopt: reviewers only, by passkey; a contributor cannot.
      expect((await w.act(A, alex, "task.adopt", { intakeId, title: "October meeting notes" })).body.error).toBe("access_role_not_permitted");
      const adopted = await w.act(A, robin, "task.adopt", { intakeId, title: "October meeting notes" });
      expect(adopted.body).toMatchObject({ ok: true, result: { result: { disposition: "ACCEPTED" } } });
      const taskId = adopted.body.result.documentId as string;
      const task = (await A.rt.authority.backend.read(taskId, "kilgore/task")).document.state.global as any;
      expect(task).toMatchObject({ title: "October meeting notes", sourceRef: `intake:${intakeId}`, createdBy: expect.stringContaining(robin.memberId) });

      // Plan (system-prepared), approved by the reviewer's passkey with the plan hash pinned; one hosted run -> Report.
      const snap = await A.kit.snapshot({ instanceId: A.preparer, scope: { kind: "folder", rootId: "rp", relativeDirectory: "intake" } });
      const op = randomUUID(), expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const roster = await A.rt.authority.taskDelegationAgents(taskId, { operationId: op, expiresAt, instanceId: A.preparer, source: snap.source });
      const ag = roster.agents.find((x: any) => x.id === A.preparer);
      expect(ag).toMatchObject({ available: true });
      const p = (await A.api.create({ operationId: op, draft: { operationId: op, taskId, revision: roster.task.revision, agentId: A.preparer, recipient: ag.recipient, grantPlan: ag.grantPlan,
        sourceHash: roster.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: "Draft meeting notes from the submitted material only." } }))!;
      const last = p.versions.at(-1)!;
      const approve = await w.act(A, robin, "proposal.approve", { proposalId: p.proposalId, expectedRevision: p.revision, version: last.version, planHash: last.planHash }, last.planHash, randomUUID());
      expect(approve.body.ok, JSON.stringify(approve.body)).toBe(true);
      const dispatchId = approve.body.result.dispatchId;
      await A.exec.run(dispatchId); await A.exec.drain();
      expect((await A.exec.status(dispatchId))?.status).toBe("REPORT_PUBLISHED");
      const publicationId = [...A.reg.pubs.keys()][0];
      expect((await w.http("/o/org-a/api/draft/read", { publicationId }, robin.cookie)).body.result.markdown).toContain("QUESTION: start time");
      expect((await w.http("/o/org-a/api/draft/read", { publicationId }, alex.cookie)).body.error).toBe("access_role_not_permitted");

      // Member notes: a separate reviewer-approved rendition, immutable versions only.
      const reportId = A.reg.pubs.get(publicationId).documentId;
      const v1 = await w.act(A, robin, "notes.approve", { meeting: "2026-10-08", reportId, markdown: MEMBER_NOTES }, notesDigest(MEMBER_NOTES));
      expect(v1.body.result).toMatchObject({ path: "notes/2026-10-08.v1.md", version: 1 });
      expect((await w.act(A, robin, "notes.approve", { meeting: "2026-10-08", reportId, markdown: MEMBER_NOTES }, notesDigest("tampered"))).body.error).toBeTruthy();
      const v2 = await w.act(A, robin, "notes.approve", { meeting: "2026-10-08", reportId, markdown: MEMBER_NOTES + "Bring gloves.\n" }, notesDigest(MEMBER_NOTES + "Bring gloves.\n"));
      expect(v2.body.result.version).toBe(2);
      expect(readFileSync(join(A.folder, "members", "notes", "2026-10-08.v1.md"), "utf8")).toBe(MEMBER_NOTES);
      expect(readdirSync(join(A.folder, "members", "notes")).sort()).toEqual(["2026-10-08.v1.md", "2026-10-08.v2.md"]);

      // Member Q&A over members/ only (web): a cited answer; nothing from reviewers-private.
      const ans = await w.http("/o/org-a/api/agent/ask", { question: "When is the cleanup?" }, alex.cookie);
      expect(ans.body.result).toMatchObject({ status: "ANSWERED", citations: [{ path: "2026-10-08.v1.md", startLine: 2, valid: true }] });
      expect(JSON.stringify(ans.body)).not.toMatch(/SENTINEL-RP|reviewers-private|intake_/);
    } finally { await w.close(); }
  }, 300_000);
});
