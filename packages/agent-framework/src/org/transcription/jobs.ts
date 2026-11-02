// Transcription T-3 (plan v2 §5-§7, Fable R-3, R-4, R-5, R-8, P-2(ii), P-4): the job.
// - `transcript.start` (session-fresh, receipts): artifact digest = the audio's sha256; body {jobId, profileHash, attestation}.
//   Preconditions: an active policy for the configured profile, a qualified profile, the R-8 attestation, the job uploaded
//   (or failed and retryable) with its audio present. The reservation is taken AT APPROVAL and held while queued (P-4).
// - One job per org at a time (a queue). The run marks the ledger `sent` before the backend call. Refused -> release, job
//   failed (retryable). Uncertain -> unsettled, never resubmitted. Billed over the reservation -> settle the actual and audit
//   it (P-2(ii)); the overage counts against the monthly cap. An empty transcript is settled (it was billed) and fails.
// - The transcript: deterministic lines `[hh:mm:ss] Speaker N: text`, pre-split into parts <= 32 KiB with the same header
//   on every part, plus manifest.json; written into a hidden `.partial-<job>` dir and renamed into place when complete.
// - Restart: `sending` with a complete transcript settles from its manifest; otherwise unsettled. Queued keeps its reservation.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { refuseWebsiteRoot } from "../website/content-root.js";
import type { SqliteSpendLedger } from "../../service/sqlite-effects.js";
import { AccessError, type Authorization } from "../../access/org-access.js";
import type { TranscriptionBackend, Utterance } from "./adapter.js";
import { transcriptionPolicySchema, type TranscriptionPolicies } from "./policy.js";
import type { MediaStore } from "./media.js";
import { transcriptionCostUsd, transcriptionProfileHash, transcriptionReservationUsd, TranscriptionRefused, TranscriptionUncertain, type TranscriptionProfile } from "./profile.js";

const text = (max: number) => z.string().min(1).max(max).refine((s) => !/[\u0000-\u001f\u007f<>]/.test(s) && s.trim().length > 0, "plain_text_only");
/** R-8: the organiser's attestation, a precondition of the job (not metadata). */
export const attestationSchema = z.object({ authority: text(200), announced: z.literal(true), audience: text(200), declinedAlternative: text(300) }).strict();
export type Attestation = z.infer<typeof attestationSchema>;
export const PART_MAX_BYTES = 32 * 1024; // ASSEMBLER_LIMITS.maxFileBytes: each part is one snapshot document, never chunked
type Job = { job_id: string; audio_sha256: string; bytes: number; container: string; content_type: string; duration_sec: number; file_name: string; state: string;
  label: string | null; audio_deleted_at: string | null; attempts: number; reservation_key: string | null; policy_hash: string | null; profile_hash: string | null;
  attestation: string | null; started_by: string | null; operation_id: string | null; billed_sec: number | null; cost_usd: number | null; parts: number | null;
  uploaded_at: string; accepted_at: string | null; hold_reason: string | null };
const DAY = 86_400_000;

const hms = (sec: number) => { const s = Math.max(0, Math.floor(sec)); return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, "0")).join(":"); };
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** Deterministic transcript lines. Speaker numbers are 1-based estimates; `(uncertain)` marks low confidence or overlap; a
 *  passage with no words stays as `[inaudible]`; long utterances wrap at sentence boundaries, every line keeping its prefix. */
