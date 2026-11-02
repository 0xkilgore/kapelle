// SCHEDULED-TASKS-V1 S1 (design 8cf4853f; Fable ACCEPT f8abcea2 and conditions C-1..C-8 of 33b98fd8): the §6 fixtures over a
// REAL SQLite authority and the REAL team-task store (create / propose / derived approval / claim / executor / verify), with a
// fake clock, a FAKE executor and a fake hosted ledger. No provider, no network, no spend. A "restart" is a new store +
// schedules over the same database file.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SqliteAuthority, openSqliteDatabase } from "../src/service/sqlite-authority.js";
import { TeamTasks, TeamTaskEnd, type TeamTaskExecutor } from "../src/org/teamtasks/store.js";
import { TeamTaskSchedules, derivePlan, selectSources, SCHEDULE_LIMITS, DEFAULT_SCHEDULE_TIME, SCHEDULE_TEMPLATES, SCHEDULE_COLLECTIONS, type SchedulePins } from "../src/org/teamtasks/schedules.js";
import { localToUtc, nextDue, runtimeTime } from "../src/org/teamtasks/schedule-time.js";
import { planDigest, planSchema, TEAMTASK_CEILING, type Pins } from "../src/org/teamtasks/contract.js";
import { TEAMTASK_REASONS } from "../src/org/teamtasks/labels.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";
import { ACCESS_ACTIONS, ACCESS_TABLE_HASH, STEP_UP, audienceOf, stepUpOf } from "../src/access/org-access.js";
import { canonical } from "../src/content.js";
import { createHash } from "node:crypto";

const H = (c: string) => "sha256:" + c.repeat(64);
const TASK_PINS: Pins = { agentId: "org-agent:exna", profileId: "or-sonnet", profileHash: H("1"), toolCatalogHash: H("2"), accessTableHash: H("3"), executor: "fake-v1" };
const BUDGET = { requests: 6, toolCalls: 12, wallMs: 480_000, maxOutputTokens: 16_384, usd: 1 };
type Mode = { kind: "ok" | "partial" | "fail" | "uncertain" | "hold"; cost?: number; steps?: number };

/** One org: folder with notes, authority, store + schedules, a fake clock / executor / ledger; `restart()` re-opens both. */
function world(o: { roles?: Record<string, string>; handbook?: string } = {}) {
  const dir = realpathSync(mkdtempSync("/tmp/ksch-")); chmodSync(dir, 0o700);
  const folder = join(dir, "folder"); mkdirSync(join(folder, "members", "notes"), { recursive: true });
  writeFileSync(join(folder, "members", "notes", "2026-10-08.md"), "# October\nThe cleanup is on Oct 31.\n");
  mkdirSync(join(folder, "reviewers-private", "intake"), { recursive: true });
  writeFileSync(join(folder, "reviewers-private", "intake", "secret.md"), "# Private\nNot for members.\n");
  const dbPath = join(dir, "authority.sqlite"), ident = { binding: "test", authorityId: randomUUID(), driveId: randomUUID(), installationId: randomUUID() };
  const roles: Record<string, string> = { kara: "contributor", sue: "reviewer", admin: "admin", ...(o.roles ?? {}) };
  const pins: SchedulePins = { rulesHash: H("7"), profileHash: TASK_PINS.profileHash, toolCatalogHash: TASK_PINS.toolCatalogHash, accessTableHash: TASK_PINS.accessTableHash };
  const config = { run: true, envelopeUsd: 20 as number | null };
  const ledger: { key: string; state: string; cost_usd: number | null }[] = [];
  const calls: { attemptId: string; budget: unknown; sources: { path: string; text: string }[] }[] = [];
  const state = { clock: Date.parse("2026-11-01T12:00:00.000Z"), chatBusy: false, mode: { kind: "ok" } as Mode, midHook: null as null | (() => void), release: null as null | (() => void) };
  const now = () => new Date(state.clock).toISOString();
  const executor: TeamTaskExecutor = { id: "fake-v1", async run(r) {
    calls.push({ attemptId: r.attemptId, budget: r.plan.budget, sources: r.sources() });
    const m = state.mode;
    for (let i = 0; i < (m.steps ?? 1); i++) {
      if (!r.stillAuthorized()) throw new TeamTaskEnd(r.authorization() ?? "teamtask_scope_not_permitted", "failed"); // the executor's own check, every step
      ledger.push({ key: `teamtask:${r.attemptId}:${i + 1}`, state: m.kind === "uncertain" ? "unsettled" : "settled", cost_usd: m.kind === "uncertain" ? null : m.cost ?? 0.95 });
      if (i === 0 && state.midHook) { const f = state.midHook; state.midHook = null; f(); }
      if (m.kind === "hold") await new Promise<void>((res) => { state.release = res; r.signal.addEventListener("abort", () => res(), { once: true }); });
      // Like the production executor: an abort ends it cancelled, or uncertain while a sent request is unsettled.
      if (r.signal.aborted) throw new TeamTaskEnd("teamtask_cancelled", ledger.some((x) => x.key.startsWith(`teamtask:${r.attemptId}:`) && x.state !== "settled") ? "uncertain" : "cancelled");
    }
    if (m.kind === "fail") throw new TeamTaskEnd("chat_cap_requests", "failed");
    if (m.kind === "uncertain") throw new TeamTaskEnd("hosted_transport_failed", "uncertain");
    r.writeResult("Draft from " + r.sources().map((f) => f.path).join(", "), m.kind === "partial" ? "chat_cap_requests" : undefined);
  } };
  const open = () => {
    const a = new SqliteAuthority(openSqliteDatabase(dbPath, { create: true }), ident, { create: true });
    let s: TeamTaskSchedules | null = null;
    const t = new TeamTasks(a, { orgId: "exna", folder, stateRoot: join(dir, "state"), pins: () => TASK_PINS, budget: BUDGET, executor,
      memberOf: (id) => roles[id] ? { role: roles[id] } : null, ledgerRows: (p) => ledger.filter((x) => x.key.startsWith(p)),
      scheduleGate: (id) => s?.gate(id) ?? null, onAttemptEnd: (id) => s?.onAttemptEnd(id),
      // AGENT-HANDBOOK-V1 H1: a fixed approved handbook (v1) when the world has one.
      ...(o.handbook ? { context: { handbook: () => ({ version: 1, content: o.handbook!, sha256: "sha256:" + createHash("sha256").update(o.handbook!).digest("hex") }),
        handbookVersion: (v: number) => v === 1 ? { version: 1, content: o.handbook!, sha256: "sha256:" + createHash("sha256").update(o.handbook!).digest("hex") } : null,
        features: () => ({ chat: true, teamTasks: true, schedules: true, website: false, newsletter: false, images: false, transcription: false }) } } : {}) }, now);
    s = new TeamTaskSchedules(a, { orgId: "exna", folder, store: t, pins: () => ({ ...pins }), ceiling: BUDGET, memberOf: (id) => roles[id] ? { role: roles[id] } : null,
      ledgerRows: (p) => ledger.filter((x) => x.key.startsWith(p)), config: () => ({ ...config }), busy: () => t.busy() || state.chatBusy }, now);
    return { a, t, s };
  };
  let cur = open();
  const z = (memberId: string, artifactDigest: string | null) => ({ operationId: randomUUID(), memberId, artifactDigest }) as never;
  const m = (id: string) => ({ memberId: id, role: roles[id] });
  const at = async (iso: string) => { state.clock = Date.parse(iso); const r = cur.s.tick(); await cur.t.idle(); return r; };
  const occ = () => cur.a.db.prepare("SELECT * FROM teamtask_schedule_occurrences ORDER BY due_at, kind").all() as Record<string, any>[];
  const sched = (id: string) => cur.a.db.prepare("SELECT * FROM teamtask_schedules WHERE schedule_id=? ORDER BY version DESC LIMIT 1").get(id) as Record<string, any>;
  const outbox = () => cur.a.db.prepare("SELECT occurrence_id, kind, audience, label FROM teamtask_schedule_outbox ORDER BY seq").all() as Record<string, any>[];
  /** Jordan proposes and approves a Monday 06:00 Chicago newsletter-notes schedule. */
  const monday = (extra: Record<string, unknown> = {}, approver = "sue") => {
    const v = cur.s.propose(m("sue"), { title: "Monday newsletter draft", template: { title: "Newsletter draft {{date}}", notes: "From notes new since {{since}}." },
      sources: { roots: ["members/notes"], rule: "new" }, recurrence: { weekday: 1, timezone: "America/Chicago" }, ...extra });
    cur.s.approve(z(approver, v.digest), m(approver), { scheduleId: v.scheduleId, version: v.version });
    return v;
  };
  return { dir, folder, roles, pins, config, ledger, calls, state, z, m, at, occ, sched, outbox, monday, get t() { return cur.t; }, get s() { return cur.s; }, get a() { return cur.a; },
    restart: () => { cur = open(); }, write: (rel: string, text: string) => { mkdirSync(join(folder, rel, ".."), { recursive: true }); writeFileSync(join(folder, rel), text); } };
}

