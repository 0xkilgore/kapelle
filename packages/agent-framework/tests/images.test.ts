// IMAGES-V1 I1a (design of record IMAGES-V1.md a5160d58 §1): the sanitizer (decoder/decode.mjs, the REAL sharp/libvips in its
// own process) against hostile and ordinary fixtures, and the org runtime's image store: single-use tickets bound to member +
// session + conversation, a bounded streamed write, the original deleted on every outcome, owner-only reads, retention with
// the conversation, quotas. Fixtures are generated here (synthetic pixels); no member image is used. Runs when the decoder
// package is installed (cd decoder && npm ci).
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { transcriptionWorld } from "./transcription-world.js";
import { childDecoder, socketDecoder, IMAGE_LIMITS } from "../src/org/images/store.js";
import { createServer } from "node:net";
import { execFile, spawn } from "node:child_process";
import { ACCESS_ACTIONS, STEP_UP } from "../src/access/org-access.js";

const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const enabled = existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const sharp = enabled ? createRequire(new URL("../decoder/package.json", import.meta.url))("sharp") : null;
const decoder = childDecoder({ node: process.execPath, script: DECODER });
const solid = (w: number, h: number, extra: Record<string, unknown> = {}) => sharp({ create: { width: w, height: h, channels: 3, background: "#2a6", ...extra } });

it("I1 isolation policy: the decoder units keep every sandbox property (drift fails here); the decoder has no file arguments", () => {
  const unit = (n: string) => readFileSync(new URL(`../deploy/systemd/${n}`, import.meta.url), "utf8");
  const svc = unit("kapelle-image-decode@.service"), sock = unit("kapelle-image-decode@.socket");
  for (const p of ["DynamicUser=yes", "PrivateNetwork=yes", "RestrictAddressFamilies=AF_UNIX", "IPAddressDeny=any", "ProtectSystem=strict", "ProtectHome=yes", "PrivateTmp=yes",
    "PrivateDevices=yes", "NoNewPrivileges=yes", "CapabilityBoundingSet=\n", "RestrictNamespaces=yes", "SystemCallFilter=@system-service", "MemoryMax=256M", "TasksMax=16",
    "CPUQuota=100%", "RuntimeMaxSec=10s", "StandardInput=socket", "StandardOutput=socket", "InaccessiblePaths=-/etc/kapelle -/var/lib/kapelle -/var/lib/kapelle-hub -/var/backups/kapelle -/run/kapelle-access"])
    expect(svc.includes(p), p).toBe(true);
  expect(svc).toMatch(/^ExecStart=\/opt\/node\/bin\/node \/opt\/kapelle\/current\/decoder\/decode\.mjs$/m); // no arguments, no paths
  for (const p of ["Accept=yes", "MaxConnections=1", "SocketUser=kapelle-%i", "SocketMode=0600", "ListenStream=/run/kapelle-images/%i.sock"]) expect(sock.includes(p), p).toBe(true);
  expect(readFileSync(DECODER, "utf8")).toMatch(/process\.argv\.length !== 2/); // the script refuses any argument
});

