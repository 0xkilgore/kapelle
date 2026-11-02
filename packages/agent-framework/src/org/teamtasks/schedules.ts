// SCHEDULED-TASKS-V1 S1 (design 8cf4853f, Fable ACCEPT f8abcea2 + conditions C-1..C-8 of 33b98fd8): weekly, prepare-only
// standing schedules inside the org's own SQLite authority. A reviewer approves ONE bounded standing instruction (template,
// source rule, limits, expiry <= 90 days, the four pins); each due occurrence becomes an ORDINARY team task: the same create,
// the same propose (same frozen snapshot, same plan validator and budget wiring, C-2), ONE derived approval consumed once by
// the same claim (never a forged session), the same executor. Nothing here sends, publishes, marks Done or calls a provider.
// - Time (schedule-time.ts): one weekday + local HH:MM + IANA zone; latest-only within 24 h; older windows Skipped: missed;
//   UNIQUE (schedule, version, local date) so ticks, restarts and backward clocks never duplicate.
// - Sources: admitted roots only, checked against the audience; frozen when the occurrence is admitted to the runner (the org
//   slot is free), not at wake-up; "new notes" = path + sha256 not in the coverage watermark, which advances ONLY on a full,
//   non-partial verified result. Nothing new = Skipped: no new notes, zero model calls.
// - Pins (C-3): rulesHash + profileHash + toolCatalogHash + ACCESS_TABLE_HASH stored at approval; checked at admission, claim
//   and before EVERY provider/tool step (the store's scheduleGate inside authorization()); any change pauses (pin_changed).
// - Replay (C-1): every occurrence stores its derivation inputs; derivePlan(inputs) recomputes the stored plan digest; an
//   edited input or schedule refuses (teamtask_plan_changed).
// - Budget: the per-run allowance is reserved against the schedule's UTC month before claim (and inside an Ops-admitted
//   envelope); settled from the hosted ledger when the attempt ends; unknown cost keeps its reserve (held).
// - Kill (C-5): the existing Ops config (teamTasks.schedules.run) + "Pause all" + the existing Ops pause, ONE gate path.
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonical, digest } from "../../content.js";
import { AccessError, type Authorization } from "../../access/org-access.js";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { takeSnapshot } from "../chat/tools.js";
import { AUDIENCES, TEAMTASK_CEILING, budgetSchema, planDigest, planSchema, teamTaskGrantPlan, teamTaskRecommendation, type Budget, type Pins, type Plan, type PlanContext } from "./contract.js";
export type { Pins };
import type { TeamTasks } from "./store.js";
import { addDays, latestDue, localToUtc, nextDue, runtimeTime, validZone, wallAt } from "./schedule-time.js";

// v2 (S3): the allowlisted {{until}} placeholder (the run's local date + 13 days, for "the next 14 days"); nothing was deployed on v1.
// v3 (AGENT-HANDBOOK-V1 H1, Fable C-3): the plan's approved context (handbook version/hash + system-map hash) is a derivation
// input, so a replay recomputes the same digest; null when the feature is off. Nothing was deployed on v1 or v2.
export const SCHEDULE_DERIVATION = "kapelle.teamtask-schedule-derivation/v3";
export const SCHEDULE_LIMITS = Object.freeze({ horizonDays: 90, activePerOrg: 5, perRunUsd: 1, monthlyUsd: 5, lateWindowMs: 24 * 3_600_000, missedWarning: 3 });
/** The Director's default (Oct 23): off-peak, so a run (up to 8 min) does not hold chat at 09:00. The reviewer chooses the time. */
/** S2: in-app notifications are shown for this many days. */
export const NOTIFICATION_DAYS = 14;
export const DEFAULT_SCHEDULE_TIME = "06:00";
export const DEFAULT_SCHEDULE_ZONE = "America/Chicago";
/** A start inside these local hours may make a live chat answer wait up to the run's wall (8 min); the preview says so. */
const BUSY_HOURS = { from: 8, to: 20 };
const PLACEHOLDERS = ["date", "since", "until", "occurrence"] as const;
/** {{until}}: the last local day of a "next 14 days" window starting on the run's date (both inclusive). */
export const UNTIL_DAYS = 13;
type Substitutions = Record<(typeof PLACEHOLDERS)[number], string>;
/** S3 (design §6, N-3 of the v1 review): the three named example schedules, prepare-only, weekly, off-peak. Product text only:
 *  a proposal from a template is validated exactly like any other, and a reviewer approves its exact digest. */
export const SCHEDULE_TEMPLATES = [
  { id: "newsletter", title: "Monday newsletter draft", weekday: 1, rule: "new", roots: ["members/notes"],
    template: { title: "Newsletter draft for {{date}}",
      notes: "Draft this week's member newsletter from the approved notes that are new since {{since}}. Lead with dates and actions members need; cite each fact to its note. Mark anything not stated in the notes as unknown. This is a draft for the team to check; nothing is sent." } },
  { id: "meeting-summary", title: "Weekly meeting notes summary", weekday: 3, rule: "new", roots: ["members/website/meeting-notes"],
    template: { title: "Meeting notes summary for {{date}}",
      notes: "Summarize the meeting notes that are new since {{since}}: decisions, open questions and who is doing what by when. Cite each point to its meeting note. A draft for the team; nothing is published." } },
  { id: "upcoming-events", title: "Friday upcoming events", weekday: 5, rule: "current", roots: ["members/website/events.md"],
    template: { title: "Upcoming events {{date}} to {{until}}",
      notes: "List the events dated from {{date}} through {{until}} (inclusive), in date order, with time and place as listed. Leave out events outside those dates. If an event's date is missing or unclear, list it under \"Date unknown\". A draft for the team; nothing is published." } },
] as const;
/** The source collections a schedule may name (rootAllowed still decides per audience). */
export const SCHEDULE_COLLECTIONS = [
  { root: "members/notes", label: "Approved member notes", audience: "members" },
  { root: "members/website/meeting-notes", label: "Website meeting notes", audience: "members" },
  { root: "members/website/events.md", label: "Website events list", audience: "members" },
  { root: "members/shared", label: "Files shared from chat", audience: "members" },
  { root: "reviewers-private/intake", label: "Intake submissions (reviewers only)", audience: "reviewers-private" },
  { root: "reviewers-private/transcripts", label: "Meeting transcripts (reviewers only)", audience: "reviewers-private" },
] as const;

type Member = { memberId: string; role: string };
/** AGENT-HANDBOOK-V1 H2 (D-3): with the handbook feature ON, a schedule also pins the active handbook (version + sha256, or null
 *  when none is approved). The key is ABSENT when the feature is off, so definitions and comparisons are exactly as before. */
export type SchedulePins = { rulesHash: string; profileHash: string; toolCatalogHash: string; accessTableHash: string; handbook?: { version: number; sha256: string } | null };
const refuse = (label: string): never => { throw new AccessError(label); };
const sha = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const isReviewer = (role: string | undefined) => role === "admin" || role === "reviewer";