describe("SCHEDULED-TASKS-V1 S1: contract, approval, labels, access gate", () => {
  it("labels: the seven teamtask_schedule_* persist verbatim (CODES) and the default time is off-peak", () => {
    const labels = ["teamtask_schedule_expired", "teamtask_schedule_pin_changed", "teamtask_schedule_source_refused", "teamtask_schedule_budget_exhausted",
      "teamtask_schedule_missed", "teamtask_schedule_no_new_sources", "teamtask_schedule_paused"];
    for (const l of labels) { expect(TEAMTASK_REASONS).toContain(l); expect(persistedReason(failureLabel(new Error(l)))).toBe(l); }
    expect(DEFAULT_SCHEDULE_TIME).toBe("06:00");
  });
  it("C-4: eight new actions in the right tiers change ACCESS_TABLE_HASH (the package carries the access gate)", () => {
    const routine = ["teamtask.schedule.propose", "teamtask.schedule.read", "teamtask.schedule.list", "teamtask.schedule.pause", "teamtask.schedule.pause.all"];
    const conseq = ["teamtask.schedule.approve", "teamtask.schedule.resume", "teamtask.schedule.run_now"];
    expect(routine.map((x) => [audienceOf(x), stepUpOf(x)])).toEqual(Array(5).fill(["routine", "session"]));
    expect(conseq.map((x) => [audienceOf(x), stepUpOf(x)])).toEqual(Array(3).fill(["consequential", "session-fresh"]));
    const all = new Set([...routine, ...conseq]);
    const without = { actions: { ...ACCESS_ACTIONS, routine: ACCESS_ACTIONS.routine.filter((x) => !all.has(x)), consequential: ACCESS_ACTIONS.consequential.filter((x) => !all.has(x)) },
      stepUp: { ...STEP_UP, session: STEP_UP.session.filter((x) => !all.has(x)), "session-fresh": STEP_UP["session-fresh"].filter((x) => !all.has(x)) } };
    expect("sha256:" + createHash("sha256").update(canonical(without)).digest("hex")).not.toBe(ACCESS_TABLE_HASH);
    // S2: a routine action is reached as POST /o/<org>/api/<action with "/" for ".">, and the hub's route is [a-z/-]+: no "_".
    for (const x of ACCESS_ACTIONS.routine) expect(x, x).toMatch(/^[a-z-]+(\.[a-z-]+)*$/);
  });
  it("approval binds the exact digest; an edited schedule refuses; preview shows the next 3 dates, off-peak and the UTC budget reset; 90-day horizon; no envelope = propose-only", () => {
    const w = world();
    const v = w.s.propose(w.m("kara"), { title: "Weekly notes summary", template: { title: "Summary {{date}}", notes: "" }, sources: { roots: ["members/notes"], rule: "new" }, recurrence: { weekday: 1 } });
    expect(v).toMatchObject({ state: "proposed", offPeak: true, chatWaitNote: null, budget: { monthlyUsd: 5, resetsUtc: true }, definition: { recurrence: { weekday: 1, time: "06:00", timezone: "America/Chicago" },
      runtime: runtimeTime(), budget: { perRunUsd: 1, monthlyUsd: 5 } } });
    expect(v.next.map((x: any) => x.localDate)).toEqual(["2026-11-02", "2026-11-09", "2026-11-16"]);
    expect(() => w.s.approve(w.z("kara", v.digest), w.m("kara"), { scheduleId: v.scheduleId, version: 1 })).toThrow("teamtask_scope_not_permitted"); // contributors propose only
    expect(() => w.s.approve(w.z("sue", "sha256:" + "0".repeat(64)), w.m("sue"), { scheduleId: v.scheduleId, version: 1 })).toThrow("teamtask_plan_changed");
    // An edit to the stored definition after review refuses the same digest.
    w.a.db.prepare("UPDATE teamtask_schedules SET definition=replace(definition,'Summary','Summary!') WHERE schedule_id=?").run(v.scheduleId);
    expect(() => w.s.approve(w.z("sue", v.digest), w.m("sue"), { scheduleId: v.scheduleId, version: 1 })).toThrow("teamtask_plan_changed");
    // 09:00 is flagged (chat may wait up to 8 minutes); more than 90 days refuses; no Ops envelope: recurring refuses, propose-only works.
    expect(w.s.propose(w.m("sue"), { title: "Peak", template: { title: "x {{date}}", notes: "" }, sources: { roots: ["members"], rule: "current" }, recurrence: { weekday: 5, time: "09:00" } }))
      .toMatchObject({ offPeak: false, chatWaitNote: "A run at this time can make a live chat answer wait up to 8 minutes." });
    expect(() => w.s.propose(w.m("sue"), { title: "Long", template: { title: "x", notes: "" }, sources: { roots: ["members"], rule: "current" }, recurrence: { weekday: 1 }, endDate: "2027-03-01" })).toThrow("teamtask_schedule_expired");
    expect(() => w.s.propose(w.m("sue"), { title: "Bad", template: { title: "x {{secret}}", notes: "" }, sources: { roots: ["members"], rule: "current" }, recurrence: { weekday: 1 } })).toThrow("teamtask_input_invalid");
    w.config.envelopeUsd = null;
    const r = w.s.propose(w.m("sue"), { title: "No envelope", template: { title: "x {{date}}", notes: "" }, sources: { roots: ["members"], rule: "current" }, recurrence: { weekday: 1 } });
    expect(() => w.s.approve(w.z("sue", r.digest), w.m("sue"), { scheduleId: r.scheduleId, version: 1 })).toThrow("teamtask_schedule_budget_exhausted");
    const p = w.s.propose(w.m("sue"), { title: "Propose each", template: { title: "x {{date}}", notes: "" }, sources: { roots: ["members"], rule: "current" }, recurrence: { weekday: 1 }, mode: "propose_each" });
    expect(w.s.approve(w.z("sue", p.digest), w.m("sue"), { scheduleId: p.scheduleId, version: 1 })).toMatchObject({ state: "active" });
  });
  it("C-8: a member-audience rule that reaches reviewers-private REFUSES (source_refused) at proposal and in the derivation; never filtered", () => {
    const w = world();
    expect(() => w.s.propose(w.m("sue"), { title: "Leak", template: { title: "x", notes: "" }, sources: { roots: ["members/notes", "reviewers-private/intake"], rule: "current" }, recurrence: { weekday: 1 } }))
      .toThrow("teamtask_schedule_source_refused");
    expect(() => selectSources({ audience: "members", sources: { roots: ["members/notes", "reviewers-private/intake"], rule: "current" } },
      [{ path: "members/notes/a.md", sha256: H("a") }, { path: "reviewers-private/intake/secret.md", sha256: H("b") }], {})).toThrow("teamtask_schedule_source_refused");
    expect(() => selectSources({ audience: "members", sources: { roots: ["members/uploads"], rule: "current" } }, [], {})).toThrow("teamtask_schedule_source_refused");
    expect(selectSources({ audience: "reviewers-private", sources: { roots: ["reviewers-private/intake"], rule: "current" } }, [{ path: "reviewers-private/intake/secret.md", sha256: H("b") }], {}).selected).toHaveLength(1);
  });
});