// Director's rehearsal attempt 2 (Oct 23): the unit starts /opt/kapelle/current/decoder/decode.mjs through the current ->
// releases/<rel> SYMLINK; the old entry-point check compared argv[1] with the resolved import.meta.url and was false there, so
// the decoder exited 0 with NO output. Run it through a symlinked release directory, exactly like the host.
describe.skipIf(!enabled)("the decoder through a symlinked release path (as /opt/kapelle/current on the host)", () => {
  const run = (script: string, input: Buffer, args: string[] = []) => new Promise<{ code: number | null; out: Buffer }>((resolve) => {
    const c = spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "inherit"] }), parts: Buffer[] = [];
    c.stdout.on("data", (d) => parts.push(d)); c.on("close", (code) => resolve({ code, out: Buffer.concat(parts) })); c.stdin.end(input);
  });
  it("answers through the symlink (refusal, usage and a real decode), never a silent exit 0", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kdec-link-"))), link = join(dir, "current");
    try {
      symlinkSync(fileURLToPath(new URL("..", import.meta.url)), link); // current -> the release (this agent-framework tree)
      const script = join(link, "decoder", "decode.mjs");
      const bad = await run(script, Buffer.from("x"));
      expect([bad.code, JSON.parse(bad.out.toString("utf8").split("\n")[0])]).toEqual([1, { ok: false, label: "image_type_not_admitted" }]);
      const usage = await run(script, Buffer.from("x"), ["/etc/passwd"]);
      expect([usage.code, JSON.parse(usage.out.toString("utf8").split("\n")[0])]).toEqual([1, { ok: false, label: "image_decoder_usage" }]);
      const png = await solid(64, 48).png().toBuffer(), good = await run(script, png);
      const head = JSON.parse(good.out.subarray(0, good.out.indexOf(10)).toString("utf8"));
      expect([good.code, head.ok, head.width, head.height]).toEqual([0, true, 64, 48]);
      expect(good.out.length).toBe(good.out.indexOf(10) + 1 + head.bytes);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("answers through a symlinked PREFIX higher up the path (like /tmp -> /private/tmp), never a silent exit 0", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kdec-pfx-"))), pfx = join(dir, "pfx");
    try {
      symlinkSync(fileURLToPath(new URL("../..", import.meta.url)), pfx); // pfx -> the directory ABOVE agent-framework
      const bad = await run(join(pfx, "agent-framework", "decoder", "decode.mjs"), Buffer.from("x"));
      expect([bad.code, JSON.parse(bad.out.toString("utf8").split("\n")[0])]).toEqual([1, { ok: false, label: "image_type_not_admitted" }]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

it("I1b render: --images-enable on wires the org's decoder socket and needs chat", async () => {
  const { render } = await import("../deploy/kapelle-admin.js");
  const root = mkdtempSync(join(tmpdir(), "kimg-render-"));
  try {
    const base = { org: "exna", label: "Example Park", domain: "agent.example.org", monthlyUsd: 15, root, intake: "none" as const };
    const r = render({ ...base, chat: { enable: "on" }, images: { enable: "on" } });
    expect(JSON.parse(readFileSync(r.orgConfig, "utf8")).images).toEqual({ decoder: { mode: "systemd", socket: "/run/kapelle-images/exna.sock" }, extract: false });
    // I2: --images-extract on turns "Read this flyer" on (still refused until the image profile is qualified).
    expect(JSON.parse(readFileSync(render({ ...base, root: mkdtempSync(join(tmpdir(), "kimg-render2-")), chat: { enable: "on" }, images: { enable: "on", extract: "on" } }).orgConfig, "utf8")).images.extract).toBe(true);
    expect(() => render({ ...base, chat: { enable: "on" }, images: { enable: "on", extract: "yes" } })).toThrow("render_images_extract_invalid");
    expect(() => render({ ...base, images: { enable: "on" } })).toThrow("render_images_need_chat");
    expect(() => render({ ...base, chat: { enable: "on" }, images: { enable: "" } })).toThrow("render_images_enable_required");
    expect(JSON.parse(readFileSync(render({ ...base, chat: { enable: "on" } }).orgConfig, "utf8")).images).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("I1 access: image.upload and image.read are session-tier routines", () => {
  for (const a of ["image.upload", "image.read"]) { expect(ACCESS_ACTIONS.routine).toContain(a); expect(STEP_UP.session).toContain(a); }
});

describe.skipIf(!enabled)("the sanitizer (decoder/decode.mjs, real sharp in its own process)", () => {
  const run = async (input: Buffer) => { const r = await decoder.decode(input); return { r, out: r.data }; };
  const refused = async (input: Buffer) => { try { await run(input); return "decoded"; } catch (e: any) { return e.reason as string; } };

  it("re-encodes: GPS/EXIF/ICC/XMP gone, orientation applied, one JPEG, fixed sanitizer version", async () => {
    const src = await solid(400, 200).jpeg().withExif({ IFD0: { Make: "SecretCam", Copyright: "Private Person" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "36/1 10/1 0/1" } })
      .withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(src).metadata()).exif).toBeTruthy();
    const { r, out } = await run(src);
    expect(r).toMatchObject({ width: 200, height: 400, sanitizer: "kapelle.image-sanitizer/v1" }); // rotated upright
    const m = await sharp(out).metadata();
    expect(m).toMatchObject({ format: "jpeg", width: 200, height: 400 });
    expect([m.exif, m.icc, m.xmp, m.orientation]).toEqual([undefined, undefined, undefined, undefined]);
    expect(out.includes("SecretCam")).toBe(false); expect(out.includes("Private Person")).toBe(false);
  });

  it("PNG alpha is flattened onto white; WebP is admitted; a large image is bounded to a 1600 px long edge", async () => {
    const png = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const { out } = await run(png);
    const px = await sharp(out).raw().toBuffer();
    expect([px[0], px[1], px[2]].every((v: number) => v > 245)).toBe(true);
    expect((await run(await solid(30, 30).webp().toBuffer())).r).toMatchObject({ width: 30, height: 30 });
    expect((await run(await solid(4000, 3000).jpeg().toBuffer())).r).toMatchObject({ width: 1600, height: 1200 });
  });

  it("an appended payload (polyglot) does not survive re-encoding", async () => {
    const marker = Buffer.from("<script>alert('x')</script>PK\u0003\u0004POLYGLOT-MARKER");
    const { out } = await run(Buffer.concat([await solid(40, 40).jpeg().toBuffer(), marker]));
    expect(out.includes("POLYGLOT-MARKER")).toBe(false);
  });

  it("the rehearsal kit: make-fixtures.mjs writes every fixture with the decoder's expected answer, and send.mjs gets exactly that over a socket", async () => {
    const d = mkdtempSync(join(tmpdir(), "kimgf-")), fx = join(d, "fx"), sock = join(d, "decode.sock");
    // Async on purpose: the socket server below lives in THIS process, so a synchronous child would deadlock it.
    const run = (args: string[]) => new Promise<string>((res, rej) => execFile(process.execPath, args, { encoding: "utf8", timeout: 60_000 }, (e, out) => e ? rej(e) : res(out)));
    const listed = (await run([new URL("../decoder/fixtures/make-fixtures.mjs", import.meta.url).pathname, fx]))
      .trim().split("\n").map((l) => JSON.parse(l) as { name: string; bytes: number; expect: string });
    expect(listed.length).toBeGreaterThanOrEqual(15);
    const server = createServer({ pauseOnConnect: true }, (c) => { spawn(process.execPath, [DECODER], { stdio: [c, c, "ignore"], env: {} }).on("exit", () => c.destroy()); });
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      for (const f of listed) {
        const r = JSON.parse(await run([new URL("../decoder/fixtures/send.mjs", import.meta.url).pathname, sock, join(fx, f.name)]));
        expect(r.header?.ok ? "ok" : r.header?.label, f.name).toBe(f.expect);
        if (f.expect === "ok") expect(r.jpegBytes).toBe(r.header.bytes);
      }
    } finally { await new Promise((r) => server.close(r)); rmSync(d, { recursive: true, force: true }); }
  }, 120_000);

  it("the org-host protocol: one connection = one fresh decoder with the connection as stdin/stdout (as systemd Accept=yes)", async () => {
    const d = mkdtempSync(join(tmpdir(), "kimgs-")), sock = join(d, "decode.sock");
    const server = createServer({ pauseOnConnect: true }, (c) => { spawn(process.execPath, [DECODER], { stdio: [c, c, "ignore"], env: {} }).on("exit", () => c.destroy()); });
    await new Promise<void>((r) => server.listen(sock, r));
    try {
      const viaSocket = socketDecoder({ socket: sock });
      const ok = await viaSocket.decode(await solid(120, 60).png().toBuffer());
      expect(ok).toMatchObject({ width: 120, height: 60, sanitizer: "kapelle.image-sanitizer/v1" });
      expect((await sharp(ok.data).metadata()).format).toBe("jpeg");
      await expect(viaSocket.decode(Buffer.from("%PDF-1.7"))).rejects.toThrow("image_type_not_admitted");
      await expect(socketDecoder({ socket: join(d, "absent.sock") }).decode(Buffer.from("x"))).rejects.toThrow("image_decoder_unavailable");
    } finally { await new Promise((r) => server.close(r)); rmSync(d, { recursive: true, force: true }); }
  });

  it("refuses: SVG/GIF/TIFF/PDF (only JPEG/PNG/WebP loaders exist), truncation, pixel bombs, oversize dimensions, animation", async () => {
    expect(await refused(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'))).toBe("image_type_not_admitted");
    expect(await refused(await solid(8, 8).gif().toBuffer())).toBe("image_type_not_admitted");
    expect(await refused(await solid(8, 8).tiff().toBuffer())).toBe("image_type_not_admitted");
    expect(await refused(Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\n"))).toBe("image_type_not_admitted");
    // A PNG signature in front of SVG text: the PNG loader refuses it (no SVG loader to fall back on).
    expect(await refused(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("<svg/>")]))).toBe("image_unreadable");
    const jpg = await solid(300, 300, { noise: { type: "gaussian", mean: 128, sigma: 30 } }).jpeg().toBuffer();
    expect(await refused(jpg.subarray(0, Math.floor(jpg.length / 2)))).toBe("image_unreadable");
    const bomb = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: "#000" }, limitInputPixels: false }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(IMAGE_LIMITS.inputBytes); // small on disk, 36 MP decoded
    expect(await refused(bomb)).toBe("image_too_many_pixels");
    expect(await refused(await solid(10_500, 20).png().toBuffer())).toBe("image_dimensions");
    const frames = await Promise.all([solid(16, 16).png().toBuffer(), solid(16, 16, { background: "#a00" }).png().toBuffer()]);
    const animated = await sharp(frames, { join: { animated: true } }).webp().toBuffer();
    expect(await refused(animated)).toBe("image_animated");
  });
});

describe.skipIf(!enabled || !process.env.KAPELLE_SCOPED_REACTOR_ROOT)("the image store in the org runtime (I1a)", () => {
  async function setup() {
    const w = await transcriptionWorld({ chat: {}, images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true } } });
    const api = (p: string, b: unknown, c = w.alex) => w.post(`/o/exna/api/${p}`, b, c);
    const conv = (await api("chat/conversation/create", {})).result.conversationId;
    const store = w.org.images!, db = w.org.sqlite.db;
    const sessionOf = (uploadId: string) => (db.prepare("SELECT member_id, session_ref FROM image_uploads WHERE upload_id=?").get(uploadId) as any);
    const put = async (bytes: Buffer, o: { contentType?: string; conversationId?: string; cookie?: string; stream?: Readable; size?: number } = {}) => {
      const t = await api("image/upload", { conversationId: o.conversationId ?? conv, size: o.size ?? bytes.length, contentType: o.contentType ?? "image/jpeg" }, o.cookie ?? w.alex);
      if (!t.ok) return { error: t.error };
      const s = sessionOf(t.result.uploadId), m = { memberId: s.member_id, role: "contributor", sessionRef: s.session_ref };
      try { return { ok: true, uploadId: t.result.uploadId, m, ...(await store.put(t.result.uploadId, m, o.stream ?? Readable.from([bytes]), { size: o.size ?? bytes.length, contentType: o.contentType ?? "image/jpeg" })) }; }
      catch (e: any) { return { error: e.reason, uploadId: t.result.uploadId, m }; }
    };
    const quarantine = () => readdirSync(store.quarantine);
    return { w, api, conv, store, db, put, quarantine, close: () => w.close() };
  }

  it("stores only the normalized JPEG under stateRoot/media/images; the original is gone; the owner reads it; nothing in the folder", async () => {
    const s = await setup();
    try {
      const src = await solid(400, 200).jpeg().withExif({ IFD0: { Make: "SecretCam" } }).toBuffer();
      const r: any = await s.put(src);
      expect(r).toMatchObject({ ok: true, imageId: expect.stringMatching(/^img_[a-f0-9]{32}$/), width: 400, height: 200, deduplicated: false });
      expect(s.quarantine()).toEqual([]);
      expect(readdirSync(s.store.dir).filter((f) => f.endsWith(".jpg"))).toEqual([r.imageId + ".jpg"]);
      expect(readFileSync(join(s.store.dir, r.imageId + ".jpg")).includes("SecretCam")).toBe(false);
      expect(JSON.stringify(readdirSync(s.w.cfg.folder, { recursive: true }))).not.toMatch(/img_|\.jpg/);
      expect(s.store.read(r.m, { imageId: r.imageId }).sha256).toBe(r.sha256);
      // The conversation view lists it (for its starter).
      expect((await s.api("chat/conversation/read", { conversationId: s.conv })).result.images).toEqual([expect.objectContaining({ imageId: r.imageId, width: 400 })]);
      // The same image twice in one conversation is one image.
      expect(await s.put(src)).toMatchObject({ ok: true, imageId: r.imageId, deduplicated: true });
      expect(s.db.prepare("SELECT outcome FROM image_uploads ORDER BY at").all().map((x: any) => x.outcome)).toEqual(["stored", "deduplicated"]);
      // Another member cannot read it, nor mint into this conversation.
      const robin = (await s.w.post("/o/exna/api/member/me", {}, s.w.robin)).result;
      expect(() => s.store.read({ memberId: robin.memberId, role: "reviewer", sessionRef: "x" }, { imageId: r.imageId })).toThrow("image_unknown");
      expect((await s.api("image/upload", { conversationId: s.conv, size: 10, contentType: "image/jpeg" }, s.w.robin)).error).toBe("chat_conversation_unknown");
      expect((await s.w.ops("/ops/status", {})).images).toMatchObject({ decoder: "child", decoderAvailable: true, images: 1, quarantined: 0 });
    } finally { await s.close(); }
  });

  it("tickets: type and size checked at mint; single use; session-bound; declared size enforced; refusals leave nothing", async () => {
    const s = await setup();
    try {
      const jpg = await solid(30, 30).jpeg().toBuffer();
      expect((await s.api("image/upload", { conversationId: s.conv, size: 10, contentType: "image/gif" })).error).toBe("image_type_not_admitted");
      expect((await s.api("image/upload", { conversationId: s.conv, size: IMAGE_LIMITS.inputBytes + 1, contentType: "image/jpeg" })).error).toBe("image_too_large");
      expect((await s.api("image/upload", { conversationId: "conv_nope", size: 10, contentType: "image/jpeg" })).error).toBe("chat_conversation_unknown");
      const ok: any = await s.put(jpg);
      await expect(s.store.put(ok.uploadId, ok.m, Readable.from([jpg]), { size: jpg.length, contentType: "image/jpeg" })).rejects.toThrow("image_upload_consumed");
      // Wrong session, declared size mismatch, a PNG sent as JPEG, an SVG sent as PNG.
      const t = (await s.api("image/upload", { conversationId: s.conv, size: jpg.length, contentType: "image/jpeg" })).result;
      const row = s.db.prepare("SELECT member_id FROM image_uploads WHERE upload_id=?").get(t.uploadId) as any;
      await expect(s.store.put(t.uploadId, { memberId: row.member_id, role: "contributor", sessionRef: "other" }, Readable.from([jpg]), { size: jpg.length, contentType: "image/jpeg" }))
        .rejects.toThrow("image_upload_session_mismatch");
      expect((await s.put(jpg, { size: jpg.length + 5 })).error).toBe("image_upload_aborted");
      expect((await s.put(await solid(10, 10).png().toBuffer(), { contentType: "image/jpeg" })).error).toBe("image_type_mismatch");
      expect((await s.put(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { contentType: "image/png" })).error).toBe("image_type_mismatch");
      // A stream that dies mid-way.
      const dying = new Readable({ read() { this.push(jpg.subarray(0, 10)); this.destroy(new Error("client gone")); } });
      expect((await s.put(jpg, { stream: dying })).error).toBe("image_upload_aborted");
      expect(s.quarantine()).toEqual([]);
      expect(readdirSync(s.store.dir).filter((f) => f.endsWith(".jpg"))).toEqual([ok.imageId + ".jpg"]);
    } finally { await s.close(); }
  });

  it("Fable I1a N-2: at most 4 uploads in flight per org; the 5th refuses image_upload_busy; the slots free when they end", async () => {
    const s = await setup();
    try {
      const jpg = await solid(20, 20).jpeg().toBuffer();
      const held = Array.from({ length: 4 }, () => new Readable({ read() {} })), running: Promise<unknown>[] = [];
      for (const stream of held) { // mint first, then start the PUT WITHOUT awaiting it (its stream stays open)
        const t = (await s.api("image/upload", { conversationId: s.conv, size: jpg.length, contentType: "image/jpeg" })).result;
        const row = s.db.prepare("SELECT member_id, session_ref FROM image_uploads WHERE upload_id=?").get(t.uploadId) as any;
        running.push(s.store.put(t.uploadId, { memberId: row.member_id, role: "contributor", sessionRef: row.session_ref }, stream, { size: jpg.length, contentType: "image/jpeg" }).catch((e) => e.reason));
      }
      await new Promise((r) => setTimeout(r, 50));
      expect((await s.put(jpg)).error).toBe("image_upload_busy");
      held.forEach((h, i) => { h.push(i ? Buffer.concat([jpg.subarray(0, jpg.length - 1), Buffer.from([i])]) : jpg); h.push(null); });
      await Promise.all(running);
      expect(await s.put(await solid(22, 22).jpeg().toBuffer())).toMatchObject({ ok: true });
    } finally { await s.close(); }
  }, 60_000);

  it("an expired ticket refuses; the hourly mint limit holds", async () => {
    const s = await setup();
    try {
      const jpg = await solid(20, 20).jpeg().toBuffer();
      const t = (await s.api("image/upload", { conversationId: s.conv, size: jpg.length, contentType: "image/jpeg" })).result;
      s.db.prepare("UPDATE image_uploads SET expires_at='2000-01-01T00:00:00.000Z' WHERE upload_id=?").run(t.uploadId);
      const row = s.db.prepare("SELECT member_id, session_ref FROM image_uploads WHERE upload_id=?").get(t.uploadId) as any;
      await expect(s.store.put(t.uploadId, { memberId: row.member_id, role: "contributor", sessionRef: row.session_ref }, Readable.from([jpg]), { size: jpg.length, contentType: "image/jpeg" }))
        .rejects.toThrow("image_upload_expired");
      for (let i = 1; i < IMAGE_LIMITS.mintsPerMemberHour; i++) expect((await s.api("image/upload", { conversationId: s.conv, size: 10, contentType: "image/jpeg" })).ok).toBe(true);
      expect((await s.api("image/upload", { conversationId: s.conv, size: 10, contentType: "image/jpeg" })).error).toBe("image_upload_rate_limited");
    } finally { await s.close(); }
  });

  it("retention follows the conversation: a tombstoned chat's images are deleted (row kept as evidence); stale quarantine files are reaped", async () => {
    const s = await setup();
    try {
      const r: any = await s.put(await solid(50, 50).jpeg().toBuffer());
      writeFileSync(join(s.store.quarantine, "im_stale.in"), "x");
      const old = new Date(Date.now() - 2 * IMAGE_LIMITS.quarantineReapMs);
      (await import("node:fs")).utimesSync(join(s.store.quarantine, "im_stale.in"), old, old);
      s.db.prepare("UPDATE chat_conversations SET deleted_at=? WHERE id=?").run(new Date().toISOString(), s.conv);
      expect(s.store.sweep()).toEqual({ deleted: 1, reaped: 1 });
      expect(existsSync(join(s.store.dir, r.imageId + ".jpg"))).toBe(false);
      expect(s.db.prepare("SELECT deleted_at IS NOT NULL AS d, delete_reason, sha256 FROM chat_images WHERE id=?").get(r.imageId)).toMatchObject({ d: 1, delete_reason: "conversation_tombstoned", sha256: r.sha256 });
      expect(() => s.store.read(r.m, { imageId: r.imageId })).toThrow("image_unknown");
      expect(s.quarantine()).toEqual([]);
    } finally { await s.close(); }
  });

  it("Ops (Oct 19): a missing decoder does not stop the org; uploads refuse with a label; status says so", async () => {
    const w = await transcriptionWorld({ chat: {}, images: { decoder: { mode: "systemd", socket: join(tmpdir(), "kapelle-no-such-decoder.sock") } } });
    try {
      const conv = (await w.post("/o/exna/api/chat/conversation/create", {}, w.alex)).result.conversationId;
      expect((await w.post("/o/exna/api/image/upload", { conversationId: conv, size: 10, contentType: "image/jpeg" }, w.alex)).error).toBe("image_decoder_unavailable");
      expect((await w.ops("/ops/status", {})).images).toMatchObject({ decoder: "systemd", decoderAvailable: false, images: 0 });
      expect((await w.post("/o/exna/api/chat/conversation/read", { conversationId: conv }, w.alex)).ok).toBe(true); // chat itself unaffected
    } finally { await w.close(); }
  });
});
