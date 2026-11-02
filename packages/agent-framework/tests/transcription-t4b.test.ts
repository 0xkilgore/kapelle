// Transcription T-4b, Fable's required fixes carried from the T-2/T-3 reviews:
// F-1 the hub cuts every refused upload (it never reads or drains a refused body) and the idle timeout runs before any check.
// F-2 the ledger's `sent` and the job's `sending` commit together; a `queued` job whose entry is already `sent` recovers as
//     unsettled; one job's unexpected failure never wedges the org's queue. Synthetic audio only.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { connect } from "node:net";
import { Hub } from "../src/hub/hub.js";
import { fakeTranscriptionBackend } from "../src/org/transcription/adapter.js";
import { transcriptionProfileHash, TRANSCRIPTION_PROFILES } from "../src/org/transcription/profile.js";
import { transcriptionWorld, policyFor, ATTESTATION } from "./transcription-world.js";
import * as F from "./media-fixtures.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
/** A raw HTTP client: send the request head, then `body` chunks every 50 ms forever (until closed). Resolves with the status
 *  line seen (if any), when the hub closed the connection, and how many body bytes this client managed to write. */
function rawPut(port: number, head: string, chunk: Buffer, o: { maxChunks?: number } = {}) {
  return new Promise<{ status: string | null; closedAfterMs: number; wrote: number }>((resolve) => {
    const t0 = Date.now(), s = connect(port, "127.0.0.1"); let status: string | null = null, wrote = 0, n = 0;
    const tick = setInterval(() => { if (o.maxChunks !== undefined && n >= o.maxChunks) return; n++; if (!s.destroyed) s.write(chunk, () => { wrote += chunk.length; }); }, 50);
    s.on("data", (d) => { status ??= d.toString("latin1").split("\r\n")[0]; });
    s.on("error", () => {});
    s.on("close", () => { clearInterval(tick); resolve({ status, closedAfterMs: Date.now() - t0, wrote }); });
    s.write(head);
    setTimeout(() => { if (!s.destroyed) { s.destroy(); } }, 8000);
  });
}