describe("SCHEDULED-TASKS-V1 S1: occurrences", () => {
  it("Monday run: ordinary task + plan + ONE derived approval, consumed once; derived/human parity (C-2); replay offline (C-1); coverage only after a full verified result", async () => {
    const w = world();
    const v = w.monday({ limits: { ...BUDGET, requests: 4, maxOutputTokens: 8192 } });
    expect(await w.at("2026-11-02T11:59:00.000Z")).toMatchObject({ materialized: 0 }); // 05:59 Chicago: not yet
    expect(await w.at("2026-11-02T12:00:00.000Z")).toMatchObject({ materialized: 1, admitted: 1 });
    const [o] = w.occ();
    expect(o).toMatchObject({ state: "result_ready", kind: "scheduled", local_date: "2026-11-02", due_at: "2026-11-02T12:00:00.000Z" });
    const task = w.t.read(w.m("sue"), { taskId: o.task_id });
    expect(task).toMatchObject({ title: "Newsletter draft 2026-11-02", notes: "From notes new since the start.", audience: "members" });
    expect(task.attempts).toHaveLength(1);
    expect(task.attempts[0]).toMatchObject({ state: "result_ready", approval: { approverId: "sue", consumed: true, kind: "schedule", occurrenceId: o.occurrence_id } });
    // C-2: the same plan schema and budget wiring; the schedule's lower limits reach the executor.
    const p = task.attempts[0];
    expect(w.calls[0].budget).toEqual({ ...BUDGET, requests: 4, maxOutputTokens: 8192 });
    expect(p.plan.budget).toEqual({ ...BUDGET, requests: 4, maxOutputTokens: 8192 });
    expect(() => w.s.propose(w.m("sue"), { title: "Over", template: { title: "x", notes: "" }, sources: { roots: ["members"], rule: "current" }, recurrence: { weekday: 1 },
      limits: { ...BUDGET, maxOutputTokens: TEAMTASK_CEILING.maxOutputTokens + 1 } })).toThrow("teamtask_input_invalid"); // never above the admitted ceiling
    // C-1: replay recomputes the identical digest from the stored inputs alone.
    const inputs = JSON.parse(o.inputs);
    expect(planDigest(derivePlan(inputs))).toBe(o.plan_digest);
    expect(w.s.replay(o.occurrence_id)).toMatchObject({ ok: true, planDigest: o.plan_digest, recomputed: o.plan_digest });
    expect(planSchema.parse(derivePlan(inputs)).pins).toEqual(TASK_PINS);
    // C-1: an edit to ANY stored input is refused against the schedule approval (and plan-bearing ones change the digest).
    const edits: Record<string, unknown> = { derivation: "kapelle.teamtask-schedule-derivation/v0", scheduleId: "tts_" + "1".repeat(32), version: 2, scheduleDigest: H("d"),
      occurrenceId: "tso_" + "1".repeat(32), localDate: "2026-11-09", substitutions: { ...inputs.substitutions, since: "2026-01-01" }, title: "Other", notes: "Other",
      orgId: "other", taskId: "tt_" + "1".repeat(32), attemptId: "tta_" + "1".repeat(32), expiresAt: "2026-11-02T13:00:00.000Z", audience: "reviewers-private",
      roots: [...inputs.roots, "members/other"], manifestHash: H("e"), files: inputs.files + 1, bytes: inputs.bytes + 1, budget: { ...inputs.budget, requests: 3 }, taskPins: { ...inputs.taskPins, profileHash: H("f") },
      context: { handbook: { version: 9, sha256: H("9") }, map: { id: "tta_" + "9".repeat(32), sha256: H("8"), bytes: 100 } } }; // H1 (C-3): the context is an input too
    expect(Object.keys(edits).sort()).toEqual(Object.keys(inputs).sort()); // every field is covered
    for (const [k, val] of Object.entries(edits)) {
      const save = o.inputs;
      w.a.db.prepare("UPDATE teamtask_schedule_occurrences SET inputs=? WHERE occurrence_id=?").run(canonical({ ...inputs, [k]: val }), o.occurrence_id);
      expect([k, w.s.replay(o.occurrence_id).ok]).toEqual([k, false]);
      w.a.db.prepare("UPDATE teamtask_schedule_occurrences SET inputs=? WHERE occurrence_id=?").run(save, o.occurrence_id);
    }
    expect(w.s.replay(o.occurrence_id).ok).toBe(true);
    // Coverage advanced (full verified result); a notification for the audience, once.
    expect(JSON.parse(w.sched(v.scheduleId).coverage)).toEqual({ "members/notes/2026-10-08.md": expect.stringMatching(/^sha256:/) });
    expect(w.outbox()).toEqual([{ occurrence_id: o.occurrence_id, kind: "result_ready", audience: "members", label: null }]);
    // The agent never marks Done: the task stays open until a person does.
    expect(task.state).toBe("open");
  });
  it("C-1: an edited input (or schedule) refuses at claim; propose-each plans wait for an ordinary approval and expire at the start deadline", async () => {
    const w = world();
    const v = w.monday({ mode: "propose_each" });
    await w.at("2026-11-02T12:00:00.000Z");
    const [o] = w.occ();
    expect(o.state).toBe("admitted");
    const task = w.t.read(w.m("sue"), { taskId: o.task_id }), att = task.attempts[0];
    expect(att.state).toBe("proposed");
    expect(Date.parse(att.plan.expiresAt)).toBeLessThanOrEqual(Date.parse(o.deadline_at)); // stale proposals never auto-run
    w.a.db.prepare("UPDATE teamtask_schedule_occurrences SET inputs=replace(inputs,'From notes','FROM notes') WHERE occurrence_id=?").run(o.occurrence_id);
    expect(w.s.replay(o.occurrence_id).ok).toBe(false);
    w.t.approve(w.z("sue", att.planDigest), w.m("sue"), { attemptId: att.attemptId }); await w.t.idle();
    expect(w.t.read(w.m("sue"), { taskId: o.task_id }).attempts[0]).toMatchObject({ state: "failed", label: "teamtask_plan_changed" });
    expect(w.calls).toHaveLength(0);
    expect(w.sched(v.scheduleId).coverage).toBe("{}");
  });
  it("no new notes: Skipped, zero model calls, no task; a changed note is new again; the watermark is path + sha256, not mtime", async () => {
    const w = world();
    w.monday();
    await w.at("2026-11-02T12:00:00.000Z");
    expect(w.calls).toHaveLength(1);
    expect(await w.at("2026-11-09T12:00:00.000Z")).toMatchObject({ skipped: 1, admitted: 0 });
    expect(w.occ().at(-1)).toMatchObject({ state: "skipped", label: "teamtask_schedule_no_new_sources", task_id: null });
    expect(w.calls).toHaveLength(1); // zero calls
    w.write("members/notes/2026-10-08.md", "# October\nThe cleanup MOVED to Nov 7.\n");
    w.write("members/notes/2026-11-12.md", "# November\nNew minutes.\n");
    await w.at("2026-11-16T12:00:00.000Z");
    expect(w.calls).toHaveLength(2);
    expect(w.calls[1].sources.map((f) => f.path).sort()).toEqual(["members/notes/2026-10-08.md", "members/notes/2026-11-12.md"]);
    const t = w.t.read(w.m("sue"), { taskId: w.occ().at(-1)!.task_id });
    expect(t.notes).toBe("From notes new since 2026-11-02.");
  });
  it("coverage is unchanged after a failed, partial or uncertain result; partial and uncertain pause the schedule; failure notifies reviewers", async () => {
    for (const kind of ["fail", "partial", "uncertain"] as const) {
      const w = world();
      const v = w.monday();
      w.state.mode = { kind };
      await w.at("2026-11-02T12:00:00.000Z");
      const o = w.occ()[0];
      expect(o.state).toBe(kind === "fail" ? "failed" : kind === "partial" ? "partial" : "uncertain");
      expect(w.sched(v.scheduleId).coverage).toBe("{}"); // the notes are not consumed
      expect(w.sched(v.scheduleId).state).toBe(kind === "fail" ? "active" : "paused");
      expect(w.outbox().map((x) => x.kind)).toEqual(kind === "fail" ? ["failure"] : ["incident"]);
      if (kind === "uncertain") expect(w.a.db.prepare("SELECT state FROM teamtask_schedule_budget").get()).toEqual({ state: "held" }); // unknown cost keeps its reserve
    }
  });
  it("source changed during the run: the run reads the frozen snapshot; a source set over the bounds refuses (never truncated)", async () => {
    const w = world();
    w.monday();
    w.state.mode = { kind: "hold" };
    const p = w.at("2026-11-02T12:00:00.000Z");
    for (let i = 0; i < 50 && !w.state.release; i++) await new Promise((r) => setTimeout(r, 10));
    w.write("members/notes/2026-10-08.md", "# CHANGED AFTER ADMISSION\n");
    w.state.release!(); await p; await w.t.idle();
    expect(w.calls[0].sources).toEqual([{ path: "members/notes/2026-10-08.md", text: "# October\nThe cleanup is on Oct 31.\n" }]);
    const x = world();
    x.monday();
    for (let i = 0; i < 1001; i++) x.write(`members/notes/many/n${i}.md`, "x\n");
    await x.at("2026-11-02T12:00:00.000Z");
    expect(x.occ()[0]).toMatchObject({ state: "skipped", label: "teamtask_schedule_source_refused" });
    expect(x.calls).toHaveLength(0);
  });
});