export function transcriptLines(utterances: Utterance[]) {
  const out: { line: string; start: number; end: number }[] = [];
  let prevEnd = -1;
  for (const u of [...utterances].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const words = clean(u.text), uncertain = (words && u.confidence < 0.7) || u.start < prevEnd - 0.05;
    const prefix = `[${hms(u.start)}] Speaker ${u.speaker + 1}${uncertain ? " (uncertain)" : ""}: `;
    const pieces: string[] = [];
    if (!words) pieces.push("[inaudible]");
    else for (const sentence of words.match(/[^.!?]+[.!?]*\s*/g) ?? [words]) {
      const last = pieces.at(-1);
      if (last !== undefined && (last + sentence).length <= 400) pieces[pieces.length - 1] = last + sentence; else pieces.push(sentence.length > 400 ? sentence.slice(0, 400) : sentence);
    }
    for (const p of pieces) out.push({ line: prefix + p.trim(), start: u.start, end: u.end });
    prevEnd = Math.max(prevEnd, u.end);
  }
  return out;
}
const header = (h: { jobId: string; part: number; parts: number; from: number; to: number; fileName: string; audioSha: string; profileHash: string; policyHash: string;
  backend: string; model: string; attestation: Attestation }) => [
  `# Transcript (automatic, unverified): part ${h.part} of ${h.parts}`,
  `Job ${h.jobId}. Recording "${clean(h.fileName).slice(0, 120)}", audio sha256:${h.audioSha}.`,
  `Profile ${h.profileHash}, policy ${h.policyHash}, ${h.backend} ${h.model}. Time range ${hms(h.from)} to ${hms(h.to)}.`,
  `Recording notice (organiser's attestation, not a legal finding): authority: ${clean(h.attestation.authority)}; announced: yes; audience: ${clean(h.attestation.audience)}; ` +
    `alternative for people who declined: ${clean(h.attestation.declinedAlternative)}.`,
  "Speaker labels are automatic estimates, not identities. Times are from the start of the recording.", "", ""].join("\n");