const hashZ = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const rootZ = z.string().regex(/^[a-z0-9-]+(\/[a-z0-9._-]+)*$/).max(200);
export const scheduleDefSchema = z.object({
  contract: z.literal("kapelle.teamtask-schedule/v1"), derivation: z.literal(SCHEDULE_DERIVATION), orgId: z.string().min(1).max(100),
  scheduleId: z.string().regex(/^tts_[a-f0-9]{32}$/), version: z.number().int().min(1), title: z.string().min(1).max(120), audience: z.enum(AUDIENCES),
  template: z.object({ title: z.string().min(1).max(150), notes: z.string().max(3000) }).strict(),
  sources: z.object({ roots: z.array(rootZ).min(1).max(8), rule: z.enum(["new", "current"]) }).strict(),
  recurrence: z.object({ weekday: z.number().int().min(1).max(7), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), timezone: z.string().min(1).max(64) }).strict(),
  mode: z.enum(["recurring_drafts", "propose_each"]), limits: budgetSchema,
  budget: z.object({ perRunUsd: z.number().positive().max(SCHEDULE_LIMITS.perRunUsd), monthlyUsd: z.number().positive().max(SCHEDULE_LIMITS.monthlyUsd) }).strict(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  pins: z.object({ rulesHash: hashZ, profileHash: hashZ, toolCatalogHash: hashZ, accessTableHash: hashZ,
    handbook: z.object({ version: z.number().int().min(1), sha256: hashZ }).strict().nullable().optional() }).strict(),
  proposedBy: z.string().min(1).max(200), runtime: z.object({ node: z.string(), icu: z.string(), tz: z.string() }).strict(),
}).strict();
export type ScheduleDef = z.infer<typeof scheduleDefSchema>;

/** Deterministic, allowlisted substitution (no model input): {{date}} {{since}} {{occurrence}} only. */
export function substitute(template: string, values: Substitutions) {
  return template.replace(/\{\{([a-z]+)\}\}/g, (_m, k: string) => (PLACEHOLDERS as readonly string[]).includes(k) ? values[k as keyof typeof values] : refuse("teamtask_input_invalid"));
}
const placeholdersOk = (t: string) => [...t.matchAll(/\{\{([^}]*)\}\}/g)].every((m) => (PLACEHOLDERS as readonly string[]).includes(m[1])) && !/\{\{(?![a-z]+\}\})/.test(t);

/** The roots an audience may read (the chat/task snapshot scopes); anything else is a rule mistake (Fable C-8). */
export function rootAllowed(audience: string, root: string) {
  const inside = (base: string) => root === base || root.startsWith(base + "/");
  if (inside("members/uploads")) return false; // a member's own chat uploads are never a schedule source
  if (inside("members")) return true;
  return audience === "reviewers-private" && (inside("reviewers-private/intake") || inside("reviewers-private/transcripts"));
}
/** The store's own text cleaning (disclosure), applied identically so a derived plan replays byte-for-byte (C-1). */
const clean = (v: string) => v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
export function derivedText(d: Pick<ScheduleDef, "template">, values: Substitutions) {
  return { title: clean(substitute(d.template.title, values)).slice(0, 200), notes: clean(substitute(d.template.notes, values)) };
}
const inRule = (d: Pick<ScheduleDef, "audience" | "sources">, path: string) => rootAllowed(d.audience, path) && d.sources.roots.some((r) => path === r || path.startsWith(r + "/"));
/** Fable C-8: the selection REFUSES when a rule reaches a root the audience may not read (never filters it out silently). */
export function selectSources(def: Pick<ScheduleDef, "audience" | "sources">, files: { path: string; sha256: string }[], coverage: Record<string, string>) {
  if (def.sources.roots.some((r) => !rootAllowed(def.audience, r))) refuse("teamtask_schedule_source_refused");
  const under = (p: string) => def.sources.roots.some((r) => p === r || p.startsWith(r + "/"));
  const inRule = files.filter((f) => under(f.path));
  if (inRule.some((f) => !rootAllowed(def.audience, f.path))) refuse("teamtask_schedule_source_refused");
  return { inRule, selected: def.sources.rule === "current" ? inRule : inRule.filter((f) => coverage[f.path] !== f.sha256) };
}

/** C-1: what an occurrence's plan is derived from; replay recomputes the identical plan digest from exactly these. */
export type DerivationInputs = { derivation: string; scheduleId: string; version: number; scheduleDigest: string; occurrenceId: string; localDate: string;
  substitutions: Substitutions; title: string; notes: string; orgId: string; taskId: string; attemptId: string;
  expiresAt: string; audience: Plan["audience"]; roots: string[]; manifestHash: string; files: number; bytes: number; budget: Budget; taskPins: Pins; context: PlanContext | null };