describe("SCHEDULED-TASKS-V1 S1: pins, sponsor, kill (C-3, C-5)", () => {
  it("C-3: each of the four pins flipped before admission pauses the schedule (pin_changed), with an admin incident; nothing runs", async () => {
    for (const k of ["rulesHash", "profileHash", "toolCatalogHash", "accessTableHash"] as const) {
      const w = world();
      const v = w.monday();
      w.pins[k] = H("9");
      await w.at("2026-11-02T12:00:00.000Z");
      expect([k, w.occ()[0].state, w.occ()[0].label, w.sched(v.scheduleId).state, w.sched(v.scheduleId).label]).toEqual([k, "skipped", "teamtask_schedule_pin_changed", "paused", "teamtask_schedule_pin_changed"]);
      expect(w.outbox()).toEqual([expect.objectContaining({ kind: "incident", audience: "admins", label: "teamtask_schedule_pin_changed" })]);
      expect(w.calls).toHaveLength(0);
    }
  });
  it("C-3: each pin flipped MID-RUN stops the run before its next provider/tool step (the gate inside authorization())", async () => {
    for (const k of ["rulesHash", "profileHash", "toolCatalogHash", "accessTableHash"] as const) {
      const w = world();
      const v = w.monday();
      w.state.mode = { kind: "ok", steps: 2 };
      w.state.midHook = () => { w.pins[k] = H("9"); };
      await w.at("2026-11-02T12:00:00.000Z");
      const o = w.occ()[0];
      expect([k, o.state, o.label]).toEqual([k, "failed", "teamtask_schedule_pin_changed"]);
      expect(w.ledger).toHaveLength(1); // the second request was never sent
      expect(w.sched(v.scheduleId).state).toBe("paused");
    }
  });
  it("sponsor removal stops automatic authority (before admission and mid-run)", async () => {
    const w = world();
    const v = w.monday();
    w.roles.sue = "contributor";
    await w.at("2026-11-02T12:00:00.000Z");
    expect([w.occ()[0].state, w.occ()[0].label, w.sched(v.scheduleId).state]).toEqual(["skipped", "teamtask_scope_not_permitted", "paused"]);
    const x = world();
    x.monday();
    x.state.mode = { kind: "ok", steps: 2 };
    x.state.midHook = () => { x.roles.sue = "contributor"; };
    await x.at("2026-11-02T12:00:00.000Z");
    expect(x.occ()[0]).toMatchObject({ state: "failed", label: "teamtask_scope_not_permitted" });
    expect(x.ledger).toHaveLength(1);
  });
  it("C-5: Ops' switch off = nothing starts (the deadline still applies); Pause all stops a running attempt (abort, F-1); one gate path", async () => {
    const w = world();
    w.monday();
    w.config.run = false;
    expect(await w.at("2026-11-02T12:00:00.000Z")).toMatchObject({ materialized: 1, waiting: 1 });
    expect(w.occ()[0].state).toBe("due");
    await w.at("2026-11-03T12:01:00.000Z"); // past due + 24 h
    expect(w.occ()[0]).toMatchObject({ state: "skipped", label: "teamtask_schedule_paused" }); // Fable N-1: the kill path reads "paused"
    expect(w.calls).toHaveLength(0);
    const x = world();
    x.monday();
    x.state.mode = { kind: "ok", steps: 2 };
    x.state.midHook = () => { x.s.pauseAll(x.m("sue")); };
    await x.at("2026-11-02T12:00:00.000Z");
    expect(x.occ()[0]).toMatchObject({ state: "cancelled", label: "teamtask_cancelled" }); // F-1: Pause all aborts the run itself
    expect(x.ledger).toHaveLength(1);
    expect(() => x.s.pauseAll(x.m("kara"))).toThrow("teamtask_scope_not_permitted");
    // Resume lifts Pause all; it never replays the paused/consumed occurrence.
    x.s.resume(x.z("sue", null), x.m("sue"), { all: true });
    await x.at("2026-11-02T18:00:00.000Z");
    expect(x.occ()).toHaveLength(1);
  });
  it("F-1: pause and Pause all ABORT the running attempt (the store's cancellation path) at once, not at its next step", async () => {
    const hold = async (w: ReturnType<typeof world>) => {
      w.state.mode = { kind: "hold" };
      const p = w.at("2026-11-02T12:00:00.000Z");
      for (let i = 0; i < 50 && !w.state.release; i++) await new Promise((r) => setTimeout(r, 10));
      return { done: p }; // not the bare promise: an async function would adopt it
    };
    // pause, request settled: cancelled, schedule paused, no further request, the reservation settles at the actual cost.
    const w = world();
    const v = w.monday();
    const { done: p } = await hold(w);
    expect(w.s.pause(w.m("sue"), { scheduleId: v.scheduleId })).toEqual({ paused: true });
    await p; await w.t.idle(); // no release(): only the abort ends it
    expect(w.occ()[0]).toMatchObject({ state: "cancelled", label: "teamtask_cancelled" });
    expect(w.t.read(w.m("sue"), { taskId: w.occ()[0].task_id }).attempts[0]).toMatchObject({ state: "cancelled", label: "teamtask_cancelled" });
    expect([w.sched(v.scheduleId).state, w.ledger.length, w.sched(v.scheduleId).coverage]).toEqual(["paused", 1, "{}"]);
    expect(w.a.db.prepare("SELECT state, settled_usd FROM teamtask_schedule_budget").get()).toEqual({ state: "settled", settled_usd: 0.95 });
    // Pause all while the sent request is unsettled: uncertain (no rerun), the schedule pauses, the reservation is held.
    const x = world();
    const xv = x.monday();
    const { done: q } = await hold(x);
    Object.assign(x.ledger[0], { state: "unsettled", cost_usd: null });
    x.s.pauseAll(x.m("sue")); await q; await x.t.idle();
    expect(x.occ()[0]).toMatchObject({ state: "uncertain", label: "teamtask_cancelled" });
    expect([x.sched(xv.scheduleId).state, x.ledger.length]).toEqual(["paused", 1]);
    expect(x.a.db.prepare("SELECT state FROM teamtask_schedule_budget").get()).toEqual({ state: "held" });
    // An edit of the running schedule pauses it, so it aborts too; nothing is running = nothing to abort.
    const y = world();
    const yv = y.monday();
    const { done: r } = await hold(y);
    y.s.propose(y.m("sue"), { scheduleId: yv.scheduleId, title: "Edited", template: { title: "x {{date}}", notes: "" }, sources: { roots: ["members/notes"], rule: "new" }, recurrence: { weekday: 1 } });
    await r; await y.t.idle();
    expect(y.occ()[0].state).toBe("cancelled");
    expect(y.s.abortRunning()).toBe(0);
  });
  it("pause / resume: the creator or a reviewer pauses; resume needs the digest, current pins and no pending edit; an edit pauses until approved", async () => {
    const w = world();
    const v = w.monday();
    expect(() => w.s.pause(w.m("kara"), { scheduleId: v.scheduleId })).toThrow("teamtask_scope_not_permitted"); // not the creator
    w.s.pause(w.m("sue"), { scheduleId: v.scheduleId });
    await w.at("2026-11-02T12:00:00.000Z");
    expect(w.occ()[0]).toMatchObject({ state: "skipped", label: "teamtask_schedule_paused" });
    expect(() => w.s.resume(w.z("sue", "sha256:" + "0".repeat(64)), w.m("sue"), { scheduleId: v.scheduleId })).toThrow("teamtask_plan_changed");
    w.s.resume(w.z("sue", v.digest), w.m("sue"), { scheduleId: v.scheduleId });
    expect(w.sched(v.scheduleId).state).toBe("active");
    const v2 = w.s.propose(w.m("sue"), { scheduleId: v.scheduleId, title: "Monday newsletter draft", template: { title: "Draft {{date}}", notes: "" }, sources: { roots: ["members/notes"], rule: "new" }, recurrence: { weekday: 1 } });
    expect(v2.version).toBe(2);
    expect(w.a.db.prepare("SELECT state FROM teamtask_schedules WHERE schedule_id=? AND version=1").get(v.scheduleId)).toEqual({ state: "paused" });
    w.s.approve(w.z("sue", v2.digest), w.m("sue"), { scheduleId: v.scheduleId, version: 2 });
    expect(w.a.db.prepare("SELECT version, state FROM teamtask_schedules WHERE schedule_id=? ORDER BY version").all(v.scheduleId)).toEqual([{ version: 1, state: "superseded" }, { version: 2, state: "active" }]);
  });
});

