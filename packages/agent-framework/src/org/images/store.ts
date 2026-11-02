// IMAGES-V1 I1 (design of record IMAGES-V1.md a5160d58 §1; Fable FABLE-REVIEW-IMAGES-V1 N-2): a member attaches ONE flyer or
// image to their own chat. Same shape as the transcription upload (T-2): a single-use ticket (routine `image.upload`) bound to
// member + hub session + conversation + declared size + type, then ONE streamed PUT (counted, capped; the hub buffers
// nothing). The original is held in memory only (<= 4 MiB; never on disk), decoded and RE-ENCODED by the separate decoder
// process (decoder/decode.mjs: sharp/libvips, JPEG/PNG/WebP loaders only; bytes in, one header line + JPEG out), and dropped
// on every outcome; only the normalized JPEG is written (stateRoot/media/images/<imageId>.jpg, via a temp file in
// media/images/quarantine), never under members/, the folder or a webroot. On the org host the decoder is a socket-activated
// systemd instance (deploy/systemd/kapelle-image-decode@.socket/.service: DynamicUser, PrivateNetwork, AF_UNIX only, no state
// paths, 256 MiB, 10 s): the org unit's NoNewPrivileges forbids any privileged helper, and needs none.
// Reads (`image.read`) are the conversation starter's only. Retention follows the conversation: when it is tombstoned, its
// images are deleted (the row keeps hashes, sizes and the reason as deletion evidence). No provider ever sees an image here.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import type { Duplex, Writable } from "node:stream";
import type { Readable } from "node:stream";
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { AccessError } from "../../access/org-access.js";
import { SharedDrive, driveImageName } from "../library/drive.js";

export const IMAGE_LIMITS = { inputBytes: 4 * 1024 * 1024, perMemberStored: 50, perOrgBytes: 512 * 1024 * 1024, mintsPerMemberHour: 20, ticketMinutes: 10,
  decodeMs: 10_000, quarantineReapMs: 60 * 60_000, inFlightPerOrg: 4 };
export const IMAGE_TYPES: Record<string, "jpeg" | "png" | "webp"> = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp" };
export const SANITIZER = "kapelle.image-sanitizer/v1";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS image_uploads(upload_id TEXT PRIMARY KEY, member_id TEXT NOT NULL, session_ref TEXT NOT NULL, conversation_id TEXT NOT NULL,
  size INTEGER NOT NULL, content_type TEXT NOT NULL, at TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT, image_id TEXT, outcome TEXT) STRICT;
CREATE TABLE IF NOT EXISTS chat_images(id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, member_id TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_bytes INTEGER NOT NULL,
  source_type TEXT NOT NULL, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, sanitizer TEXT NOT NULL, at TEXT NOT NULL,
  deleted_at TEXT, delete_reason TEXT) STRICT;
