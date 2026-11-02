// Transcription T-2 (plan v2 §3, Fable R-2, R-7, P-2(i), P-3): the org's media store. Audio lives ONLY under
// stateRoot/media/<jobId>/ (never in the backed-up folder). An upload is minted (routine `media.upload`, reviewer role,
// bound to the minting hub session) and then streamed once: the id is consumed on the first PUT whatever happens next.
// The stream is hashed and counted as it is written; the container and duration are sniffed from the header after close;
// a second upload of the same audio returns the existing job (per-org dedup, no cross-org signal). Every refusal after a
// file exists writes a TOMBSTONE first, then unlinks (deletion evidence).
import { createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { Readable } from "node:stream";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { AccessError } from "../../access/org-access.js";
import { CONTENT_TYPES, sniffMedia } from "./media-sniff.js";
import { TranscriptionRefused, type TranscriptionProfile } from "./profile.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS media_uploads(upload_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, session_ref TEXT NOT NULL, file_name TEXT NOT NULL, size INTEGER NOT NULL,
  content_type TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, job_id TEXT, outcome TEXT) STRICT;
CREATE TABLE IF NOT EXISTS transcription_jobs(job_id TEXT PRIMARY KEY, audio_sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, container TEXT NOT NULL, content_type TEXT NOT NULL,
  duration_sec REAL NOT NULL, file_name TEXT NOT NULL, uploaded_by TEXT NOT NULL, uploaded_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploaded','queued','sending','done','failed','unsettled','discarded')), label TEXT, audio_deleted_at TEXT,
  -- T-3: set by transcript.start (P-4: the reservation is held from approval), and by the run.
  attempts INTEGER NOT NULL DEFAULT 0, reservation_key TEXT, operation_id TEXT, started_by TEXT, started_at TEXT, policy_hash TEXT, profile_hash TEXT, attestation TEXT,
  billed_sec REAL, cost_usd REAL, parts INTEGER, finished_at TEXT, accepted_at TEXT,
  -- T-4: an Ops hold pauses both deletion clocks (explicit authority, audited).
  hold_reason TEXT, hold_at TEXT) STRICT;
