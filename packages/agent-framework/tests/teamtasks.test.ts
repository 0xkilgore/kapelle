// TEAM-TASKS-V1 T1 (design of record 9320d2e5; Fable F-1/F-2, N-1..N-6): exact-plan approval, the claim, the verified result
// and the human completion, in the org's own SQLite store. A FAKE executor only (T2 brings the shared bounded runner); no
// provider call. Includes the lifted Mac kit vectors (b2efd132, 3de91335): planned grants confer nothing until approval and
// claim; live pins must match before dispatch; a consumed approval is never reused; uncertain history blocks new work.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import { failureLabel, persistedReason, REASON_PATTERN } from "../src/task-delegation/failure-labels.js";
import { TEAMTASK_REASONS } from "../src/org/teamtasks/labels.js";
import { teamTaskGrantPlan, teamTaskRecommendation, grantPlanValid, pinOf, approvedPin, planDigest, type Pins, type Plan } from "../src/org/teamtasks/contract.js";
import { TeamTasks, TeamTaskEnd, type TeamTaskExecutor, type TeamTaskRun } from "../src/org/teamtasks/store.js";
import { ACCESS_ACTIONS, audienceOf, stepUpOf } from "../src/access/org-access.js";
import { SqliteAuthority, openSqliteDatabase } from "../src/service/sqlite-authority.js";
import { digest } from "../src/content.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const A = "tta_" + "a".repeat(32), H = "sha256:" + "1".repeat(64), EXP = "2026-10-23T00:00:00.000Z";
const PINS: Pins = { agentId: "org-agent:exna", profileId: "or-sonnet", profileHash: H, toolCatalogHash: H, accessTableHash: H, executor: "fake-v1" };

it("labels: the teamtask_* vocabulary persists verbatim (never 'unlabeled') and never reuses the Mac task_* names (F-2, N-3)", () => {
  for (const l of TEAMTASK_REASONS) {
    expect(failureLabel(new Error(l)), l).toBe(l); expect(persistedReason(failureLabel(new Error(l))), l).toBe(l); expect(REASON_PATTERN.test(l)).toBe(true);
    expect(l.startsWith("teamtask_")).toBe(true);
  }
  for (const l of ["teamtask_audience_not_permitted", "teamtask_adoption_refused", "teamtask_result_unverified", "teamtask_outcome_uncertain"]) expect(TEAMTASK_REASONS).toContain(l);
  expect(["teamtask.create", "teamtask.propose", "teamtask.read", "teamtask.list"].map((a) => [audienceOf(a), stepUpOf(a)])).toEqual(Array(4).fill(["routine", "session"]));
  expect(["teamtask.approve", "teamtask.cancel", "teamtask.complete"].map((a) => [audienceOf(a), stepUpOf(a)])).toEqual(Array(3).fill(["consequential", "session-fresh"]));
  expect([...ACCESS_ACTIONS.routine, ...ACCESS_ACTIONS.consequential].filter((a) => a.startsWith("task."))).toEqual(["task.adopt"]); // the intake action keeps its meaning
});

