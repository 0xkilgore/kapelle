// LIBRARY L2 test world: a shared-drive image, a newsletter draft that places it, the hub's files host, fake providers.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { createRequire } from "node:module";
import { transcriptionWorld } from "./transcription-world.js";
import { ChatTools } from "../src/org/chat/tools.js";
import { FakeResend } from "../src/org/newsletter/fake-resend.js";
import { drivePublicUrl, FILES_HOST } from "../src/org/newsletter/render-cp.js";

export const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;

/** One request to the world hub AS the files host (Host header), optionally from a forwarded client address. */
export function filesHost(port: number, path: string, o: { method?: string; xff?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, path, method: o.method ?? "GET", agent: false, headers: { host: FILES_HOST, ...(o.xff ? { "x-forwarded-for": o.xff } : {}) } }, (x) => {
      const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => resolve({ status: x.statusCode ?? 0, headers: x.headers, body: Buffer.concat(c) })); });
    r.on("error", reject); r.end();
  });
}

export async function publicFilesWorld(o: { publicRoute?: boolean } = {}) {
  const sharp = createRequire(new URL("../decoder/package.json", import.meta.url))("sharp");
  const dir = mkdtempSync(join(tmpdir(), "kpf-")), kf = join(dir, "resend-test.key");
  writeFileSync(kf, "re_" + "A".repeat(30), { mode: 0o600 }); chmodSync(kf, 0o600);
  const sent: any[] = [];
  const testFetch = async (url: string, init: any) => { sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "rs-" + sent.length }), { status: 200, headers: { "content-type": "application/json" } }); };
  const resend = new FakeResend(); resend.setContacts(3);
  let port = 0;
  // The E-2 preflight: a drive URL is fetched through the REAL hub files route (as a mail client will); CP site URLs are faked.
  const imageFetch = async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.hostname === FILES_HOST) { const r = await filesHost(port, u.pathname, { method: String(init.method ?? "GET") });
      return new Response(r.status === 200 && init.method !== "HEAD" ? new Uint8Array(r.body) : null, { status: r.status, headers: { "content-type": String(r.headers["content-type"] ?? "") } }); }
    return new Response(init.method === "HEAD" ? null : Buffer.from("IMG:" + url), { status: 200, headers: { "content-type": "image/jpeg" } });
  };
  const w = await transcriptionWorld({ chat: {}, images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true } },
    files: { publicRoute: o.publicRoute ?? true }, newsletterProviderFetch: resend.fetch,
    newsletter: { totpKeyFile: "/nonexistent/totp.key", approvers: ["robin@exna.test"], from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org",
      testFrom: "Example Park agent <agent@example.org>", testKeyFile: kf, testsPerMemberPerDay: 6, testsPerDay: 12 }, newsletterTestFetch: testFetch, newsletterImageFetch: imageFetch });
  port = Number(new URL(w.url).port);
  const api = (p: string, b: unknown, c = w.robin) => w.post(`/o/exna/api/${p}`, b, c);
  // Alex adds an image to the shared drive.
  const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 230, g: 120, b: 50 } } }).jpeg().toBuffer();
  const t = await api("image/upload", { drive: true, fileName: "Porch party.jpg", size: jpg.length, contentType: "image/jpeg" }, w.alex);
  const up = await (await fetch(`${w.url}/o/exna/upload/${t.result.uploadId}`, { method: "PUT", headers: { "content-type": "image/jpeg", cookie: w.alex }, body: new Uint8Array(jpg) })).json() as any;
  const h = up.sha256 as string, url = drivePublicUrl("exna", h);
  // Robin's newsletter draft places it (the chat tools, as a draft turn does; the drive list is in the snapshot).
  mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
  writeFileSync(join(w.cfg.folder, "members/notes/2026-10-08.v1.md"), "# October\nBlock Party drew over 300 neighbors.\n");
  const conv = (await api("chat/conversation/create", {})).result.conversationId;
  const tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
  const draft = async (images: boolean, heading = "Porch party") => {
    const ctx = { turnId: "turn_" + randomUUID().replaceAll("-", ""), conversationId: conv, memberId: "m", scope: "member" as const };
    await tools.begin(ctx);
    const v = JSON.parse(((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "November in Example Park",
      sections: [{ heading, body: "Over 300 neighbors came out.", ...(images ? { images: [{ url, alt: "Neighbors on a porch", position: "above" }] } : {}) }],
      sources: [{ path: "members/notes/2026-10-08.v1.md", line: 2 }] } }), ctx)) as any).content);
    await tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: v.version }), ctx);
    return v as { artifactId: string; version: number; saved: boolean };
  };
  return { w, api, h, url, conv, draft, sent, port, close: async () => { await w.close(); rmSync(dir, { recursive: true, force: true }); } };
}