describe("SCHEDULED-TASKS-V1 S1: time, restarts, budget", () => {
  it("C-7: the real Chicago 2026-03-08 gap (02:30 -> 03:00) and 2026-11-01 fold (01:30 -> first), 09:00 unaffected; Node/ICU/tzdata recorded", () => {
    expect([localToUtc("2026-03-08", "02:30", "America/Chicago"), localToUtc("2026-11-01", "01:30", "America/Chicago")].map((x) => [new Date(x.at).toISOString(), x.adjust]))
      .toEqual([["2026-03-08T08:00:00.000Z", "gap"], ["2026-11-01T06:30:00.000Z", "fold"]]);
    expect([localToUtc("2026-03-08", "09:00", "America/Chicago"), localToUtc("2026-11-01", "09:00", "America/Chicago")].map((x) => [new Date(x.at).toISOString(), x.adjust]))
      .toEqual([["2026-03-08T14:00:00.000Z", "exact"], ["2026-11-01T15:00:00.000Z", "exact"]]);
    // Weekly is not 168 hours: the Sunday 02:30 schedule across both changes.
    expect(nextDue({ weekday: 7, time: "02:30", timezone: "America/Chicago" }, Date.parse("2026-03-01T00:00:00Z"), 3).map((x) => new Date(x.dueMs).toISOString()))
      .toEqual(["2026-03-01T08:30:00.000Z", "2026-03-08T08:00:00.000Z", "2026-03-15T07:30:00.000Z"]);
    expect(nextDue({ weekday: 7, time: "01:30", timezone: "America/Chicago" }, Date.parse("2026-10-25T00:00:00Z"), 2).map((x) => new Date(x.dueMs).toISOString()))
      .toEqual(["2026-10-25T06:30:00.000Z", "2026-11-01T06:30:00.000Z"]); // the fold's first 01:30 (CDT), once
    const w = world();
    expect(w.monday().definition.runtime).toEqual({ node: process.versions.node, icu: process.versions.icu, tz: process.versions.tz });
  });
  it("two ticks = one occurrence; a backward clock never duplicates; missed weeks collapse to one (latest within 24 h), three missed warn once", async () => {
    const w = world();
    w.monday();
    await w.at("2026-11-02T12:00:00.000Z"); await w.at("2026-11-02T12:00:30.000Z");
    expect(w.occ()).toHaveLength(1);
    await w.at("2026-10-30T12:00:00.000Z"); // the clock went back
    expect(w.occ()).toHaveLength(1);
    // Down for three weeks; up on Monday 2026-11-23 within 24 h of 06:00: the two older windows are Skipped: missed.
    await w.at("2026-11-23T20:00:00.000Z");
    expect(w.occ().map((x) => [x.local_date, x.state, x.label])).toEqual([["2026-11-02", "result_ready", null], ["2026-11-09", "skipped", "teamtask_schedule_missed"],
      ["2026-11-16", "skipped", "teamtask_schedule_missed"], ["2026-11-23", "skipped", "teamtask_schedule_no_new_sources"]]);
    // Later than 24 h: the latest window is missed too; three missed in a row -> ONE warning.
    await w.at("2026-12-16T12:00:00.000Z");
    expect(w.occ().slice(-3).map((x) => x.label)).toEqual(Array(3).fill("teamtask_schedule_missed"));
    await w.at("2026-12-16T12:05:00.000Z");
    expect(w.outbox().filter((x) => x.kind === "missed_warning")).toHaveLength(1);
  });
  it("restart after materialization, claim/send, result and notification: no duplicate occurrence, run, coverage or notification; an interrupted run is uncertain and pauses", async () => {
    const w = world();
    const v = w.monday();
    w.config.run = false;
    await w.at("2026-11-02T12:00:00.000Z"); // materialized, waiting
    w.restart(); w.config.run = true;
    await w.at("2026-11-02T12:01:00.000Z");
    expect(w.occ()).toHaveLength(1);
    expect(w.occ()[0].state).toBe("result_ready");
    w.restart(); await w.at("2026-11-02T12:02:00.000Z"); w.restart(); await w.at("2026-11-02T12:03:00.000Z");
    expect([w.occ().length, w.calls.length, w.outbox().length]).toEqual([1, 1, 1]);
    expect(JSON.parse(w.sched(v.scheduleId).coverage)).toHaveProperty(["members/notes/2026-10-08.md"]);
    // A run interrupted after its request was sent (claim + send, then the process stops).
    const x = world();
    const xv = x.monday();
    x.state.mode = { kind: "hold" };
    void x.at("2026-11-02T12:00:00.000Z");
    for (let i = 0; i < 50 && !x.state.release; i++) await new Promise((r) => setTimeout(r, 10));
    Object.assign(x.ledger[0], { state: "unsettled", cost_usd: null }); // the request was sent; its cost is not known yet
    x.restart(); // the old process is gone; the new one recovers
    x.t.recover(); x.s.tick();
    expect(x.occ()[0]).toMatchObject({ state: "uncertain", label: "teamtask_outcome_uncertain" });
    expect(x.sched(xv.scheduleId).state).toBe("paused");
    expect(x.a.db.prepare("SELECT state FROM teamtask_schedule_budget").get()).toEqual({ state: "held" }); // unknown cost keeps its reservation
  });
  it("C-6: five $1 Monday claims + an attached Run now: the sixth claim refuses budget_exhausted (no partial reservation); monthly boundary keeps the reservation month", async () => {
    const w = world({ roles: {} });
    const v = w.monday({ sources: { roots: ["members/notes"], rule: "current" } }); // runs every week (events-style)
    w.state.mode = { kind: "ok", cost: 0.95 };
    await w.at("2026-11-02T12:00:00.000Z"); await w.at("2026-11-09T12:00:00.000Z"); await w.at("2026-11-16T12:00:00.000Z"); await w.at("2026-11-23T12:00:00.000Z");
    w.state.clock = Date.parse("2026-11-25T15:00:00.000Z");
    const run = w.s.runNow(w.z("sue", null), w.m("sue"), { scheduleId: v.scheduleId }); await w.t.idle();
    expect(run.state).toBe("admitted");
    expect(await w.at("2026-11-30T12:00:00.000Z")).toMatchObject({ skipped: 1 }); // the 5th Monday = the 6th claim of the month
    expect(w.occ().at(-1)).toMatchObject({ local_date: "2026-11-30", state: "skipped", label: "teamtask_schedule_budget_exhausted" });
    expect(w.a.db.prepare("SELECT COUNT(*) AS n FROM teamtask_schedule_budget WHERE month='2026-11'").get()).toEqual({ n: 5 }); // never a partial 6th reservation
    expect(w.sched(v.scheduleId)).toMatchObject({ state: "paused", label: "teamtask_schedule_budget_exhausted" });
    expect(w.calls).toHaveLength(5);
    // A reservation made on Oct 31 UTC that settles on Nov 1 stays charged to October.
    const x = world();
    x.state.clock = Date.parse("2026-10-30T12:00:00.000Z");
    x.monday({ recurrence: { weekday: 6, timezone: "America/Chicago" }, sources: { roots: ["members/notes"], rule: "current" } }); // Saturdays
    x.state.mode = { kind: "hold" };
    void x.at("2026-10-31T11:00:00.000Z");
    for (let i = 0; i < 50 && !x.state.release; i++) await new Promise((r) => setTimeout(r, 10));
    x.state.clock = Date.parse("2026-11-01T01:00:00.000Z"); x.state.release!(); await x.t.idle();
    expect(x.a.db.prepare("SELECT month, state, settled_usd FROM teamtask_schedule_budget").get()).toEqual({ month: "2026-10", state: "settled", settled_usd: 0.95 });
  });
  it("chat first: a busy org slot makes the occurrence wait (no snapshot, no task) until it is free or the start deadline passes", async () => {
    const w = world();
    w.monday();
    w.state.chatBusy = true;
    expect(await w.at("2026-11-02T12:00:00.000Z")).toMatchObject({ waiting: 1 });
    expect(w.occ()[0]).toMatchObject({ state: "due", task_id: null });
    w.state.chatBusy = false;
    expect(await w.at("2026-11-02T12:05:00.000Z")).toMatchObject({ admitted: 1 });
    expect(w.occ()[0].state).toBe("result_ready");
  });
  it("duplicate notifications: finalizing twice (end hook + sync + restart) records ONE; a reviewers-private result is never visible to a contributor", async () => {
    const w = world();
    const v = w.s.propose(w.m("sue"), { title: "Private", audience: "reviewers-private", template: { title: "Intake {{date}}", notes: "" }, sources: { roots: ["reviewers-private/intake"], rule: "current" }, recurrence: { weekday: 1 } });
    w.s.approve(w.z("sue", v.digest), w.m("sue"), { scheduleId: v.scheduleId, version: 1 });
    await w.at("2026-11-02T12:00:00.000Z");
    const o = w.occ()[0];
    w.s.onAttemptEnd(o.attempt_id); w.s.sync(); w.restart(); w.s.sync();
    expect(w.outbox()).toEqual([{ occurrence_id: o.occurrence_id, kind: "result_ready", audience: "reviewers-private", label: null }]);
    expect(() => w.t.read(w.m("kara"), { taskId: o.task_id })).toThrow("teamtask_audience_not_permitted");
    expect(w.t.list(w.m("kara")).tasks).toHaveLength(0);
    expect(() => w.s.read(w.m("kara"), { scheduleId: v.scheduleId })).toThrow("teamtask_audience_not_permitted");
    expect(() => w.s.read(w.m("kara"), { scheduleId: "tts_" + "0".repeat(32) })).toThrow("teamtask_audience_not_permitted"); // unknown = inaccessible
  });
  it("expiry: after the end date the schedule expires and nothing more runs", async () => {
    const w = world();
    const v = w.monday({ endDate: "2026-11-05" });
    await w.at("2026-11-02T12:00:00.000Z");
    await w.at("2026-11-09T12:00:00.000Z");
    expect(w.sched(v.scheduleId)).toMatchObject({ state: "expired", label: "teamtask_schedule_expired" });
    expect(w.occ()).toHaveLength(1);
  });
  it("the reviewer journey: Jordan approves Monday drafts; Kara opens the resulting draft and marks it Done; nothing is sent to anyone", async () => {
    const w = world({ roles: { kara: "reviewer" } });
    w.monday();
    await w.at("2026-11-02T12:00:00.000Z");
    const o = w.occ()[0], t = w.t.read(w.m("kara"), { taskId: o.task_id }), att = t.attempts[0];
    const res = w.t.result(w.m("kara"), { taskId: o.task_id, resultId: att.report!.resultId });
    expect(res.text).toBe("Draft from members/notes/2026-10-08.md");
    w.t.complete(w.z("kara", att.report!.resultDigest), w.m("kara"), { taskId: o.task_id, expectedRevision: t.revision });
    expect(w.t.read(w.m("kara"), { taskId: o.task_id })).toMatchObject({ state: "done", done: { by: "kara" } });
    expect(w.outbox().map((x) => x.kind)).toEqual(["result_ready"]); // in-app only: no email, no newsletter, no subscriber list
  });
});