export function derivePlan(i: DerivationInputs): Plan {
  const rec = teamTaskRecommendation({ title: i.title, notes: i.notes });
  return planSchema.parse({ contract: "kapelle.teamtask-plan/v1", orgId: i.orgId, taskId: i.taskId, taskRevision: 1, attemptId: i.attemptId, version: 1, audience: i.audience,
    instructions: rec.instructions, summary: rec.summary, sources: { roots: i.roots, manifestHash: i.manifestHash, files: i.files, bytes: i.bytes },
    pins: i.taskPins, output: { kind: "text" }, budget: i.budget,
    grantPlan: teamTaskGrantPlan({ attemptId: i.attemptId, agentId: i.taskPins.agentId, manifestHash: i.manifestHash, expiresAt: i.expiresAt }), expiresAt: i.expiresAt,
    ...(i.context ? { context: i.context } : {}) });
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teamtask_schedules(schedule_id TEXT NOT NULL, version INTEGER NOT NULL, definition TEXT NOT NULL, digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('proposed','active','paused','expired','superseded')), label TEXT, proposed_by TEXT NOT NULL, approved_by TEXT,
  approved_at TEXT, approval_op TEXT, expires_at TEXT, coverage TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(schedule_id, version)) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_schedule_occurrences(occurrence_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, version INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('scheduled','manual')), local_date TEXT NOT NULL, due_at TEXT NOT NULL, deadline_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('due','skipped','admitted','result_ready','partial','failed','cancelled','uncertain')), label TEXT,
  task_id TEXT, attempt_id TEXT UNIQUE, inputs TEXT, plan_digest TEXT, manifest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(schedule_id, version, kind, local_date)) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_schedule_budget(occurrence_id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, month TEXT NOT NULL,
  reserved_usd REAL NOT NULL, settled_usd REAL, state TEXT NOT NULL CHECK(state IN ('reserved','settled','held','released')), updated_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_schedule_outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, occurrence_id TEXT NOT NULL, result_version INTEGER NOT NULL,
  kind TEXT NOT NULL, audience TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL, UNIQUE(occurrence_id, result_version, kind)) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_schedule_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;`;

type Row = Record<string, any>;

export class TeamTaskSchedules {
  constructor(private readonly a: SqliteAuthority, private readonly o: { orgId: string; folder: string; store: TeamTasks;
    /** The four pins (C-3) of the code running now. */ pins: () => SchedulePins;
    /** The store's (admitted) budget: a schedule's limits may lower it, never raise it. */ ceiling: Budget;
    memberOf: (memberId: string) => { role: string } | null;
    ledgerRows: (prefix: string) => { key: string; state: string; cost_usd: number | null }[];
    /** Ops config (C-5): schedules switched on, and the org's admitted monthly schedule envelope (null = propose-only). */
    config: () => { run: boolean; envelopeUsd: number | null };
    /** N-5 / chat-first: the org's one model slot is busy (a chat turn or a task). */ busy: () => boolean },
    private readonly now: () => string = () => new Date().toISOString()) {
    a.db.exec(SCHEMA);
    // AGENT-HANDBOOK-V1 H2 (Fable C-A; U-2 additive, PRAGMA-guarded): an incident about a SCHEDULE with no occurrence (a handbook
    // activation pausing it) names the schedule here; occurrence_id then holds a synthetic, unique "handbook:v<N>:<scheduleId>" key.
    if (!(a.db.prepare("PRAGMA table_info(teamtask_schedule_outbox)").all() as { name: string }[]).some((c) => c.name === "schedule_id"))
      a.db.exec("ALTER TABLE teamtask_schedule_outbox ADD COLUMN schedule_id TEXT");
  }
  private nowMs() { return Date.parse(this.now()); }
  private sched(id: string, version: number) { return this.a.db.prepare("SELECT * FROM teamtask_schedules WHERE schedule_id=? AND version=?").get(id, version) as Row | undefined; }
  private def(r: Row) { return scheduleDefSchema.parse(JSON.parse(r.definition)); }
  private pausedAll() { return (this.a.db.prepare("SELECT value FROM teamtask_schedule_meta WHERE key='paused_all'").get() as { value: string } | undefined)?.value === "1"; }
  private setSched(r: Row, state: string, label: string | null) {
    this.a.db.prepare("UPDATE teamtask_schedules SET state=?, label=?, updated_at=? WHERE schedule_id=? AND version=?").run(state, label, this.now(), r.schedule_id, r.version);
  }
  private outbox(occurrenceId: string, kind: string, audience: string, label: string | null, resultVersion = 1) {
    this.a.db.prepare("INSERT OR IGNORE INTO teamtask_schedule_outbox(occurrence_id,result_version,kind,audience,label,created_at) VALUES (?,?,?,?,?,?)")
      .run(occurrenceId, resultVersion, kind, audience, label, this.now());
  }
  /** Pause a schedule with a reason + an admin incident in the outbox (one per occurrence and reason). */
  private pauseFor(r: Row, label: string, occurrenceId: string) {
    if (r.state === "active") this.setSched(r, "paused", label);
    this.outbox(occurrenceId, "incident", "admins", label);
  }

  // ---- proposal, approval, pause, resume -------------------------------------------------------------------------
  /** Session (any member): a schedule version to review (nothing runs). Defaults: 06:00 local (off-peak), America/Chicago,
   *  the store's limits, $1/run, $5/month, 90 days. Editing an active schedule = a new version that pauses it until approved. */
  propose(m: Member, b: any) {
    const allowed = ["scheduleId", "title", "audience", "template", "sources", "recurrence", "mode", "limits", "budget", "endDate"];
    if (!b || typeof b !== "object" || Object.keys(b).some((k) => !allowed.includes(k))) refuse("teamtask_input_invalid");
    const audience = b.audience ?? "members";
    if (audience === "reviewers-private" && !isReviewer(m.role)) refuse("teamtask_scope_not_permitted");
    const rec = b.recurrence ?? {}, nowMs = this.nowMs();
    const timezone = rec.timezone ?? DEFAULT_SCHEDULE_ZONE;
    if (!validZone(timezone)) refuse("teamtask_input_invalid");
    const today = wallAt(timezone, nowMs).date;
    const prior = b.scheduleId !== undefined ? this.a.read(() => this.a.db.prepare("SELECT * FROM teamtask_schedules WHERE schedule_id=? ORDER BY version DESC LIMIT 1").get(String(b.scheduleId))) as Row | undefined : undefined;
    if (b.scheduleId !== undefined && !prior) refuse("teamtask_audience_not_permitted");
    if (prior && prior.proposed_by !== m.memberId && !isReviewer(m.role)) refuse("teamtask_scope_not_permitted");
    const limits = b.limits === undefined ? { ...this.o.ceiling } : b.limits;
    const def = scheduleDefSchema.safeParse({ contract: "kapelle.teamtask-schedule/v1", derivation: SCHEDULE_DERIVATION, orgId: this.o.orgId,
      scheduleId: prior?.schedule_id ?? "tts_" + hex(`${this.o.orgId}:${m.memberId}:${nowMs}:${Math.random()}`).slice(0, 32), version: (prior?.version ?? 0) + 1,
      title: typeof b.title === "string" ? b.title.trim() : b.title, audience,
      template: b.template, sources: b.sources, recurrence: { weekday: rec.weekday, time: rec.time ?? DEFAULT_SCHEDULE_TIME, timezone },
      mode: b.mode ?? "recurring_drafts", limits, budget: b.budget ?? { perRunUsd: Math.min(SCHEDULE_LIMITS.perRunUsd, this.o.ceiling.usd), monthlyUsd: SCHEDULE_LIMITS.monthlyUsd },
      endDate: b.endDate ?? addDays(today, SCHEDULE_LIMITS.horizonDays), pins: this.o.pins(), proposedBy: m.memberId, runtime: runtimeTime() });
    if (!def.success) refuse("teamtask_input_invalid");
    const d = def.data!;
    if (!placeholdersOk(d.template.title) || !placeholdersOk(d.template.notes) || /\n/.test(d.template.title)) refuse("teamtask_input_invalid");
    if (d.sources.roots.some((r) => !rootAllowed(d.audience, r))) refuse("teamtask_schedule_source_refused"); // C-8, at the door too
    if ((Object.keys(this.o.ceiling) as (keyof Budget)[]).some((k) => d.limits[k] > this.o.ceiling[k] || d.limits[k] > (TEAMTASK_CEILING as any)[k])) refuse("teamtask_input_invalid");
    if (d.budget.perRunUsd > d.limits.usd || d.budget.perRunUsd > d.budget.monthlyUsd) refuse("teamtask_input_invalid");
    if (d.endDate <= today || d.endDate > addDays(today, SCHEDULE_LIMITS.horizonDays)) refuse("teamtask_schedule_expired");
    const dg = digest(d);
    this.a.write(() => {
      this.a.db.prepare("INSERT INTO teamtask_schedules(schedule_id,version,definition,digest,state,label,proposed_by,created_at,updated_at) VALUES (?,?,?,?,'proposed',NULL,?,?,?)")
        .run(d.scheduleId, d.version, canonical(d), dg, m.memberId, this.now(), this.now());
      // An edit pauses the version it would replace until the new one is approved (design §1).
      const live = this.a.db.prepare("SELECT * FROM teamtask_schedules WHERE schedule_id=? AND state='active'").all(d.scheduleId) as Row[];
      for (const r of live) this.setSched(r, "paused", "teamtask_schedule_paused");
    });
    if (prior) this.abortRunning(d.scheduleId); // the edit paused the running version
    return this.view(m, d.scheduleId, d.version);
  }
  /** Consequential (session-fresh), reviewers/admins: approve EXACTLY this version (artifact digest = schedule digest). */
  approve(zz: Authorization, m: Member, b: any) {
    if (!isReviewer(m.role)) refuse("teamtask_scope_not_permitted");
    const nowMs = this.nowMs();
    this.a.write(() => {
      const r = this.sched(String(b?.scheduleId ?? ""), Number(b?.version));
      if (!r) refuse("teamtask_audience_not_permitted");
      if (r!.approval_op === zz.operationId) return; // a replay of the same approval
      const d = this.def(r!);
      if (!zz.artifactDigest || zz.artifactDigest !== r!.digest || digest(d) !== r!.digest) refuse("teamtask_plan_changed"); // edited after review
      if (r!.state !== "proposed") refuse("teamtask_claim_consumed");
      if (canonical(d.pins) !== canonical(this.o.pins())) refuse("teamtask_schedule_pin_changed");
      const env = this.o.config().envelopeUsd;
      if (d.mode === "recurring_drafts" && (env === null || d.budget.monthlyUsd > env)) refuse("teamtask_schedule_budget_exhausted"); // no envelope: propose-only
      const active = (this.a.db.prepare("SELECT COUNT(DISTINCT schedule_id) AS n FROM teamtask_schedules WHERE state IN ('active','paused') AND schedule_id<>?").get(d.scheduleId) as { n: number }).n;
      if (active >= SCHEDULE_LIMITS.activePerOrg) refuse("teamtask_queue_full");
      const today = wallAt(d.recurrence.timezone, nowMs).date;
      if (d.endDate <= today || d.endDate > addDays(today, SCHEDULE_LIMITS.horizonDays)) refuse("teamtask_schedule_expired");
      const expiresAt = new Date(localToUtc(addDays(d.endDate, 1), "00:00", d.recurrence.timezone).at).toISOString();
      const prev = this.a.db.prepare("SELECT * FROM teamtask_schedules WHERE schedule_id=? AND version<? AND state IN ('active','paused') ORDER BY version DESC LIMIT 1").get(d.scheduleId, d.version) as Row | undefined;
      if (prev) this.setSched(prev, "superseded", null);
      this.a.db.prepare("UPDATE teamtask_schedules SET state='active', label=NULL, approved_by=?, approved_at=?, approval_op=?, expires_at=?, coverage=?, updated_at=? WHERE schedule_id=? AND version=?")
        .run(zz.memberId, this.now(), zz.operationId, expiresAt, prev?.coverage ?? "{}", this.now(), d.scheduleId, d.version);
    });
    return this.view(m, String(b.scheduleId), Number(b.version));
  }
  /** Fable F-1 (design §4): pausing ABORTS active work through the store's cancellation path; sent work may stay unsettled
   *  (its reservation is then held). One schedule, or every schedule (Pause all, the Ops pause). */
  abortRunning(scheduleId?: string) {
    const rows = this.a.read(() => this.a.db.prepare(`SELECT attempt_id FROM teamtask_schedule_occurrences WHERE state='admitted' AND attempt_id IS NOT NULL${scheduleId ? " AND schedule_id=?" : ""}`)
      .all(...(scheduleId ? [scheduleId] : []))) as Row[];
    return rows.filter((x) => this.o.store.abort(x.attempt_id)).length;
  }
  /** Session: the creator or a reviewer/admin stops new claims of this schedule at once (queued attempts refuse at claim) and
   *  aborts a running one (F-1). */
  pause(m: Member, b: any) {
    this.a.write(() => {
      const r = this.a.db.prepare("SELECT * FROM teamtask_schedules WHERE schedule_id=? AND state='active'").get(String(b?.scheduleId ?? "")) as Row | undefined;
      if (!r) refuse("teamtask_audience_not_permitted");
      if (r!.proposed_by !== m.memberId && !isReviewer(m.role)) refuse("teamtask_scope_not_permitted");
      this.setSched(r!, "paused", "teamtask_schedule_paused");
    });
    this.abortRunning(String(b.scheduleId));
    return { paused: true };
  }
  /** AGENT-HANDBOOK-V1 H2 (D-3): a handbook activation pauses every active schedule, called INSIDE the handbook approve
   *  transaction (no own transaction). Never re-pinned silently: each one needs "Review again" (a new version with the current
   *  pins under its existing caps and end date) and a fresh approval. Returns how many were paused. */
  pauseForHandbook(handbookVersion: number): number {
    const rows = this.a.db.prepare("SELECT * FROM teamtask_schedules WHERE state='active'").all() as Row[];
    for (const r of rows) {
      this.setSched(r, "paused", "teamtask_schedule_pin_changed");
      // Fable C-A: the admin incident, in the SAME transaction (content-free: ids, kind, fixed label).
      this.a.db.prepare("INSERT OR IGNORE INTO teamtask_schedule_outbox(occurrence_id,result_version,kind,audience,label,created_at,schedule_id) VALUES (?,1,'incident','admins','teamtask_schedule_pin_changed',?,?)")
        .run(`handbook:v${handbookVersion}:${r.schedule_id}`, this.now(), r.schedule_id);
    }
    return rows.length;
  }
  /** H2: the active schedules a handbook change would pause (for the review card; titles only, reviewers see them all). */
  activeTitles(): string[] { return (this.a.read(() => this.a.db.prepare("SELECT definition FROM teamtask_schedules WHERE state='active' ORDER BY schedule_id").all()) as Row[]).map((r) => this.def(r).title); }
  /** Session, reviewers/admins: pause EVERY schedule (with Ops' teamTasks.schedules.run, the one kill path, C-5). */
  pauseAll(m: Member) {
    if (!isReviewer(m.role)) refuse("teamtask_scope_not_permitted");
    this.a.write(() => this.a.db.prepare("INSERT INTO teamtask_schedule_meta(key,value) VALUES ('paused_all','1') ON CONFLICT(key) DO UPDATE SET value='1'").run());
    this.abortRunning();
    return { pausedAll: true };
  }
  /** Consequential (session-fresh), reviewers/admins: resume ONE paused schedule (artifact digest = its digest; current pins and
   *  expiry rechecked), or `all: true` to lift "Pause all". Never replays a missed, paused or consumed occurrence. */
  resume(zz: Authorization, m: Member, b: any) {
    if (!isReviewer(m.role)) refuse("teamtask_scope_not_permitted");
    this.a.write(() => {
      if (b?.all === true) { this.a.db.prepare("DELETE FROM teamtask_schedule_meta WHERE key='paused_all'").run(); return; }
      const r = this.a.db.prepare("SELECT * FROM teamtask_schedules WHERE schedule_id=? AND state='paused' ORDER BY version DESC LIMIT 1").get(String(b?.scheduleId ?? "")) as Row | undefined;
      if (!r) refuse("teamtask_audience_not_permitted");
      if (zz.artifactDigest !== r!.digest) refuse("teamtask_plan_changed");
      if (canonical(this.def(r!).pins) !== canonical(this.o.pins())) refuse("teamtask_schedule_pin_changed");
      if (Date.parse(r!.expires_at) <= this.nowMs()) refuse("teamtask_schedule_expired");
      const proposed = this.a.db.prepare("SELECT 1 FROM teamtask_schedules WHERE schedule_id=? AND version>? AND state='proposed'").get(r!.schedule_id, r!.version);
      if (proposed) refuse("teamtask_plan_changed"); // an edit is waiting: approve that version instead
      this.setSched(r!, "active", null);
    });
    return { resumed: true };
  }
  /** Consequential (session-fresh), reviewers/admins: an ordinary run now, attached to the schedule (same admission, the same
   *  monthly budget: a manual run cannot escape it, C-6). */
  runNow(zz: Authorization, m: Member, b: any) {
    if (!isReviewer(m.role)) refuse("teamtask_scope_not_permitted");
    const r = this.a.read(() => this.a.db.prepare("SELECT * FROM teamtask_schedules WHERE schedule_id=? AND state='active'").get(String(b?.scheduleId ?? ""))) as Row | undefined;
    if (!r) refuse("teamtask_audience_not_permitted");
    const nowIso = this.now(), occ = "tso_" + hex(`${r!.schedule_id}:${r!.version}:manual:${zz.operationId}`).slice(0, 32);
    this.a.write(() => this.a.db.prepare(`INSERT OR IGNORE INTO teamtask_schedule_occurrences(occurrence_id,schedule_id,version,kind,local_date,due_at,deadline_at,state,label,created_at,updated_at)
      VALUES (?,?,?,'manual',?,?,?,'due',NULL,?,?)`).run(occ, r!.schedule_id, r!.version, "manual:" + zz.operationId, nowIso, new Date(this.nowMs() + SCHEDULE_LIMITS.lateWindowMs).toISOString(), nowIso, nowIso));
    const res = this.admit(occ);
    return { occurrenceId: occ, state: res };
  }

  // ---- the timer: materialize (model-free) and admit -----------------------------------------------------------------
  /** A wake-up hint (and every restart): record due windows, admit what may run now, finalize what ended. Idempotent. */
  tick() {
    const nowMs = this.nowMs(), out = { materialized: 0, skipped: 0, admitted: 0, waiting: 0 };
    const rows = this.a.read(() => this.a.db.prepare("SELECT * FROM teamtask_schedules WHERE state IN ('active','paused')").all()) as Row[];
    for (const r of rows) {
      const d = this.def(r);
      if (r.state === "active" && Date.parse(r.expires_at) <= nowMs) { this.a.write(() => this.setSched(r, "expired", "teamtask_schedule_expired")); continue; }
      const latest = latestDue(d.recurrence, nowMs);
      if (latest.dueMs < Date.parse(r.approved_at)) continue; // nothing due since approval
      this.a.write(() => {
        const last = (this.a.db.prepare("SELECT MAX(local_date) AS d FROM teamtask_schedule_occurrences WHERE schedule_id=? AND kind='scheduled'").get(d.scheduleId) as { d: string | null }).d;
        if (last && last >= latest.localDate) return; // two ticks, a restart or a backward clock: nothing new
        // Older windows since the last recorded one (or since approval) are Skipped: missed, never a catch-up loop.
        let date = last ? addDays(last, 7) : latest.localDate;
        const firstDue = (dt: string) => localToUtc(dt, d.recurrence.time, d.recurrence.timezone).at;
        if (!last) { while (firstDue(addDays(date, -7)) >= Date.parse(r.approved_at)) date = addDays(date, -7); }
        for (let n = 0; date <= latest.localDate && n < 60; date = addDays(date, 7), n++) {
          const due = firstDue(date), isLatest = date === latest.localDate, fresh = isLatest && nowMs - due <= SCHEDULE_LIMITS.lateWindowMs;
          const stopped = r.state !== "active"; // the kill path (Ops switch, Pause all) leaves it due: it waits until the start deadline
          const state = fresh && !stopped ? "due" : "skipped", label = state === "due" ? null : stopped && fresh ? "teamtask_schedule_paused" : "teamtask_schedule_missed";
          const occ = "tso_" + hex(`${d.scheduleId}:${d.version}:scheduled:${date}`).slice(0, 32);
          const ins = this.a.db.prepare(`INSERT OR IGNORE INTO teamtask_schedule_occurrences(occurrence_id,schedule_id,version,kind,local_date,due_at,deadline_at,state,label,created_at,updated_at)
            VALUES (?,?,?,'scheduled',?,?,?,?,?,?,?)`).run(occ, d.scheduleId, d.version, date, new Date(due).toISOString(), new Date(due + SCHEDULE_LIMITS.lateWindowMs).toISOString(), state, label, this.now(), this.now());
          if (Number(ins.changes)) { if (state === "due") out.materialized++; else out.skipped++; }
        }
        this.missedWarning(d);
      });
    }
    // Admit due occurrences (oldest first); a busy org slot waits (chat first) until the start deadline.
    const due = this.a.read(() => this.a.db.prepare("SELECT occurrence_id, deadline_at FROM teamtask_schedule_occurrences WHERE state='due' ORDER BY due_at, occurrence_id").all()) as Row[];
    for (const o of due) {
      // Fable N-1: a window held back by the kill path reads "paused" in history; one held by a busy slot reads "missed".
      if (Date.parse(o.deadline_at) < nowMs) { const killed = !this.o.config().run || this.a.read(() => this.pausedAll());
        this.a.write(() => this.setOcc(o.occurrence_id, "skipped", killed ? "teamtask_schedule_paused" : "teamtask_schedule_missed")); out.skipped++; continue; }
      const res = this.admit(o.occurrence_id);
      if (res === "admitted") out.admitted++; else if (res === "waiting") out.waiting++; else out.skipped++;
    }
    this.sync();
    return out;
  }
  /** Three consecutive missed/busy windows -> one in-app warning (keyed by the third occurrence). */
  private missedWarning(d: ScheduleDef) {
    const last3 = this.a.db.prepare("SELECT occurrence_id, state, label FROM teamtask_schedule_occurrences WHERE schedule_id=? AND kind='scheduled' ORDER BY local_date DESC LIMIT 3").all(d.scheduleId) as Row[];
    if (last3.length === 3 && last3.every((x) => x.state === "skipped" && x.label === "teamtask_schedule_missed")) this.outbox(last3[0].occurrence_id, "missed_warning", "reviewers", "teamtask_schedule_missed");
  }
  private setOcc(id: string, state: string, label: string | null, extra: Record<string, unknown> = {}) {
    const cols = Object.keys(extra);
    this.a.db.prepare(`UPDATE teamtask_schedule_occurrences SET state=?, label=?, updated_at=?${cols.map((c) => `, ${c}=?`).join("")} WHERE occurrence_id=?`)
      .run(state, label, this.now(), ...cols.map((c) => extra[c] as any), id);
  }
  /** Admission: every check, the frozen snapshot, the reservation, the ordinary task + plan, the derived approval. */
  private admit(occurrenceId: string): "admitted" | "waiting" | "skipped" {
    const o = this.a.read(() => this.a.db.prepare("SELECT * FROM teamtask_schedule_occurrences WHERE occurrence_id=?").get(occurrenceId)) as Row;
    if (!o || o.state !== "due") return "skipped";
    const r = this.a.read(() => this.sched(o.schedule_id, o.version))!, d = this.def(r);
    const skip = (label: string, pause = false) => { this.a.write(() => { this.setOcc(occurrenceId, "skipped", label); if (pause) this.pauseFor(r, label, occurrenceId); }); return "skipped" as const; };
    if (!this.o.config().run || this.pausedAll()) return "waiting"; // the kill path: nothing new starts; the deadline still applies
    if (r.state !== "active") return skip(r.state === "expired" ? "teamtask_schedule_expired" : "teamtask_schedule_paused");
    if (Date.parse(r.expires_at) <= this.nowMs()) return skip("teamtask_schedule_expired");
    if (canonical(d.pins) !== canonical(this.o.pins())) return skip("teamtask_schedule_pin_changed", true);
    const sponsor = this.o.memberOf(r.approved_by);
    if (!sponsor || !isReviewer(sponsor.role)) return skip("teamtask_scope_not_permitted", true); // sponsor removed / demoted
    const inFlight = this.a.read(() => this.a.db.prepare("SELECT 1 FROM teamtask_schedule_occurrences WHERE schedule_id=? AND state='admitted' AND occurrence_id<>?").get(o.schedule_id, occurrenceId));
    if (inFlight || this.o.busy()) return "waiting"; // one per schedule; the org slot (chat first)
    // Freeze NOW (admission), not at wake-up: a preliminary snapshot decides "no new notes" with zero model calls.
    let files: { path: string; sha256: string }[];
    try { files = [...takeSnapshot(this.o.folder, d.audience === "reviewers-private" ? "reviewer" : "member", r.approved_by, occurrenceId).files.values()].map((f) => ({ path: f.path, sha256: "sha256:" + f.sha256 })); }
    catch { return skip("teamtask_schedule_source_refused"); } // over the bounds: refuse, never truncate
    const coverage = JSON.parse(r.coverage) as Record<string, string>;
    let sel: ReturnType<typeof selectSources>;
    try { sel = selectSources(d, files, coverage); } catch { return skip("teamtask_schedule_source_refused", true); } // C-8: a rule mistake
    if (!sel.inRule.length) return skip("teamtask_schedule_source_refused"); // the rule's collections are empty or missing
    if (!sel.selected.length) return skip("teamtask_schedule_no_new_sources"); // quiet: zero model calls
    // Reserve the full per-run allowance against the schedule's UTC month and the org envelope, atomically (C-6).
    const month = this.now().slice(0, 7);
    const reserved = this.a.write(() => {
      const used = (sid: string | null) => (this.a.db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN settled_usd WHEN state='released' THEN 0 ELSE reserved_usd END),0) AS n
        FROM teamtask_schedule_budget WHERE month=?${sid ? " AND schedule_id=?" : ""}`).get(...(sid ? [month, sid] : [month])) as { n: number }).n;
      const env = this.o.config().envelopeUsd ?? 0;
      if (used(d.scheduleId) + d.budget.perRunUsd > d.budget.monthlyUsd + 1e-9 || used(null) + d.budget.perRunUsd > env + 1e-9) {
        this.setOcc(occurrenceId, "skipped", "teamtask_schedule_budget_exhausted"); this.pauseFor(r, "teamtask_schedule_budget_exhausted", occurrenceId); return false;
      }
      this.a.db.prepare("INSERT INTO teamtask_schedule_budget(occurrence_id,schedule_id,month,reserved_usd,settled_usd,state,updated_at) VALUES (?,?,?,?,NULL,'reserved',?)")
        .run(occurrenceId, d.scheduleId, month, d.budget.perRunUsd, this.now());
      return true;
    });
    if (!reserved) return "skipped";
    const release = () => this.a.write(() => this.a.db.prepare("UPDATE teamtask_schedule_budget SET state='released', updated_at=? WHERE occurrence_id=?").run(this.now(), occurrenceId));
    // The ordinary task (the sponsor's), its title/notes from the template by allowlisted substitution only.
    const prior = this.a.read(() => this.a.db.prepare("SELECT MAX(local_date) AS d FROM teamtask_schedule_occurrences WHERE schedule_id=? AND kind='scheduled' AND state='result_ready'").get(d.scheduleId)) as { d: string | null };
    const date = o.kind === "manual" ? wallAt(d.recurrence.timezone, this.nowMs()).date : o.local_date;
    const values = { date, since: prior.d ?? "the start", until: addDays(date, UNTIL_DAYS), occurrence: occurrenceId };
    const { title, notes } = derivedText(d, values);
    const sponsorMember = { memberId: r.approved_by, role: sponsor.role };
    const task = this.o.store.create(sponsorMember, { clientRequestId: "sch-" + occurrenceId.slice(4, 40), title, notes, audience: d.audience });
    let p: { attemptId: string; planDigest: string; plan: Plan };
    try {
      // The SAME propose (C-2); the rule applied to ITS frozen snapshot, so "new notes" match exactly what is frozen.
      p = this.o.store.propose(sponsorMember, { taskId: task.taskId, expectedRevision: 1 }, { budget: d.limits, emptyLabel: "teamtask_schedule_no_new_sources", expiresBefore: o.deadline_at,
        filter: (path, h) => inRule(d, path) && (d.sources.rule === "current" || coverage[path] !== h) });
    } catch (e) {
      this.o.store.abandon(task.taskId); release();
      const label = e instanceof AccessError ? e.reason : "teamtask_plan_changed";
      if (label === "teamtask_plan_changed") return "waiting"; // a file changed mid-snapshot: freeze again on the next tick
      return skip(label === "teamtask_schedule_no_new_sources" ? label : "teamtask_schedule_source_refused");
    }
    const plan = p.plan;
    // Fable C-C (H2): with the handbook on, the occurrence's plan must carry EXACTLY the handbook this schedule's reviewer approved.
    if (d.pins.handbook !== undefined && canonical(plan.context?.handbook ?? null) !== canonical(d.pins.handbook ?? null)) {
      this.o.store.abandon(task.taskId); release(); return skip("teamtask_schedule_pin_changed", true); }
    const inputs: DerivationInputs = { derivation: SCHEDULE_DERIVATION, scheduleId: d.scheduleId, version: d.version, scheduleDigest: r.digest, occurrenceId, localDate: o.local_date,
      substitutions: values, title, notes, orgId: this.o.orgId, taskId: task.taskId, attemptId: p.attemptId, expiresAt: plan.expiresAt, audience: plan.audience,
      roots: plan.sources.roots, manifestHash: plan.sources.manifestHash, files: plan.sources.files, bytes: plan.sources.bytes, budget: plan.budget, taskPins: plan.pins, context: plan.context ?? null };
    if (planDigest(derivePlan(inputs)) !== p.planDigest) { this.o.store.abandon(task.taskId); release(); return skip("teamtask_plan_changed"); } // C-1: replayable or nothing
    this.a.write(() => this.setOcc(occurrenceId, "admitted", null, { task_id: task.taskId, attempt_id: p.attemptId, inputs: canonical(inputs), plan_digest: p.planDigest,
      manifest: canonical(this.o.store.manifestOf(p.attemptId)) }));
    if (d.mode === "recurring_drafts" || o.kind === "manual") {
      try { this.o.store.approveDerived(p.attemptId, r.approved_by, occurrenceId, p.planDigest); }
      catch (e) { this.a.write(() => this.setOcc(occurrenceId, "failed", e instanceof AccessError ? e.reason : "teamtask_plan_changed")); this.settle(occurrenceId, p.attemptId); return "skipped"; }
    }
    return "admitted";
  }

  // ---- the gate the store asks before claim and every provider/tool step (C-3, C-5) -----------------------------------
  gate(attemptId: string): string | null {
    const o = this.a.db.prepare("SELECT * FROM teamtask_schedule_occurrences WHERE attempt_id=?").get(attemptId) as Row | undefined;
    if (!o) return null; // not a schedule's attempt
    const r = this.sched(o.schedule_id, o.version);
    if (!r) return "teamtask_schedule_paused";
    if (!this.o.config().run || this.pausedAll()) return "teamtask_schedule_paused";
    if (r.state === "expired" || Date.parse(r.expires_at) <= this.nowMs()) return "teamtask_schedule_expired";
    if (r.state !== "active") return "teamtask_schedule_paused";
    if (canonical(this.def(r).pins) !== canonical(this.o.pins())) return "teamtask_schedule_pin_changed";
    return this.replayOk(o, r) ? null : "teamtask_plan_changed";
  }
  /** C-1: the stored inputs recompute the stored plan digest, title/notes come from THIS schedule version's template and
   *  substitutions, and the schedule row itself is unedited. */
  private replayOk(o: Row, r: Row) {
    try {
      const i = JSON.parse(o.inputs) as DerivationInputs, d = this.def(r);
      if (digest(d) !== r.digest || i.scheduleDigest !== r.digest || i.occurrenceId !== o.occurrence_id) return false;
      if (i.derivation !== SCHEDULE_DERIVATION || i.scheduleId !== o.schedule_id || i.version !== o.version || i.localDate !== o.local_date || i.orgId !== this.o.orgId
        || i.taskId !== o.task_id || i.attemptId !== o.attempt_id || i.audience !== d.audience || i.substitutions.occurrence !== o.occurrence_id
        || (o.kind === "scheduled" && i.substitutions.date !== o.local_date) || i.substitutions.until !== addDays(i.substitutions.date, UNTIL_DAYS)) return false; // every input is bound to its record
      const t = derivedText(d, i.substitutions);
      if (t.title !== i.title || t.notes !== i.notes) return false;
      if (canonical(i.budget) !== canonical(budgetSchema.parse(d.limits))) return false;
      return planDigest(derivePlan(i)) === o.plan_digest;
    } catch { return false; }
  }
  /** Offline replay (C-1) for Ops and tests: recompute and compare. */
  replay(occurrenceId: string) {
    return this.a.read(() => {
      const o = this.a.db.prepare("SELECT * FROM teamtask_schedule_occurrences WHERE occurrence_id=?").get(occurrenceId) as Row | undefined;
      if (!o || !o.inputs) return { ok: false, planDigest: null };
      const r = this.sched(o.schedule_id, o.version)!;
      return { ok: this.replayOk(o, r), planDigest: o.plan_digest as string, recomputed: planDigest(derivePlan(JSON.parse(o.inputs))) };
    });
  }

  // ---- the end of an occurrence's attempt: coverage, budget, notification, pause ------------------------------------
  onAttemptEnd(attemptId: string) {
    const o = this.a.read(() => this.a.db.prepare("SELECT occurrence_id FROM teamtask_schedule_occurrences WHERE attempt_id=?").get(attemptId)) as Row | undefined;
    if (o) this.finalize(o.occurrence_id);
  }
  /** Reconcile every admitted occurrence with its attempt (after restarts and refused claims too). */
  sync() {
    const rows = this.a.read(() => this.a.db.prepare("SELECT occurrence_id FROM teamtask_schedule_occurrences WHERE state='admitted'").all()) as Row[];
    for (const x of rows) this.finalize(x.occurrence_id);
  }
  private finalize(occurrenceId: string) {
    const o = this.a.read(() => this.a.db.prepare("SELECT * FROM teamtask_schedule_occurrences WHERE occurrence_id=?").get(occurrenceId)) as Row;
    if (!o || o.state !== "admitted" || !o.attempt_id) return;
    const att = this.a.read(() => this.a.db.prepare("SELECT state, label, partial FROM teamtask_attempts WHERE attempt_id=?").get(o.attempt_id)) as Row | undefined;
    if (!att || ["proposed", "approved", "running"].includes(att.state)) return;
    const r = this.a.read(() => this.sched(o.schedule_id, o.version))!, d = this.def(r);
    this.a.write(() => {
      const cur = this.a.db.prepare("SELECT state FROM teamtask_schedule_occurrences WHERE occurrence_id=?").get(occurrenceId) as Row;
      if (cur.state !== "admitted") return; // finalized once
      if (att.state === "result_ready" && !att.partial) {
        // The ONLY place the coverage watermark advances: a full, non-partial, verified result (a human's Done is independent).
        const cov = { ...JSON.parse(r.coverage), ...Object.fromEntries((JSON.parse(o.manifest ?? "[]") as [string, string, number][]).map(([p, h]) => [p, h])) };
        if (o.kind === "scheduled" || d.sources.rule === "new") this.a.db.prepare("UPDATE teamtask_schedules SET coverage=?, updated_at=? WHERE schedule_id=? AND version=?").run(canonical(cov), this.now(), r.schedule_id, r.version);
        this.setOcc(occurrenceId, "result_ready", null);
        this.outbox(occurrenceId, "result_ready", d.audience, null);
      } else if (att.state === "result_ready") {
        this.setOcc(occurrenceId, "partial", att.partial); this.pauseFor(r, "teamtask_schedule_paused", occurrenceId); // partial: never a completed draft
      } else if (att.state === "needs_reconciliation") {
        this.setOcc(occurrenceId, "uncertain", att.label); this.pauseFor(r, "teamtask_schedule_paused", occurrenceId);
      } else if (att.state === "cancelled") {
        this.setOcc(occurrenceId, "cancelled", att.label);
      } else {
        this.setOcc(occurrenceId, "failed", att.label);
        const authority = ["teamtask_schedule_pin_changed", "teamtask_scope_not_permitted", "teamtask_schedule_budget_exhausted", "teamtask_schedule_expired"].includes(att.label);
        if (authority) this.pauseFor(r, att.label === "teamtask_schedule_pin_changed" ? att.label : "teamtask_schedule_paused", occurrenceId);
        else if (att.label !== "teamtask_schedule_paused") this.outbox(occurrenceId, "failure", "reviewers", att.label);
      }
    });
    this.settle(occurrenceId, o.attempt_id);
  }
  /** Settle the reservation from the hosted ledger: all rows definitive -> actual cost (the rest released); any unknown -> held. */
  private settle(occurrenceId: string, attemptId: string) {
    const rows = this.o.ledgerRows(`teamtask:${attemptId}:`);
    const unknown = rows.some((x) => !["settled", "released"].includes(x.state));
    const cost = Math.round(rows.reduce((n, x) => n + (x.state === "settled" ? x.cost_usd ?? 0 : 0), 0) * 1e6) / 1e6;
    this.a.write(() => this.a.db.prepare("UPDATE teamtask_schedule_budget SET state=?, settled_usd=?, updated_at=? WHERE occurrence_id=? AND state='reserved'")
      .run(unknown ? "held" : "settled", unknown ? null : cost, this.now(), occurrenceId));
  }

  // ---- read model ------------------------------------------------------------------------------------------------------
  private canSee(m: Member, audience: string) { return audience === "members" || isReviewer(m.role); }
  private view(m: Member, scheduleId: string, version?: number) {
    return this.a.read(() => {
      const r = (version !== undefined ? this.sched(scheduleId, version) : this.a.db.prepare("SELECT * FROM teamtask_schedules WHERE schedule_id=? ORDER BY version DESC LIMIT 1").get(scheduleId)) as Row | undefined;
      if (!r) refuse("teamtask_audience_not_permitted");
      const d = this.def(r!);
      if (!this.canSee(m, d.audience)) refuse("teamtask_audience_not_permitted"); // unknown and inaccessible share the refusal
      const next = nextDue(d.recurrence, this.nowMs(), 3).map((x) => ({ localDate: x.localDate, dueAt: new Date(x.dueMs).toISOString(), adjust: x.adjust }));
      const hour = Number(d.recurrence.time.slice(0, 2));
      const occurrences = this.a.db.prepare("SELECT occurrence_id, kind, local_date, due_at, state, label, task_id FROM teamtask_schedule_occurrences WHERE schedule_id=? ORDER BY due_at DESC LIMIT 20").all(d.scheduleId) as Row[];
      const month = this.now().slice(0, 7), spent = this.a.db.prepare(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN settled_usd WHEN state='released' THEN 0 ELSE reserved_usd END),0) AS n
        FROM teamtask_schedule_budget WHERE schedule_id=? AND month=?`).get(d.scheduleId, month) as { n: number };
      return { contract: "kapelle.team-task-schedule/v1", scheduleId: d.scheduleId, version: d.version, digest: r!.digest, state: r!.state, label: r!.label, definition: d,
        approvedBy: r!.approved_by ?? null, approvedAt: r!.approved_at ?? null, expiresAt: r!.expires_at ?? null, next,
        offPeak: hour < BUSY_HOURS.from || hour >= BUSY_HOURS.to, chatWaitNote: hour < BUSY_HOURS.from || hour >= BUSY_HOURS.to ? null : "A run at this time can make a live chat answer wait up to 8 minutes.",
        budget: { month, usedUsd: Math.round(spent.n * 1e6) / 1e6, monthlyUsd: d.budget.monthlyUsd, resetsUtc: true },
        occurrences: occurrences.map((x) => ({ occurrenceId: x.occurrence_id, kind: x.kind, localDate: x.kind === "manual" ? null : x.local_date, dueAt: x.due_at, state: x.state, label: x.label, taskId: x.task_id ?? null })) };
    });
  }
  read(m: Member, b: any) { return this.view(m, String(b?.scheduleId ?? ""), b?.version === undefined ? undefined : Number(b.version)); }
  /** S2: the schedules this member may see, the shared runner fact (the same busy/queued fact as the task list), and the
   *  member's in-app notifications: the schedule's own name and date, inside its audience (ids, kind, fixed label, time; never result
   *  or model text), only for the audiences the member is in now. */
  list(m: Member) {
    const ids = this.a.read(() => this.a.db.prepare("SELECT schedule_id, MAX(version) AS v, MAX(updated_at) AS u FROM teamtask_schedules GROUP BY schedule_id ORDER BY u DESC LIMIT 50").all()) as Row[];
    const out = [];
    for (const x of ids) { try { out.push(this.view(m, x.schedule_id, x.v)); } catch { /* not visible to this member */ } }
    const cfg = this.o.config();
    return { schedules: out, pausedAll: this.a.read(() => this.pausedAll()),
      // Fable S2 N-1: the Ops envelope is an Ops/admin fact: reviewers and admins only.
      runner: { run: cfg.run, ...(isReviewer(m.role) ? { envelopeUsd: cfg.envelopeUsd } : {}), busy: this.o.busy(), due: (this.a.read(() => this.a.db.prepare("SELECT COUNT(*) AS n FROM teamtask_schedule_occurrences WHERE state='due'").get()) as { n: number }).n },
      notifications: this.notificationsFor(m),
      // S3: the editor's choices (the same validation applies to whatever is proposed).
      templates: SCHEDULE_TEMPLATES, collections: SCHEDULE_COLLECTIONS.filter((x) => x.audience === "members" || isReviewer(m.role)) };
  }
  /** The audiences a member's CURRENT role reads (rechecked on every read; a demoted reviewer stops seeing reviewer items). */
  private audiencesOf(m: Member) { return m.role === "admin" ? ["members", "reviewers", "reviewers-private", "admins"] : isReviewer(m.role) ? ["members", "reviewers", "reviewers-private"] : ["members"]; }
  private notificationsFor(m: Member) {
    const since = new Date(this.nowMs() - NOTIFICATION_DAYS * 86_400_000).toISOString(), aud = this.audiencesOf(m);
    // Director render review: a notice names its schedule (the reviewer-approved title, never model text) and the run's local
    // date, so two notices can be told apart. Only for a member who may see that schedule (its audience, rechecked here).
    // H2 (C-A): an incident about a schedule with no occurrence (a handbook activation) carries schedule_id; its latest version names it.
    return (this.a.read(() => this.a.db.prepare(`SELECT x.seq, x.occurrence_id, x.kind, x.audience, x.label, x.created_at, COALESCE(o.schedule_id, x.schedule_id) AS sid, o.task_id, o.kind AS okind,
      o.local_date, o.due_at, s.definition FROM teamtask_schedule_outbox x LEFT JOIN teamtask_schedule_occurrences o ON o.occurrence_id=x.occurrence_id
      JOIN teamtask_schedules s ON s.schedule_id=COALESCE(o.schedule_id, x.schedule_id)
        AND s.version=COALESCE(o.version, (SELECT MAX(version) FROM teamtask_schedules v WHERE v.schedule_id=x.schedule_id))
      WHERE x.created_at>=? ORDER BY x.seq DESC LIMIT 50`).all(since)) as Row[])
      .filter((x) => aud.includes(x.audience)).slice(0, 20)
      .map((x) => { const d = scheduleDefSchema.parse(JSON.parse(x.definition)), seen = this.canSee(m, d.audience);
        return { id: x.seq, kind: x.kind, label: x.label, at: x.created_at, scheduleId: x.sid, occurrenceId: x.okind ? x.occurrence_id : null,
          title: seen ? d.title : null, localDate: x.okind === "scheduled" ? x.local_date : wallAt(d.recurrence.timezone, Date.parse(x.due_at ?? x.created_at)).date,
          taskId: x.kind === "result_ready" || x.kind === "failure" ? x.task_id ?? null : null }; });
  }
  /** S2 (Fable N-3), Ops only, via /ops/teamtasks/reconcile: settle HELD reservations whose ledger rows are now all definitive.
   *  Budget rows only: it never restores a consumed occurrence, never reruns and never advances coverage. */
  settleHeld() {
    const held = this.a.read(() => this.a.db.prepare("SELECT b.occurrence_id, o.attempt_id FROM teamtask_schedule_budget b JOIN teamtask_schedule_occurrences o ON o.occurrence_id=b.occurrence_id WHERE b.state='held'").all()) as Row[];
    let settled = 0;
    for (const h of held) {
      const rows = this.o.ledgerRows(`teamtask:${h.attempt_id}:`);
      if (rows.some((x) => !["settled", "released"].includes(x.state))) continue;
      const cost = Math.round(rows.reduce((n, x) => n + (x.state === "settled" ? x.cost_usd ?? 0 : 0), 0) * 1e6) / 1e6;
      settled += Number(this.a.write(() => this.a.db.prepare("UPDATE teamtask_schedule_budget SET state='settled', settled_usd=?, updated_at=? WHERE occurrence_id=? AND state='held'").run(cost, this.now(), h.occurrence_id)).changes);
    }
    return { held: held.length, settled };
  }
  /** Content-free outbox rows for the given audiences (tests and Ops). */
  outboxFor(audiences: string[]) {
    return this.a.read(() => (this.a.db.prepare("SELECT occurrence_id, result_version, kind, audience, label, created_at FROM teamtask_schedule_outbox ORDER BY seq").all() as Row[]).filter((x) => audiences.includes(x.audience)));
  }
}