it("contract: the prepare-only plan text (e93d7aec lifted); a deterministic grant plan (b2efd132 parity) and the pin", () => {
  const r = teamTaskRecommendation({ title: "Draft next month's newsletter", notes: "From the approved notes." });
  expect(r.instructions.split("\n")).toEqual(["Draft next month's newsletter.", "Notes from the team: From the approved notes.",
    "Use only the supplied source contents and the saved task context. Do not browse, fetch linked contents, contact anyone, or submit anything.",
    "Prepare it as a draft for the team to review: never send, publish, schedule or deploy anything, and never say it was sent.",
    'Cite the source for each fact and list anything the sources do not state under "Unknown or not stated". Return it as this task\'s result. Do not complete the task.']);
  const g = teamTaskGrantPlan({ attemptId: A, agentId: PINS.agentId, manifestHash: H, expiresAt: EXP });
  expect(g).toEqual(teamTaskGrantPlan({ attemptId: A, agentId: PINS.agentId, manifestHash: H, expiresAt: EXP })); // a retry names the same grants
  expect(g.grants.map((x) => [x.id, x.resourceRef, x.actions[0], x.expiresAt])).toEqual([[`teamtask:${A}:read`, `teamtask-sources:${H}`, "read", EXP],
    [`teamtask:${A}:result`, `teamtask-result:${A}`, "write_result", EXP]]);
  const plan = { attemptId: A, pins: PINS, sources: { manifestHash: H }, expiresAt: EXP, grantPlan: g } as unknown as Plan;
  expect(grantPlanValid(plan)).toBe(true);
  // A grant plan for another attempt, agent, source set or expiry is refused (b2efd132: another instance/Task/permission, expired).
  for (const other of [{ attemptId: "tta_" + "b".repeat(32) }, { agentId: "org-agent:other" }, { manifestHash: "sha256:" + "2".repeat(64) }, { expiresAt: "2026-10-24T00:00:00.000Z" }])
    expect(grantPlanValid({ ...plan, grantPlan: teamTaskGrantPlan({ attemptId: A, agentId: PINS.agentId, manifestHash: H, expiresAt: EXP, ...other }) } as Plan)).toBe(false);
  // The pin over the planned grants equals the pin over exactly those grants materialized; any other grant set or pin differs.
  expect(approvedPin(plan)).toBe(pinOf(PINS, [...g.grants].reverse()));
  expect(approvedPin(plan)).not.toBe(pinOf(PINS, [g.grants[0]]));
  expect(approvedPin(plan)).not.toBe(pinOf({ ...PINS, executor: "fake-v2" }, g.grants));
});

/** A store over a real SQLite authority with a controllable clock (expiry vectors). */
function unitStore(o: { executor?: TeamTaskExecutor | null; now?: () => string } = {}) {
  const dir = realpathSync(mkdtempSync("/tmp/ktt-")); chmodSync(dir, 0o700);
  const folder = join(dir, "folder"); mkdirSync(join(folder, "members", "notes"), { recursive: true });
  writeFileSync(join(folder, "members", "notes", "2026-10-08.md"), "# Notes\nThe cleanup is on Oct 31.\n");
  const a = new SqliteAuthority(openSqliteDatabase(join(dir, "authority.sqlite"), { create: true }), { binding: "test", authorityId: randomUUID(), driveId: randomUUID(), installationId: randomUUID() }, { create: true });
  const roles: Record<string, string> = { kara: "contributor", sue: "reviewer" };
  let clock = Date.parse("2026-10-22T12:00:00.000Z");
  const t = new TeamTasks(a, { orgId: "exna", folder, stateRoot: join(dir, "state"), pins: () => PINS, budget: { requests: 6, toolCalls: 12, wallMs: 120_000, maxOutputTokens: 4096, usd: 1 },
    executor: o.executor === undefined ? { id: "fake-v1", async run(r) { r.writeResult("ok"); } } : o.executor, memberOf: (id) => roles[id] ? { role: roles[id] } : null },
    o.now ?? (() => new Date(clock).toISOString()));
  const z = (memberId: string, artifactDigest: string | null) => ({ operationId: randomUUID(), memberId, artifactDigest }) as never;
  return { t, a, folder, dir, z, advance: (ms: number) => { clock += ms; }, kara: { memberId: "kara", role: "contributor" }, sue: { memberId: "sue", role: "reviewer" } };
}

