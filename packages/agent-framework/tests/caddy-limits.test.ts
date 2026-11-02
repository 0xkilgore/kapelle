// IMAGES-V1 live bug (CP, Oct 23): Caddy's site-wide request_body max_size 1MB answered a flyer upload with 413 before the hub
// saw it. The Caddyfile TEMPLATE (deploy/caddy/Caddyfile.template, rendered exactly as on the host) in front of the REAL hub and
// org runtime (test world + the real decoder): only PUT /o/<org>/upload/im_<32 hex> may carry up to 4 MiB (= the hub's own image
// cap); everything else keeps 1 MB; Caddy's 413 is answered as the app's JSON refusal (image_too_large / hub_body_too_large). Opt-in: CADDY_BIN = a caddy binary
// of the host's version (CP: 2.6.2), run unprivileged on loopback high ports with private XDG dirs and the admin API off.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { request } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { transcriptionWorld } from "./transcription-world.js";

const CADDY = process.env.CADDY_BIN ?? "";
const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const hasDecoder = existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const enabled = !!CADDY && existsSync(CADDY) && hasDecoder && !!process.env.KAPELLE_SCOPED_REACTOR_ROOT;
const sharp = enabled ? createRequire(new URL("../decoder/package.json", import.meta.url))("sharp") : null;
const freePort = () => new Promise<number>((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
type Res = { status: number; body: string };
const send = (port: number, method: string, path: string, headers: Record<string, string>, body: Buffer) => new Promise<Res>((resolve) => {
  const req = request({ host: "127.0.0.1", port, method, path, headers: { ...headers, "content-length": String(body.length) } }, (r) => {
    const parts: Buffer[] = []; r.on("data", (c) => parts.push(c)); r.on("end", () => resolve({ status: r.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8") }));
  });
  req.on("error", () => resolve({ status: -1, body: "" })); // the proxy may cut a refused body mid-stream
  req.end(body);
});
const json = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

describe.skipIf(!enabled)("the Caddyfile template's body limits in front of the real hub (Caddy " + CADDY + ")", () => {
  it("image uploads up to the hub's own 4 MiB cap pass; every other route keeps Caddy's 1 MB and the hub's 64 KiB", async () => {
    const w = await transcriptionWorld({ chat: {}, images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true } } });
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "kcaddy-"))), cport = await freePort();
    const hubPort = Number(new URL(w.url).port);
    // Rendered as on a host WITHOUT a files host: the optional FILES-HOST block is deleted (caddy-template.test.ts proves the recipe).
    const tpl = readFileSync(new URL("../deploy/caddy/Caddyfile.template", import.meta.url), "utf8").replace(/^# FILES-HOST-BEGIN[\s\S]*^# FILES-HOST-END\n/m, "");
    // Rendered as on the host, plus test-only: plain HTTP on a loopback high port, no admin API, private storage.
    const conf = tpl.replaceAll("{{ACME_EMAIL}}", "ops@example.org").replaceAll("{{DOMAIN}}", `http://127.0.0.1:${cport}`)
      .replaceAll("reverse_proxy 127.0.0.1:8700", `reverse_proxy 127.0.0.1:${hubPort}`).replace("{\n\temail", "{\n\tadmin off\n\temail");
    expect(conf).not.toContain("8700"); expect(conf).not.toContain("{{");
    writeFileSync(join(dir, "Caddyfile"), conf);
    const caddy = spawn(CADDY, ["run", "--config", join(dir, "Caddyfile"), "--adapter", "caddyfile"],
      { env: { PATH: "/usr/bin:/bin", HOME: dir, XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config") }, stdio: ["ignore", "ignore", "pipe"] });
    let log = ""; caddy.stderr.on("data", (c) => { log += c; });
    try {
      for (let i = 0; i < 100 && (await send(cport, "GET", "/health", {}, Buffer.alloc(0))).status <= 0; i++) await new Promise((r) => setTimeout(r, 100));
      const cookie = w.alex, api = (p: string, b: unknown) => w.post(`/o/exna/api/${p}`, b, cookie);
      const conv = (await api("chat/conversation/create", {})).result.conversationId;
      // A real 3.9 MB JPEG (noise does not compress), uploaded the way the browser does: mint, then a raw PUT of the file.
      let big = await sharp({ create: { width: 1700, height: 1700, channels: 3, noise: { type: "gaussian", mean: 128, sigma: 60 } } }).jpeg({ quality: 100 }).toBuffer();
      expect(big.length).toBeGreaterThan(3_800_000); expect(big.length).toBeLessThan(4 * 1024 * 1024);
      const t = (await api("image/upload", { conversationId: conv, size: big.length, contentType: "image/jpeg" })).result;
      const ok = await send(cport, "PUT", `/o/exna/upload/${t.uploadId}`, { cookie, "content-type": "image/jpeg" }, big);
      expect([ok.status, json(ok.body)?.ok]).toEqual([200, true]); // reached the hub, the runtime and the decoder
      // A declared 4.2 MiB image: over both caps; whichever answers first (the hub by Content-Length, or Caddy), the member gets
      // the same JSON image_too_large, never an empty 413.
      const over = await send(cport, "PUT", `/o/exna/upload/im_${randomBytes(16).toString("hex")}`, { cookie, "content-type": "image/jpeg" }, Buffer.alloc(Math.round(4.2 * 1024 * 1024), 1));
      expect([over.status, json(over.body)?.error]).toEqual([413, "image_too_large"]);
      // 1.5 MB to a NON-image upload path (the audio route, not enabled on CP): never accepted. The hub answers and closes before
      // reading the body, so Caddy reports the upstream close (502); with the 1 MB limit it can never pass either way.
      const audio = await send(cport, "PUT", `/o/exna/upload/up_${randomBytes(16).toString("hex")}`, { cookie, "content-type": "audio/wav" }, Buffer.alloc(1_500_000, 1));
      expect([413, 502, -1]).toContain(audio.status); expect(json(audio.body)?.ok).not.toBe(true);
      // A JSON API body over 1 MB: Caddy's 413; one over 64 KiB but under 1 MB: the hub's own refusal; a small one: served.
      const huge = await send(cport, "POST", "/o/exna/api/member/me", { cookie, "content-type": "application/json" }, Buffer.from(JSON.stringify({ x: "y".repeat(1_200_000) })));
      expect([huge.status, json(huge.body)?.error]).toEqual([413, "hub_body_too_large"]); // Caddy's limit, answered as the app's JSON
      const mid = await send(cport, "POST", "/o/exna/api/member/me", { cookie, "content-type": "application/json" }, Buffer.from(JSON.stringify({ x: "y".repeat(100_000) })));
      expect([mid.status, json(mid.body)?.error]).toEqual([413, "hub_body_too_large"]); // the hub's own 64 KiB cap
      const small = await send(cport, "POST", "/o/exna/api/member/me", { cookie, "content-type": "application/json" }, Buffer.from("{}"));
      expect([small.status, json(small.body)?.ok]).toEqual([200, true]);
      // The image route matcher is exact: a GET or another prefix does not get the larger limit.
      const notPut = await send(cport, "POST", `/o/exna/upload/${t.uploadId}`, { cookie, "content-type": "image/jpeg" }, Buffer.alloc(1_500_000, 1));
      expect([404, 413, -1]).toContain(notPut.status); expect(json(notPut.body)?.ok).not.toBe(true); // not the image route: never accepted
      // The edge: exactly 4 MiB on the image route passes Caddy (the hub's cap is "more than 4 MiB").
      const t2 = (await api("image/upload", { conversationId: conv, size: 4 * 1024 * 1024, contentType: "image/jpeg" })).result;
      const edge = await send(cport, "PUT", `/o/exna/upload/${t2.uploadId}`, { cookie, "content-type": "image/jpeg" }, Buffer.alloc(4 * 1024 * 1024, 1));
      expect([edge.status, json(edge.body)?.error]).toEqual([403, "image_type_mismatch"]); // passed BOTH caps; only the content check refused
    } finally { caddy.kill("SIGTERM"); await new Promise((r) => caddy.once("exit", r)); rmSync(dir, { recursive: true, force: true }); await w.close(); if (log && /error/i.test(log) && !/request body too large/i.test(log)) console.log("caddy stderr tail:", log.slice(-600)); }
  }, 120_000);
});