describe.skipIf(!enabled)("T-4b: F-1 hub cut + idle-first, F-2 atomic sent + queue recovery", () => {
  it("F-1: a stranger's 250 MiB PUT, an endless chunked body and an idle valid upload are all cut; the hub reads no refused body", async () => {
    const w = await transcriptionWorld(), idleBefore = Hub.UPLOAD_IDLE_MS;
    Hub.UPLOAD_IDLE_MS = 600;
    try {
      const port = w.hub.port, mb = Buffer.alloc(64 * 1024, 7);
      const mint = async (size: number) => (await w.post("/o/exna/api/media/upload", { fileName: "m.wav", size, contentType: "audio/wav" }, w.robin)).result.uploadId as string;
      // No session, 250 MiB declared: answered 401 and closed at once, long before the body (or the idle timeout).
      const id1 = await mint(1000);
      const a = await rawPut(port, `PUT /o/exna/upload/${id1} HTTP/1.1\r\nHost: x\r\nContent-Type: audio/wav\r\nContent-Length: ${250 * 1024 * 1024}\r\n\r\n`, mb);
      expect(a.status).toBe("HTTP/1.1 401 Unauthorized");
      expect(a.closedAfterMs).toBeLessThan(500);
      expect(a.wrote).toBeLessThan(2 * 1024 * 1024);
      // Chunked (no length) with a valid session: 411 and closed at once, however long the client keeps streaming.
      const id2 = await mint(1000);
      const b = await rawPut(port, `PUT /o/exna/upload/${id2} HTTP/1.1\r\nHost: x\r\nCookie: ${w.robin}\r\nContent-Type: audio/wav\r\nTransfer-Encoding: chunked\r\n\r\n`,
        Buffer.concat([Buffer.from(mb.length.toString(16) + "\r\n"), mb, Buffer.from("\r\n")]));
      expect(b.status).toBe("HTTP/1.1 411 Length Required");
      expect(b.closedAfterMs).toBeLessThan(500);
      // Every other refusal also cuts: cross-site, a non-audio type.
      for (const [headers, line] of [[`Cookie: ${w.robin}\r\nSec-Fetch-Site: cross-site\r\nContent-Type: audio/wav`, "HTTP/1.1 403 Forbidden"],
        [`Cookie: ${w.robin}\r\nContent-Type: text/plain`, "HTTP/1.1 415 Unsupported Media Type"]] as const) {
        const id = await mint(1000);
        const r = await rawPut(port, `PUT /o/exna/upload/${id} HTTP/1.1\r\nHost: x\r\n${headers}\r\nContent-Length: ${200 * 1024 * 1024}\r\n\r\n`, mb);
        expect(r.status, line).toBe(line); expect(r.closedAfterMs, line).toBeLessThan(500);
      }
      // A valid upload whose client goes quiet half-way: cut at the idle timeout; the runtime tombstones what it got.
      const audio = F.wav(30), id3 = await mint(audio.length);
      const c = await rawPut(port, `PUT /o/exna/upload/${id3} HTTP/1.1\r\nHost: x\r\nCookie: ${w.robin}\r\nContent-Type: audio/wav\r\nContent-Length: ${audio.length}\r\n\r\n`,
        audio.subarray(0, 64 * 1024), { maxChunks: 2 });
      expect(c.closedAfterMs).toBeGreaterThanOrEqual(600); expect(c.closedAfterMs).toBeLessThan(3000);
      for (let i = 0; i < 100 && (w.org.sqlite.db.prepare("SELECT outcome FROM media_uploads WHERE upload_id=?").get(id3) as any).outcome === null; i++) await new Promise((r) => setTimeout(r, 20));
      expect(w.org.sqlite.db.prepare("SELECT outcome FROM media_uploads WHERE upload_id=?").get(id3)).toEqual({ outcome: "media_upload_aborted" });
      expect(readdirSync(join(w.cfg.stateRoot, "media"))).toEqual([]);
    } finally { Hub.UPLOAD_IDLE_MS = idleBefore; await w.close(); }
  }, 120_000);

  it("F-2: sent + sending are one transaction; queued+sent recovers unsettled; one bad job never wedges the queue", async () => {
    const w = await transcriptionWorld({ backend: fakeTranscriptionBackend() });
    try {
      const org = () => w.org, db = () => org().sqlite.db, ledger = () => org().transcription.ledger!;
      const job = (id: string) => db().prepare("SELECT state, label, reservation_key FROM transcription_jobs WHERE job_id=?").get(id) as any;
      expect((await w.ops("/ops/transcription/policy/approve", { policy: policyFor() })).ok).toBe(true);
      // Atomicity: make the job's `sending` update fail for job A only. The ledger's `sent` rolls back with it (still
      // `reserved`), the queue catches A (released, failed, fixed label) and runs B.
      const A = await w.upload(w.robin, F.wav(30)), B = await w.upload(w.robin, F.wav(31));
      db().exec(`CREATE TRIGGER fail_sending_a BEFORE UPDATE OF state ON transcription_jobs WHEN NEW.state='sending' AND NEW.job_id='${A.jobId}' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
      await w.start(w.robin, A); await w.start(w.robin, B); await org().transcription.jobs!.idle();
      expect(job(A.jobId)).toMatchObject({ state: "failed", label: "transcription_internal_error" });
      expect(ledger().entry(job(A.jobId).reservation_key)).toMatchObject({ state: "released", reason: "transcription_internal_error" }); // never `sent`
      expect(job(B.jobId).state).toBe("done");
      db().exec("DROP TRIGGER fail_sending_a");
      // No wedge: a queued job whose reservation is missing (an impossible row) fails with the fixed label; the next one runs.
      const E = await w.upload(w.robin, F.wav(32)), G = await w.upload(w.robin, F.wav(33)), ph = transcriptionProfileHash(TRANSCRIPTION_PROFILES.fake);
      const plant = (id: string, key: string) => db().prepare(`UPDATE transcription_jobs SET state='queued', attempts=1, reservation_key=?, started_at=?, policy_hash=?, profile_hash=?, attestation=? WHERE job_id=?`)
        .run(key, new Date().toISOString(), org().transcription.policies.active()!.hash, ph, JSON.stringify(ATTESTATION), id);
      plant(E.jobId, "transcription:missing:1");
      await w.start(w.robin, G); await org().transcription.jobs!.idle();
      expect(job(E.jobId)).toMatchObject({ state: "failed", label: "transcription_internal_error" });
      expect(job(G.jobId).state).toBe("done");
      // Recovery: a queued job whose entry is already `sent` (the old crash window) -> unsettled at restart, never re-sent;
      // a normally queued job keeps its reservation and runs.
      const C = await w.upload(w.admin, F.wav(34)), D = await w.upload(w.admin, F.wav(35));
      const kc = `transcription:${C.jobId}:1`, kd = `transcription:${D.jobId}:1`;
      ledger().reserve(kc, "fake-nova-3-en", 0.01, 1); ledger().markSent(kc); plant(C.jobId, kc);
      ledger().reserve(kd, "fake-nova-3-en", 0.01, 1); plant(D.jobId, kd);
      const calls = () => (w.org.transcription.jobs as any).o.backend.calls.map((x: any) => x.audioSha256);
      await w.restart();
      expect(job(C.jobId)).toMatchObject({ state: "unsettled", label: "transcription_outcome_unknown_after_restart" });
      expect(ledger().entry(kc)).toMatchObject({ state: "unsettled", reason: "transcription_outcome_unknown_after_restart" });
      await org().transcription.jobs!.idle();
      expect(job(D.jobId).state).toBe("done");
      expect(calls()).not.toContain(createHash("sha256").update(F.wav(34)).digest("hex")); // C was never re-sent
      expect((await w.ops("/ops/status")).transcription.recovered).toMatchObject({ resumedUnsettled: 1 });
      expect(existsSync(join(w.cfg.folder, "reviewers-private", "transcripts", D.jobId, "manifest.json"))).toBe(true);
    } finally { await w.close(); }
  }, 120_000);
});