describe("unit: expiry and the claim transaction", () => {
  it("an expired plan cannot be approved; a plan that expires after approval is never claimed (no inference)", async () => {
    let ran = 0;
    const u = unitStore({ executor: { id: "fake-v1", async run(r) { ran++; r.writeResult("x"); } } });
    const task = u.t.create(u.kara, { clientRequestId: "req-00000001", title: "Agenda", notes: "" });
    const p = u.t.propose(u.kara, { taskId: task.taskId, expectedRevision: 1 });
    u.advance(25 * 3_600_000);
    expect(() => u.t.approve(u.z("sue", p.planDigest), u.sue, { attemptId: p.attemptId })).toThrow("teamtask_plan_expired");
    u.advance(-25 * 3_600_000);
    u.t.setPaused(true);
    const p2 = u.t.propose(u.kara, { taskId: task.taskId, expectedRevision: 1 });
    u.t.approve(u.z("sue", p2.planDigest), u.sue, { attemptId: p2.attemptId });
    u.advance(25 * 3_600_000);
    u.t.setPaused(false); await u.t.idle();
    expect(ran).toBe(0);
    expect(u.t.read(u.kara, { taskId: task.taskId }).attempts.at(-1)).toMatchObject({ state: "failed", label: "teamtask_plan_expired", approval: { consumed: false } });
  });

  it("a replayed approval (same operation id) is the same effect; the queue is bounded (10); a second result write is refused; the run has no effect port", async () => {
    let keys: string[] = [];
    const u = unitStore({ executor: { id: "fake-v1", async run(r) { keys = Object.keys(r).sort(); r.writeResult("one"); r.writeResult("two"); } } });
    u.t.setPaused(true);
    const ids: string[] = [];
    for (let i = 0; i < 11; i++) { const t = u.t.create(u.kara, { clientRequestId: `req-q${String(i).padStart(7, "0")}`, title: "Task " + i }); ids.push(t.taskId); }
    const p0 = u.t.propose(u.kara, { taskId: ids[0], expectedRevision: 1 }), z0 = u.z("sue", p0.planDigest);
    u.t.approve(z0, u.sue, { attemptId: p0.attemptId }); u.t.approve(z0, u.sue, { attemptId: p0.attemptId }); // double click / retried reply
    expect(u.a.read(() => u.a.db.prepare("SELECT COUNT(*) AS n FROM teamtask_approvals").get())).toEqual({ n: 1 });
    for (let i = 1; i < 10; i++) { const p = u.t.propose(u.kara, { taskId: ids[i], expectedRevision: 1 }); u.t.approve(u.z("sue", p.planDigest), u.sue, { attemptId: p.attemptId }); }
    const p10 = u.t.propose(u.kara, { taskId: ids[10], expectedRevision: 1 });
    expect(() => u.t.approve(u.z("sue", p10.planDigest), u.sue, { attemptId: p10.attemptId })).toThrow("teamtask_queue_full");
    u.t.setPaused(false); await u.t.idle();
    // no send, publish or website port exists; "context" (AGENT-HANDBOOK-V1 H1) only READS the plan's approved handbook and map
    expect(keys).toEqual(["attemptId", "authorization", "context", "grants", "plan", "signal", "sources", "stillAuthorized", "taskId", "writeResult"]);
    expect(u.t.read(u.kara, { taskId: ids[0] }).attempts[0]).toMatchObject({ state: "failed", label: "teamtask_tool_not_admitted" });
    expect(() => u.t.claim(p0.attemptId)).not.toThrow(); expect(u.t.claim(p0.attemptId)).toBeNull(); // consumed: never claimed again
  });
});