CREATE INDEX IF NOT EXISTS chat_images_conv ON chat_images(conversation_id);`;

/** The decoder: the original's bytes in; the normalized JPEG and its facts out. Never a path, never member-supplied arguments. */
export type Decoded = { data: Buffer; width: number; height: number; sanitizer: string };
export type ImageDecoder = { readonly mode: string; available(): boolean; decode(input: Buffer): Promise<Decoded> };
const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const isSocket = (p: string) => { try { return statSync(p).isSocket(); } catch { return false; } };
/** One exchange: write the input, half-close, read ONE header line + exactly `bytes` bytes (bounded), with a wall-clock limit. */
function exchange(out: Writable, inp: NodeJS.ReadableStream, input: Buffer, timeoutMs: number, kill: () => void): Promise<Decoded> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0), settled = false;
    const finish = (f: () => void) => { if (settled) return; settled = true; clearTimeout(timer); f(); };
    const timer = setTimeout(() => finish(() => { kill(); reject(new AccessError("image_decoder_timeout")); }), timeoutMs);
    inp.on("data", (c: Buffer) => { buf = Buffer.concat([buf, c]); if (buf.length > 1024 * 1024 + 4096) finish(() => { kill(); reject(new AccessError("image_unreadable")); }); });
    inp.on("error", () => finish(() => reject(new AccessError("image_decoder_unavailable"))));
    inp.on("end", () => finish(() => {
      const nl = buf.indexOf(10); let h: any = null;
      try { h = nl > 0 ? JSON.parse(buf.subarray(0, nl).toString("utf8")) : null; } catch { h = null; }
      if (h?.ok === true && h.sanitizer === SANITIZER && Number.isInteger(h.width) && Number.isInteger(h.height) && Number.isInteger(h.bytes) && buf.length - nl - 1 === h.bytes)
        return resolve({ data: Buffer.from(buf.subarray(nl + 1)), width: h.width, height: h.height, sanitizer: h.sanitizer });
      reject(new AccessError(typeof h?.label === "string" && /^image_[a-z_]{1,40}$/.test(h.label) ? h.label : "image_unreadable"));
    }));
    out.on("error", () => { /* the decoder may refuse early (too large): the answer still arrives on inp */ });
    out.end(input);
  });
}
/** Tests and the development Mac: a plain child process with a V8 heap cap and a wall-clock kill. NOT network-isolated
 *  (IMAGES-V1 N-2): the org host uses `socketDecoder`; the runtime config must name this mode explicitly. */
export const childDecoder = (o: { node: string; script: string; timeoutMs?: number }): ImageDecoder => ({ mode: "child",
  available: () => isFile(o.node) && isFile(o.script),
  decode: (input) => {
    const child = spawn(o.node, ["--max-old-space-size=256", o.script], { stdio: ["pipe", "pipe", "ignore"], env: {} });
    return new Promise<Decoded>((resolve, reject) => {
      child.on("error", () => reject(new AccessError("image_decoder_unavailable")));
      exchange(child.stdin, child.stdout, input, o.timeoutMs ?? IMAGE_LIMITS.decodeMs, () => child.kill("SIGKILL")).then(resolve, reject);
    });
  } });
/** The org host: the per-org socket of the socket-activated decoder (one connection = one fresh sandboxed instance). */
export const socketDecoder = (o: { socket: string; timeoutMs?: number }): ImageDecoder => ({ mode: "systemd",
  available: () => isSocket(o.socket),
  decode: (input) => new Promise<Decoded>((resolve, reject) => {
    const s: Duplex = connect(o.socket);
    s.on("error", () => reject(new AccessError("image_decoder_unavailable")));
    s.on("connect", () => exchange(s, s, input, (o.timeoutMs ?? IMAGE_LIMITS.decodeMs) + 2_000, () => s.destroy()).then(resolve, reject));
  }) });

const sniff = (b: Buffer): "jpeg" | "png" | "webp" | null =>
  b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "jpeg"
  : b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "png"
  : b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" ? "webp" : null;
const sha = (b: Buffer) => "sha256:" + createHash("sha256").update(b).digest("hex");
export type ImageMember = { memberId: string; role: string; sessionRef: string };
type Upload = { member_id: string; session_ref: string; conversation_id: string; size: number; content_type: string; expires_at: string; consumed_at: string | null };

export class ImageStore {
  readonly dir: string; readonly quarantine: string;
  private readonly now: () => string;
  /** One decoder per org (the socket unit allows ONE connection): decodes queue here instead of being refused. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Fable I1a N-2: uploads in progress hold <= 4 MiB each in memory; at most this many per org at once. */
  private inFlight = 0;
  /** LIBRARY L1: the shared drive (a drive ticket's normalized JPEG is stored there instead of in a chat). */
  drive: SharedDrive | null = null;
  constructor(private readonly a: SqliteAuthority, private readonly o: { stateRoot: string; decoder: ImageDecoder }, now?: () => string) {
    this.now = now ?? (() => new Date().toISOString());
    a.db.exec(SCHEMA);
    this.dir = join(o.stateRoot, "media", "images"); this.quarantine = join(this.dir, "quarantine");
    mkdirSync(this.quarantine, { recursive: true, mode: 0o700 });
  }
  /** The member's own, live conversation (the same rule as chat text uploads). */
  private ownConversation(memberId: string, conversationId: unknown) {
    const c = typeof conversationId === "string" ? this.a.db.prepare("SELECT started_by, deleted_at FROM chat_conversations WHERE id=?").get(conversationId) as
      { started_by: string; deleted_at: string | null } | undefined : undefined;
    if (!c || c.started_by !== memberId || c.deleted_at) throw new AccessError("chat_conversation_unknown");
  }
  /** Routine `image.upload` (session tier): a single-use ticket, 10 minutes, bound to member + session + conversation + size + type. */
  mint(m: ImageMember, body: any) {
    const at = this.now(), hourAgo = new Date(Date.parse(at) - 3_600_000).toISOString();
    if (!this.o.decoder.available()) throw new AccessError("image_decoder_unavailable"); // fail closed, never at org start
    // LIBRARY L1: a drive ticket (body.drive) names the image instead of a conversation; conversation_id holds `drive:<name>`.
    const drive = body?.drive === true;
    if (drive && !this.drive) throw new AccessError("drive_not_available");
    const target = drive ? "drive:" + driveImageName(body?.fileName) : body?.conversationId;
    return this.a.write(() => {
      if (!drive) this.ownConversation(m.memberId, body?.conversationId);
      if (!(typeof body?.contentType === "string" && IMAGE_TYPES[body.contentType])) throw new AccessError("image_type_not_admitted");
      if (!(Number.isInteger(body?.size) && body.size > 0 && body.size <= IMAGE_LIMITS.inputBytes)) throw new AccessError("image_too_large");
      if ((this.a.db.prepare("SELECT COUNT(*) AS n FROM image_uploads WHERE member_id=? AND at>?").get(m.memberId, hourAgo) as { n: number }).n >= IMAGE_LIMITS.mintsPerMemberHour)
        throw new AccessError("image_upload_rate_limited");
      if ((this.a.db.prepare("SELECT COUNT(*) AS n FROM chat_images WHERE member_id=? AND deleted_at IS NULL").get(m.memberId) as { n: number }).n >= IMAGE_LIMITS.perMemberStored)
        throw new AccessError("image_limit");
      if (this.orgBytes() >= IMAGE_LIMITS.perOrgBytes) throw new AccessError("image_org_storage_full");
      const uploadId = "im_" + randomBytes(16).toString("hex"), expiresAt = new Date(Date.parse(at) + IMAGE_LIMITS.ticketMinutes * 60_000).toISOString();
      this.a.db.prepare("INSERT INTO image_uploads(upload_id,member_id,session_ref,conversation_id,size,content_type,at,expires_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(uploadId, m.memberId, m.sessionRef, target, body.size, body.contentType, at, expiresAt);
      return { uploadId, expiresAt, maxBytes: IMAGE_LIMITS.inputBytes };
    });
  }
  /** The streamed PUT: the ticket is consumed first (whatever happens next), then every check, then the bounded write, the
   *  decoder, and the original's deletion. Only the normalized JPEG survives. */
  async put(uploadId: string, m: ImageMember, stream: Readable, meta: { size: number; contentType: string }) {
    return await this.receive(uploadId, m, stream, meta, "chat") as { deduplicated: boolean; imageId: string; conversationId: string; sha256: string; bytes: number; width: number; height: number; at: string };
  }
  /** LIBRARY L1: the same streamed PUT for a drive ticket; the normalized JPEG lands in the shared drive. */
  async putDrive(uploadId: string, m: ImageMember, stream: Readable, meta: { size: number; contentType: string }) {
    return await this.receive(uploadId, m, stream, meta, "drive") as ReturnType<SharedDrive["save"]> & { drive: true };
  }
  /** True when the ticket was minted for the drive (the PUT dispatch). */
  isDriveTicket(uploadId: string) {
    return !!this.a.read(() => this.a.db.prepare("SELECT 1 FROM image_uploads WHERE upload_id=? AND conversation_id LIKE 'drive:%'").get(uploadId));
  }
  private async receive(uploadId: string, m: ImageMember, stream: Readable, meta: { size: number; contentType: string }, mode: "chat" | "drive") {
    const row = this.a.write(() => {
      const r = this.a.db.prepare("SELECT * FROM image_uploads WHERE upload_id=?").get(uploadId) as Upload | undefined;
      if (r && !r.consumed_at) this.a.db.prepare("UPDATE image_uploads SET consumed_at=? WHERE upload_id=?").run(this.now(), uploadId);
      return r;
    });
    const mark = (outcome: string, imageId: string | null = null) => this.a.write(() =>
      this.a.db.prepare("UPDATE image_uploads SET outcome=COALESCE(outcome, ?), image_id=COALESCE(image_id, ?) WHERE upload_id=?").run(outcome, imageId, uploadId));
    const refuse = (label: string): never => { mark(label); throw new AccessError(label); };
    if (!row) throw new AccessError("image_upload_unknown");
    if (row.consumed_at) throw new AccessError("image_upload_consumed");
    if (Date.parse(row.expires_at) <= Date.parse(this.now())) refuse("image_upload_expired");
    if (row.member_id !== m.memberId || row.session_ref !== m.sessionRef) refuse("image_upload_session_mismatch");
    if (meta.size !== row.size) refuse("image_size_mismatch");
    if (meta.contentType !== row.content_type) refuse("image_type_not_admitted");
    const driveName = row.conversation_id.startsWith("drive:") ? row.conversation_id.slice(6) : null;
    if (driveName === null) { try { this.a.read(() => this.ownConversation(m.memberId, row.conversation_id)); } catch { refuse("chat_conversation_unknown"); } }
    else if (!this.drive) refuse("drive_not_available");
    if ((driveName !== null) !== (mode === "drive")) refuse("image_upload_unknown");
    if (this.inFlight >= IMAGE_LIMITS.inFlightPerOrg) refuse("image_upload_busy");
    this.inFlight++;
    const imageId = "img_" + randomBytes(16).toString("hex"), temp = join(this.quarantine, imageId + ".tmp"), final = join(this.dir, imageId + ".jpg");
    try {
      // The original in memory only: counted against the declared size, never written to disk.
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        let bytes = 0, failed = false;
        const fail = (l: string) => { if (failed) return; failed = true; stream.destroy(); reject(new AccessError(l)); };
        stream.on("data", (c: Buffer) => { bytes += c.length; if (bytes > row.size) return fail("image_size_mismatch"); chunks.push(c); });
        stream.on("aborted", () => fail("image_upload_aborted"));
        stream.on("error", () => fail("image_upload_aborted"));
        stream.on("end", () => { if (bytes !== row.size) fail(bytes < row.size ? "image_upload_aborted" : "image_size_mismatch"); else if (!failed) resolve(); });
      });
      const src = Buffer.concat(chunks), kind = sniff(src);
      if (!kind || kind !== IMAGE_TYPES[row.content_type]) throw new AccessError("image_type_mismatch");
      const job = this.chain.then(() => this.o.decoder.decode(src));
      this.chain = job.catch(() => undefined);
      const r = await job;
      const norm = r.data;
      if (sniff(norm) !== "jpeg" || norm.length > 1024 * 1024) throw new AccessError("image_unreadable");
      const normSha = sha(norm);
      if (driveName !== null) { // LIBRARY L1: the drive keeps it once per content hash; nothing goes in a chat
        const v = this.drive!.save(m, norm, { width: r.width, height: r.height, name: driveName, source: "drive" });
        mark(v.deduplicated ? "deduplicated" : "stored_in_drive");
        return { drive: true, ...v };
      }
      // The same normalized image twice in one conversation is one image.
      const prior = this.a.read(() => this.a.db.prepare("SELECT id FROM chat_images WHERE conversation_id=? AND sha256=? AND deleted_at IS NULL").get(row.conversation_id, normSha)) as { id: string } | undefined;
      if (prior) { mark("deduplicated", prior.id); return { ...this.view(prior.id)!, deduplicated: true }; }
      writeFileSync(temp, norm, { flag: "wx", mode: 0o600 }); renameSync(temp, final);
      this.a.write(() => {
        this.a.db.prepare(`INSERT INTO chat_images(id,conversation_id,member_id,source_sha256,source_bytes,source_type,sha256,bytes,width,height,sanitizer,at,deleted_at,delete_reason)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`).run(imageId, row.conversation_id, m.memberId, sha(src), src.length, kind, normSha, norm.length, r.width, r.height, r.sanitizer, this.now());
        this.a.db.prepare("UPDATE image_uploads SET outcome='stored', image_id=? WHERE upload_id=?").run(imageId, uploadId);
      });
      return { ...this.view(imageId)!, deduplicated: false };
    } catch (e) {
      const label = e instanceof AccessError ? e.reason : "image_upload_aborted";
      mark(label);
      throw e instanceof AccessError ? e : new AccessError(label);
    } finally { this.inFlight--; rmSync(temp, { force: true }); }
  }
  private view(imageId: string) {
    const r = this.a.read(() => this.a.db.prepare("SELECT id, conversation_id, sha256, bytes, width, height, at FROM chat_images WHERE id=? AND deleted_at IS NULL").get(imageId)) as
      { id: string; conversation_id: string; sha256: string; bytes: number; width: number; height: number; at: string } | undefined;
    return r ? { imageId: r.id, conversationId: r.conversation_id, sha256: r.sha256, bytes: r.bytes, width: r.width, height: r.height, at: r.at } : null;
  }
  /** Chat images + the shared drive: one storage cap per org. */
  private orgBytes() {
    return (this.a.db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM chat_images WHERE deleted_at IS NULL").get() as { n: number }).n + (this.drive?.bytesUsed() ?? 0);
  }
  /** LIBRARY L1: "Save to shared drive" on one of the member's own chat images (the same normalized bytes, re-hashed). */
  saveToDrive(m: ImageMember, body: any) {
    if (!this.drive) throw new AccessError("drive_not_available");
    const img = this.read(m, { imageId: body?.imageId });
    const r = this.a.read(() => this.a.db.prepare("SELECT width, height FROM chat_images WHERE id=?").get(body.imageId)) as { width: number; height: number };
    if (this.a.read(() => this.orgBytes()) + img.data.length > IMAGE_LIMITS.perOrgBytes && !this.drive.has(img.sha256)) throw new AccessError("image_org_storage_full");
    return this.drive.save(m, img.data, { width: r.width, height: r.height, name: body?.name, source: "chat", sourceImageId: body.imageId });
  }
  /** A conversation's live images (for the chat view). */
  list(memberId: string, conversationId: string) {
    return (this.a.read(() => this.a.db.prepare(`SELECT i.id FROM chat_images i JOIN chat_conversations c ON c.id=i.conversation_id
      WHERE i.conversation_id=? AND c.started_by=? AND c.deleted_at IS NULL AND i.deleted_at IS NULL ORDER BY i.at, i.id`).all(conversationId, memberId)) as { id: string }[])
      .map((r) => this.view(r.id)!);
  }
  /** Routine `image.read`: the normalized bytes, for the conversation's starter only. */
  read(m: ImageMember, body: any) {
    const id = typeof body?.imageId === "string" && /^img_[a-f0-9]{32}$/.test(body.imageId) ? body.imageId : null;
    const r = id ? this.a.read(() => this.a.db.prepare(`SELECT i.id, i.sha256, i.bytes FROM chat_images i JOIN chat_conversations c ON c.id=i.conversation_id
      WHERE i.id=? AND i.member_id=? AND c.started_by=? AND c.deleted_at IS NULL AND i.deleted_at IS NULL`).get(id, m.memberId, m.memberId)) as { id: string; sha256: string; bytes: number } | undefined : undefined;
    if (!r) throw new AccessError("image_unknown");
    const data = readFileSync(join(this.dir, r.id + ".jpg"));
    if (data.length !== r.bytes || sha(data) !== r.sha256) throw new AccessError("image_unknown");
    return { data, sha256: r.sha256 };
  }
  /** Retention: images of tombstoned conversations are deleted (row = evidence); quarantine leftovers older than an hour
   *  (a crash between write and cleanup) are removed. Run at start and with the daily chat sweep. */
  sweep() {
    const gone = this.a.read(() => this.a.db.prepare(`SELECT i.id FROM chat_images i JOIN chat_conversations c ON c.id=i.conversation_id
      WHERE i.deleted_at IS NULL AND c.deleted_at IS NOT NULL`).all()) as { id: string }[];
    for (const { id } of gone) {
      this.a.write(() => this.a.db.prepare("UPDATE chat_images SET deleted_at=?, delete_reason='conversation_tombstoned' WHERE id=? AND deleted_at IS NULL").run(this.now(), id));
      rmSync(join(this.dir, id + ".jpg"), { force: true });
    }
    let reaped = 0;
    const cutoff = Date.parse(this.now()) - IMAGE_LIMITS.quarantineReapMs;
    for (const f of existsSync(this.quarantine) ? readdirSync(this.quarantine) : []) {
      const p = join(this.quarantine, f);
      try { if (statSync(p).mtimeMs < cutoff) { rmSync(p, { force: true }); reaped++; } } catch { /* already gone */ }
    }
    return { deleted: gone.length, reaped };
  }
  stats() {
    return this.a.read(() => ({ decoder: this.o.decoder.mode, decoderAvailable: this.o.decoder.available(),
      ...(this.a.db.prepare("SELECT COUNT(*) AS images, COALESCE(SUM(bytes),0) AS bytes FROM chat_images WHERE deleted_at IS NULL").get() as { images: number; bytes: number }),
      deleted: (this.a.db.prepare("SELECT COUNT(*) AS n FROM chat_images WHERE deleted_at IS NOT NULL").get() as { n: number }).n,
      quarantined: existsSync(this.quarantine) ? readdirSync(this.quarantine).length : 0 }));
  }
}
