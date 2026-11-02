// Transcription T-2 (plan v2 §3, Fable R-2, R-7, P-2(i), P-3): mint + PUT stream through the real hub into the org runtime's
// media store. Synthetic containers only; FAKE transcription profile; no network beyond loopback and Unix sockets.
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { request } from "node:http";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { openHub } from "../src/hub/hub-launcher.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { hosted } from "./org-meeting-kit.js";
import { RP, ORIGIN } from "./soft-authenticator.js";
import * as F from "./media-fixtures.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
  sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };

describe.skipIf(!enabled)("transcription upload: mint + streamed PUT", () => {
  it("binds the id to the session, consumes it once, hashes and sniffs, dedups, tombstones refusals; the hub stores nothing", async () => {
    const base = realpathSync(mkdtempSync("/tmp/ktu-")); chmodSync(base, 0o700);
    const sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { mode: 0o700 }); return d; };
    const file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
    const root = sub(base, "exna"), secrets = sub(root, "secrets"), spool = sub(base, "spool");
    const catalogPath = file(join(root, "catalog.json"), JSON.stringify(runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] })));
    const cfg = { contract: "kapelle.org-runtime/v1", orgId: "exna", label: "EXNA", stateRoot: sub(root, "state"), folder: sub(root, "folder"), accessSocket: join(sub(root, "run"), "a.sock"),
      opsSocket: join(sub(root, "ops"), "o.sock"), rpId: RP, origins: [ORIGIN], installations: [{ installationId: "inst-exna", domain: "in.exna.test", secretFile: file(join(secrets, "wh"), randomBytes(24).toString("base64url")) }],
      catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: 5 },
      replyDomain: "reply.exna.test", transcription: { backend: "fake", monthlyUsd: 3 } };
    const org = await openOrgRuntime(cfg, { fetchImpl: (async () => new Response("{}", { status: 503 })) as never });
    const ops = (route: string, body: unknown = {}): Promise<any> => new Promise((res, rej) => { const data = Buffer.from(JSON.stringify(body));
      const r = request({ socketPath: cfg.opsSocket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
        const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); }); r.on("error", rej); r.end(data); });
    const kp = generateKeyPairSync("ed25519"); await ops("/ops/envelope-key/add", { kid: "k1", publicJwk: kp.publicKey.export({ format: "jwk" }) });
    const mail: any[] = [];
    const hub = await openHub({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 0 }, mailSpool: spool,
      orgs: [{ orgId: "exna", installationId: org.sqlite.identity.installationId, accessSocket: cfg.accessSocket, kid: "k1", keyFile: file(join(base, "k.pem"), kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string), origin: ORIGIN }],
      ingress: [] }, { mailer: (m) => mail.push(m) });
    const url = `http://127.0.0.1:${hub.port}`;
    const post = async (path: string, body: unknown, cookie: string) => (await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })).json() as Promise<any>;
    const join_ = async (link: string) => { const r = await fetch(`${url}/o/exna/invite/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(link).hash.slice(7) }) });
      return (r.headers.get("set-cookie") ?? "").split(";")[0]; };
    const login = async (email: string) => { mail.length = 0; await post("/o/exna/login", { email }, ""); await new Promise((r) => setTimeout(r, 20));
      return ((await fetch(`${url}/o/exna/magic?token=${new URL(mail.find((m) => m.to === email).link).searchParams.get("token")}`)).headers.get("set-cookie") ?? "").split(";")[0]; };
    const mint = (cookie: string, b: Buffer, contentType = "audio/wav", fileName = "meeting.wav") => post("/o/exna/api/media/upload", { fileName, size: b.length, contentType }, cookie);
    const put = async (cookie: string, id: string, b: Buffer, contentType = "audio/wav") =>
      (await fetch(`${url}/o/exna/upload/${id}`, { method: "PUT", headers: { "content-type": contentType, cookie }, body: new Uint8Array(b) })).json() as Promise<any>;
    const raw = (cookie: string, id: string, headers: Record<string, string | number>, chunks: Buffer[], o: { abortAfter?: number } = {}): Promise<{ status: number; body: any }> =>
      new Promise((res) => { const r = request({ host: "127.0.0.1", port: hub.port, path: `/o/exna/upload/${id}`, method: "PUT", agent: false, headers: { cookie, ...headers } }, (x) => {
        const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res({ status: x.statusCode!, body: JSON.parse(Buffer.concat(c).toString() || "{}") })); });
        r.on("error", () => res({ status: 0, body: null }));
        for (const c of chunks) r.write(c);
        if (o.abortAfter !== undefined) setTimeout(() => { r.destroy(); res({ status: -1, body: null }); }, o.abortAfter); else r.end(); });
    const mediaDirs = () => readdirSync(join(cfg.stateRoot, "media")).sort();
    try {
      const admin = await join_((await ops("/ops/bootstrap/invite", { email: "admin@exna.test" })).link);
      const robin = await join_((await ops("/ops/member/invite", { email: "robin@exna.test", role: "reviewer" })).link);
      const alex = await join_((await ops("/ops/member/invite", { email: "alex@exna.test", role: "contributor" })).link);
      const audio = F.wav(30), sha = createHash("sha256").update(audio).digest("hex");
      // Mint: reviewers only; admitted types; a size within the cap.
      expect(await mint(alex, audio)).toEqual({ ok: false, error: "access_role_not_permitted" });
      expect(await mint(robin, audio, "video/mp4")).toEqual({ ok: false, error: "media_type_not_admitted" });
      expect(await post("/o/exna/api/media/upload", { fileName: "x.wav", size: 251 * 1024 * 1024, contentType: "audio/wav" }, robin)).toEqual({ ok: false, error: "media_too_large" });
      expect(await mint(robin, audio, "audio/wav", "../../etc/passwd")).toEqual({ ok: false, error: "media_file_name_invalid" });
      const m1 = await mint(robin, audio);
      expect(m1).toMatchObject({ ok: true, result: { uploadId: expect.stringMatching(/^up_[a-f0-9]{32}$/), maxBytes: 250 * 1024 * 1024 } });
      // Happy path: streamed, hashed, sniffed; audio only under stateRoot/media (0700 dir, 0600 file), never in the folder.
      const up1 = await put(robin, m1.result.uploadId, audio);
      expect(up1).toEqual({ ok: true, jobId: expect.stringMatching(/^tj_[a-f0-9]{32}$/), deduplicated: false, audioSha256: "sha256:" + sha, durationSec: 30, container: "wav" });
      const stored = join(cfg.stateRoot, "media", up1.jobId, "audio.bin");
      expect(lstatSync(stored).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(cfg.stateRoot, "media", up1.jobId)).mode & 0o777).toBe(0o700);
      expect(createHash("sha256").update(readFileSync(stored)).digest("hex")).toBe(sha);
      expect(org.sqlite.db.prepare("SELECT state, duration_sec, container, uploaded_by FROM transcription_jobs WHERE job_id=?").get(up1.jobId))
        .toMatchObject({ state: "uploaded", duration_sec: 30, container: "wav" });
      // P-3: the id is consumed on the first PUT whatever the outcome.
      expect(await put(robin, m1.result.uploadId, audio)).toEqual({ ok: false, error: "media_upload_consumed" });
      // P-3: another session of the SAME member is refused, and that also consumes the id.
      const m2 = await mint(robin, audio), robin2 = await login("robin@exna.test");
      expect(await put(robin2, m2.result.uploadId, audio)).toEqual({ ok: false, error: "media_upload_session_mismatch" });
      expect(await put(robin, m2.result.uploadId, audio)).toEqual({ ok: false, error: "media_upload_consumed" });
      // Declared size and type must match the mint exactly.
      const m3 = await mint(robin, audio);
      expect(await put(robin, m3.result.uploadId, audio.subarray(0, audio.length - 10))).toEqual({ ok: false, error: "media_size_mismatch" });
      const m4 = await mint(robin, audio);
      expect(await put(robin, m4.result.uploadId, audio, "audio/x-wav")).toEqual({ ok: false, error: "media_type_not_admitted" });
      // Hub-side: chunked or missing length, over the cap, a non-audio type, cross-site: refused before any streaming.
      const m5 = await mint(robin, audio);
      // F-1: refused and CUT (a client still writing may see the reset before the 411; the exact 411 is asserted in t4b).
      expect([411, 0]).toContain((await raw(robin, m5.result.uploadId, { "content-type": "audio/wav", "transfer-encoding": "chunked" }, [audio])).status);
      expect((await raw(robin, m5.result.uploadId, { "content-type": "audio/wav", "content-length": 300 * 1024 * 1024 }, [], { abortAfter: 300 })).status).not.toBe(200);
      expect(await put(robin, m5.result.uploadId, audio, "text/plain")).toEqual({ ok: false, error: "hub_content_type_refused" });
      expect(await (await fetch(`${url}/o/exna/upload/${m5.result.uploadId}`, { method: "PUT", headers: { "content-type": "audio/wav", cookie: robin, "sec-fetch-site": "cross-site" }, body: new Uint8Array(audio) })).json())
        .toEqual({ ok: false, error: "hub_cross_site_refused" });
      expect(await (await fetch(`${url}/o/exna/upload/${m5.result.uploadId}`, { method: "PUT", headers: { "content-type": "audio/wav" }, body: new Uint8Array(audio) })).json()).toEqual({ ok: false, error: "hub_no_session" });
      // P-2(i): a lying header is refused after the stream; the bytes are tombstoned and removed.
      const liar = F.wav(5, { claimSec: 7000 }), m6 = await mint(robin, liar);
      const before = mediaDirs();
      expect(await put(robin, m6.result.uploadId, liar)).toEqual({ ok: false, error: "media_duration_implausible" });
      expect(mediaDirs()).toEqual(before);
      expect(org.sqlite.db.prepare("SELECT reason FROM media_tombstones ORDER BY seq DESC LIMIT 1").get()).toEqual({ reason: "upload_refused:media_duration_implausible" });
      // A file whose container differs from the minted type (an mp3 sent as audio/wav).
      const mp3 = F.mp3(10), m7 = await mint(admin, mp3);
      expect(await put(admin, m7.result.uploadId, mp3)).toEqual({ ok: false, error: "media_type_not_admitted" });
      // Per-org dedup: the same audio again returns the existing job; the second copy is tombstoned.
      const m8 = await mint(admin, audio);
      expect(await put(admin, m8.result.uploadId, audio)).toMatchObject({ ok: true, jobId: up1.jobId, deduplicated: true });
      expect(mediaDirs()).toEqual([up1.jobId]);
      // Expiry: a minted id older than 10 minutes is refused (and consumed).
      const ogg = F.opus(20), m9 = await mint(admin, ogg, "audio/ogg", "x.ogg");
      org.sqlite.db.prepare("UPDATE media_uploads SET expires_at=? WHERE upload_id=?").run(new Date(Date.now() - 1000).toISOString(), m9.result.uploadId);
      expect(await put(admin, m9.result.uploadId, ogg, "audio/ogg")).toEqual({ ok: false, error: "media_upload_expired" });
      // A client that aborts mid-stream leaves no job and no media directory (tombstoned).
      const big = F.m4a(600), m10 = await mint(admin, big, "audio/mp4", "long.m4a");
      const tombsBefore = (org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM media_tombstones").get() as { n: number }).n;
      await raw(admin, m10.result.uploadId, { "content-type": "audio/mp4", "content-length": big.length }, [big.subarray(0, 100_000)], { abortAfter: 200 });
      for (let i = 0; i < 100 && mediaDirs().length > 1; i++) await new Promise((r) => setTimeout(r, 20));
      expect(mediaDirs()).toEqual([up1.jobId]);
      for (let i = 0; i < 100 && (org.sqlite.db.prepare("SELECT outcome FROM media_uploads WHERE upload_id=?").get(m10.result.uploadId) as any).outcome === null; i++) await new Promise((r) => setTimeout(r, 20));
      expect(org.sqlite.db.prepare("SELECT outcome FROM media_uploads WHERE upload_id=?").get(m10.result.uploadId)).toEqual({ outcome: "media_upload_aborted" });
      expect((org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM media_tombstones").get() as { n: number }).n).toBe(tombsBefore + 1);
      // Another container end to end (moov after mdat, as phones write it).
      const m11 = await mint(admin, F.m4a(45), "audio/mp4", "phone.m4a");
      expect(await put(admin, m11.result.uploadId, F.m4a(45), "audio/mp4")).toMatchObject({ ok: true, container: "mp4", durationSec: 45 });
      // P-3 per-session rate limit (10 PUTs/hour/session): the admin's session has used 5; 6 more reach the limit.
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push((await mint(admin, audio)).result.uploadId);
      const statuses: number[] = [];
      for (const id of ids) statuses.push((await fetch(`${url}/o/exna/upload/${id}`, { method: "PUT", headers: { "content-type": "audio/wav", cookie: admin }, body: new Uint8Array(audio) })).status);
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses[5]).toBe(429);
      // The hub wrote nothing: its only directory (the mail spool) is empty; audio lives only in the org's media store.
      expect(readdirSync(spool)).toEqual([]);
      expect(existsSync(join(cfg.folder, "media"))).toBe(false);
      expect((await ops("/ops/status")).transcription).toMatchObject({ jobs: { uploaded: 2 } });
    } finally { await hub.close(); await org.close(); }
  }, 180_000);
});
