// TEAM-TASKS-V1 T1 (design of record 9320d2e5; Fable F-1/F-2, N-1..N-6): team tasks in the org's own SQLite store (additive
// tables, the existing writer transaction; no second database, no transaction across I/O).
// - create (session): a member's typed title + notes only (F-1: chat history, chat images, flyer proposals and draft artifacts
//   are not adoptable; picked text uploads arrive with T2's disclosure), deduplicated by the creator's client request id.
// - propose (session): an immutable plan version from the task's own title/notes (prepare-only, e93d7aec), its sources FROZEN
//   (bytes copied into the task store, content-addressed, by the audience's roots), the live pins, the budget and the grant plan.
// - approve (consequential, session-fresh; reviewers/admins): artifact digest = plan digest; task revision, expiry and live
//   pins rechecked; one approval per attempt (UNIQUE), a replay of the same operation returns the same result; the queue is
//   bounded. Receipts to the actor and every admin (N-1).
// - claim (runtime): ONE transaction rechecks approver membership, task revision, expiry, kill switch and live pins, consumes
//   the approval, materializes exactly the planned grants and inserts the UNIQUE run; the live pin over the materialized grants
//   must equal the approved pin, else nothing is dispatched (b2efd132 parity).
// - run: the executor (T1: injected; T2: the shared bounded runner) sees only the frozen sources and one result write, both
//   behind the materialized grants. Result ready ONLY after an independent read-back of the envelope (bindings, kind,
//   SHA-256, length); a mismatch records expected-vs-read fields (N-4) and holds the attempt in Needs reconciliation.
// - A claimed attempt never restarts inference after a crash (recover -> Needs reconciliation); approved-but-unclaimed
//   attempts are safe to claim. Uncertain history blocks new attempts (3de91335 parity). Ops reconcile (N-6) re-reads durable
//   evidence and applies the normal verifier; an assertion alone never unlocks a claim.
// - complete (consequential, session-fresh): creator or reviewer/admin; binds the displayed result digest and task revision.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, digest } from "../../content.js";
import { AccessError, type Authorization } from "../../access/org-access.js";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { failureLabel, persistedReason } from "../../task-delegation/failure-labels.js";
import { takeSnapshot } from "../chat/tools.js";
import { PRIOR_RESULT_EXCERPT_CHARS, TEAMTASK_INLINE_BYTES, budgetSchema, revisedInstructions, type PlanContext } from "./contract.js";
import { systemMap, type ContextHandbook, type ContextMap, type MapFeatures } from "../handbook/context.js";
import { AUDIENCES, TEAMTASK_LIMITS, approvedPin, grantPlanValid, pinOf, planDigest, planSchema, resultDigest, resultEnvelopeSchema, teamTaskGrantPlan,
  teamTaskRecommendation, type Audience, type Budget, type Pins, type Plan, type ResultEnvelope } from "./contract.js";

export { TEAMTASK_REASONS } from "./labels.js";
const sha = (b: Buffer | string) => "sha256:" + createHash("sha256").update(b).digest("hex");
const refuse = (label: string): never => { throw new AccessError(label); };
const id = (p: string) => p + randomBytes(16).toString("hex");
export type TeamMember = { memberId: string; role: string };
/** SCHEDULED-TASKS-V1 S1: how a schedule derives a plan through the SAME propose (Fable C-2): a lower budget, its source rule as
 *  a filter over the same frozen snapshot, an earlier expiry (its start deadline), and the label when nothing is selected. */
export type ProposeOptions = { budget?: Budget; filter?: (path: string, sha256: string) => boolean; expiresBefore?: string; emptyLabel?: string };
/** An executor outcome other than a written result: a definitive failure, an uncertain one (a request may have been sent),
 *  or a cancellation. Labels are fixed (persisted through failure-labels). */
export class TeamTaskEnd extends Error { constructor(readonly label: string, readonly state: "failed" | "uncertain" | "cancelled") { super(label); this.name = "TeamTaskEnd"; } }
export type TeamTaskRun = { attemptId: string; taskId: string; plan: Plan; signal: AbortSignal; grants: string[];
  /** The frozen sources (manifest order); readable only through the materialized read grant. */
  sources(): { path: string; text: string }[];
  /** The ONE result write (text), only through the materialized result grant. `partial`: the content-free label of why the
   *  result is a kept partial (long output), recorded on the attempt. */
  writeResult(text: string, partial?: string): void;
  /** T2 (design: "recheck access/revocation, expiry, kill switch before every model/tool step"): the approver is still a
   *  reviewer/admin, the task is open at the plan's revision, the plan has not expired and Ops has not paused tasks. */
  stillAuthorized(): boolean;
  /** Fable T2a N-2: WHY the run may no longer continue (null = it may): the precise fixed label for the stop. */
  authorization(): string | null;
  /** AGENT-HANDBOOK-V1 H1 (C-3): the plan's approved handbook (immutable version, re-hashed) and its stored system map (re-hashed);
   *  null when the plan has no context (feature off). A mismatch ends the run (handbook_changed / system_map_unavailable). */
  context?(): { handbook: ContextHandbook; map: ContextMap } | null };