CREATE INDEX IF NOT EXISTS transcription_jobs_sha ON transcription_jobs(audio_sha256);
CREATE TABLE IF NOT EXISTS media_tombstones(seq INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, audio_sha256 TEXT, bytes INTEGER, reason TEXT NOT NULL, at TEXT NOT NULL) STRICT;`;
const UPLOAD_TTL_MS = 10 * 60_000;
const plainName = (s: unknown) => typeof s === "string" && s.length >= 1 && s.length <= 255 && !/[\u0000-\u001f\u007f/\\<>]/.test(s);

export type UploadMember = { memberId: string; role: string; sessionRef: string };
export class MediaStore {
  private readonly now: () => string;
  readonly dir: string;
  constructor(private readonly a: SqliteAuthority, private readonly o: { stateRoot: string; profile: TranscriptionProfile }, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString());
    a.db.exec(SCHEMA);
    this.dir = join(o.stateRoot, "media");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }
  /** Routine `media.upload` (session tier, reviewer): a single-use id bound to member + hub session + size + type, 10 minutes. */
  mint(m: UploadMember, body: any) {
    if (!["admin", "reviewer"].includes(m.role)) throw new AccessError("access_role_not_permitted");
    if (!plainName(body?.fileName)) throw new AccessError("media_file_name_invalid");
    if (!(typeof body?.contentType === "string" && CONTENT_TYPES[body.contentType])) throw new TranscriptionRefused("media_type_not_admitted");
    if (!(Number.isInteger(body?.size) && body.size > 0 && body.size <= this.o.profile.limits.maxUploadBytes)) throw new TranscriptionRefused("media_too_large");
    const uploadId = "up_" + randomBytes(16).toString("hex"), expiresAt = new Date(Date.parse(this.now()) + UPLOAD_TTL_MS).toISOString();
    this.a.write(() => this.a.db.prepare("INSERT INTO media_uploads(upload_id,member_id,session_ref,file_name,size,content_type,expires_at) VALUES (?,?,?,?,?,?,?)")
      .run(uploadId, m.memberId, m.sessionRef, body.fileName, body.size, body.contentType, expiresAt));
    return { uploadId, expiresAt, maxBytes: this.o.profile.limits.maxUploadBytes };
  }
  /** The streamed PUT. P-3: consumed first (whatever the outcome), then every check, then the write. */
  async put(uploadId: string, m: UploadMember, stream: Readable, meta: { size: number; contentType: string }) {
    const row = this.a.write(() => {
      const r = this.a.db.prepare("SELECT * FROM media_uploads WHERE upload_id=?").get(uploadId) as
        { member_id: string; session_ref: string; file_name: string; size: number; content_type: string; expires_at: string; consumed_at: string | null } | undefined;
      if (r && !r.consumed_at) this.a.db.prepare("UPDATE media_uploads SET consumed_at=? WHERE upload_id=?").run(this.now(), uploadId);
      return r;
    });
    const refuse = (label: string): never => { this.a.write(() => this.a.db.prepare("UPDATE media_uploads SET outcome=? WHERE upload_id=? AND outcome IS NULL").run(label, uploadId));
      throw new TranscriptionRefused(label); };
    if (!row) throw new TranscriptionRefused("media_upload_unknown");
    if (row.consumed_at) throw new TranscriptionRefused("media_upload_consumed");
    if (Date.parse(row.expires_at) <= Date.parse(this.now())) refuse("media_upload_expired");
    if (row.member_id !== m.memberId || row.session_ref !== m.sessionRef) refuse("media_upload_session_mismatch");
    if (meta.size !== row.size) refuse("media_size_mismatch");
    if (meta.contentType !== row.content_type) refuse("media_type_not_admitted");
    const jobId = "tj_" + randomBytes(16).toString("hex"), dir = join(this.dir, jobId), file = join(dir, "audio.bin");
    mkdirSync(dir, { mode: 0o700 });
    const hash = createHash("sha256");
    let bytes = 0, label: string | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(file, { flags: "wx", mode: 0o600 });
        const fail = (l: string) => { label ??= l; stream.unpipe(out); out.destroy(); stream.destroy(); reject(new TranscriptionRefused(l)); };
        stream.on("data", (c: Buffer) => { bytes += c.length; if (bytes > row.size) return fail("media_size_mismatch"); hash.update(c); });
        stream.on("aborted", () => fail("media_upload_aborted"));
        stream.on("error", () => fail("media_upload_aborted"));
        stream.on("end", () => { if (bytes !== row.size) fail(bytes < row.size ? "media_upload_aborted" : "media_size_mismatch"); });
        out.on("error", () => fail("media_upload_aborted"));
        out.on("finish", () => { if (!label) resolve(); });
        stream.pipe(out);
      });
      const sha = hash.digest("hex"), sniffed = sniffMedia(file, this.o.profile.limits.maxAudioMinutes * 60);
      if (sniffed.container !== CONTENT_TYPES[row.content_type]) throw new TranscriptionRefused("media_type_not_admitted");
      // Per-org dedup: the same audio (still present) returns its job; this copy is tombstoned and removed.
      const existing = this.a.read(() => this.a.db.prepare("SELECT job_id FROM transcription_jobs WHERE audio_sha256=? AND audio_deleted_at IS NULL").get(sha)) as { job_id: string } | undefined;
      if (existing) {
        this.tombstone(jobId, sha, bytes, "duplicate_upload");
        this.a.write(() => this.a.db.prepare("UPDATE media_uploads SET job_id=?, outcome='deduplicated' WHERE upload_id=?").run(existing.job_id, uploadId));
        return { jobId: existing.job_id, deduplicated: true, audioSha256: "sha256:" + sha, durationSec: sniffed.durationSec, container: sniffed.container };
      }
      this.a.write(() => {
        this.a.db.prepare(`INSERT INTO transcription_jobs(job_id,audio_sha256,bytes,container,content_type,duration_sec,file_name,uploaded_by,uploaded_at,state)
          VALUES (?,?,?,?,?,?,?,?,?,'uploaded')`).run(jobId, sha, bytes, sniffed.container, row.content_type, sniffed.durationSec, row.file_name, m.memberId, this.now());
        this.a.db.prepare("UPDATE media_uploads SET job_id=?, outcome='uploaded' WHERE upload_id=?").run(jobId, uploadId);
      });
      return { jobId, deduplicated: false, audioSha256: "sha256:" + sha, durationSec: sniffed.durationSec, container: sniffed.container };
    } catch (e) {
      const l = e instanceof TranscriptionRefused ? e.label : "media_upload_aborted";
      if (existsSync(dir)) this.tombstone(jobId, null, bytes, `upload_refused:${l}`);
      this.a.write(() => this.a.db.prepare("UPDATE media_uploads SET outcome=? WHERE upload_id=? AND outcome IS NULL").run(l, uploadId));
      throw e instanceof TranscriptionRefused ? e : new TranscriptionRefused(l);
    }
  }
  /** R-7: the tombstone row first (deletion evidence, restored with the DB), then the files. */
  tombstone(jobId: string, sha: string | null, bytes: number | null, reason: string) {
    this.a.write(() => this.a.db.prepare("INSERT INTO media_tombstones(job_id,audio_sha256,bytes,reason,at) VALUES (?,?,?,?,?)").run(jobId, sha, bytes, reason.slice(0, 100), this.now()));
    rmSync(join(this.dir, jobId), { recursive: true, force: true });
  }
  stats() {
    return this.a.read(() => ({
      jobs: Object.fromEntries((this.a.db.prepare("SELECT state, COUNT(*) AS n FROM transcription_jobs GROUP BY state").all() as { state: string; n: number }[]).map((r) => [r.state, r.n])),
      tombstones: (this.a.db.prepare("SELECT COUNT(*) AS n FROM media_tombstones").get() as { n: number }).n,
    }));
  }
}