describe("AGENT-HANDBOOK-V1 H1 (Fable C-3): schedule derivation v3 replays the plan's approved context", () => {
  it("with the handbook on, the derived plan binds handbook + map, the inputs carry the context, replay recomputes the digest; an edited context refuses", async () => {
    const w = world({ handbook: "# How we work\nPeople approve and send.\n" });
    w.monday();
    await w.at("2026-11-02T12:00:00.000Z");
    const [o] = w.occ(), i = JSON.parse(o.inputs);
    expect(o.state).toBe("result_ready");
    expect(i.context).toMatchObject({ handbook: { version: 1 }, map: { id: o.attempt_id } });
    expect(planDigest(derivePlan(i))).toBe(o.plan_digest);
    expect(w.s.replay(o.occurrence_id).ok).toBe(true);
    w.a.db.prepare("UPDATE teamtask_schedule_occurrences SET inputs=? WHERE occurrence_id=?").run(canonical({ ...i, context: { ...i.context, handbook: { version: 2, sha256: H("2") } } }), o.occurrence_id);
    expect(w.s.replay(o.occurrence_id).ok).toBe(false);
    const off = world(); off.monday(); await off.at("2026-11-02T12:00:00.000Z");
    expect(JSON.parse(off.occ()[0].inputs).context).toBeNull(); // feature off: no context, as before
  });
});

describe("AGENT-HANDBOOK-V1 H2 (D-3): handbook pins on schedules", () => {
  it("Fable C-C: an occurrence whose derived plan carries a handbook OTHER than the schedule's pinned one never runs (pin_changed, paused)", async () => {
    const w = world({ handbook: "# How we work\nPeople approve.\n" }); // the store's active handbook: v1 with this text's sha256
    (w.pins as any).handbook = { version: 1, sha256: H("1") };         // the schedule's (and the current pins') handbook: v1 with ANOTHER sha
    const v = w.monday();
    await w.at("2026-11-02T12:00:00.000Z");
    expect([w.occ()[0].state, w.occ()[0].label, w.sched(v.scheduleId).state]).toEqual(["skipped", "teamtask_schedule_pin_changed", "paused"]);
    expect(w.calls).toHaveLength(0);
  });
  it("Fable N-1 in code: a schedule approved WITHOUT a handbook pin pauses (pin_changed) once the feature is on; pauseForHandbook pauses every active one", async () => {
    const w = world();
    const v = w.monday();
    (w.pins as any).handbook = { version: 1, sha256: H("1") }; // the feature switched on with an approved handbook
    await w.at("2026-11-02T12:00:00.000Z");
    expect([w.occ()[0].state, w.occ()[0].label, w.sched(v.scheduleId).state]).toEqual(["skipped", "teamtask_schedule_pin_changed", "paused"]);
    expect(w.calls).toHaveLength(0);
    const x = world();
    (x.pins as any).handbook = { version: 1, sha256: H("1") };
    const a = x.monday(), b = x.monday({ title: "Second" });
    expect(x.sched(a.scheduleId).definition).toContain('"handbook":{"sha256":"' + H("1") + '","version":1}'); // pinned at approval
    expect(x.s.pauseForHandbook(2)).toBe(2);
    // Fable C-A: one admin incident per paused schedule, content-free, in the same call; admins see it named, members do not.
    expect(x.s.outboxFor(["admins"]).filter((o: any) => o.kind === "incident")).toHaveLength(2);
    expect(x.s.list(x.m("admin")).notifications.map((n: any) => [n.kind, n.label, n.title, n.occurrenceId]).sort())
      .toEqual([["incident", "teamtask_schedule_pin_changed", "Monday newsletter draft", null], ["incident", "teamtask_schedule_pin_changed", "Second", null]]);
    expect(x.s.list(x.m("kara")).notifications).toEqual([]);
    expect([x.sched(a.scheduleId), x.sched(b.scheduleId)].map((r) => [r.state, r.label])).toEqual([["paused", "teamtask_schedule_pin_changed"], ["paused", "teamtask_schedule_pin_changed"]]);
    // Re-approval keeps the caps and the END DATE: a new version proposed from the paused definition with the current pins.
    (x.pins as any).handbook = { version: 2, sha256: H("2") };
    const d = JSON.parse(x.sched(a.scheduleId).definition);
    const again = x.s.propose(x.m("sue"), { scheduleId: a.scheduleId, title: d.title, audience: d.audience, template: d.template, sources: d.sources, recurrence: d.recurrence,
      mode: d.mode, limits: d.limits, budget: d.budget, endDate: d.endDate });
    expect([again.version, again.definition.endDate, again.definition.pins.handbook]).toEqual([2, d.endDate, { version: 2, sha256: H("2") }]);
    x.s.approve(x.z("sue", again.digest), x.m("sue"), { scheduleId: a.scheduleId, version: 2 });
    expect(x.sched(a.scheduleId).state).toBe("active");
    expect(() => x.s.resume(x.z("sue", x.sched(b.scheduleId).digest), x.m("sue"), { scheduleId: b.scheduleId })).toThrow("teamtask_schedule_pin_changed"); // plain resume still refuses
  });
});