describe.skipIf(!enabled)("team tasks in the org runtime (T1)", () => {
  async function setup(run: (r: TeamTaskRun) => Promise<void>) {
    const executor = { id: "fake-v1", calls: 0, async run(r: TeamTaskRun) { this.calls++; return run(r); } };
    const w = await transcriptionWorld({ chat: {}, teamTasks: true, teamTaskExecutor: executor });
    mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
    writeFileSync(join(w.cfg.folder, "members", "notes", "2026-10-08.md"), "# Notes\nThe cleanup is on Oct 31.\n");
    const api = (p: string, b: unknown, c = w.alex) => w.post(`/o/exna/api/${p}`, b, c);
    const tt = () => w.org.teamTasks!;
    const create = async (c = w.alex, extra: Record<string, unknown> = {}) => (await api("teamtask/create", { clientRequestId: "req-" + randomUUID().slice(0, 8), title: "Draft next month's newsletter", notes: "From the approved notes.", ...extra }, c)).result;
    const propose = async (taskId: string, revision = 1, c = w.alex) => (await api("teamtask/propose", { taskId, expectedRevision: revision }, c));
    const read = async (taskId: string, c = w.alex) => (await api("teamtask/read", { taskId }, c));
    const settle = () => tt().idle();
    const events = (taskId: string) => w.org.sqlite.db.prepare("SELECT event, label, detail FROM teamtask_events WHERE task_id=? ORDER BY seq").all(taskId) as { event: string; label: string | null; detail: string | null }[];
    return { w, api, tt, create, propose, read, settle, events, executor, close: () => w.close() };
  }

  it("journey: create (deduplicated, typed text only) -> exact plan -> reviewer approves -> claim -> verified result -> creator marks done; receipts to admins", async () => {
    let seen: { grants: string[]; sources: string[] } | null = null;
    const s = await setup(async (r) => { seen = { grants: r.grants, sources: r.sources().map((x) => x.path + ":" + x.text.length) }; r.writeResult("# Newsletter draft\nThe cleanup is on Oct 31 [members/notes/2026-10-08.md#L2].\n"); });
    try {
      expect((await s.api("member/me", {})).result.teamTasks).toBe(true);
      const crid = "req-dedup001";
      const t1 = (await s.api("teamtask/create", { clientRequestId: crid, title: "Draft next month's newsletter", notes: "From the approved notes." })).result;
      const t2 = (await s.api("teamtask/create", { clientRequestId: crid, title: "something else" })).result;
      expect(t2.taskId).toBe(t1.taskId); // the duplicate command returns the original
      expect(t1).toMatchObject({ contract: "kapelle.team-task/v1", revision: 1, state: "open", audience: "members", attempts: [] });
      // F-1: nothing but typed text is adoptable in v1.
      for (const extra of [{ imageId: "img_" + "0".repeat(32) }, { flyerProposalId: "ip_x" }, { conversationId: "conv_x" }, { uploads: ["up_" + "0".repeat(32)] /* T2b: only own uploads, after a disclosure */ }, { artifactId: "a" }])
        expect((await s.api("teamtask/create", { clientRequestId: "req-adopt" + Object.keys(extra)[0].slice(0, 4), title: "x", ...extra })).error).toBe("teamtask_adoption_refused");
      expect((await s.api("teamtask/create", { clientRequestId: "req-private1", title: "x", audience: "reviewers-private" })).error).toBe("teamtask_scope_not_permitted");
      // The plan: prepare-only from the task's own text, frozen sources, live pins, budget, grant plan, expiry.
      const p = (await s.propose(t1.taskId)).result;
      expect(p.plan).toMatchObject({ contract: "kapelle.teamtask-plan/v1", taskRevision: 1, version: 1, output: { kind: "text" }, sources: { files: 1 },
        pins: { agentId: "org-agent:exna", executor: "fake-v1" }, budget: { requests: expect.any(Number), usd: expect.any(Number) } });
      expect(p.plan.instructions).toMatch(/^Draft next month's newsletter\.\nNotes from the team: From the approved notes\.\n/);
      expect(p.planDigest).toBe(planDigest(p.plan));
      expect(s.tt().grantsOf(p.attemptId)).toEqual([]); // planned grants confer nothing before approval
      // Sources are frozen: an org file changed after the plan does not change what the run reads.
      writeFileSync(join(s.w.cfg.folder, "members", "notes", "2026-10-08.md"), "# Notes\nEDITED LATER, much longer text here.\n");
      // Approval: reviewers/admins only, exactly this digest.
      expect((await s.w.act(s.w.alex, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest)).error).toBe("access_role_not_permitted");
      expect((await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, "sha256:" + "0".repeat(64))).error).toBe("teamtask_plan_changed");
      const ok = await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      expect(ok).toMatchObject({ ok: true, authorization: { action: "teamtask.approve", artifactDigest: p.planDigest } });
      await s.settle();
      expect(seen).toEqual({ grants: [`teamtask:${p.attemptId}:read`, `teamtask:${p.attemptId}:result`], sources: ["members/notes/2026-10-08.md:34"] });
      const v = (await s.read(t1.taskId)).result;
      expect(v.attempts).toEqual([expect.objectContaining({ dispatch: p.attemptId, state: "result_ready", label: null, approval: expect.objectContaining({ consumed: true }),
        report: expect.objectContaining({ kind: "text", contentVersion: 1, producer: "org-agent:exna/fake-v1", resultDigest: expect.stringMatching(/^sha256:/) }) })]);
      const rep = v.attempts[0].report;
      expect((await s.api("teamtask/read", { taskId: t1.taskId, resultId: rep.resultId })).result.text).toContain("The cleanup is on Oct 31");
      // A second approval of the same (consumed) attempt is refused.
      expect((await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest)).error).toBe("teamtask_claim_consumed");
      // Done: a human, binding the displayed result digest and the task revision; the agent never sets it.
      expect((await s.w.act(s.w.alex, "teamtask.complete", { taskId: t1.taskId, expectedRevision: 1 }, "sha256:" + "0".repeat(64))).error).toBe("teamtask_plan_changed");
      const done = await s.w.act(s.w.alex, "teamtask.complete", { taskId: t1.taskId, expectedRevision: 1 }, rep.resultDigest);
      expect(done.ok).toBe(true);
      expect((await s.read(t1.taskId)).result).toMatchObject({ state: "done", revision: 2, done: { resultDigest: rep.resultDigest } });
      expect((await s.propose(t1.taskId, 2)).error).toBe("teamtask_closed");
      // N-1: fixed-template receipts for approve and complete go to the actor and every admin.
      for (let i = 0; i < 50 && s.w.mail.filter((m: any) => m.kind === "receipt" && /^teamtask\./.test(m.receipt?.action)).length < 4; i++) await new Promise((x) => setTimeout(x, 20));
      const receipts = s.w.mail.filter((m: any) => m.kind === "receipt" && /^teamtask\./.test(m.receipt?.action)).map((m: any) => `${m.receipt.action}>${m.to}`).sort();
      expect(receipts).toEqual(["teamtask.approve>admin@exna.test", "teamtask.approve>robin@exna.test", "teamtask.complete>admin@exna.test", "teamtask.complete>alex@exna.test"]);
      expect(s.executor.calls).toBe(1);
    } finally { await s.close(); }
  });

  it("audience: a reviewers-private task is invisible to contributors (same refusal as unknown); list filters", async () => {
    const s = await setup(async (r) => r.writeResult("x"));
    try {
      const priv = await s.create(s.w.robin, { audience: "reviewers-private" }), pub = await s.create(s.w.alex);
      expect((await s.read(priv.taskId)).error).toBe("teamtask_audience_not_permitted");
      expect((await s.read("tt_" + "0".repeat(32))).error).toBe("teamtask_audience_not_permitted");
      expect((await s.propose(priv.taskId)).error).toBe("teamtask_audience_not_permitted");
      expect((await s.api("teamtask/list", {})).result.tasks.map((t: any) => t.taskId)).toEqual([pub.taskId]);
      expect((await s.api("teamtask/list", {}, s.w.robin)).result.tasks.map((t: any) => t.taskId).sort()).toEqual([priv.taskId, pub.taskId].sort());
    } finally { await s.close(); }
  });

  it("parity: live pins must match before dispatch; a revoked approver's approval never runs; competing reviewers: the first wins", async () => {
    const s = await setup(async (r) => r.writeResult("x"));
    try {
      await s.w.ops("/ops/teamtasks/pause", { on: true });
      const t = await s.create(), p = (await s.propose(t.taskId)).result;
      const first = await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      expect(first.ok).toBe(true);
      expect((await s.w.act(s.w.admin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest)).error).toBe("teamtask_claim_consumed");
      s.executor.id = "fake-v2"; // the runtime's executor pin changed after approval
      await s.w.ops("/ops/teamtasks/pause", { on: false }); await s.settle();
      expect((await s.read(t.taskId)).result.attempts[0]).toMatchObject({ state: "failed", label: "teamtask_plan_changed", approval: { consumed: false } });
      expect(s.executor.calls).toBe(0);
      expect(s.tt().grantsOf(p.attemptId)).toEqual([]); // nothing materialized
      // Revocation before claim: the approver is no longer a reviewer.
      s.executor.id = "fake-v1";
      await s.w.ops("/ops/teamtasks/pause", { on: true });
      const p2 = (await s.propose(t.taskId)).result;
      expect((await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p2.attemptId }, p2.planDigest)).ok).toBe(true);
      await s.w.ops("/ops/member/role", { email: "robin@exna.test", role: "contributor" });
      await s.w.ops("/ops/teamtasks/pause", { on: false }); await s.settle();
      expect((await s.read(t.taskId)).result.attempts.at(-1)).toMatchObject({ state: "failed", label: "teamtask_scope_not_permitted" });
      expect(s.executor.calls).toBe(0);
      // A changed task text (new revision) or a newer plan makes an older plan unapprovable.
      const p3 = (await s.propose(t.taskId)).result, p4 = (await s.propose(t.taskId)).result;
      expect((await s.w.act(s.w.admin, "teamtask.approve", { attemptId: p3.attemptId }, p3.planDigest)).error).toBe("teamtask_plan_changed"); // superseded
      expect((await s.w.act(s.w.admin, "teamtask.approve", { attemptId: p4.attemptId }, p4.planDigest)).ok).toBe(true);
      await s.settle();
      expect((await s.read(t.taskId)).result.attempts.at(-1)).toMatchObject({ state: "result_ready" });
      expect(s.executor.calls).toBe(1);
    } finally { await s.close(); }
  });

  it("parity: uncertain history blocks new work until Ops reconciles from durable evidence; an assertion alone never unlocks it", async () => {
    let mode = "uncertain";
    const s = await setup(async (r) => { if (mode === "uncertain") throw new TeamTaskEnd("hosted_transport_failed", "uncertain"); r.writeResult("x"); });
    try {
      const t = await s.create(), p = (await s.propose(t.taskId)).result;
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest); await s.settle();
      const a = (await s.read(t.taskId)).result.attempts[0];
      expect(a).toMatchObject({ state: "needs_reconciliation", label: "hosted_transport_failed" });
      expect((await s.propose(t.taskId)).error).toBe("teamtask_outcome_uncertain"); // 3de91335: incomplete history blocks new work
      // Ops reconcile: exact keys; the evidence must be the attempt's durable ledger rows (none sent/unsettled).
      expect((await s.w.ops("/ops/teamtasks/reconcile", { attemptId: p.attemptId, disposition: "definitive_failure" })).error).toBe("teamtask_input_invalid");
      expect((await s.w.ops("/ops/teamtasks/reconcile", { attemptId: p.attemptId, expectedRevision: a.revision, evidenceSha: "sha256:" + "0".repeat(64), disposition: "definitive_failure" })).error).toBe("teamtask_reconcile_refused");
      expect((await s.w.ops("/ops/teamtasks/reconcile", { attemptId: p.attemptId, expectedRevision: a.revision, evidenceSha: digest([]), disposition: "verified_result" })).error).toBe("teamtask_reconcile_refused"); // no result exists
      // A held (sent, unsettled) ledger row keeps the fence.
      s.w.org.sqlite.db.prepare("INSERT INTO effects(key, kind, profile_id, month, reserved_usd, state, at) VALUES (?, 'hosted-inference', 'or-sonnet', '2026-10', 0.1, 'unsettled', ?)").run(`teamtask:${p.attemptId}:1`, "2026-10-22T00:00:00Z");
      const held = s.w.org.sqlite.db.prepare("SELECT key, state, cost_usd FROM effects WHERE key LIKE ? ORDER BY key").all(`teamtask:${p.attemptId}:%`);
      expect((await s.w.ops("/ops/teamtasks/reconcile", { attemptId: p.attemptId, expectedRevision: a.revision, evidenceSha: digest(held), disposition: "definitive_failure" })).error).toBe("teamtask_reconcile_refused");
      s.w.org.sqlite.db.prepare("UPDATE effects SET state='released' WHERE key=?").run(`teamtask:${p.attemptId}:1`);
      const settled = s.w.org.sqlite.db.prepare("SELECT key, state, cost_usd FROM effects WHERE key LIKE ? ORDER BY key").all(`teamtask:${p.attemptId}:%`);
      expect((await s.w.ops("/ops/teamtasks/reconcile", { attemptId: p.attemptId, expectedRevision: a.revision, evidenceSha: digest(settled), disposition: "definitive_failure" })))
        .toMatchObject({ attemptId: p.attemptId, state: "failed" });
      mode = "ok";
      const p2 = (await s.propose(t.taskId)).result; // new work needs a NEW attempt and a NEW approval
      expect(p2.attemptId).not.toBe(p.attemptId);
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p2.attemptId }, p2.planDigest); await s.settle();
      expect((await s.read(t.taskId)).result.attempts.map((x: any) => x.state)).toEqual(["failed", "result_ready"]);
    } finally { await s.close(); }
  });

  it("N-4: a read-back mismatch records expected-vs-read (hash, length, producer, version) and holds the attempt; Ops reconcile re-verifies", async () => {
    let tamper: "content" | "delete" | null = "content";
    const s = await setup(async (r) => {
      r.writeResult("The real draft.");
      const f = join(s.w.cfg.stateRoot, "teamtasks", r.attemptId, "result-v1.json");
      if (tamper === "content") { const j = JSON.parse(readFileSync(f, "utf8")); writeFileSync(f, JSON.stringify({ ...j, content: "A different draft!!", producer: "someone-else" })); }
      if (tamper === "delete") rmSync(f);
    });
    try {
      const t = await s.create(), p = (await s.propose(t.taskId)).result;
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest); await s.settle();
      const a = (await s.read(t.taskId)).result.attempts[0];
      expect(a).toMatchObject({ state: "needs_reconciliation", label: "teamtask_result_unverified", report: null });
      expect(a.unverified.expected).toMatchObject({ sha256: expect.stringMatching(/^sha256:/), bytes: 15, producer: "org-agent:exna/fake-v1", contentVersion: 1 });
      expect(a.unverified.read).toMatchObject({ sha256: expect.stringMatching(/^sha256:/), bytes: 19, producer: "someone-else", contentVersion: 1 });
      expect(a.unverified.mismatched).toEqual(["sha256", "bytes", "producer", "binding"]);
      expect(JSON.stringify(a.unverified)).not.toContain("different draft"); // audience-safe fields only, never the bytes
      expect(s.events(t.taskId).filter((e) => e.event === "result_unverified")).toHaveLength(1);
      expect((await s.w.act(s.w.alex, "teamtask.complete", { taskId: t.taskId, expectedRevision: 1 }, "sha256:" + "0".repeat(64))).error).toBe("teamtask_result_unverified");
      // Ops: the tampered file still fails the normal verifier, so the fence stays.
      const f = join(s.w.cfg.stateRoot, "teamtasks", p.attemptId, "result-v1.json"), shaOf = (b: Buffer) => "sha256:" + createHash("sha256").update(b).digest("hex");
      expect((await s.w.ops("/ops/teamtasks/reconcile", { attemptId: p.attemptId, expectedRevision: a.revision, evidenceSha: shaOf(readFileSync(f)), disposition: "verified_result" })).error).toBe("teamtask_reconcile_refused");
      // Restored durable evidence verifies -> Result ready.
      const j = JSON.parse(readFileSync(f, "utf8")); writeFileSync(f, JSON.stringify({ ...j, content: "The real draft.", producer: "org-agent:exna/fake-v1" }));
      const rev = (await s.read(t.taskId)).result.attempts[0].revision;
      expect((await s.w.ops("/ops/teamtasks/reconcile", { attemptId: p.attemptId, expectedRevision: rev, evidenceSha: shaOf(readFileSync(f)), disposition: "verified_result" }))).toMatchObject({ attemptId: p.attemptId, state: "result_ready" });
      // A missing file reads as the explicit unavailable marker.
      tamper = "delete";
      const t2 = await s.create(), q = (await s.propose(t2.taskId)).result;
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: q.attemptId }, q.planDigest); await s.settle();
      expect((await s.read(t2.taskId)).result.attempts[0].unverified).toMatchObject({ read: "unavailable", mismatched: ["unavailable"] });
    } finally { await s.close(); }
  });

  it("crash: a claimed attempt is never re-run after a restart (Needs reconciliation); an approved-but-unclaimed one runs once", async () => {
    let block = true;
    const s = await setup(async (r) => { if (block) await new Promise((_, rej) => r.signal.addEventListener("abort", () => rej(new TeamTaskEnd("hosted_transport_failed", "uncertain")))); r.writeResult("x"); });
    try {
      const t = await s.create(), p = (await s.propose(t.taskId)).result;
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      for (let i = 0; i < 50 && (await s.read(t.taskId)).result.attempts[0].state !== "running"; i++) await new Promise((x) => setTimeout(x, 10));
      block = false;
      await s.w.restart(); await s.settle();
      expect((await s.read(t.taskId)).result.attempts[0]).toMatchObject({ state: "needs_reconciliation" });
      expect(s.executor.calls).toBe(1);
      // Approved while paused, then a restart: claimed and run exactly once.
      const t2 = await s.create();
      await s.w.ops("/ops/teamtasks/pause", { on: true });
      const q = (await s.propose(t2.taskId)).result;
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: q.attemptId }, q.planDigest);
      await s.w.restart(); await s.w.ops("/ops/teamtasks/pause", { on: false }); await s.w.org.teamTasks!.idle();
      expect((await s.read(t2.taskId)).result.attempts[0]).toMatchObject({ state: "result_ready" });
      expect(s.executor.calls).toBe(2);
    } finally { await s.close(); }
  });

  it("cancel: members cancel their own unstarted task; running work is stopped by a reviewer; the budget label persists", async () => {
    const s = await setup(async (r) => { if (r.plan.summary.startsWith("Budget")) throw new TeamTaskEnd("teamtask_budget_exhausted", "failed");
      await new Promise((_, rej) => r.signal.addEventListener("abort", () => rej(new TeamTaskEnd("teamtask_cancelled", "cancelled")))); });
    try {
      const mine = await s.create();
      expect((await s.w.act(s.w.robin, "teamtask.cancel", { taskId: mine.taskId, expectedRevision: 1 })).ok).toBe(true); // reviewers may
      const t = await s.create(), p = (await s.propose(t.taskId)).result;
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: p.attemptId }, p.planDigest);
      for (let i = 0; i < 50 && (await s.read(t.taskId)).result.attempts[0].state !== "running"; i++) await new Promise((x) => setTimeout(x, 10));
      expect((await s.w.act(s.w.alex, "teamtask.cancel", { taskId: t.taskId, expectedRevision: 1 })).error).toBe("teamtask_scope_not_permitted"); // running: reviewers only
      expect((await s.w.act(s.w.robin, "teamtask.cancel", { taskId: t.taskId, expectedRevision: 1 })).ok).toBe(true);
      await s.settle();
      expect((await s.read(t.taskId)).result).toMatchObject({ state: "cancelled", attempts: [{ state: "cancelled", label: "teamtask_cancelled" }] });
      const own = await s.create(s.w.alex, { title: "Budget check" });
      await s.propose(own.taskId);
      expect((await s.w.act(s.w.alex, "teamtask.cancel", { taskId: own.taskId, expectedRevision: 1 })).ok).toBe(true); // own, unstarted
      const b = await s.create(s.w.alex, { title: "Budget run" }), bp = (await s.propose(b.taskId)).result;
      await s.w.act(s.w.robin, "teamtask.approve", { attemptId: bp.attemptId }, bp.planDigest); await s.settle();
      expect((await s.read(b.taskId)).result.attempts[0]).toMatchObject({ state: "failed", label: "teamtask_budget_exhausted" });
    } finally { await s.close(); }
  });
});