export type TeamTaskExecutor = { id: string; run(r: TeamTaskRun): Promise<void> };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS teamtasks(id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, client_request_id TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL,
  audience TEXT NOT NULL CHECK(audience IN ('members','reviewers-private')), revision INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','done','cancelled')),
  done_by TEXT, done_at TEXT, done_result_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(creator_id, client_request_id)) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_plans(attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, version INTEGER NOT NULL, plan TEXT NOT NULL, plan_digest TEXT NOT NULL,
  proposed_by TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(task_id, version)) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_attempts(attempt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('proposed','superseded','approved','running','result_ready','failed','cancelled','needs_reconciliation')),
  label TEXT, updated_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_approvals(operation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, plan_digest TEXT NOT NULL, approver_id TEXT NOT NULL,
  access_table_hash TEXT NOT NULL, approved_at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_grants(grant_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, grant_json TEXT NOT NULL, materialized_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_runs(claim_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, started_at TEXT NOT NULL, ended_at TEXT, expected TEXT) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_results(result_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL, envelope TEXT NOT NULL, result_digest TEXT NOT NULL,
  verified_at TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, attempt_id TEXT, at TEXT NOT NULL, actor TEXT NOT NULL,
  event TEXT NOT NULL, label TEXT, detail TEXT) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS teamtask_inputs(task_id TEXT NOT NULL, name TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, from_upload TEXT NOT NULL, PRIMARY KEY(task_id, name)) STRICT;`;

export class TeamTasks {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly running = new Map<string, AbortController>();
  constructor(private readonly a: SqliteAuthority, private readonly o: { orgId: string; folder: string; stateRoot: string; pins: () => Pins; budget: Budget;
    executor: TeamTaskExecutor | null;
    /** The independent read path of a written result (default: the file on disk; tests inject a tampered read). */
    readBack?: (path: string) => Buffer | null;
    /** The org's hosted ledger rows of one attempt (Ops reconcile evidence for a definitive failure). */
    ledgerRows?: (prefix: string) => { key: string; state: string; cost_usd: number | null }[];
    memberOf: (memberId: string) => { role: string } | null;
    /** N-5: the org's ONE model slot is shared with chat: while a chat turn is queued/running no attempt is claimed. */
    modelBusy?: () => boolean;
    /** T2b (F-1): one of the member's own text uploads (owner-only, hash re-checked) for "Make this a task". */
    upload?: (memberId: string, uploadId: unknown) => { uploadId: string; name: string; bytes: Buffer; sha256: string };
    /** SCHEDULED-TASKS-V1 S1 (Fable C-3/C-5): a schedule-associated attempt's extra gate (paused / kill / expired / pin_changed /
     *  replay mismatch), checked at claim AND inside authorization(), i.e. before every provider and tool step. null = may run. */
    scheduleGate?: (attemptId: string) => string | null;
    /** S1: an attempt reached a terminal or held state (result_ready / failed / cancelled / needs_reconciliation). */
    onAttemptEnd?: (attemptId: string) => void;
    /** AGENT-HANDBOOK-V1 H1: present ONLY when org.json handbook is enabled. The active approved handbook, an exact version, and
     *  the installed features the system map states. Absent = plans carry no context and prompts are today's. */
    context?: { handbook: () => ContextHandbook | null; handbookVersion: (version: number) => ContextHandbook | null; features: () => MapFeatures } },
    private readonly now: () => string = () => new Date().toISOString()) {
    a.db.exec(SCHEMA);
    // Long output (Fable ab150875 Q2; U-2 additive): a result kept after a cut-off records why (a content-free label), else NULL.
    if (!(a.db.prepare("PRAGMA table_info(teamtask_attempts)").all() as { name: string }[]).some((c) => c.name === "partial")) a.db.exec("ALTER TABLE teamtask_attempts ADD COLUMN partial TEXT");
    // SCHEDULED-TASKS-V1 S1 (U-2 additive): an approval DERIVED from a standing schedule says so (kind 'schedule' + the occurrence id).
    const ap = new Set((a.db.prepare("PRAGMA table_info(teamtask_approvals)").all() as { name: string }[]).map((c) => c.name));
    if (!ap.has("kind")) a.db.exec("ALTER TABLE teamtask_approvals ADD COLUMN kind TEXT");
    if (!ap.has("ref")) a.db.exec("ALTER TABLE teamtask_approvals ADD COLUMN ref TEXT");
  }
  private dir(attemptId: string) { return join(this.o.stateRoot, "teamtasks", attemptId); }
  private event(taskId: string, attemptId: string | null, actor: string, event: string, label: string | null = null, detail: unknown = null) {
    this.a.db.prepare("INSERT INTO teamtask_events(task_id,attempt_id,at,actor,event,label,detail) VALUES (?,?,?,?,?,?,?)")
      .run(taskId, attemptId, this.now(), actor, event, label === null ? null : persistedReason(failureLabel(new Error(label))), detail === null ? null : JSON.stringify(detail));
  }
  private setAttempt(attemptId: string, state: string, label: string | null) {
    this.a.db.prepare("UPDATE teamtask_attempts SET state=?, label=?, revision=revision+1, updated_at=? WHERE attempt_id=?")
      .run(state, label === null ? null : persistedReason(failureLabel(new Error(label))), this.now(), attemptId);
  }
  private canSee(m: TeamMember, audience: string) { return audience === "members" || ["admin", "reviewer"].includes(m.role); }
  private task(m: TeamMember, taskId: unknown) {
    const t = typeof taskId === "string" && /^tt_[a-f0-9]{32}$/.test(taskId) ? this.a.db.prepare("SELECT * FROM teamtasks WHERE id=?").get(taskId) as Record<string, any> | undefined : undefined;
    // Unknown and inaccessible ids share one refusal (no existence oracle).
    if (!t || !this.canSee(m, t.audience)) refuse("teamtask_audience_not_permitted");
    return t!;
  }
  private killed() { return (this.a.db.prepare("SELECT value FROM teamtask_meta WHERE key='paused'").get() as { value: string } | undefined)?.value === "1"; }

  /** T2b (F-1): what "Make this a task" will share, computed by the runtime: the typed title/notes (sizes + hashes), the picked
   *  text uploads (name, size, sha256; at most 5), the audience and who that is. The member confirms THIS digest. */
  private disclosure(m: TeamMember, b: any) {
    const keys = Object.keys(b ?? {});
    if (keys.some((k) => !["clientRequestId", "title", "notes", "audience", "uploads", "disclosureDigest"].includes(k))) refuse("teamtask_adoption_refused"); // no images, proposals, chats, artifacts
    const clean = (v: unknown) => typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim() : "";
    const title = clean(b?.title), notes = clean(b?.notes ?? "");
    if (!title || title.length > TEAMTASK_LIMITS.titleMax || /\n/.test(title) || notes.length > TEAMTASK_LIMITS.notesMax) refuse("teamtask_input_invalid");
    const audience: Audience = b?.audience === undefined ? "members" : (AUDIENCES as readonly string[]).includes(b.audience) ? b.audience : refuse("teamtask_input_invalid");
    if (audience === "reviewers-private" && !["admin", "reviewer"].includes(m.role)) refuse("teamtask_scope_not_permitted");
    const ids = b?.uploads === undefined ? [] : Array.isArray(b.uploads) && b.uploads.length <= 5 && new Set(b.uploads).size === b.uploads.length ? b.uploads : refuse("teamtask_adoption_refused");
    if (ids.length && !this.o.upload) refuse("teamtask_adoption_refused");
    const files = ids.map((u: unknown) => this.o.upload!(m.memberId, u));
    if (new Set(files.map((f: { name: string }) => f.name)).size !== files.length) refuse("teamtask_adoption_refused");
    const view = { contract: "kapelle.teamtask-disclosure/v1", audience, visibleTo: audience === "members" ? "all members" : "reviewers and admins",
      title: { text: title, bytes: Buffer.byteLength(title), sha256: sha(title) }, notes: { text: notes, bytes: Buffer.byteLength(notes), sha256: sha(notes) },
      uploads: files.map((f: { uploadId: string; name: string; bytes: Buffer; sha256: string }) => ({ uploadId: f.uploadId, name: f.name, bytes: f.bytes.length, sha256: f.sha256 })) };
    return { view, digest: digest(view), files };
  }
  /** Session (T2b): the disclosure to show before "Create task" (nothing is written). */
  disclose(m: TeamMember, b: any) { const d = this.disclosure(m, b); return { disclosure: d.view, disclosureDigest: d.digest }; }
  /** Session: create from the member's own typed text and, after an exact disclosure, picked text uploads (F-1: COPIED into the
   *  task store; chat history, images, flyer proposals and draft artifacts are never adoptable). Deduplicated by (creator,
   *  clientRequestId). With uploads, disclosureDigest must equal the runtime's disclosure. */
  create(m: TeamMember, b: any) {
    const crid = typeof b?.clientRequestId === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(b.clientRequestId) ? b.clientRequestId : refuse("teamtask_input_invalid");
    const prior = this.a.read(() => this.a.db.prepare("SELECT id FROM teamtasks WHERE creator_id=? AND client_request_id=?").get(m.memberId, crid)) as { id: string } | undefined;
    if (prior) return this.read(m, { taskId: prior.id }); // a duplicate command returns the original task
    const d = this.disclosure(m, b);
    if (d.files.length && b?.disclosureDigest !== d.digest) refuse("teamtask_adoption_refused");
    const tid = id("tt_"), at = this.now(), dir = join(this.o.stateRoot, "teamtasks", "tasks", tid);
    if (d.files.length) { mkdirSync(dir, { recursive: true, mode: 0o700 });
      for (const f of d.files as { name: string; bytes: Buffer; sha256: string }[]) writeFileSync(join(dir, f.sha256.slice(7) + ".txt"), f.bytes, { mode: 0o600, flag: "wx" }); }
    const taskId = this.a.write(() => {
      const again = this.a.db.prepare("SELECT id FROM teamtasks WHERE creator_id=? AND client_request_id=?").get(m.memberId, crid) as { id: string } | undefined;
      if (again) return again.id; // a concurrent duplicate won: its copies are the task's; ours are removed below
      this.a.db.prepare("INSERT INTO teamtasks(id,creator_id,client_request_id,title,notes,audience,revision,state,created_at,updated_at) VALUES (?,?,?,?,?,?,1,'open',?,?)")
        .run(tid, m.memberId, crid, d.view.title.text, d.view.notes.text, d.view.audience, at, at);
      for (const f of d.files as { uploadId: string; name: string; bytes: Buffer; sha256: string }[])
        this.a.db.prepare("INSERT INTO teamtask_inputs(task_id,name,sha256,bytes,from_upload) VALUES (?,?,?,?,?)").run(tid, f.name, f.sha256, f.bytes.length, f.uploadId);
      this.event(tid, null, m.memberId, "created", null, d.files.length ? { disclosureDigest: d.digest, uploads: d.view.uploads.map((u: { name: string; bytes: number; sha256: string }) => ({ name: u.name, bytes: u.bytes, sha256: u.sha256 })) } : null);
      return tid;
    });
    // Fable T2b N-2: the losing concurrent duplicate's copies (under its unused id) are removed, file by file.
    if (taskId !== tid) for (const f of d.files as { sha256: string }[]) rmSync(join(dir, f.sha256.slice(7) + ".txt"), { force: true });
    return this.read(m, { taskId });
  }
  /** Session: a new immutable plan version (prepare-only, frozen sources). Uncertain or active history blocks it. */
  propose(m: TeamMember, b: any, opts: ProposeOptions = {}) {
    const t = this.a.read(() => this.task(m, b?.taskId));
    if (t.state !== "open") refuse("teamtask_closed");
    if (b?.expectedRevision !== t.revision) refuse("teamtask_plan_changed");
    const blocking = this.a.read(() => this.a.db.prepare("SELECT state FROM teamtask_attempts WHERE task_id=? AND state IN ('approved','running','needs_reconciliation')").all(t.id)) as { state: string }[];
    if (blocking.some((x) => x.state === "needs_reconciliation")) refuse("teamtask_outcome_uncertain"); // 3de91335: uncertain history blocks new work
    if (blocking.length) refuse("teamtask_attempt_active");
    const attemptId = id("tta_"), pins = this.o.pins();
    // Frozen sources: the audience's roots at this moment, bytes copied (content-addressed) into the task store.
    const snap = takeSnapshot(this.o.folder, t.audience === "reviewers-private" ? "reviewer" : "member", t.creator_id, attemptId);
    const dir = join(this.dir(attemptId), "sources"); mkdirSync(dir, { recursive: true, mode: 0o700 });
    const manifest: [string, string, number][] = [];
    let bytes = 0;
    for (const f of snap.files.values()) {
      if (opts.filter && !opts.filter(f.path, "sha256:" + f.sha256)) continue; // S1: a schedule's source rule (same snapshot, same checks)
      const buf = readFileSync(join(this.o.folder, f.path)), h = sha(buf);
      if (h !== "sha256:" + f.sha256) refuse("teamtask_plan_changed"); // changed mid-snapshot: propose again
      const name = join(dir, h.slice(7) + ".txt");
      if (!existsSync(name)) writeFileSync(name, buf, { mode: 0o600, flag: "wx" });
      manifest.push([f.path, h, buf.length]); bytes += buf.length;
    }
    // T2b: the task's adopted uploads (copied at creation) are frozen with the plan as task-uploads/<name>.
    const inputs = this.a.read(() => this.a.db.prepare("SELECT name, sha256, bytes FROM teamtask_inputs WHERE task_id=? ORDER BY name").all(t.id)) as { name: string; sha256: string; bytes: number }[];
    for (const f of inputs) {
      const buf = readFileSync(join(this.o.stateRoot, "teamtasks", "tasks", t.id, f.sha256.slice(7) + ".txt"));
      if (sha(buf) !== f.sha256) refuse("teamtask_plan_changed");
      const name = join(dir, f.sha256.slice(7) + ".txt");
      if (!existsSync(name)) writeFileSync(name, buf, { mode: 0o600, flag: "wx" });
      manifest.push([`task-uploads/${f.name}`, f.sha256, buf.length]); bytes += buf.length;
    }
    if (opts.emptyLabel && !manifest.length) refuse(opts.emptyLabel); // S1: nothing selected = no plan (zero model calls)
    // S1 (Fable C-2): a derived plan may LOWER, never raise, the store's budget; validated by the same budgetSchema.
    const budget = opts.budget ? budgetSchema.parse(opts.budget) : this.o.budget;
    if (opts.budget && (Object.keys(this.o.budget) as (keyof Budget)[]).some((k) => budget[k] > this.o.budget[k])) refuse("teamtask_input_invalid");
    writeFileSync(join(this.dir(attemptId), "manifest.json"), JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
    const manifestHash = digest(manifest), expiresAt = new Date(Math.min(Date.parse(this.now()) + TEAMTASK_LIMITS.planHours * 3_600_000, opts.expiresBefore ? Date.parse(opts.expiresBefore) : Infinity)).toISOString();
    // AGENT-HANDBOOK-V1 H1 (C-3, C-4, C-6): with the feature on, the plan binds the ACTIVE approved handbook and a system map made
    // from THIS frozen manifest (the task's audience scope) and the installed features; none approved or a map over its cap refuses
    // here, before any plan or inference. The map bytes are stored with the attempt and re-hashed at run.
    let context: PlanContext | undefined;
    if (this.o.context) {
      const h = this.o.context.handbook();
      if (!h) refuse("teamtask_handbook_missing");
      const m = systemMap({ id: attemptId, snapshotHash: manifestHash, generatedAt: this.now(), paths: manifest.map((x) => x[0]), features: this.o.context.features(),
        tools: manifest.length && bytes <= TEAMTASK_INLINE_BYTES ? [] : ["read_org_file", "search_org_history"] });
      if (!m) refuse("teamtask_system_map_unavailable");
      writeFileSync(join(this.dir(attemptId), "system-map.txt"), m!.text, { mode: 0o600, flag: "wx" });
      context = { handbook: { version: h!.version, sha256: h!.sha256 }, map: { id: m!.id as `tta_${string}`, sha256: m!.sha256, bytes: m!.bytes } };
    }
    const rec = teamTaskRecommendation({ title: t.title, notes: t.notes });
    // T3 "Revise or run again" (3de91335 parity): the team's note and, optionally, ONE earlier VERIFIED result of this task as
    // a bounded excerpt, re-read and re-hashed now (a changed or unverified result is refused, never quoted).
    let revision: Plan["revision"] = undefined, excerpt: string | null = null, full = "";
    if (b?.revision !== undefined) {
      const rv = b.revision;
      if (!rv || typeof rv !== "object" || Object.keys(rv).some((k) => !["note", "priorResultId"].includes(k))) refuse("teamtask_input_invalid");
      const note = typeof rv.note === "string" ? rv.note.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim() : rv.note === undefined ? "" : refuse("teamtask_input_invalid");
      if (note.length > 1000) refuse("teamtask_input_invalid");
      let prior: NonNullable<Plan["revision"]>["prior"] = null;
      if (rv.priorResultId !== undefined) {
        const r = typeof rv.priorResultId === "string" ? this.a.read(() => this.a.db.prepare("SELECT attempt_id, envelope, result_digest FROM teamtask_results WHERE task_id=? AND result_id=?").get(t.id, rv.priorResultId)) as
          { attempt_id: string; envelope: string; result_digest: string } | undefined : undefined;
        if (!r) refuse("teamtask_result_unverified");
        const e = JSON.parse(r!.envelope) as ResultEnvelope, f = JSON.parse(readFileSync(join(this.dir(r!.attempt_id), "result-v1.json"), "utf8"));
        if (typeof f.content !== "string" || sha(Buffer.from(f.content, "utf8")) !== e.sha256) refuse("teamtask_result_unverified");
        excerpt = f.content.slice(0, PRIOR_RESULT_EXCERPT_CHARS);
        prior = { resultId: rv.priorResultId, resultDigest: r!.result_digest, excerptSha256: "", excerptChars: 0, truncated: false }; // fitted below
        full = f.content;
      }
      revision = { note, prior };
    }
    // Fable T3 F-1: fit the quote to the plan's 4,000-char bound (a shorter excerpt, recorded); refuse cleanly if nothing fits.
    const fitted = revision ? revisedInstructions(rec.instructions, revision.note, excerpt) : null;
    if (revision && !fitted) refuse("teamtask_input_invalid");
    if (revision?.prior && fitted?.excerpt !== null && fitted) {
      revision.prior = { ...revision.prior, excerptSha256: sha(fitted.excerpt!), excerptChars: fitted.excerpt!.length, truncated: fitted.excerpt!.length < full.length };
    }
    const instructions = fitted ? fitted.text : rec.instructions;
    return this.a.write(() => {
      const cur = this.task(m, t.id);
      if (cur.revision !== t.revision || cur.state !== "open") refuse("teamtask_plan_changed");
      const version = ((this.a.db.prepare("SELECT MAX(version) AS v FROM teamtask_plans WHERE task_id=?").get(t.id) as { v: number | null }).v ?? 0) + 1;
      const plan: Plan = planSchema.parse({ contract: "kapelle.teamtask-plan/v1", orgId: this.o.orgId, taskId: t.id, taskRevision: t.revision, attemptId, version, audience: t.audience,
        instructions, summary: revision ? ("Revised: " + rec.summary).slice(0, 800) : rec.summary, sources: { roots: snap.roots.filter((r) => !r.startsWith("members/uploads/")) /* takeSnapshot appends the (never existing) per-attempt uploads path */, manifestHash, files: manifest.length, bytes },
        pins, output: { kind: "text" }, budget, grantPlan: teamTaskGrantPlan({ attemptId, agentId: pins.agentId, manifestHash, expiresAt }), expiresAt,
        ...(revision ? { revision } : {}), ...(context ? { context } : {}) });
      // A newer plan supersedes an unapproved one (it never had run authority).
      for (const r of this.a.db.prepare("SELECT attempt_id FROM teamtask_attempts WHERE task_id=? AND state='proposed'").all(t.id) as { attempt_id: string }[]) {
        this.setAttempt(r.attempt_id, "superseded", null); this.event(t.id, r.attempt_id, m.memberId, "superseded");
      }
      this.a.db.prepare("INSERT INTO teamtask_plans(attempt_id,task_id,version,plan,plan_digest,proposed_by,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(attemptId, t.id, version, JSON.stringify(plan), planDigest(plan), m.memberId, this.now());
      this.a.db.prepare("INSERT INTO teamtask_attempts(attempt_id,task_id,revision,state,label,updated_at) VALUES (?,?,1,'proposed',NULL,?)").run(attemptId, t.id, this.now());
      this.event(t.id, attemptId, m.memberId, "proposed", null, { planDigest: planDigest(plan), version });
      return { attemptId, planDigest: planDigest(plan), plan };
    });
  }
  private plan(attemptId: string) {
    const r = this.a.db.prepare("SELECT plan, plan_digest FROM teamtask_plans WHERE attempt_id=?").get(attemptId) as { plan: string; plan_digest: string } | undefined;
    return r ? { plan: planSchema.parse(JSON.parse(r.plan)), digest: r.plan_digest } : null;
  }
  /** Consequential (session-fresh), reviewers/admins: approve exactly this plan; queues the attempt. */
  approve(z: Authorization, m: TeamMember, b: any) {
    if (!["admin", "reviewer"].includes(m.role)) refuse("teamtask_scope_not_permitted");
    if (!this.o.executor) refuse("teamtask_tool_not_admitted");
    const out = this.a.write(() => {
      const prior = this.a.db.prepare("SELECT attempt_id FROM teamtask_approvals WHERE operation_id=?").get(z.operationId) as { attempt_id: string } | undefined;
      if (prior) return prior.attempt_id; // a replay of the same approval: the same effect, never a second one
      const attemptId = typeof b?.attemptId === "string" ? b.attemptId : "";
      const p = /^tta_[a-f0-9]{32}$/.test(attemptId) ? this.plan(attemptId) : null;
      if (!p) return refuse("teamtask_audience_not_permitted");
      const t = this.task(m, p.plan.taskId);
      if (!z.artifactDigest || z.artifactDigest !== p.digest) refuse("teamtask_plan_changed");
      const att = this.a.db.prepare("SELECT state FROM teamtask_attempts WHERE attempt_id=?").get(attemptId) as { state: string };
      if (att.state !== "proposed") refuse(att.state === "superseded" ? "teamtask_plan_changed" : "teamtask_claim_consumed"); // competing reviewers: the first wins
      if (t.state !== "open" || t.revision !== p.plan.taskRevision) refuse("teamtask_plan_changed");
      if (Date.parse(p.plan.expiresAt) <= Date.parse(this.now())) refuse("teamtask_plan_expired");
      if (canonical(this.o.pins()) !== canonical(p.plan.pins) || !grantPlanValid(p.plan)) refuse("teamtask_plan_changed");
      if ((this.a.db.prepare("SELECT COUNT(*) AS n FROM teamtask_attempts WHERE state IN ('approved','running')").get() as { n: number }).n >= TEAMTASK_LIMITS.queue) refuse("teamtask_queue_full");
      this.a.db.prepare("INSERT INTO teamtask_approvals(operation_id,attempt_id,plan_digest,approver_id,access_table_hash,approved_at,expires_at,consumed_at) VALUES (?,?,?,?,?,?,?,NULL)")
        .run(z.operationId, attemptId, p.digest, z.memberId, p.plan.pins.accessTableHash, this.now(), p.plan.expiresAt);
      this.setAttempt(attemptId, "approved", null);
      this.event(t.id, attemptId, z.memberId, "approved", null, { planDigest: p.digest, operationId: z.operationId });
      return attemptId;
    });
    this.kick();
    const p = this.a.read(() => this.plan(out))!;
    return this.read(m, { taskId: p.plan.taskId });
  }
  /** SCHEDULED-TASKS-V1 S1: ONE approval derived from a reviewer-approved standing schedule for ONE occurrence's exact plan
   *  (kind 'schedule', ref = the occurrence id, approver = the schedule's sponsor). Never a forged session: the same plan, pin,
   *  expiry, queue and single-claim checks as approve(); the claim then rechecks the sponsor and pins like any approval. */
  approveDerived(attemptId: string, sponsorId: string, ref: string, planDigestExpected: string) {
    if (!this.o.executor) refuse("teamtask_tool_not_admitted");
    const sponsor = this.o.memberOf(sponsorId);
    if (!sponsor || !["admin", "reviewer"].includes(sponsor.role)) refuse("teamtask_scope_not_permitted");
    this.a.write(() => {
      const op = "schedule:" + ref;
      if (this.a.db.prepare("SELECT 1 FROM teamtask_approvals WHERE operation_id=?").get(op)) return; // replay: the same effect once
      const p = this.plan(attemptId);
      if (!p || p.digest !== planDigestExpected) refuse("teamtask_plan_changed");
      const att = this.a.db.prepare("SELECT state FROM teamtask_attempts WHERE attempt_id=?").get(attemptId) as { state: string };
      if (att.state !== "proposed") refuse("teamtask_claim_consumed");
      if (Date.parse(p!.plan.expiresAt) <= Date.parse(this.now())) refuse("teamtask_plan_expired");
      if (canonical(this.o.pins()) !== canonical(p!.plan.pins) || !grantPlanValid(p!.plan)) refuse("teamtask_plan_changed");
      if ((this.a.db.prepare("SELECT COUNT(*) AS n FROM teamtask_attempts WHERE state IN ('approved','running')").get() as { n: number }).n >= TEAMTASK_LIMITS.queue) refuse("teamtask_queue_full");
      this.a.db.prepare("INSERT INTO teamtask_approvals(operation_id,attempt_id,plan_digest,approver_id,access_table_hash,approved_at,expires_at,consumed_at,kind,ref) VALUES (?,?,?,?,?,?,?,NULL,'schedule',?)")
        .run(op, attemptId, p!.digest, sponsorId, p!.plan.pins.accessTableHash, this.now(), p!.plan.expiresAt, ref);
      this.setAttempt(attemptId, "approved", null);
      this.event(p!.plan.taskId, attemptId, sponsorId, "approved", null, { planDigest: p!.digest, operationId: op, kind: "schedule", occurrenceId: ref });
    });
    this.kick();
  }
  /** S1 (Fable F-1): abort ONE running attempt through the existing cancellation path (the executor ends it cancelled, or
   *  uncertain when a sent request is unsettled). True if it was running here. */
  abort(attemptId: string) { const ac = this.running.get(attemptId); ac?.abort(); return !!ac; }
  /** S1: an attempt's frozen manifest ([path, sha256, bytes] in snapshot order), for a schedule's coverage watermark. */
  manifestOf(attemptId: string): [string, string, number][] { return JSON.parse(readFileSync(join(this.dir(attemptId), "manifest.json"), "utf8")); }
  /** S1: a schedule-created task whose freeze selected nothing is closed (cancelled) at once, before any plan exists. */
  abandon(taskId: string) {
    this.a.write(() => {
      this.a.db.prepare("UPDATE teamtasks SET state='cancelled', revision=revision+1, updated_at=? WHERE id=? AND state='open'").run(this.now(), taskId);
      this.event(taskId, null, "runtime", "task_cancelled", "teamtask_cancelled");
    });
  }
  /** H1: the handbook pin of a plan vs now. Feature off and no context = fine (today). Otherwise the plan must carry the context
   *  and its handbook must be the ACTIVE approved version, byte for byte; else teamtask_handbook_changed (a new plan is needed). */
  private handbookGate(plan: Plan): string | null {
    if (!this.o.context && !plan.context) return null;
    if (!this.o.context || !plan.context) return "teamtask_handbook_changed";
    const a = this.o.context.handbook();
    return a && a.version === plan.context.handbook.version && a.sha256 === plan.context.handbook.sha256 ? null : "teamtask_handbook_changed";
  }
  /** Planned grants confer nothing: only grants materialized by a claim are effective. */
  grantsOf(attemptId: string) {
    return (this.a.read(() => this.a.db.prepare("SELECT grant_json FROM teamtask_grants WHERE attempt_id=? ORDER BY grant_id").all(attemptId)) as { grant_json: string }[])
      .map((r) => JSON.parse(r.grant_json) as Plan["grantPlan"]["grants"][number]);
  }
  /** The claim: one transaction (b2efd132 parity). Returns the plan to run, or null when nothing may run. */
  claim(attemptId: string): Plan | null {
    return this.a.write(() => {
      const att = this.a.db.prepare("SELECT state, task_id FROM teamtask_attempts WHERE attempt_id=?").get(attemptId) as { state: string; task_id: string } | undefined;
      if (!att || att.state !== "approved") return null;
      const ap = this.a.db.prepare("SELECT * FROM teamtask_approvals WHERE attempt_id=?").get(attemptId) as Record<string, any> | undefined;
      const fail = (label: string) => { this.setAttempt(attemptId, "failed", label); this.event(att.task_id, attemptId, "runtime", "claim_refused", label); return null; };
      if (!ap) return fail("teamtask_plan_changed");
      if (ap.consumed_at) return fail("teamtask_claim_consumed"); // a consumed approval is never reused
      const p = this.plan(attemptId)!, t = this.a.db.prepare("SELECT * FROM teamtasks WHERE id=?").get(att.task_id) as Record<string, any>;
      if (this.killed()) return null; // paused by Ops: stays queued, nothing consumed
      if (ap.plan_digest !== p.digest || planDigest(p.plan) !== p.digest) return fail("teamtask_plan_changed");
      if (Date.parse(p.plan.expiresAt) <= Date.parse(this.now())) return fail("teamtask_plan_expired");
      const approver = this.o.memberOf(ap.approver_id);
      if (!approver || !["admin", "reviewer"].includes(approver.role)) return fail("teamtask_scope_not_permitted"); // revocation before claim
      if (t.state !== "open" || t.revision !== p.plan.taskRevision) return fail("teamtask_plan_changed");
      if (canonical(this.o.pins()) !== canonical(p.plan.pins)) return fail("teamtask_plan_changed"); // live pins before dispatch
      const hb = this.handbookGate(p.plan); if (hb) return fail(hb); // H1: the approved handbook is still the plan's
      const gate = this.o.scheduleGate?.(attemptId) ?? null; if (gate) return fail(gate); // S1: schedule pins / pause / expiry / replay
      this.a.db.prepare("UPDATE teamtask_approvals SET consumed_at=? WHERE attempt_id=? AND consumed_at IS NULL").run(this.now(), attemptId);
      for (const g of p.plan.grantPlan.grants) {
        const have = this.a.db.prepare("SELECT grant_json FROM teamtask_grants WHERE grant_id=?").get(g.id) as { grant_json: string } | undefined;
        if (have && have.grant_json !== canonical(g)) throw new AccessError("teamtask_plan_changed"); // same id, other content: conflict
        if (!have) this.a.db.prepare("INSERT INTO teamtask_grants(grant_id,attempt_id,grant_json,materialized_at) VALUES (?,?,?,?)").run(g.id, attemptId, canonical(g), this.now());
      }
      const live = pinOf(this.o.pins(), (this.a.db.prepare("SELECT grant_json FROM teamtask_grants WHERE attempt_id=?").all(attemptId) as { grant_json: string }[]).map((r) => JSON.parse(r.grant_json)));
      if (live !== approvedPin(p.plan)) throw new AccessError("teamtask_plan_changed"); // rolls the whole claim back
      this.a.db.prepare("INSERT INTO teamtask_runs(claim_id,attempt_id,started_at,ended_at,expected) VALUES (?,?,?,NULL,NULL)").run(id("ttc_"), attemptId, this.now());
      this.setAttempt(attemptId, "running", null);
      this.event(att.task_id, attemptId, "runtime", "claimed", null, { pin: live });
      return p.plan;
    });
  }
  /** Run queued attempts one at a time (T2 joins the org's chat scheduler: one model run per org). */
  kick() { this.chain = this.chain.then(() => this.drain()).catch(() => {}); }
  private waiting: NodeJS.Timeout | null = null;
  /** N-5: true while an attempt is running (chat refuses a new turn with chat_turn_busy, the same scheduler fact). */
  busy() { return !!this.a.db.prepare("SELECT 1 FROM teamtask_attempts WHERE state='running' LIMIT 1").get(); } // plain read: also called inside chat's write
  /** The scheduler fact both views show: a run (chat turn or team task) is in progress, and how many tasks are queued. */
  schedulerFact() {
    const queued = (this.a.read(() => this.a.db.prepare("SELECT COUNT(*) AS n FROM teamtask_attempts WHERE state='approved'").get()) as { n: number }).n;
    return { anotherRunInProgress: this.busy() || !!this.o.modelBusy?.(), queued, paused: this.a.read(() => this.killed()) };
  }
  private async drain() {
    for (;;) {
      if (this.o.modelBusy?.()) { // a chat turn holds the org's model slot: look again shortly (never a second concurrent run)
        if (!this.waiting) { this.waiting = setTimeout(() => { this.waiting = null; this.kick(); }, 2000); this.waiting.unref(); }
        return;
      }
      const next = this.a.read(() => this.a.db.prepare("SELECT a.attempt_id FROM teamtask_attempts a JOIN teamtask_approvals p ON p.attempt_id=a.attempt_id WHERE a.state='approved' ORDER BY p.approved_at, a.attempt_id LIMIT 1").get()) as { attempt_id: string } | undefined;
      if (!next || this.killed()) return;
      let plan: Plan | null;
      try { plan = this.claim(next.attempt_id); }
      catch (e) { this.a.write(() => { const t = this.a.db.prepare("SELECT task_id FROM teamtask_attempts WHERE attempt_id=?").get(next.attempt_id) as { task_id: string };
        this.setAttempt(next.attempt_id, "failed", e instanceof AccessError ? e.reason : "teamtask_plan_changed"); this.event(t.task_id, next.attempt_id, "runtime", "claim_refused", e instanceof AccessError ? e.reason : "teamtask_plan_changed"); });
        this.o.onAttemptEnd?.(next.attempt_id); continue; }
      if (plan) await this.execute(plan); else this.o.onAttemptEnd?.(next.attempt_id); // a refused claim ends the attempt
    }
  }
  private async execute(plan: Plan) {
    const ac = new AbortController(), attemptId = plan.attemptId;
    this.running.set(attemptId, ac);
    const has = (action: string) => this.grantsOf(attemptId).some((g) => g.actions[0] === action && Date.parse(g.expiresAt) > Date.parse(this.now()));
    let written = false;
    const run = {
      attemptId, taskId: plan.taskId, plan, signal: ac.signal, grants: this.grantsOf(attemptId).map((g) => g.id),
      authorization: (): string | null => this.a.read(() => {
        const ap = this.a.db.prepare("SELECT approver_id FROM teamtask_approvals WHERE attempt_id=?").get(attemptId) as { approver_id: string } | undefined;
        const who = ap ? this.o.memberOf(ap.approver_id) : null, t = this.a.db.prepare("SELECT state, revision FROM teamtasks WHERE id=?").get(plan.taskId) as { state: string; revision: number };
        if (!who || !["admin", "reviewer"].includes(who.role)) return "teamtask_scope_not_permitted";
        if (t.state !== "open") return "teamtask_closed";
        if (t.revision !== plan.taskRevision) return "teamtask_plan_changed";
        if (Date.parse(plan.expiresAt) <= Date.parse(this.now())) return "teamtask_plan_expired";
        if (this.killed()) return "teamtask_paused";
        const hb = this.handbookGate(plan); if (hb) return hb; // H1: a handbook change stops the run before its next step
        return this.o.scheduleGate?.(attemptId) ?? null; // S1 (C-3/C-5): before EVERY provider and tool step
      }),
      stillAuthorized: (): boolean => run.authorization() === null,
      context: () => {
        if (!plan.context) return null;
        const h = this.o.context?.handbookVersion(plan.context.handbook.version);
        if (!h || h.sha256 !== plan.context.handbook.sha256) throw new TeamTaskEnd("teamtask_handbook_changed", "failed");
        let text: string;
        try { text = readFileSync(join(this.dir(attemptId), "system-map.txt"), "utf8"); } catch { throw new TeamTaskEnd("teamtask_system_map_unavailable", "failed"); }
        if (sha(Buffer.from(text, "utf8")) !== plan.context.map.sha256) throw new TeamTaskEnd("teamtask_system_map_unavailable", "failed");
        return { handbook: h, map: { id: plan.context.map.id, text, sha256: plan.context.map.sha256 } };
      },
      sources: () => {
        if (!has("read")) throw new TeamTaskEnd("teamtask_tool_not_admitted", "failed");
        const manifest = JSON.parse(readFileSync(join(this.dir(attemptId), "manifest.json"), "utf8")) as [string, string, number][];
        if (digest(manifest) !== plan.sources.manifestHash) throw new TeamTaskEnd("teamtask_plan_changed", "failed");
        return manifest.map(([path, h]) => { const buf = readFileSync(join(this.dir(attemptId), "sources", h.slice(7) + ".txt"));
          if (sha(buf) !== h) throw new TeamTaskEnd("teamtask_plan_changed", "failed"); return { path, text: buf.toString("utf8") }; });
      },
      writeResult: (text: string, partial?: string) => {
        if (!has("write_result") || written) throw new TeamTaskEnd("teamtask_tool_not_admitted", "failed");
        const content = Buffer.from(String(text), "utf8");
        if (!content.length || content.length > TEAMTASK_LIMITS.resultMaxBytes) throw new TeamTaskEnd("teamtask_budget_exhausted", "failed");
        const expected: ResultEnvelope = { contract: "kapelle.teamtask-result/v1", orgId: this.o.orgId, taskId: plan.taskId, attemptId, planDigest: planDigest(plan),
          inputHash: plan.sources.manifestHash, producer: `${plan.pins.agentId}/${plan.pins.executor}`, contentVersion: 1, kind: "text", sha256: sha(content), bytes: content.length };
        this.a.write(() => this.a.db.prepare("UPDATE teamtask_runs SET expected=? WHERE attempt_id=? AND expected IS NULL").run(JSON.stringify(expected), attemptId));
        writeFileSync(join(this.dir(attemptId), "result-v1.json"), JSON.stringify({ ...expected, content: content.toString("utf8") }), { mode: 0o600, flag: "wx" });
        if (partial) this.a.write(() => this.a.db.prepare("UPDATE teamtask_attempts SET partial=? WHERE attempt_id=?").run(persistedReason(failureLabel(new Error(partial))), attemptId));
        written = true;
      },
    } satisfies TeamTaskRun;
    let end: { state: string; label: string | null };
    try {
      await this.o.executor!.run(run);
      end = written ? { state: "verify", label: null } : { state: "failed", label: "teamtask_result_unverified" };
    } catch (e) {
      // Unknown errors may follow a send: uncertain, never failed (no rerun until reconciled).
      end = e instanceof TeamTaskEnd ? { state: e.state === "uncertain" ? "needs_reconciliation" : e.state, label: e.label } : { state: "needs_reconciliation", label: "teamtask_outcome_uncertain" };
      if (ac.signal.aborted && end.state === "failed") end = { state: "cancelled", label: "teamtask_cancelled" };
    } finally { this.running.delete(attemptId); }
    this.a.write(() => {
      this.a.db.prepare("UPDATE teamtask_runs SET ended_at=? WHERE attempt_id=?").run(this.now(), attemptId);
      if (end.state === "verify") this.verifyLocked(attemptId, "runtime");
      else { this.setAttempt(attemptId, end.state, end.label); this.event(plan.taskId, attemptId, "runtime", end.state, end.label); }
    });
    this.o.onAttemptEnd?.(attemptId); // S1: after the terminal write, outside it
  }
  /** Read back the result through the separate read path and record it, or hold the attempt with expected-vs-read (N-4). */
  private verifyLocked(attemptId: string, actor: string): boolean {
    const run = this.a.db.prepare("SELECT expected FROM teamtask_runs WHERE attempt_id=?").get(attemptId) as { expected: string | null } | undefined;
    const taskId = (this.a.db.prepare("SELECT task_id FROM teamtask_attempts WHERE attempt_id=?").get(attemptId) as { task_id: string }).task_id;
    const expected = run?.expected ? resultEnvelopeSchema.parse(JSON.parse(run.expected)) : null;
    let read: Record<string, unknown> | "unavailable" = "unavailable", envelope: ResultEnvelope | null = null;
    try {
      const raw = (this.o.readBack ?? ((p: string) => existsSync(p) ? readFileSync(p) : null))(join(this.dir(attemptId), "result-v1.json"));
      if (raw) {
        const f = JSON.parse(raw.toString("utf8")), content = Buffer.from(typeof f.content === "string" ? f.content : "", "utf8");
        const { content: _c, ...rest } = f;
        read = { sha256: sha(content), bytes: content.length, producer: f.producer ?? null, contentVersion: f.contentVersion ?? null };
        const e = resultEnvelopeSchema.safeParse({ ...rest, sha256: sha(content), bytes: content.length });
        if (e.success && f.sha256 === sha(content) && f.bytes === content.length) envelope = e.data;
      }
    } catch { read = "unavailable"; }
    const ok = !!expected && !!envelope && canonical(envelope) === canonical(expected);
    if (!ok) {
      const exp = expected ? { sha256: expected.sha256, bytes: expected.bytes, producer: expected.producer, contentVersion: expected.contentVersion } : "unavailable";
      const mismatched = read === "unavailable" || exp === "unavailable" ? ["unavailable"]
        : ["sha256", "bytes", "producer", "contentVersion"].filter((k) => (read as any)[k] !== (exp as any)[k]).concat(envelope ? [] : ["binding"]);
      this.setAttempt(attemptId, "needs_reconciliation", "teamtask_result_unverified");
      this.event(taskId, attemptId, actor, "result_unverified", "teamtask_result_unverified", { expected: exp, read, mismatched });
      return false;
    }
    const resultId = id("ttr_");
    this.a.db.prepare("INSERT INTO teamtask_results(result_id,attempt_id,task_id,envelope,result_digest,verified_at) VALUES (?,?,?,?,?,?)")
      .run(resultId, attemptId, taskId, JSON.stringify(envelope), resultDigest(envelope!), this.now());
    this.setAttempt(attemptId, "result_ready", null);
    this.event(taskId, attemptId, actor, "result_ready", null, { resultId, resultDigest: resultDigest(envelope!), sha256: envelope!.sha256, bytes: envelope!.bytes });
    return true;
  }
  /** Consequential (session-fresh): cancel the task. Members only their own task with nothing running; reviewers/admins any
   *  in their audience. Unstarted attempts end; a running one is aborted (a sent request keeps its fence). */
  cancel(z: Authorization, m: TeamMember, b: any) {
    const t = this.a.read(() => this.task(m, b?.taskId));
    const reviewer = ["admin", "reviewer"].includes(m.role);
    if (t.state !== "open") refuse("teamtask_closed");
    if (b?.expectedRevision !== t.revision) refuse("teamtask_plan_changed");
    const live = this.a.read(() => this.a.db.prepare("SELECT attempt_id, state FROM teamtask_attempts WHERE task_id=? AND state IN ('proposed','approved','running')").all(t.id)) as { attempt_id: string; state: string }[];
    if (!reviewer && (t.creator_id !== m.memberId || live.some((x) => x.state === "running"))) refuse("teamtask_scope_not_permitted");
    this.a.write(() => {
      for (const x of live) if (x.state !== "running") { this.setAttempt(x.attempt_id, "cancelled", "teamtask_cancelled"); this.event(t.id, x.attempt_id, z.memberId, "cancelled", "teamtask_cancelled"); }
      this.a.db.prepare("UPDATE teamtasks SET state='cancelled', revision=revision+1, updated_at=? WHERE id=?").run(this.now(), t.id);
      this.event(t.id, null, z.memberId, "task_cancelled", null, { operationId: z.operationId });
    });
    for (const x of live) if (x.state === "running") this.running.get(x.attempt_id)?.abort(); else this.o.onAttemptEnd?.(x.attempt_id);
    return this.read(m, { taskId: t.id });
  }
  /** Consequential (session-fresh): a human marks a VERIFIED result done (artifact digest = its result digest). */
  complete(z: Authorization, m: TeamMember, b: any) {
    this.a.write(() => {
      const t = this.task(m, b?.taskId);
      if (t.state !== "open") refuse("teamtask_closed");
      if (b?.expectedRevision !== t.revision) refuse("teamtask_plan_changed");
      if (t.creator_id !== m.memberId && !["admin", "reviewer"].includes(m.role)) refuse("teamtask_scope_not_permitted");
      const r = this.a.db.prepare(`SELECT r.result_digest FROM teamtask_results r JOIN teamtask_attempts a ON a.attempt_id=r.attempt_id JOIN teamtask_plans p ON p.attempt_id=r.attempt_id
        WHERE r.task_id=? AND a.state='result_ready' ORDER BY p.version DESC LIMIT 1`).get(t.id) as { result_digest: string } | undefined;
      if (!r) refuse("teamtask_result_unverified");
      if (z.artifactDigest !== r!.result_digest) refuse("teamtask_plan_changed");
      this.a.db.prepare("UPDATE teamtasks SET state='done', revision=revision+1, done_by=?, done_at=?, done_result_digest=?, updated_at=? WHERE id=?").run(z.memberId, this.now(), r!.result_digest, this.now(), t.id);
      this.event(t.id, null, z.memberId, "done", null, { resultDigest: r!.result_digest, operationId: z.operationId });
    });
    return this.read(m, { taskId: b.taskId });
  }
  /** Start-up: a claimed attempt never restarts inference (its outcome is unknown); queued ones may be claimed. */
  recover() {
    const n = this.a.write(() => {
      const rows = this.a.db.prepare("SELECT attempt_id, task_id FROM teamtask_attempts WHERE state='running'").all() as { attempt_id: string; task_id: string }[];
      for (const r of rows) { this.setAttempt(r.attempt_id, "needs_reconciliation", "teamtask_outcome_uncertain"); this.event(r.task_id, r.attempt_id, "runtime", "interrupted", "teamtask_outcome_uncertain"); }
      return rows;
    });
    for (const r of n) this.o.onAttemptEnd?.(r.attempt_id); // S1: an interrupted scheduled run pauses its schedule
    this.kick();
    return n.length;
  }
  /** Ops (POST /ops/teamtasks/reconcile, N-6): exact keys; re-read the durable evidence and apply the normal verifier. */
  reconcile(b: any) {
    const keys = Object.keys(b ?? {}).sort();
    if (canonical(keys) !== canonical(["attemptId", "disposition", "evidenceSha", "expectedRevision"])) refuse("teamtask_input_invalid");
    return this.a.write(() => {
      const att = this.a.db.prepare("SELECT * FROM teamtask_attempts WHERE attempt_id=?").get(String(b.attemptId)) as Record<string, any> | undefined;
      if (!att || att.state !== "needs_reconciliation") refuse("teamtask_reconcile_refused");
      if (att!.revision !== b.expectedRevision) refuse("teamtask_plan_changed");
      if (b.disposition === "verified_result") {
        const p = join(this.dir(att!.attempt_id), "result-v1.json");
        if (!existsSync(p) || sha(readFileSync(p)) !== b.evidenceSha) refuse("teamtask_reconcile_refused");
        if (!this.verifyLocked(att!.attempt_id, "ops")) refuse("teamtask_reconcile_refused"); // never unlocks on an assertion
      } else if (b.disposition === "definitive_failure") {
        const rows = (this.o.ledgerRows ?? (() => []))(`teamtask:${att!.attempt_id}:`);
        if (digest(rows) !== b.evidenceSha || rows.some((r) => !["settled", "released"].includes(r.state))) refuse("teamtask_reconcile_refused"); // a sent/unsettled request keeps the fence
        this.setAttempt(att!.attempt_id, "failed", att!.label ?? "teamtask_outcome_uncertain");
        this.event(att!.task_id, att!.attempt_id, "ops", "reconciled_failure", att!.label, { evidenceSha: b.evidenceSha, rows: rows.length });
      } else refuse("teamtask_input_invalid");
      return { attemptId: att!.attempt_id, state: (this.a.db.prepare("SELECT state FROM teamtask_attempts WHERE attempt_id=?").get(att!.attempt_id) as { state: string }).state };
    });
  }
  /** Ops kill switch: paused = nothing is claimed (queued attempts stay queued). */
  setPaused(on: boolean) { this.a.write(() => this.a.db.prepare("INSERT INTO teamtask_meta(key,value) VALUES ('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(on ? "1" : "0")); if (!on) this.kick(); return { paused: on }; }
  /** Session: the versioned read model (kapelle.team-task/v1) for one task, inside the audience. */
  read(m: TeamMember, b: any) {
    return this.a.read(() => {
      const t = this.task(m, b?.taskId);
      const attempts = (this.a.db.prepare(`SELECT a.attempt_id, a.state, a.label, a.partial, a.revision, p.version, p.plan, p.plan_digest FROM teamtask_attempts a JOIN teamtask_plans p ON p.attempt_id=a.attempt_id
        WHERE a.task_id=? ORDER BY p.version`).all(t.id) as Record<string, any>[]).map((a) => {
        const plan = JSON.parse(a.plan) as Plan;
        const r = this.a.db.prepare("SELECT result_id, envelope, result_digest, verified_at FROM teamtask_results WHERE attempt_id=?").get(a.attempt_id) as Record<string, any> | undefined;
        const unverified = a.label === "teamtask_result_unverified" ? JSON.parse((this.a.db.prepare("SELECT detail FROM teamtask_events WHERE attempt_id=? AND event='result_unverified' ORDER BY seq DESC LIMIT 1").get(a.attempt_id) as { detail: string }).detail) : null;
        const ap = this.a.db.prepare("SELECT approver_id, approved_at, consumed_at, kind, ref FROM teamtask_approvals WHERE attempt_id=?").get(a.attempt_id) as Record<string, any> | undefined;
        return { dispatch: a.attempt_id, attemptId: a.attempt_id, version: a.version, state: a.state, label: a.label, revision: a.revision, planDigest: a.plan_digest,
          plan: { instructions: plan.instructions, summary: plan.summary, sources: plan.sources, budget: plan.budget, output: plan.output, expiresAt: plan.expiresAt, pins: plan.pins,
            revision: plan.revision ? { note: plan.revision.note, prior: plan.revision.prior ? { resultId: plan.revision.prior.resultId, truncated: plan.revision.prior.truncated } : null } : null,
            context: plan.context ? { handbookVersion: plan.context.handbook.version, mapId: plan.context.map.id } : null }, // H2: for the cite chips
          approval: ap ? { approverId: ap.approver_id, approvedAt: ap.approved_at, consumed: !!ap.consumed_at, kind: ap.kind ?? "member", occurrenceId: ap.ref ?? null } : null,
          report: r ? { resultId: r.result_id, resultDigest: r.result_digest, verifiedAt: r.verified_at, ...(({ sha256, bytes, kind, producer, contentVersion }) => ({ sha256, bytes, kind, producer, contentVersion }))(JSON.parse(r.envelope)) } : null,
          unverified, partial: a.partial ?? null };
      });
      const inputs = this.a.db.prepare("SELECT name, sha256, bytes FROM teamtask_inputs WHERE task_id=? ORDER BY name").all(t.id);
      return { contract: "kapelle.team-task/v1", orgId: this.o.orgId, taskId: t.id, revision: t.revision, state: t.state, audience: t.audience, title: t.title, notes: t.notes, inputs,
        creatorId: t.creator_id, createdAt: t.created_at, done: t.state === "done" ? { by: t.done_by, at: t.done_at, resultDigest: t.done_result_digest } : null, attempts };
    });
  }
  /** Session: the verified result text of one attempt (audience only; never an unverified one). */
  /** H2 (Fable C-E): what a handbook approval interrupts: runs in progress (they stop at their next step) and approved or proposed
   *  plans (each needs a new plan). Counts only. */
  handbookImpact() {
    return this.a.read(() => ({ running: (this.a.db.prepare("SELECT COUNT(*) AS n FROM teamtask_attempts WHERE state='running'").get() as { n: number }).n,
      plans: (this.a.db.prepare("SELECT COUNT(*) AS n FROM teamtask_attempts WHERE state IN ('approved','proposed')").get() as { n: number }).n }));
  }
  /** H2 cite chips: an attempt's frozen system map, inside the task's audience (the same check as read), re-hashed vs the plan. */
  mapOf(m: TeamMember, b: any) {
    return this.a.read(() => {
      const t = this.task(m, b?.taskId), p = this.plan(String(b?.mapOf ?? ""));
      if (!p || p.plan.taskId !== t.id || !p.plan.context) refuse("teamtask_input_invalid");
      let text = "";
      try { text = readFileSync(join(this.dir(p!.plan.attemptId), "system-map.txt"), "utf8"); } catch { refuse("teamtask_system_map_unavailable"); }
      if (sha(Buffer.from(text, "utf8")) !== p!.plan.context!.map.sha256) refuse("teamtask_system_map_unavailable");
      return { map: { id: p!.plan.attemptId, text, handbookVersion: p!.plan.context!.handbook.version } };
    });
  }
  result(m: TeamMember, b: any) {
    return this.a.read(() => {
      const t = this.task(m, b?.taskId);
      const r = this.a.db.prepare("SELECT attempt_id, envelope FROM teamtask_results WHERE task_id=? AND result_id=?").get(t.id, String(b?.resultId ?? "")) as { attempt_id: string; envelope: string } | undefined;
      if (!r) refuse("teamtask_result_unverified");
      const e = JSON.parse(r!.envelope) as ResultEnvelope, f = JSON.parse(readFileSync(join(this.dir(r!.attempt_id), "result-v1.json"), "utf8"));
      if (sha(Buffer.from(f.content, "utf8")) !== e.sha256) refuse("teamtask_result_unverified"); // changed since verification: unavailable
      return { resultId: b.resultId, text: f.content as string, sha256: e.sha256, bytes: e.bytes };
    });
  }
  /** T3 (design: Website hand-off): a VERIFIED result of a task the member can see, re-hashed now, as the source reference of a
   *  Website request (that request still needs its own exact card approval; approving the task never approves a PR). */
  websiteSource(m: TeamMember, b: any) {
    return this.a.read(() => {
      const t = this.task(m, b?.taskId);
      const r = typeof b?.resultId === "string" ? this.a.db.prepare("SELECT attempt_id, envelope, result_digest FROM teamtask_results WHERE task_id=? AND result_id=?").get(t.id, b.resultId) as
        { attempt_id: string; envelope: string; result_digest: string } | undefined : undefined;
      if (!r) refuse("teamtask_result_unverified");
      const e = JSON.parse(r!.envelope) as ResultEnvelope, f = JSON.parse(readFileSync(join(this.dir(r!.attempt_id), "result-v1.json"), "utf8"));
      if (typeof f.content !== "string" || sha(Buffer.from(f.content, "utf8")) !== e.sha256) refuse("teamtask_result_unverified");
      return { taskId: t.id as string, resultId: b.resultId as string, resultDigest: r!.result_digest };
    });
  }
  list(m: TeamMember) {
    const ids = this.a.read(() => this.a.db.prepare("SELECT id, audience FROM teamtasks ORDER BY created_at DESC LIMIT ?").all(TEAMTASK_LIMITS.listMax)) as { id: string; audience: string }[];
    return { tasks: ids.filter((x) => this.canSee(m, x.audience)).map((x) => this.read(m, { taskId: x.id })) };
  }
  async idle() { await this.chain.catch(() => {}); }
  stop() { if (this.waiting) clearTimeout(this.waiting); for (const ac of this.running.values()) ac.abort(); }
}