describe("SCHEDULED-TASKS-V1 S2: notifications, status, Ops reconcile of held budget", () => {
  it("in-app notifications are content-free and audience-rechecked on every read (members / reviewers / admins; a demoted reviewer stops seeing)", async () => {
    const w = world({ roles: { rev2: "reviewer" } });
    const mem = w.monday(); // members audience
    const pv = w.s.propose(w.m("sue"), { title: "Private", audience: "reviewers-private", template: { title: "Intake {{date}}", notes: "" }, sources: { roots: ["reviewers-private/intake"], rule: "current" }, recurrence: { weekday: 1 } });
    w.s.approve(w.z("sue", pv.digest), w.m("sue"), { scheduleId: pv.scheduleId, version: 1 });
    await w.at("2026-11-02T12:00:00.000Z"); // the private one runs after the members one (one run per org): admit both over two ticks
    await w.at("2026-11-02T12:01:00.000Z");
    expect(w.occ().map((o) => o.state)).toEqual(["result_ready", "result_ready"]);
    w.pins.toolCatalogHash = H("9"); await w.at("2026-11-09T12:00:00.000Z"); // an admin incident (pin_changed) for both
    const kinds = (who: string) => w.s.list(w.m(who)).notifications.map((x: any) => x.kind + ":" + (x.label ?? "-")).sort();
    expect(kinds("kara")).toEqual(["result_ready:-"]); // members' draft only; no reviewer or admin items
    expect(kinds("rev2")).toEqual(["result_ready:-", "result_ready:-"]);
    expect(kinds("admin")).toEqual(["incident:teamtask_schedule_pin_changed", "incident:teamtask_schedule_pin_changed", "result_ready:-", "result_ready:-"]);
    const n = w.s.list(w.m("kara")).notifications[0];
    // ids, kind, fixed label, time, the run's date and the schedule's own (reviewer-approved) title: never result text
    expect(Object.keys(n).sort()).toEqual(["at", "id", "kind", "label", "localDate", "occurrenceId", "scheduleId", "taskId", "title"]);
    expect([n.title, n.localDate]).toEqual(["Monday newsletter draft", "2026-11-02"]);
    expect(w.s.list(w.m("admin")).notifications.map((x: any) => x.title).sort()).toEqual(["Monday newsletter draft", "Monday newsletter draft", "Private", "Private"]);
    expect(w.t.read(w.m("kara"), { taskId: n.taskId }).audience).toBe("members");
    w.roles.rev2 = "contributor";
    expect(kinds("rev2")).toEqual(["result_ready:-"]);
    expect(w.s.list(w.m("kara")).schedules.map((x: any) => x.scheduleId)).toEqual([mem.scheduleId]); // the private schedule is not listed
    // 14 days later the notices age out of the in-app list (the outbox keeps them).
    w.state.clock = Date.parse("2026-11-24T12:00:00.000Z");
    expect(w.s.list(w.m("admin")).notifications).toEqual([]);
    expect(w.s.outboxFor(["members", "reviewers-private", "admins"])).toHaveLength(4);
  });
  it("status: the shared runner fact (Ops switch, busy slot, waiting count) and Pause all on the list", async () => {
    const w = world();
    w.monday();
    w.state.chatBusy = true;
    await w.at("2026-11-02T12:00:00.000Z");
    expect(w.s.list(w.m("kara"))).toMatchObject({ pausedAll: false, runner: { run: true, busy: true, due: 1 } });
    expect(w.s.list(w.m("kara")).runner).not.toHaveProperty("envelopeUsd"); // Fable S2 N-1: an Ops fact, not for members
    expect(w.s.list(w.m("sue")).runner).toMatchObject({ envelopeUsd: 20 });
    w.state.chatBusy = false; w.config.run = false;
    w.s.pauseAll(w.m("sue"));
    expect(w.s.list(w.m("kara"))).toMatchObject({ pausedAll: true, runner: { run: false, busy: false, due: 1 } });
  });
  it("Fable N-3: Ops reconcile settles a HELD reservation once its ledger rows are definitive; the occurrence and coverage stay as they were", async () => {
    const w = world();
    const v = w.monday();
    w.state.mode = { kind: "uncertain" };
    await w.at("2026-11-02T12:00:00.000Z");
    expect(w.a.db.prepare("SELECT state FROM teamtask_schedule_budget").get()).toEqual({ state: "held" });
    expect(w.s.settleHeld()).toEqual({ held: 1, settled: 0 }); // still unknown: kept
    Object.assign(w.ledger[0], { state: "settled", cost_usd: 0.4 });
    expect(w.s.settleHeld()).toEqual({ held: 1, settled: 1 });
    expect(w.a.db.prepare("SELECT state, settled_usd FROM teamtask_schedule_budget").get()).toEqual({ state: "settled", settled_usd: 0.4 });
    expect([w.occ()[0].state, w.sched(v.scheduleId).state, w.sched(v.scheduleId).coverage]).toEqual(["uncertain", "paused", "{}"]); // never restored, never advanced
    expect(w.s.settleHeld()).toEqual({ held: 0, settled: 0 });
  });
});