export class TranscriptionJobs {
  private readonly now: () => string;
  private chain: Promise<unknown> = Promise.resolve();
  readonly dir: string;
  constructor(private readonly a: SqliteAuthority, private readonly o: { folder: string; media: MediaStore; profile: TranscriptionProfile; policies: TranscriptionPolicies;
    backend: TranscriptionBackend | null; ledger: SqliteSpendLedger; qualified: boolean; audit: (event: string, jobId: string, detail: string) => void }, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString());
    this.dir = join(o.folder, "reviewers-private", "transcripts");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // T-5: one Task per adopted part range (the allocation is also keyed by it).
    a.db.exec(`CREATE TABLE IF NOT EXISTS transcript_adoptions(task_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, first_part INTEGER NOT NULL, last_part INTEGER NOT NULL,
      member_id TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(job_id, first_part, last_part)) STRICT;`);
  }
  private job(id: unknown) {
    const j = typeof id === "string" && /^tj_[a-f0-9]{32}$/.test(id) ? this.a.read(() => this.a.db.prepare("SELECT * FROM transcription_jobs WHERE job_id=?").get(id)) as Job | undefined : undefined;
    if (!j) throw new AccessError("transcript_job_unknown");
    return j;
  }
  private audioPath(jobId: string) { return join(this.o.media.dir, jobId, "audio.bin"); }

  /** The consequential `transcript.start` handler (the Authorization was made by the runtime's step-up). */
  start(z: Authorization, body: any) {
    const j = this.job(body?.jobId);
    if (!(z.action === "transcript.start" && z.artifactDigest === "sha256:" + j.audio_sha256)) throw new AccessError("transcript_audio_digest_mismatch");
    const active = this.o.policies.active();
    if (!active) throw new AccessError("transcription_no_policy");
    const ph = transcriptionProfileHash(this.o.profile);
    if (body.profileHash !== ph || active.policy.profileHash !== ph) throw new AccessError("transcription_policy_profile_mismatch");
    if (!this.o.qualified || !this.o.backend) throw new AccessError("transcription_profile_not_qualified");
    const att = attestationSchema.safeParse(body.attestation);
    if (!att.success) throw new AccessError("transcript_attestation_required");
    if (!["uploaded", "failed"].includes(j.state)) throw new AccessError("transcript_job_state");
    if (j.audio_deleted_at || !existsSync(this.audioPath(j.job_id))) throw new AccessError("transcript_audio_missing");
    const key = `transcription:${j.job_id}:${j.attempts + 1}`;
    // P-4: the reservation is what the approval authorised, so it is taken now and held while the job waits its turn.
    try { this.o.ledger.reserve(key, this.o.profile.id, transcriptionReservationUsd(this.o.profile, j.duration_sec), transcriptionReservationUsd(this.o.profile, Infinity)); }
    catch (e) { const m = e instanceof Error ? e.message : ""; throw new AccessError(m === "hosted_monthly_cap_exceeded" ? "transcription_monthly_cap_exceeded" : m === "hosted_run_cap_exceeded" ? "transcription_job_cap_exceeded" : "transcription_reservation_failed"); }
    this.a.write(() => this.a.db.prepare(`UPDATE transcription_jobs SET state='queued', label=NULL, attempts=attempts+1, reservation_key=?, operation_id=?, started_by=?, started_at=?,
      policy_hash=?, profile_hash=?, attestation=? WHERE job_id=?`).run(key, z.operationId, z.memberId, this.now(), active.hash, ph, JSON.stringify(att.data), j.job_id));
    this.o.audit("transcript_queued", j.job_id, `reserved:${transcriptionReservationUsd(this.o.profile, j.duration_sec).toFixed(4)}`);
    this.kick();
    return { jobId: j.job_id, state: "queued" };
  }
  /** P-4: discarding a queued job releases its reservation; any not-running job's audio is tombstoned and deleted now. */
  discard(z: Authorization, body: any) {
    const j = this.job(body?.jobId);
    if (z.action !== "transcript.discard") throw new AccessError("access_authorization_mismatch");
    if (["sending"].includes(j.state)) throw new AccessError("transcript_job_state");
    if (j.state === "queued" && j.reservation_key) this.o.ledger.release(j.reservation_key, "transcript_discarded");
    if (!j.audio_deleted_at) { this.o.media.tombstone(j.job_id, j.audio_sha256, j.bytes, "discarded");
      this.a.write(() => this.a.db.prepare("UPDATE transcription_jobs SET audio_deleted_at=? WHERE job_id=?").run(this.now(), j.job_id)); }
    if (j.state !== "done") this.a.write(() => this.a.db.prepare("UPDATE transcription_jobs SET state='discarded', label='transcript_discarded' WHERE job_id=?").run(j.job_id));
    return { jobId: j.job_id, state: j.state === "done" ? "done" : "discarded", audioDeleted: true };
  }
  /** Start-up (before any listener): finish or account for what a crash interrupted; resume the queue. */
  recover() {
    for (const d of readdirSync(this.dir)) if (d.startsWith(".partial-")) rmSync(join(this.dir, d), { recursive: true, force: true });
    const reconciled = this.reconcile();
    // F-2: a `queued` job whose ledger entry is already `sent` (a store from before the atomic marking, or a planted row): the
    // request may have left, so it is unsettled exactly like `sending` without a transcript; it is never re-sent.
    const queuedSent = (this.a.read(() => this.a.db.prepare("SELECT * FROM transcription_jobs WHERE state='queued' AND reservation_key IS NOT NULL").all()) as Job[])
      .filter((j) => this.o.ledger.entry(j.reservation_key!)?.state === "sent");
    for (const j of queuedSent) {
      this.o.ledger.markUnsettled(j.reservation_key!, "transcription_outcome_unknown_after_restart");
      this.a.write(() => this.a.db.prepare("UPDATE transcription_jobs SET state='unsettled', label='transcription_outcome_unknown_after_restart' WHERE job_id=?").run(j.job_id));
      this.o.audit("transcript_unsettled", j.job_id, "transcription_outcome_unknown_after_restart");
    }
    const sending = this.a.read(() => this.a.db.prepare("SELECT * FROM transcription_jobs WHERE state='sending'").all()) as Job[];
    for (const j of sending) {
      const manifest = join(this.dir, j.job_id, "manifest.json");
      if (existsSync(manifest)) {
        const m = JSON.parse(readFileSync(manifest, "utf8")) as { billedSec: number; parts: unknown[] };
        this.finish(j, m.billedSec, m.parts.length);
      } else {
        this.o.ledger.markUnsettled(j.reservation_key!, "transcription_outcome_unknown_after_restart");
        this.a.write(() => this.a.db.prepare("UPDATE transcription_jobs SET state='unsettled', label='transcription_outcome_unknown_after_restart' WHERE job_id=?").run(j.job_id));
        this.o.audit("transcript_unsettled", j.job_id, "transcription_outcome_unknown_after_restart");
      }
    }
    const swept = this.sweep().deleted.length;
    this.kick();
    return { resumedUnsettled: sending.length + queuedSent.length, ...reconciled, swept };
  }
  /** Run queued jobs one at a time (per org). Returns the chain, for tests. */
  kick() { this.chain = this.chain.then(() => this.drain()).catch(() => {}); return this.chain; }
  /** Wait for the queue to go idle (close, tests). */
  idle() { return this.chain; }
  private async drain() {
    for (;;) {
      const j = this.a.read(() => this.a.db.prepare("SELECT * FROM transcription_jobs WHERE state='queued' ORDER BY started_at, job_id LIMIT 1").get()) as Job | undefined;
      if (!j) return;
      // F-2: one job's unexpected failure never stops the org's queue. Money first: an entry that may have left is
      // unsettled, one that never left is released; the job gets a fixed label; then the next job runs.
      try { await this.runOne(j); }
      catch {
        const state = j.reservation_key ? this.o.ledger.entry(j.reservation_key)?.state : undefined;
        if (state === "sent") this.o.ledger.markUnsettled(j.reservation_key!, "transcription_internal_error");
        else if (state === "reserved") this.o.ledger.release(j.reservation_key!, "transcription_internal_error");
        this.fail(j, state === "sent" ? "unsettled" : "failed", "transcription_internal_error"); // throws only if the store does: then stop
      }
    }
  }
  private settle(j: Job, billedSec: number) {
    const cost = transcriptionCostUsd(this.o.profile, billedSec), reserved = this.o.ledger.entry(j.reservation_key!)?.reservedUsd ?? 0;
    this.o.ledger.settle(j.reservation_key!, cost);
    // P-2(ii): the bill is the truth; an overage over the reservation is settled and audited (both figures).
    if (cost > reserved + 1e-9) this.o.audit("transcription_bill_over_reservation", j.job_id, `reserved:${reserved.toFixed(4)};billed:${cost.toFixed(4)};billedSec:${billedSec}`);
    return cost;
  }
  private finish(j: Job, billedSec: number, parts: number) {
    const cost = this.settle(j, billedSec);
    this.a.write(() => this.a.db.prepare("UPDATE transcription_jobs SET state='done', label=NULL, billed_sec=?, cost_usd=?, parts=?, finished_at=? WHERE job_id=?")
      .run(billedSec, cost, parts, this.now(), j.job_id));
    this.o.audit("transcript_done", j.job_id, `parts:${parts};billedSec:${billedSec}`);
  }
  private fail(j: Job, state: "failed" | "unsettled", label: string) {
    this.a.write(() => this.a.db.prepare("UPDATE transcription_jobs SET state=?, label=?, finished_at=? WHERE job_id=?").run(state, label, this.now(), j.job_id));
    this.o.audit(state === "failed" ? "transcript_failed" : "transcript_unsettled", j.job_id, label);
  }
  private async runOne(j: Job) {
    const audio = this.audioPath(j.job_id);
    if (!existsSync(audio)) { this.o.ledger.release(j.reservation_key!, "transcript_audio_missing"); return this.fail(j, "failed", "transcript_audio_missing"); }
    // Durable BEFORE the call, and ATOMIC with the job's state (F-2): the ledger's `sent` and the job's `sending` commit together.
    this.o.ledger.markSent(j.reservation_key!, () => this.a.db.prepare("UPDATE transcription_jobs SET state='sending' WHERE job_id=?").run(j.job_id));
    let result;
    try { result = await this.o.backend!.transcribe({ audioPath: audio, audioSha256: j.audio_sha256, durationSec: j.duration_sec, contentType: j.content_type }, new AbortController().signal); }
    catch (e) {
      if (e instanceof TranscriptionRefused) { this.o.ledger.release(j.reservation_key!, e.label); return this.fail(j, "failed", e.label); }
      const label = e instanceof TranscriptionUncertain ? e.label : "transcription_transport_failed";
      this.o.ledger.markUnsettled(j.reservation_key!, label);
      return this.fail(j, "unsettled", label);
    }
    if (!result.utterances.some((u) => clean(u.text))) { this.settle(j, result.billedSec); return this.fail(j, "failed", "transcription_output_empty"); }
    if (result.billedSec > this.o.profile.limits.maxAudioMinutes * 60 * 1.05) this.o.audit("transcription_duration_over_cap", j.job_id, `billedSec:${result.billedSec}`);
    try { const parts = this.write(j, result); this.finish(j, result.billedSec, parts); }
    catch { this.settle(j, result.billedSec); this.fail(j, "failed", "transcription_write_interrupted"); }
  }
  /** Parts <= 32 KiB each (the header on every part), then manifest.json; a hidden partial dir renamed into place. */
  private write(j: Job, r: { utterances: Utterance[]; billedSec: number; requestId: string | null; model: string }) {
    const lines = transcriptLines(r.utterances), att = attestationSchema.parse(JSON.parse(j.attestation!));
    const base = { jobId: j.job_id, fileName: j.file_name, audioSha: j.audio_sha256, profileHash: j.profile_hash!, policyHash: j.policy_hash!, backend: this.o.profile.backend, model: r.model, attestation: att };
    // Split by bytes with a worst-case header (the real one is shorter: same text, smaller numbers).
    const room = PART_MAX_BYTES - Buffer.byteLength(header({ ...base, part: 99, parts: 99, from: 359_999, to: 359_999 }));
    const groups: (typeof lines)[] = [[]];
    let used = 0;
    for (const l of lines) { const n = Buffer.byteLength(l.line) + 1; if (used + n > room && groups.at(-1)!.length) { groups.push([]); used = 0; } groups.at(-1)!.push(l); used += n; }
    const tmp = join(this.dir, `.partial-${j.job_id}`), final = join(this.dir, j.job_id);
    refuseWebsiteRoot(this.o.folder, tmp); refuseWebsiteRoot(this.o.folder, final); // Fable R-2 (caught: transcription_write_interrupted)
    rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { mode: 0o700 });
    let lineNo = 0;
    const parts = groups.map((g, i) => {
      const file = `transcript.v1.part-${String(i + 1).padStart(2, "0")}.md`;
      const body = header({ ...base, part: i + 1, parts: groups.length, from: g[0]?.start ?? 0, to: g.at(-1)?.end ?? 0 }) + g.map((l) => l.line).join("\n") + "\n";
      const bytes = Buffer.byteLength(body);
      if (bytes > PART_MAX_BYTES) throw new Error("transcription_write_interrupted");
      writeFileSync(join(tmp, file), body, { mode: 0o600, flag: "wx" });
      const firstLine = lineNo + 1; lineNo += g.length;
      return { file, sha256: createHash("sha256").update(body).digest("hex"), bytes, firstLine, lastLine: lineNo, startTime: g[0]?.start ?? 0, endTime: g.at(-1)?.end ?? 0 };
    });
    const manifest = { contract: "kapelle.transcript-manifest/v1", jobId: j.job_id, version: 1, audioSha256: "sha256:" + j.audio_sha256, durationSec: j.duration_sec,
      billedSec: r.billedSec, profileHash: j.profile_hash, policyHash: j.policy_hash, backend: this.o.profile.backend, model: r.model, requestId: r.requestId, attestation: att,
      speakerLabels: "automatic estimates, not identities", lines: lineNo, parts, createdAt: this.now() };
    writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 1), { mode: 0o600, flag: "wx" });
    if (existsSync(final)) throw new Error("transcription_write_interrupted"); // never overwrite: v1 is immutable
    renameSync(tmp, final);
    return parts.length;
  }
  // ---- T-5 (plan v2 §7, Fable R-5, §15(b), P-1): a contiguous part range as plan material ----
  /** Validate a part range for adoption: a done job, 1 <= first <= last <= parts, at most `maxFiles` parts whose bytes fit
   *  the packet with room for the Task. Returns the snapshot selection (paths relative to the transcripts scope). */
  partRange(body: any, caps: { maxFiles: number; maxBytes: number }) {
    const j = this.job(body?.transcriptJobId);
    if (j.state !== "done") throw new AccessError("transcript_job_state");
    const [first, last] = Array.isArray(body?.parts) && body.parts.length === 2 ? body.parts : [NaN, NaN];
    if (!(Number.isInteger(first) && Number.isInteger(last) && first >= 1 && first <= last && last <= (j.parts ?? 0))) throw new AccessError("adopt_transcript_parts_invalid");
    const m = JSON.parse(readFileSync(join(this.dir, j.job_id, "manifest.json"), "utf8")) as { parts: { file: string; bytes: number }[] };
    const parts = m.parts.slice(first - 1, last), bytes = parts.reduce((n, p) => n + p.bytes, 0);
    if (parts.length > caps.maxFiles || bytes > caps.maxBytes) throw new AccessError("adopt_transcript_parts_over_cap");
    return { jobId: j.job_id, first, last, bytes, select: parts.map((p) => `${j.job_id}/${p.file}`) };
  }
  // ---- T-4 (plan v2 §9, Fable R-7, D-2): retention and deletion ----
  /** The retention numbers the job ran under (its pinned policy), else the active policy's, else the D-2 placeholder. */
  private retention(j: Job) {
    const row = j.policy_hash ? this.a.read(() => this.a.db.prepare("SELECT json FROM transcription_policy WHERE hash=?").get(j.policy_hash)) as { json: string } | undefined : undefined;
    return row ? transcriptionPolicySchema.parse(JSON.parse(row.json)).retention : this.o.policies.active()?.policy.retention ?? { acceptPlusDays: 7, hardCapDays: 30 };
  }
  /** R-7: the tombstone row first (deletion evidence, restored with the DB), then the files; the job records the deletion. */
  private deleteAudio(j: Job, reason: string) {
    this.o.media.tombstone(j.job_id, j.audio_sha256, j.bytes, reason);
    this.a.write(() => this.a.db.prepare("UPDATE transcription_jobs SET audio_deleted_at=? WHERE job_id=?").run(this.now(), j.job_id));
    this.o.audit("media_deleted", j.job_id, reason);
  }
  /** `transcript.accept` (session tier, reviewer, receipt): starts the accept + N days clock (0 = delete now). */
  accept(z: Authorization, body: any) {
    const j = this.job(body?.jobId);
    if (z.action !== "transcript.accept") throw new AccessError("access_authorization_mismatch");
    if (j.state !== "done") throw new AccessError("transcript_job_state");
    const acceptedAt = j.accepted_at ?? this.now();
    if (!j.accepted_at) this.a.write(() => this.a.db.prepare("UPDATE transcription_jobs SET accepted_at=? WHERE job_id=?").run(acceptedAt, j.job_id));
    const days = this.retention(j).acceptPlusDays;
    if (days === 0 && !j.audio_deleted_at && !j.hold_reason) this.deleteAudio(j, "accepted_retention");
    return { jobId: j.job_id, acceptedAt, audioDeleteAfter: new Date(Date.parse(acceptedAt) + days * DAY).toISOString() };
  }
  /** Ops (owner-only socket): a hold pauses both clocks; releasing it lets the next sweep apply them. Audited either way. */
  hold(jobId: unknown, on: boolean, reason: unknown) {
    const j = this.job(jobId);
    if (on && !(typeof reason === "string" && reason.trim().length >= 3 && reason.length <= 200 && !/[\u0000-\u001f\u007f]/.test(reason))) throw new AccessError("transcript_hold_reason_required");
    this.a.write(() => this.a.db.prepare("UPDATE transcription_jobs SET hold_reason=?, hold_at=? WHERE job_id=?").run(on ? String(reason) : null, on ? this.now() : null, j.job_id));
    this.o.audit(on ? "media_hold_on" : "media_hold_off", j.job_id, on ? String(reason).slice(0, 200) : "released");
    return { jobId: j.job_id, hold: on };
  }
  /** The daily sweep (also at start and on the Ops route). `at` is for tests; production always uses the clock. */
  sweep(at = this.now()) {
    const t = Date.parse(at), deleted: { jobId: string; reason: string }[] = [];
    const rows = this.a.read(() => this.a.db.prepare("SELECT * FROM transcription_jobs WHERE audio_deleted_at IS NULL AND hold_reason IS NULL AND state <> 'sending'").all()) as Job[];
    for (const j of rows) {
      const r = this.retention(j);
      if (j.accepted_at && t >= Date.parse(j.accepted_at) + r.acceptPlusDays * DAY) { this.deleteAudio(j, "accepted_retention"); deleted.push({ jobId: j.job_id, reason: "accepted_retention" }); continue; }
      if (t >= Date.parse(j.uploaded_at) + r.hardCapDays * DAY) {
        // A job still waiting its turn at the hard cap gives up its reservation; it cannot run without its audio.
        if (j.state === "queued" && j.reservation_key) { this.o.ledger.release(j.reservation_key, "media_retention_expired");
          this.a.write(() => this.a.db.prepare("UPDATE transcription_jobs SET state='discarded', label='media_retention_expired' WHERE job_id=?").run(j.job_id)); }
        this.deleteAudio(j, "hard_cap"); deleted.push({ jobId: j.job_id, reason: "hard_cap" });
      }
    }
    return { deleted };
  }
  /** Start-up reconcile (R-7, like intake archiving): tombstoned audio still on disk is unlinked; a media dir with no job
   *  (a crash mid-upload) is tombstoned + removed; a job whose audio is missing (e.g. a restore: backups never hold audio) is
   *  recorded as deleted. The DB is the truth. */
  reconcile() {
    const out = { orphans: 0, reapplied: 0, missing: 0 };
    for (const d of readdirSync(this.o.media.dir)) {
      if (!/^tj_[a-f0-9]{32}$/.test(d)) continue;
      const j = this.a.read(() => this.a.db.prepare("SELECT * FROM transcription_jobs WHERE job_id=?").get(d)) as Job | undefined;
      if (!j) { this.o.media.tombstone(d, null, null, "orphan_at_start"); out.orphans++; }
      else if (j.audio_deleted_at) { rmSync(join(this.o.media.dir, d), { recursive: true, force: true }); out.reapplied++; }
    }
    const present = this.a.read(() => this.a.db.prepare("SELECT * FROM transcription_jobs WHERE audio_deleted_at IS NULL").all()) as Job[];
    for (const j of present) if (!existsSync(this.audioPath(j.job_id))) { this.deleteAudio(j, "missing_at_start"); out.missing++; }
    return out;
  }
  deletionStats() {
    return this.a.read(() => ({
      deletions: Object.fromEntries((this.a.db.prepare("SELECT reason, COUNT(*) AS n FROM media_tombstones GROUP BY reason").all() as { reason: string; n: number }[]).map((r) => [r.reason, r.n])),
      holds: (this.a.db.prepare("SELECT COUNT(*) AS n FROM transcription_jobs WHERE hold_reason IS NOT NULL").get() as { n: number }).n,
      // Fable T-4 (hold wins over the hard cap): every held job is listed for the monthly review, with when and why.
      held: (this.a.db.prepare("SELECT job_id, hold_at, hold_reason FROM transcription_jobs WHERE hold_reason IS NOT NULL ORDER BY hold_at").all() as { job_id: string; hold_at: string; hold_reason: string }[])
        .map((r) => ({ jobId: r.job_id, holdAt: r.hold_at, reason: r.hold_reason })) }));
  }
  /** Reviewer reads (routine, session tier). Text-only; never the audio. */
  list() {
    const adoptions = this.a.read(() => this.a.db.prepare("SELECT task_id, job_id, first_part, last_part FROM transcript_adoptions").all()) as { task_id: string; job_id: string; first_part: number; last_part: number }[];
    return (this.a.read(() => this.a.db.prepare(`SELECT job_id, audio_sha256, state, label, file_name, duration_sec, uploaded_at, started_at, finished_at, parts, audio_deleted_at, accepted_at, cost_usd
      FROM transcription_jobs ORDER BY uploaded_at DESC LIMIT 100`).all()) as Record<string, unknown>[]).map((r) => ({ jobId: r.job_id, audioSha256: "sha256:" + r.audio_sha256, state: r.state, label: r.label,
      fileName: r.file_name, durationSec: r.duration_sec, uploadedAt: r.uploaded_at, startedAt: r.started_at, finishedAt: r.finished_at, parts: r.parts,
      audioDeleted: !!r.audio_deleted_at, acceptedAt: r.accepted_at,
      adoptions: adoptions.filter((a) => a.job_id === r.job_id).map((a) => ({ taskId: a.task_id, parts: [a.first_part, a.last_part] })) }));
  }
  read(body: any) {
    const j = this.job(body?.jobId);
    if (j.state !== "done") throw new AccessError("transcript_job_state");
    const n = Number(body?.part);
    if (!(Number.isInteger(n) && n >= 1 && n <= (j.parts ?? 0))) throw new AccessError("transcript_part_unknown");
    const file = `transcript.v1.part-${String(n).padStart(2, "0")}.md`;
    return { jobId: j.job_id, part: n, parts: j.parts, file, markdown: readFileSync(join(this.dir, j.job_id, file), "utf8") };
  }
}
