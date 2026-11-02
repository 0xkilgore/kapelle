// Transcription T-4 (plan v2 §9; Fable R-7, D-2 placeholder): accept starts the clock, the hard cap from upload, Ops holds, the
// sweep, the start-up reconcile, audio never in a backup, and a restore that re-applies deletion. Synthetic audio only.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { restoreOrgBackup } from "../src/org/org-backup.js";
import { transcriptionWorld, policyFor } from "./transcription-world.js";
import * as F from "./media-fixtures.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const DAY = 86_400_000;

describe.skipIf(!enabled)("transcription retention and deletion", () => {
  it("accept + 7 days; hard cap 30 days; holds; sweep; reconcile; backup excludes audio; restore records it deleted", async () => {
    const w = await transcriptionWorld({ backup: true });
    try {
      const org = () => w.org, jobs = () => org().transcription.jobs!, media = (id: string) => join(w.cfg.stateRoot, "media", id);
      const row = (id: string) => org().sqlite.db.prepare("SELECT state, label, accepted_at, audio_deleted_at, hold_reason FROM transcription_jobs WHERE job_id=?").get(id) as any;
      const tomb = (id: string) => (org().sqlite.db.prepare("SELECT reason FROM media_tombstones WHERE job_id=? ORDER BY seq").all(id) as { reason: string }[]).map((r) => r.reason);
      expect((await w.ops("/ops/transcription/policy/approve", { policy: policyFor() })).ok).toBe(true);
      const run = async (b: Buffer) => { const u = await w.upload(w.robin, b); expect((await w.start(w.robin, u)).ok).toBe(true); await jobs().idle(); return u; };
      const A = await run(F.wav(30));
      // Accept: reviewers only; done jobs only; a receipt to the actor; the clock starts.
      expect((await w.act(w.alex, "transcript.accept", { jobId: A.jobId })).error).toBe("access_role_not_permitted");
      const notDone = await w.upload(w.robin, F.wav(31));
      expect((await w.act(w.robin, "transcript.accept", { jobId: notDone.jobId })).error).toBe("transcript_job_state");
      w.mail.length = 0;
      const acc = await w.act(w.robin, "transcript.accept", { jobId: A.jobId });
      expect(acc).toMatchObject({ ok: true, authorization: { authn: "email-session" }, result: { jobId: A.jobId } });
      const acceptedAt = Date.parse(acc.result.acceptedAt);
      expect(Date.parse(acc.result.audioDeleteAfter) - acceptedAt).toBe(7 * DAY);
      await new Promise((r) => setTimeout(r, 20));
      expect(w.mail.filter((m) => m.kind === "receipt").map((m) => [m.to, m.receipt.action])).toEqual([["robin@exna.test", "transcript.accept"]]);
      // Before the clock: nothing; after it: the audio is tombstoned and deleted; the transcript stays.
      expect(jobs().sweep(new Date(acceptedAt + 7 * DAY - 1000).toISOString()).deleted).toEqual([]);
      expect(jobs().sweep(new Date(acceptedAt + 7 * DAY + 1000).toISOString()).deleted).toEqual([{ jobId: A.jobId, reason: "accepted_retention" }]);
      expect(existsSync(media(A.jobId))).toBe(false);
      expect(row(A.jobId).audio_deleted_at).not.toBeNull();
      expect(tomb(A.jobId)).toEqual(["accepted_retention"]);
      expect(existsSync(join(w.cfg.folder, "reviewers-private", "transcripts", A.jobId, "transcript.v1.part-01.md"))).toBe(true);
      expect((await w.post("/o/exna/api/transcript/list", {}, w.robin)).result.jobs.find((j: any) => j.jobId === A.jobId)).toMatchObject({ audioDeleted: true, state: "done" });
      // The hard cap from upload applies whatever the state (here: never transcribed).
      const now = Date.now();
      expect(jobs().sweep(new Date(now + 29 * DAY).toISOString()).deleted).toEqual([]);
      // An Ops hold pauses the clocks (reason required, audited); released, the next sweep applies them.
      expect(await w.ops("/ops/transcription/hold", { jobId: notDone.jobId, on: true })).toEqual({ ok: false, error: "transcript_hold_reason_required" });
      expect(await w.ops("/ops/transcription/hold", { jobId: notDone.jobId, on: true, reason: "Board asked to keep it pending a complaint" })).toEqual({ ok: true, jobId: notDone.jobId, hold: true });
      expect(jobs().sweep(new Date(now + 31 * DAY).toISOString()).deleted).toEqual([]);
      expect((await w.ops("/ops/status")).transcription.held).toEqual([{ jobId: notDone.jobId, holdAt: expect.any(String), reason: "Board asked to keep it pending a complaint" }]);
      expect(await w.ops("/ops/transcription/hold", { jobId: notDone.jobId, on: false })).toEqual({ ok: true, jobId: notDone.jobId, hold: false });
      expect(jobs().sweep(new Date(now + 31 * DAY).toISOString()).deleted).toEqual([{ jobId: notDone.jobId, reason: "hard_cap" }]);
      expect(org().sqlite.db.prepare("SELECT event, detail FROM intake_audit WHERE intake_id=? AND event LIKE 'media_%' ORDER BY seq").all(notDone.jobId)).toEqual([
        { event: "media_hold_on", detail: "Board asked to keep it pending a complaint" }, { event: "media_hold_off", detail: "released" }, { event: "media_deleted", detail: "hard_cap" }]);
      // A queued job at the hard cap gives up its reservation and is discarded.
      const Q = await w.upload(w.robin, F.wav(32)), key = `transcription:${Q.jobId}:1`, ledger = org().transcription.ledger!;
      ledger.reserve(key, "fake-nova-3-en", 0.01, 1);
      org().sqlite.db.prepare("UPDATE transcription_jobs SET state='queued', attempts=1, reservation_key=? WHERE job_id=?").run(key, Q.jobId);
      jobs().sweep(new Date(now + 31 * DAY).toISOString());
      expect(row(Q.jobId)).toMatchObject({ state: "discarded", label: "media_retention_expired" });
      expect(ledger.entry(key)).toMatchObject({ state: "released", reason: "media_retention_expired" });
      // acceptPlusDays 0 (policy v2): accepting deletes the audio at once.
      expect((await w.ops("/ops/transcription/policy/approve", { policy: { ...policyFor(2), retention: { acceptPlusDays: 0, hardCapDays: 30 } } })).ok).toBe(true);
      const B = await run(F.wav(33));
      expect((await w.act(w.robin, "transcript.accept", { jobId: B.jobId })).ok).toBe(true);
      expect(tomb(B.jobId)).toEqual(["accepted_retention"]);
      // Backup: transcripts are in the set, audio never is.
      const C = await w.upload(w.robin, F.wav(34)); // audio present at backup time
      const bk = await org().backupNow();
      const set = JSON.parse(readFileSync(join(w.cfg.backup!.dir, bk.set, "set.json"), "utf8"));
      expect(set.files.some((f: any) => f.path.startsWith(`folder/reviewers-private/transcripts/${B.jobId}/transcript.v1.part-01.md`))).toBe(true);
      expect(set.files.filter((f: any) => /media|audio\.bin/.test(f.path))).toEqual([]);
      // Start-up reconcile: an orphan media dir is tombstoned + removed; deleted audio reappearing is removed again.
      mkdirSync(media("tj_" + "f".repeat(32)), { mode: 0o700 }); writeFileSync(join(media("tj_" + "f".repeat(32)), "audio.bin"), "x");
      mkdirSync(media(A.jobId), { mode: 0o700 }); writeFileSync(join(media(A.jobId), "audio.bin"), "x");
      await w.restart();
      expect(org().transcription.jobs!.deletionStats().deletions).toMatchObject({ orphan_at_start: 1 });
      expect(existsSync(media("tj_" + "f".repeat(32)))).toBe(false);
      expect(existsSync(media(A.jobId))).toBe(false);
      expect((await w.ops("/ops/status")).transcription).toMatchObject({ recovered: { orphans: 1, reapplied: 1, missing: 0 }, holds: 0,
        deletions: { accepted_retention: 2, hard_cap: 2, orphan_at_start: 1 } });
      // Restore into a new root: the DB says C's audio exists, the set has none -> recorded deleted (missing_at_start);
      // the transcripts are back and readable.
      const r = restoreOrgBackup(join(w.cfg.backup!.dir, bk.set), join(w.base, "restored"), "exna");
      const { backup: _b, ...rest } = w.cfg;
      const restored = await openOrgRuntime({ ...rest, stateRoot: r.stateRoot, folder: r.folder, accessSocket: r.accessSocket, opsSocket: r.opsSocket },
        { fetchImpl: (async () => new Response("{}", { status: 503 })) as never });
      try {
        const rr = restored.sqlite.db.prepare("SELECT audio_deleted_at FROM transcription_jobs WHERE job_id=?").get(C.jobId) as any;
        expect(rr.audio_deleted_at).not.toBeNull();
        expect((restored.sqlite.db.prepare("SELECT reason FROM media_tombstones WHERE job_id=? ORDER BY seq DESC").get(C.jobId) as any).reason).toBe("missing_at_start");
        expect(restored.transcription.jobs!.read({ jobId: B.jobId, part: 1 }).markdown).toMatch(/^# Transcript \(automatic, unverified\)/);
      } finally { await restored.close(); }
    } finally { await w.close(); }
  }, 240_000);
});