describe("SCHEDULED-TASKS-V1 S3: the three named templates, end to end offline (fake executor)", () => {
  const fromTemplate = (w: ReturnType<typeof world>, id: string, who = "kara") => {
    const t = SCHEDULE_TEMPLATES.find((x) => x.id === id)!;
    const v = w.s.propose(w.m(who), { title: t.title, template: { ...t.template }, sources: { roots: [...t.roots], rule: t.rule }, recurrence: { weekday: t.weekday } });
    w.s.approve(w.z("sue", v.digest), w.m("sue"), { scheduleId: v.scheduleId, version: 1 });
    return v;
  };
  it("the templates and collections are valid for their audience; list serves them (reviewers-only collections only to reviewers)", () => {
    const w = world();
    expect(SCHEDULE_TEMPLATES.map((t) => [t.id, t.weekday, t.rule])).toEqual([["newsletter", 1, "new"], ["meeting-summary", 3, "new"], ["upcoming-events", 5, "current"]]);
    for (const t of SCHEDULE_TEMPLATES) { const v = fromTemplate(w, t.id); expect(v).toMatchObject({ state: "proposed", offPeak: true, definition: { recurrence: { time: "06:00" } } }); }
    expect(w.s.list(w.m("kara")).collections.map((c: any) => c.root)).toEqual(SCHEDULE_COLLECTIONS.filter((c) => c.audience === "members").map((c) => c.root));
    expect(w.s.list(w.m("sue")).collections).toHaveLength(SCHEDULE_COLLECTIONS.length);
  });
  it("Monday newsletter draft: new approved notes only; the next week without new notes is Skipped with zero calls", async () => {
    const w = world();
    fromTemplate(w, "newsletter");
    await w.at("2026-11-02T12:00:00.000Z");
    const t = w.t.read(w.m("kara"), { taskId: w.occ()[0].task_id });
    expect(t.title).toBe("Newsletter draft for 2026-11-02");
    expect(t.notes).toContain("new since the start.");
    expect(w.calls[0].sources.map((f) => f.path)).toEqual(["members/notes/2026-10-08.md"]);
    await w.at("2026-11-09T12:00:00.000Z");
    expect(w.occ().at(-1)).toMatchObject({ state: "skipped", label: "teamtask_schedule_no_new_sources" });
    expect(w.calls).toHaveLength(1);
  });
  it("Weekly meeting notes summary: only website meeting notes, only new ones", async () => {
    const w = world();
    w.write("members/website/meeting-notes/2026-10-27-board.md", "# Board\nDecided: cleanup Oct 31.\n");
    w.write("members/website/events.md", "# Events\n");
    fromTemplate(w, "meeting-summary");
    await w.at("2026-11-04T12:00:00.000Z"); // Wednesday 06:00 Chicago
    expect(w.calls.map((c) => c.sources.map((f) => f.path))).toEqual([["members/website/meeting-notes/2026-10-27-board.md"]]);
    w.write("members/website/meeting-notes/2026-11-10-board.md", "# Board\nNew.\n");
    await w.at("2026-11-11T12:00:00.000Z");
    expect(w.calls[1].sources.map((f) => f.path)).toEqual(["members/website/meeting-notes/2026-11-10-board.md"]);
    expect(w.t.read(w.m("kara"), { taskId: w.occ().at(-1)!.task_id }).notes).toContain("new since 2026-11-04:");
  });
  it("Friday upcoming events: the current list every week (even unchanged), an explicit 14-day window ({{until}} = date + 13), bound in replay", async () => {
    const w = world();
    w.write("members/website/events.md", "# Events\n- Nov 8: Block Party\n");
    fromTemplate(w, "upcoming-events");
    await w.at("2026-11-06T12:00:00.000Z"); await w.at("2026-11-13T12:00:00.000Z"); // two Fridays, the file unchanged
    expect(w.calls.map((c) => c.sources.map((f) => f.path))).toEqual([["members/website/events.md"], ["members/website/events.md"]]);
    const [a, b] = w.occ();
    expect(w.t.read(w.m("kara"), { taskId: a.task_id }).title).toBe("Upcoming events 2026-11-06 to 2026-11-19");
    expect(w.t.read(w.m("kara"), { taskId: b.task_id }).notes).toContain("from 2026-11-13 through 2026-11-26 (inclusive)");
    expect(w.s.replay(a.occurrence_id).ok).toBe(true);
    const i = JSON.parse(a.inputs);
    expect(i.derivation).toBe("kapelle.teamtask-schedule-derivation/v3");
    w.a.db.prepare("UPDATE teamtask_schedule_occurrences SET inputs=? WHERE occurrence_id=?").run(canonical({ ...i, substitutions: { ...i.substitutions, until: "2026-12-31" } }), a.occurrence_id);
    expect(w.s.replay(a.occurrence_id).ok).toBe(false); // the window is bound to the run's date
  });
});

const runtimeEnabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
describe.skipIf(!runtimeEnabled)("SCHEDULED-TASKS-V1 S1: runtime wiring (routes, tiers, Ops switch default off)", () => {
  it("no schedules config = every schedule action refuses; with it (run off by default) propose/list work, approve needs a fresh challenge, nothing runs", async () => {
    const { transcriptionWorld } = await import("./transcription-world.js");
    const off = await transcriptionWorld({ chat: {}, teamTasks: true, teamTaskExecutor: { id: "fake-v1", async run() { throw new Error("must not run"); } } });
    try {
      // Owner (24 Oct): with exactly one org, the bare host goes to its app (not raw JSON).
      const home = await fetch(off.url + "/", { redirect: "manual" });
      expect([home.status, home.headers.get("location"), home.headers.get("cache-control")]).toEqual([302, "/o/exna/", "no-store"]);
      expect((await fetch(off.url + "/nowhere")).status).toBe(404); // everything else is unchanged
      expect((await off.post("/o/exna/api/teamtask/schedule/list", {}, off.robin)).error).toBe("teamtask_tool_not_admitted"); } finally { await off.close(); }
    const w = await transcriptionWorld({ chat: {}, teamTasks: true, teamTaskSchedules: { envelopeUsd: 5 }, teamTaskExecutor: { id: "fake-v1", async run() { throw new Error("must not run"); } } });
    try {
      const v = (await w.post("/o/exna/api/teamtask/schedule/propose", { title: "Monday draft", template: { title: "Draft {{date}}", notes: "" }, sources: { roots: ["members/notes"], rule: "new" }, recurrence: { weekday: 1 } }, w.robin)).result;
      expect(v).toMatchObject({ state: "proposed", offPeak: true, definition: { recurrence: { time: "06:00", timezone: "America/Chicago" } } });
      expect((await w.post("/o/exna/api/teamtask/schedule/approve", { scheduleId: v.scheduleId, version: 1 }, w.robin)).ok).not.toBe(true); // consequential: not on the routine path
      expect((await w.act(w.robin, "teamtask.schedule.approve", { scheduleId: v.scheduleId, version: 1 }, v.digest)).ok).toBe(true);
      const l = (await w.post("/o/exna/api/teamtask/schedule/list", {}, w.robin)).result;
      expect(l).toMatchObject({ pausedAll: false, schedules: [expect.objectContaining({ scheduleId: v.scheduleId, state: "active" })] });
      expect(w.org.teamTasks!.list({ memberId: "x", role: "admin" } as never).tasks).toHaveLength(0);
    } finally { await w.close(); }
  });
  it("F-1: the Ops pause (/ops/teamtasks/pause) aborts a running schedule-attached attempt at once", async () => {
    const { transcriptionWorld } = await import("./transcription-world.js");
    let started = false;
    const w = await transcriptionWorld({ chat: {}, teamTasks: "run", teamTaskSchedules: { run: "on", envelopeUsd: 5 }, teamTaskExecutor: { id: "fake-v1", async run(r: any) {
      started = true;
      await new Promise<void>((res) => r.signal.addEventListener("abort", () => res(), { once: true }));
      throw new TeamTaskEnd("teamtask_cancelled", "cancelled");
    } } });
    try {
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, "members", "notes", "2026-10-08.md"), "# Notes\nSynthetic.\n");
      const v = (await w.post("/o/exna/api/teamtask/schedule/propose", { title: "Monday draft", template: { title: "Draft {{date}}", notes: "" }, sources: { roots: ["members/notes"], rule: "current" }, recurrence: { weekday: 1 } }, w.robin)).result;
      expect((await w.act(w.robin, "teamtask.schedule.approve", { scheduleId: v.scheduleId, version: 1 }, v.digest)).ok).toBe(true);
      expect((await w.act(w.robin, "teamtask.schedule.run_now", { scheduleId: v.scheduleId }, null)).result).toMatchObject({ state: "admitted" });
      for (let i = 0; i < 200 && !started; i++) await new Promise((r) => setTimeout(r, 10));
      expect(started).toBe(true);
      await w.ops("/ops/teamtasks/pause", { on: true });
      await w.org.teamTasks!.idle();
      const s = (await w.post("/o/exna/api/teamtask/schedule/read", { scheduleId: v.scheduleId }, w.robin)).result;
      expect(s.occurrences).toEqual([expect.objectContaining({ kind: "manual", state: "cancelled", label: "teamtask_cancelled" })]);
    } finally { await w.close(); }
  });
});
