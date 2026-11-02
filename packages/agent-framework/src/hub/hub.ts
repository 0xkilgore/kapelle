// Lean runtime step 2: the shared hub. It ISSUES IDENTITY (org-scoped magic-link login, short-lived sessions) and SIGNS
// ENVELOPES with each org's own Ed25519 key; the org runtime authorizes. Option A (no passkeys, owner decision 2026-10-16):
// the envelope carries the session's ref (a hash of the session id) and sign-in time, which the runtime binds challenges to
// and checks for freshness; after an approval the hub mails the fixed-template receipt the runtime names. It holds no member private key and no
// org content: responses stream through, nothing is cached, sessions/links live in memory only (a restart logs everyone
// out), logs are none. Orgs exist only in install config, and each is reached only over its configured Unix socket.
// R-6: login answers identically for members and non-members, and is rate-limited per org and per email.
// R-8: dropping a session on a stale-membership refusal is a courtesy; the runtime's version check is the guarantee.
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { createHash, createPrivateKey, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bodyHash, envelopeBytes, type Envelope } from "../access/org-access.js";
import { verifyWebhook } from "../org/intake.js";
import { verifySvix } from "../org/resend-inbound.js";
import { CP_HOSTS, FILES_HOST } from "../org/newsletter/render-cp.js";

export type HubOrg = { orgId: string; installationId: string; socketPath: string; kid: string; keyFile: string; origin: string };
/** Shared email ingress (step 4): one entry per provider installation, pinned to one org. */
/** `secret` absent (production, Fable deploy R-1): the hub holds NO webhook secret; it checks structure and forwards the raw
 *  bytes, and the org runtime alone verifies (the one-secret, replay-guarded gate). Present: legacy pre-check (tests/dev). */
export type HubIngress = { installationId: string; orgId: string; secret?: string | null; provider?: "fake" | "resend" };
export type Receipt = { actor: string; action: string; artifactDigest: string | null; operationId: string; at: string; authn: string };
/** `done` (optional) gets the send's outcome: null, or the mail port's fixed failure label. */
export type Mailer = (m: { orgId: string; to: string; kind: "login" | "invite" | "receipt"; link: string; inviter?: string | null; role?: string | null; receipt?: Receipt },
  done?: (error: string | null) => void) => void;
/** authAt: when the email link that opened this session was used (option A freshness). */
type Session = { orgId: string; memberId: string; email: string; membershipVersion: number; expires: number; authAt: number };
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
/** What the runtime sees of a session: never the id itself, a domain-separated hash of its stored hash. */
const sessionRef = (token: string) => hash("kapelle-session-ref\0" + hash(token));
const MAX_BODY = 64 * 1024;

function callRuntime(org: HubOrg, path: string, payload: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const r = request({ socketPath: org.socketPath, path, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
      const chunks: Buffer[] = []; let n = 0;
      res.on("data", (c: Buffer) => { n += c.length; if (n > 4 * MAX_BODY) { r.destroy(); reject(new Error("hub_runtime_response_too_large")); } else chunks.push(c); });
      res.on("end", () => { try { resolve({ status: res.statusCode ?? 502, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); } catch { reject(new Error("hub_runtime_response_malformed")); } });
    });
    r.on("error", () => reject(new Error("hub_runtime_unreachable")));
    r.end(data);
  });
}

export class Hub {
  private readonly orgs = new Map<string, HubOrg & { key: KeyObject }>();
  private readonly sessions = new Map<string, Session>();
  private readonly links = new Map<string, { orgId: string; memberId: string; email: string; membershipVersion: number; expires: number }>();
  private readonly attempts = new Map<string, number[]>();
  private readonly ingress = new Map<string, HubIngress>();
  /** LIBRARY L2: one-image preview links. A draft preview is a fully sandboxed frame (an opaque origin: no cookies, cross-site),
   *  so each drive image in it gets a random single-purpose token, bound to the viewer's session, the org and the hash. */
  private readonly previewTokens = new Map<string, { orgId: string; sha256: string; s: Session & { token: string }; expires: number }>();
  static PREVIEW_IMAGE_MS = 15 * 60_000;
  /** LIBRARY L2: published drive images, cached briefly (an unpublish shows within FILES.cacheMs). */
  private readonly fileCache = new Map<string, { status: number; data: Buffer | null; at: number }>();
  private fileCacheBytes = 0;
  private readonly filesHost: string | null;
  /** The public files route's limits (tests lower cacheMs and the rate limits). */
  static FILES = { cacheMs: 60_000, cacheBytes: 64 * 1024 * 1024, perIp: 600, global: 6_000, windowMs: 600_000, maxBytes: 5 * 1024 * 1024 };
  /** Fable L-2: the public file response's headers, exactly. */
  static readonly FILE_HEADERS = Object.freeze({ "content-type": "image/jpeg", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "public, max-age=31536000, immutable", "referrer-policy": "no-referrer" });
  constructor(config: HubOrg[], private readonly mail: Mailer, private readonly now: () => number = () => Date.now(), ingress: HubIngress[] = [], opts: { filesHost?: string | null } = {}) {
    this.filesHost = opts.filesHost ?? null;
    for (const i of ingress) { if (this.ingress.has(i.installationId)) throw new Error("hub_ingress_config_invalid"); this.ingress.set(i.installationId, i); }
    for (const o of config) {
      const st = lstatSync(o.keyFile);
      if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) throw new Error("hub_key_file_not_private");
      if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(o.orgId) || this.orgs.has(o.orgId)) throw new Error("hub_org_config_invalid");
      this.orgs.set(o.orgId, { ...o, key: createPrivateKey(readFileSync(o.keyFile)) });
    }
  }
  private envelope(org: HubOrg & { key: KeyObject }, memberId: string, membershipVersion: number, action: string, body: unknown, s: (Session & { token: string }) | null = null) {
    const env: Envelope = { v: 1, orgId: org.orgId, installationId: org.installationId, kid: org.kid, memberId, membershipVersion, action,
      bodyHash: bodyHash(body), requestId: randomBytes(18).toString("base64url"), expiry: new Date(this.now() + 60_000).toISOString(),
      session: s ? { ref: sessionRef(s.token), authAt: new Date(s.authAt).toISOString() } : null };
    return { envelope: env, signature: sign(null, envelopeBytes(env), org.key).toString("base64url"), body };
  }
  /** N-2: bounded: entries outside the window are dropped, and the map never exceeds 10 000 keys (oldest first). */
  private limited(key: string, max: number, windowMs: number) {
    const t = this.now(), list = (this.attempts.get(key) ?? []).filter((x) => t - x < windowMs);
    list.push(t); this.attempts.delete(key); this.attempts.set(key, list.slice(-(max + 1)));
    while (this.attempts.size > 10_000) this.attempts.delete(this.attempts.keys().next().value!);
    return list.length > max;
  }
  private session(req: IncomingMessage, orgId: string): (Session & { token: string }) | null {
    const cookie = (req.headers.cookie ?? "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`kh_${orgId}=`));
    const token = cookie?.slice(`kh_${orgId}=`.length) ?? "";
    const s = this.sessions.get(hash(token));
    if (!s || s.orgId !== orgId || s.expires < this.now()) return null;
    return { ...s, token };
  }
  private openSession(orgId: string, m: { memberId: string; email: string; membershipVersion: number }) {
    const session = randomBytes(32).toString("base64url");
    this.sessions.set(hash(session), { orgId, memberId: m.memberId, email: m.email, membershipVersion: m.membershipVersion, expires: this.now() + 8 * 3_600_000, authAt: this.now() });
    return `kh_${orgId}=${session}; HttpOnly; Secure; SameSite=Lax; Path=/o/${orgId}`;
  }
  /** Test/ops hook: how much the hub holds (sizes only, never content). */
  stats() { return { sessions: this.sessions.size, links: this.links.size }; }

  async handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
    // LIBRARY L2 (Fable R-1): the dedicated files host serves ONLY published drive images; nothing else, no session code.
    const host = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (this.filesHost && host === this.filesHost) return this.publicFile(req, res);
    // Static review UI (no org content; every view fetches through the session routes below).
    const asset = /^\/ui\/(app\.js|app\.css|InterVariable\.woff2)$/.exec(req.url ?? "");
    if (asset && req.method === "GET") return this.static(res, asset[1]);
    // Owner (24 Oct): the bare host answered raw JSON {ok:false,error:hub_not_found}. One org -> its app; otherwise a plain page
    // with no org names (a hub never lists who it serves). Static, no-store, the same CSP; no session is read.
    if ((req.url === "/" || req.url === "") && (req.method === "GET" || req.method === "HEAD")) {
      const sec = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" };
      if (this.orgs.size === 1) { res.writeHead(302, { location: `/o/${[...this.orgs.keys()][0]}/`, ...sec }); return res.end(); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...sec });
      return res.end(req.method === "HEAD" ? undefined : Hub.HOME_HTML);
    }
    const page = /^\/o\/([a-z0-9][a-z0-9-]{1,62})\/?$/.exec(req.url ?? "");
    if (page && req.method === "GET" && this.orgs.has(page[1])) return this.static(res, "app.html");
    // B1: the mailed (or Ops-issued) invite link opens the same static app, which shows the invitation and accepts it (option A: no passkey).
    // The token travels in the URL FRAGMENT (#token=...), which browsers never send: it cannot reach a proxy or server log.
    const invitePage = /^\/o\/([a-z0-9][a-z0-9-]{1,62})\/invite$/.exec(req.url ?? "");
    if (invitePage && req.method === "GET" && this.orgs.has(invitePage[1])) return this.static(res, "app.html");
    const ing = /^\/ingress\/email\/([A-Za-z0-9_-]{4,64})$/.exec(req.url ?? "");
    if (ing && req.method === "POST") return this.ingest(ing[1], req, send);
    // IMAGES-V1 I1: the same streamed relay carries chat image tickets (im_): image types, a 4 MiB cap.
    const upl = /^\/o\/([a-z0-9][a-z0-9-]{1,62})\/upload\/((?:up|im)_[a-f0-9]{32})$/.exec(req.url ?? "");
    if (upl && req.method === "PUT" && this.orgs.has(upl[1])) return this.upload(this.orgs.get(upl[1])!, upl[2], req, res, send);
    // IMAGES-V1 I1: one chat image's normalized bytes, for its conversation's starter (the runtime decides).
    const img = /^\/o\/([a-z0-9][a-z0-9-]{1,62})\/image\/(img_[a-f0-9]{32})$/.exec(req.url ?? "");
    if (img && req.method === "GET" && this.orgs.has(img[1])) return this.image(this.orgs.get(img[1])!, { action: "image.read", body: { imageId: img[2] }, path: `/access/image/${img[2]}` }, req, res, send);
    // LIBRARY L2: a drive image inside a draft preview frame, by its preview token (no cookie reaches a sandboxed frame).
    const dpv = /^\/o\/([a-z0-9][a-z0-9-]{1,62})\/drive\/preview\/([a-f0-9]{64})\?t=([A-Za-z0-9_-]{43})$/.exec(req.url ?? "");
    if (dpv && req.method === "GET" && this.orgs.has(dpv[1])) {
      const t = this.previewTokens.get(dpv[3]);
      if (!t || t.orgId !== dpv[1] || t.sha256 !== dpv[2] || t.expires < this.now()) return send(404, { ok: false, error: "hub_not_found" });
      return this.image(this.orgs.get(dpv[1])!, { action: "files.image.read", body: { sha256: dpv[2] }, path: `/access/drive/image/${dpv[2]}` }, req, res, send, t.s);
    }
    // LIBRARY L1: one shared-drive image (any member of the org; the runtime decides), the chat image GET's shape.
    const dimg = /^\/o\/([a-z0-9][a-z0-9-]{1,62})\/drive\/image\/([a-f0-9]{64})$/.exec(req.url ?? "");
    if (dimg && req.method === "GET" && this.orgs.has(dimg[1])) return this.image(this.orgs.get(dimg[1])!, { action: "files.image.read", body: { sha256: dimg[2] }, path: `/access/drive/image/${dimg[2]}` }, req, res, send);
    // Package E (Fable E-11): one draft version's preview HTML under its OWN CSP (a srcdoc frame inherits this page's).
    const pvw = /^\/o\/([a-z0-9][a-z0-9-]{1,62})\/preview(\?[^#]*)?$/.exec(req.url ?? "");
    if (pvw && req.method === "GET" && this.orgs.has(pvw[1])) return this.preview(this.orgs.get(pvw[1])!, pvw[2] ?? "", req, res, send);
    const m = /^\/o\/([a-z0-9][a-z0-9-]{1,62})\/([a-z/-]+)(\?.*)?$/.exec(req.url ?? "");
    const org = m ? this.orgs.get(m[1]) : undefined;
    if (!m || !org) return send(404, { ok: false, error: "hub_not_found" });
    const route = m[2];
    let body: any = {};
    if (req.method === "POST") {
      // N-1 (defence in depth behind SameSite=Lax): state changes are same-site JSON POSTs only. A cross-site JSON POST
      // needs a CORS preflight the hub never grants; a form or text/plain POST is refused here before any work.
      if (req.headers["sec-fetch-site"] === "cross-site") return send(403, { ok: false, error: "hub_cross_site_refused" });
      if (!/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) return send(415, { ok: false, error: "hub_content_type_refused" });
      const chunks: Buffer[] = []; let n = 0;
      for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) return send(413, { ok: false, error: "hub_body_too_large" }); chunks.push(c as Buffer); }
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; } catch { return send(400, { ok: false, error: "hub_body_malformed" }); }
    }
    try {
      if (route === "login" && req.method === "POST") {
        const email = String(body.email ?? "").toLowerCase().slice(0, 320);
        // R-6: the same answer, status and work for members and non-members; limits apply to both.
        const blocked = this.limited(`org:${org.orgId}`, 30, 60_000) || this.limited(`email:${org.orgId}:${email}`, 5, 600_000);
        const lookup = await callRuntime(org, "/access/lookup", this.envelope(org, "hub", 0, "member.lookup", { email }));
        if (!blocked && lookup.body.ok && lookup.body.active) {
          const token = randomBytes(32).toString("base64url");
          this.links.set(hash(token), { orgId: org.orgId, memberId: lookup.body.memberId, email, membershipVersion: lookup.body.membershipVersion, expires: this.now() + 15 * 60_000 });
          setImmediate(() => this.mail({ orgId: org.orgId, to: email, kind: "login", link: `${org.origin}/o/${org.orgId}/magic?token=${token}` }));
        }
        return send(202, { ok: true, message: "If this address belongs to a member, a sign-in link is on its way." });
      }
      if (route === "magic" && req.method === "GET") {
        const token = new URL(req.url!, "http://hub").searchParams.get("token") ?? "", h = hash(token), link = this.links.get(h);
        this.links.delete(h); // single use, even when expired or wrong-org
        if (!link || link.orgId !== org.orgId || link.expires < this.now()) return send(403, { ok: false, error: "hub_link_invalid" });
        const cookie = this.openSession(org.orgId, link);
        // A browser following the mailed link lands on the app; API clients get JSON.
        if (/text\/html/.test(String(req.headers.accept ?? ""))) { res.writeHead(303, { location: `/o/${org.orgId}/`, "set-cookie": cookie, "cache-control": "no-store" }); return res.end(); }
        return send(200, { ok: true }, { "set-cookie": cookie });
      }
      // Invite acceptance: the mailed (or Ops-issued) runtime token is the possession proof; the runtime admits the member and
      // the hub opens their session, exactly as a sign-in link would.
      // Fable B1 N-2: the unauthenticated invite routes share the login route's hygiene: a per-org window and a per-token
      // window (tokens are 256-bit random, so this is hygiene against hammering, not the guard).
      if (/^invite\/(info|accept)$/.test(route) && req.method === "POST") {
        const per = typeof body.token === "string" ? hash(body.token).slice(0, 16) : "none";
        if (this.limited(`invite:${org.orgId}`, 60, 60_000) || this.limited(`invite-key:${org.orgId}:${per}`, 10, 600_000)) return send(429, { ok: false, error: "hub_rate_limited" });
      }
      if (route === "invite/info" && req.method === "POST") return this.relay(send, await callRuntime(org, "/access/invite/info", { token: body.token }));
      if (route === "invite/accept" && req.method === "POST") {
        const r = await callRuntime(org, "/access/invite/accept", { token: body.token });
        if (!r.body?.ok) return this.relay(send, r);
        const cookie = this.openSession(org.orgId, { memberId: r.body.memberId, email: r.body.email, membershipVersion: r.body.membershipVersion });
        return send(200, { ok: true, memberId: r.body.memberId, role: r.body.role }, { "set-cookie": cookie });
      }
      const s = this.session(req, org.orgId);
      if (!s) return send(401, { ok: false, error: "hub_no_session" });
      const r = await this.forward(org, s, route, req.method ?? "GET", body);
      if (!r) return send(404, { ok: false, error: "hub_not_found" });
      return this.relay(send, r);
    } catch (e) {
      return send(502, { ok: false, error: e instanceof Error && e.message.startsWith("hub_") ? e.message : "hub_error" });
    }
  }
  /** Forward one session request. On a stale-membership refusal (someone was removed or demoted) re-check THIS member
   *  with the runtime: still active -> refresh the session's version and retry once; otherwise drop the session (R-8:
   *  courtesy only, the runtime's version and status checks are the guarantee). */
  private async forward(org: HubOrg & { key: KeyObject }, s: Session & { token: string }, route: string, method: string, body: any, retried = false): Promise<{ status: number; body: any } | null> {
    let r: { status: number; body: any };
      if (route === "challenge" && method === "POST") r = await callRuntime(org, "/access/challenge", this.envelope(org, s.memberId, s.membershipVersion, "challenge.mint", body, s));
      else if (route === "act" && method === "POST") {
        r = await callRuntime(org, "/access/act", this.envelope(org, s.memberId, s.membershipVersion, String(body.action ?? ""), body, s));
        // Option A control 4: the runtime names who gets a receipt (the actor; admins too for a plan approval); the hub mails the
        // fixed template and never passes the list to the browser.
        if (r.body?.ok && "receipt" in r.body) {
          const rc = r.body.receipt;
          // N-3: a receipt that could not be sent is reported to the runtime (service envelope), which audits it for Ops.
          const failed = (to: string) => (error: string | null) => { if (error) void callRuntime(org, "/access/receipt/failed",
            this.envelope(org, "hub", 0, "receipt.failed", { operationId: String(rc.operationId), to, label: error })).catch(() => {}); };
          if (rc && Array.isArray(rc.to)) for (const to of rc.to.slice(0, 50)) if (typeof to === "string")
            setImmediate(() => { try { this.mail({ orgId: org.orgId, to, kind: "receipt", link: `${org.origin}/o/${org.orgId}/`,
              receipt: { actor: String(rc.actor), action: String(rc.action), artifactDigest: rc.artifactDigest ?? null, operationId: String(rc.operationId), at: String(rc.at), authn: String(rc.authn) } }, failed(to)); }
              catch { failed(to)("mail_error"); } });
          const { receipt: _drop, ...rest } = r.body; r = { status: r.status, body: rest };
        }
        // The runtime minted an invite token: deliver it by mail, never return it to the browser that requested it.
        if (r.body.ok && body.action === "member.invite" && r.body.result?.token) {
          const { token, email } = r.body.result;
          // The invite mail names the inviter (their verified session email) and the role from the approved body.
          const role = typeof body.body?.role === "string" ? body.body.role : null;
          setImmediate(() => this.mail({ orgId: org.orgId, to: email, kind: "invite", link: `${org.origin}/o/${org.orgId}/invite#token=${token}`, inviter: s.email, role }));
          r = { status: r.status, body: { ...r.body, result: { invited: email } } };
        }
      }
      else if (route.startsWith("api/") && method === "POST") r = await callRuntime(org, "/access/routine", this.envelope(org, s.memberId, s.membershipVersion, route.slice(4).replaceAll("/", "."), body, s));
      else return null;
      if (r.body?.error === "access_member_inactive") this.sessions.delete(hash(s.token));
      if (r.body?.error === "access_membership_stale" && !retried) {
        const now = await callRuntime(org, "/access/lookup", this.envelope(org, "hub", 0, "member.lookup", { email: s.email }));
        if (!(now.body.ok && now.body.active && now.body.memberId === s.memberId)) { this.sessions.delete(hash(s.token)); return r; }
        const current = this.sessions.get(hash(s.token));
        if (current) current.membershipVersion = now.body.membershipVersion;
        return this.forward(org, { ...s, membershipVersion: now.body.membershipVersion }, route, method, body, true);
      }
      return r;
  }
  /** Transcription T-2 (Fable R-2, P-3): the ONE streamed route. Session required, same-site only, an exact Content-Length
   *  (chunked refused) within the cap and an audio type; a per-session rate limit. The body is piped to the org runtime's
   *  socket with a signed `media.upload` envelope in a header (bound to this session's ref); the hub buffers nothing and writes
   *  nothing. A client abort or an idle socket destroys both sides; the runtime has already consumed the upload id. */
  private async upload(org: HubOrg & { key: KeyObject }, uploadId: string, req: IncomingMessage, res: import("node:http").ServerResponse, send: (s: number, b: unknown, h?: Record<string, string>) => void) {
    // F-1 (Fable T-2/T-3): the idle timeout is installed BEFORE any check, and EVERY refusal is answered and then the connection
    // is cut. The hub never reads (or drains) a refused body: not for a stranger, not for an endless chunked stream.
    // ONE idle listener for the whole request; the piping stage swaps in its own handler (tear down both sides).
    const cut = () => { req.destroy(); req.socket?.destroy(); };
    let onIdle = () => { if (!res.headersSent) { res.once("finish", cut); send(408, { ok: false, error: "media_upload_aborted" }); } else cut(); };
    req.setTimeout(Hub.UPLOAD_IDLE_MS, () => onIdle());
    const drop = (status: number, error: string) => { onIdle = cut; res.once("finish", cut); send(status, { ok: false, error }); };
    if (req.headers["sec-fetch-site"] === "cross-site") return drop(403, "hub_cross_site_refused");
    const s = this.session(req, org.orgId);
    if (!s) return drop(401, "hub_no_session");
    const len = String(req.headers["content-length"] ?? ""), type = String(req.headers["content-type"] ?? "");
    if (req.headers["transfer-encoding"] || !/^[1-9][0-9]{0,9}$/.test(len)) return drop(411, "hub_length_required");
    const isImage = uploadId.startsWith("im_");
    if (Number(len) > (isImage ? Hub.MAX_IMAGE_BYTES : Hub.MAX_UPLOAD_BYTES)) return drop(413, isImage ? "image_too_large" : "media_too_large");
    if (!(isImage ? /^image\/(jpeg|png|webp)$/ : /^audio\/[a-z0-9.+-]{1,40}$/).test(type)) return drop(415, "hub_content_type_refused");
    if (this.limited(`upload:${org.orgId}:${hash(s.token)}`, 10, 3_600_000)) return drop(429, "media_upload_rate_limited");
    const body = { uploadId, size: Number(len), contentType: type };
    const signed = Buffer.from(JSON.stringify(this.envelope(org, s.memberId, s.membershipVersion, "media.upload", body, s))).toString("base64url");
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (status: number, b: unknown) => { if (done) return; done = true; if (!res.headersSent) send(status, b); resolve(); };
      const up = request({ socketPath: org.socketPath, path: `/access/media/upload/${uploadId}`, method: "PUT", agent: false,
        headers: { "content-type": type, "content-length": len, "x-kapelle-envelope": signed } }, (r) => {
        const chunks: Buffer[] = []; let n = 0;
        r.on("data", (c: Buffer) => { n += c.length; if (n <= 64 * 1024) chunks.push(c); });
        r.on("end", () => { let j: any; try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { j = { ok: false, error: "hub_runtime_response_malformed" }; }
          finish(r.statusCode ?? 502, j); req.resume(); });
      });
      up.on("error", () => finish(502, { ok: false, error: "hub_runtime_unreachable" }));
      // P-3: a client abort or an idle client tears the upstream stream down (the runtime tombstones what it got).
      req.on("aborted", () => { up.destroy(); finish(499, { ok: false, error: "media_upload_aborted" }); });
      onIdle = () => { up.destroy(); res.once("finish", cut); finish(408, { ok: false, error: "media_upload_aborted" }); if (res.headersSent && !res.writableEnded) cut(); };
      req.pipe(up);
    });
  }
  static readonly MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
  static readonly MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  /** LIBRARY L2 (Fable L-2, L-8, R-1, R-2): GET/HEAD /o/<org>/files/<sha256>.jpg on the files host. No cookies are read or set.
   *  Per-IP (the address Caddy appended to X-Forwarded-For, trusted from loopback only) and global limits; the runtime answers
   *  200 / 404 / 410 / 500 under a service envelope; the bytes are re-hashed here too and must equal the name. */
  private async publicFile(req: IncomingMessage, res: import("node:http").ServerResponse) {
    const plain = (status: number, text: string, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; sandbox", ...extra }); res.end(req.method === "HEAD" ? undefined : text); };
    const m = /^\/o\/([a-z0-9][a-z0-9-]{1,62})\/files\/([a-f0-9]{64})\.jpg$/.exec(req.url ?? "");
    const org = m ? this.orgs.get(m[1]) : undefined;
    if (!m || !org || (req.method !== "GET" && req.method !== "HEAD")) return plain(404, "Not found");
    const peer = req.socket.remoteAddress ?? "", loopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
    const xff = loopback ? String(req.headers["x-forwarded-for"] ?? "").split(",").map((x) => x.trim()).filter(Boolean).at(-1) ?? peer : peer;
    if (this.limited("files:ip:" + xff, Hub.FILES.perIp, Hub.FILES.windowMs) || this.limited("files:all", Hub.FILES.global, Hub.FILES.windowMs)) return plain(429, "Too many requests", { "retry-after": "60" });
    const key = m[1] + "/" + m[2], t = this.now();
    let hit = this.fileCache.get(key);
    if (!hit || t - hit.at > Hub.FILES.cacheMs) {
      const r = await this.fetchPublicFile(org, m[2]);
      if (hit?.data) this.fileCacheBytes -= hit.data.length;
      this.fileCache.delete(key);
      hit = { ...r, at: t };
      // Only 200 and 410 are cached: a 404 may become public any moment (the prepare's own preflight follows its publish), and
      // a fault is never cached.
      if (r.status === 200 || r.status === 410) { this.fileCache.set(key, hit); if (hit.data) this.fileCacheBytes += hit.data.length; }
      while (this.fileCacheBytes > Hub.FILES.cacheBytes && this.fileCache.size) { const [k, v] = this.fileCache.entries().next().value!; this.fileCache.delete(k); if (v.data) this.fileCacheBytes -= v.data.length; }
    }
    if (hit.status === 200 && hit.data) {
      res.writeHead(200, { ...Hub.FILE_HEADERS, "content-length": String(hit.data.length) });
      return res.end(req.method === "HEAD" ? undefined : hit.data);
    }
    return hit.status === 410 ? plain(410, "Gone") : hit.status === 404 ? plain(404, "Not found") : plain(500, "Unavailable");
  }
  private fetchPublicFile(org: HubOrg & { key: KeyObject }, sha256: string): Promise<{ status: number; data: Buffer | null }> {
    const signed = Buffer.from(JSON.stringify(this.envelope(org, "hub", 0, "files.public.read", { sha256 }))).toString("base64url");
    return new Promise((resolve) => {
      const up = request({ socketPath: org.socketPath, path: `/access/public/file/${sha256}`, method: "GET", agent: false, headers: { "x-kapelle-envelope": signed } }, (r) => {
        const chunks: Buffer[] = []; let n = 0, over = false;
        r.on("data", (c: Buffer) => { n += c.length; if (n > Hub.FILES.maxBytes) over = true; else chunks.push(c); });
        r.on("end", () => {
          const b = Buffer.concat(chunks);
          if (r.statusCode === 200 && !over && r.headers["content-type"] === "image/jpeg")
            return resolve(hash(b) === sha256 ? { status: 200, data: b } : { status: 500, data: null }); // R-2: never serve mismatching bytes
          resolve({ status: r.statusCode === 404 || r.statusCode === 410 ? r.statusCode : 500, data: null });
        });
      });
      up.on("error", () => resolve({ status: 500, data: null }));
      up.end();
    });
  }
  /** IMAGES-V1 I1: GET one chat image. Session required, never cross-site; a signed `image.read` envelope in a header; the
   *  runtime checks ownership and the hash. Only a 200 relays bytes (fixed image/jpeg, nosniff, private no-store, <= 1 MiB);
   *  anything else is the runtime's JSON refusal. The hub stores nothing. */
  private async image(org: HubOrg & { key: KeyObject }, t: { action: string; body: Record<string, string>; path: string }, req: IncomingMessage, res: import("node:http").ServerResponse, send: (s: number, b: unknown, h?: Record<string, string>) => void,
    viaToken: (Session & { token: string }) | null = null) {
    // A preview token (minted for this hash inside the viewer's own preview response) stands in for the cookie a sandboxed frame lacks.
    if (!viaToken && req.headers["sec-fetch-site"] === "cross-site") return send(403, { ok: false, error: "hub_cross_site_refused" });
    const s = viaToken ?? this.session(req, org.orgId);
    if (!s) return send(401, { ok: false, error: "hub_no_session" });
    if (this.limited(`image:${org.orgId}:${hash(s.token)}`, 600, 3_600_000)) return send(429, { ok: false, error: "hub_rate_limited" });
    const signed = Buffer.from(JSON.stringify(this.envelope(org, s.memberId, s.membershipVersion, t.action, t.body, s))).toString("base64url");
    await new Promise<void>((resolve) => {
      const up = request({ socketPath: org.socketPath, path: t.path, method: "GET", agent: false, headers: { "x-kapelle-envelope": signed } }, (r) => {
        const chunks: Buffer[] = []; let n = 0, over = false;
        r.on("data", (c: Buffer) => { n += c.length; if (n > 1024 * 1024 + 64 * 1024) over = true; else chunks.push(c); });
        r.on("end", () => {
          const b = Buffer.concat(chunks);
          if (r.statusCode === 200 && !over && r.headers["content-type"] === "image/jpeg") {
            res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(b.length), "x-content-type-options": "nosniff", "cache-control": "private, no-store",
              "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; sandbox" });
            res.end(b);
          } else { let j: any; try { j = JSON.parse(b.toString("utf8")); } catch { j = { ok: false, error: "hub_runtime_response_malformed" }; } send(over ? 502 : r.statusCode ?? 502, j); }
          resolve();
        });
      });
      up.on("error", () => { send(502, { ok: false, error: "hub_runtime_unreachable" }); resolve(); });
      up.end();
    });
  }
  /** Package E (Fable E-11): the preview response's CSP, exactly; img-src from the renderer's own image allowlist (one source). */
  /** LIBRARY L2 (Fable, draft preview): this org's shared-drive images in a draft preview load through a session-bound preview
   *  link (unpublished ones have no public URL yet); the CSP's img-src gains exactly that route's path on this org's origin. The
   *  stored HTML (and every release package) keeps the public files URL; only the preview response is rewritten. */
  private previewDrive(html: string, org: HubOrg, s: Session & { token: string }, here: string) {
    const re = new RegExp(`https://${FILES_HOST.replaceAll(".", "\\.")}/o/${org.orgId}/files/([a-f0-9]{64})\\.jpg`, "g");
    let rewritten = false;
    const t = this.now();
    for (const [k, v] of this.previewTokens) if (v.expires < t) this.previewTokens.delete(k);
    while (this.previewTokens.size > 5_000) this.previewTokens.delete(this.previewTokens.keys().next().value!);
    const out = html.replace(re, (_m, h: string) => { rewritten = true;
      const tok = randomBytes(32).toString("base64url");
      this.previewTokens.set(tok, { orgId: org.orgId, sha256: h, s, expires: t + Hub.PREVIEW_IMAGE_MS });
      return `${here}/o/${org.orgId}/drive/preview/${h}?t=${tok}`; });
    return { html: out, rewritten };
  }
  static previewCspWithDrive(org: HubOrg, here: string) { return Hub.PREVIEW_CSP.replace("; base-uri", ` ${here}/o/${org.orgId}/drive/preview/; base-uri`); }
  static readonly PREVIEW_CSP = `default-src 'none'; style-src 'unsafe-inline'; img-src ${CP_HOSTS.map((h) => "https://" + h).join(" ")}; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox`;
  /** The release package's HTML cap (512 KiB) + 64 KiB slack, as the image GET does. */
  static readonly MAX_PREVIEW_BYTES = 512 * 1024 + 64 * 1024;
  /** Package E (Fable E-11): GET one draft version's stored preview HTML. The image GET's shape, line for line: never cross-site,
   *  a session, the same rate-limit family, a signed envelope for the EXISTING routine action chat.artifact.preview (the runtime
   *  checks ownership and the version as the POST path does). Only a runtime 200 text/html within the cap is relayed, with the
   *  fixed headers below; anything else is the runtime's JSON refusal, never HTML. The hub stores nothing. */
  private async preview(org: HubOrg & { key: KeyObject }, query: string, req: IncomingMessage, res: import("node:http").ServerResponse, send: (s: number, b: unknown, h?: Record<string, string>) => void) {
    if (req.headers["sec-fetch-site"] === "cross-site") return send(403, { ok: false, error: "hub_cross_site_refused" });
    const s = this.session(req, org.orgId);
    if (!s) return send(401, { ok: false, error: "hub_no_session" });
    if (this.limited(`image:${org.orgId}:${hash(s.token)}`, 600, 3_600_000)) return send(429, { ok: false, error: "hub_rate_limited" });
    const q = new URLSearchParams(query.replace(/^\?/, "")), c = q.get("conversationId") ?? "", a = q.get("artifactId") ?? "", v = q.get("version") ?? "";
    if ([...q.keys()].length !== 3 || !/^conv_[a-f0-9]{32}$/.test(c) || !/^art_[a-f0-9]{32}$/.test(a) || !/^[1-9][0-9]{0,4}$/.test(v)) return send(400, { ok: false, error: "hub_preview_invalid" });
    const body = { conversationId: c, artifactId: a, version: Number(v) };
    const signed = Buffer.from(JSON.stringify(this.envelope(org, s.memberId, s.membershipVersion, "chat.artifact.preview", body, s))).toString("base64url");
    await new Promise<void>((resolve) => {
      const up = request({ socketPath: org.socketPath, path: `/access/chat/preview?conversationId=${c}&artifactId=${a}&version=${v}`, method: "GET", agent: false, headers: { "x-kapelle-envelope": signed } }, (r) => {
        const chunks: Buffer[] = []; let n = 0, over = false;
        r.on("data", (x: Buffer) => { n += x.length; if (n > Hub.MAX_PREVIEW_BYTES) over = true; else chunks.push(x); });
        r.on("end", () => {
          const b = Buffer.concat(chunks);
          if (r.statusCode === 200 && !over && r.headers["content-type"] === "text/html; charset=utf-8") {
            // The address the viewer loaded this preview from (behind Caddy: its Host + forwarded scheme), so the image links and
            // the CSP name exactly that origin.
            const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https" ? "https" : "http";
            const here = /^[a-z0-9.-]+(:\d{1,5})?$/.test(String(req.headers.host ?? "")) ? `${proto}://${req.headers.host}` : org.origin;
            const p = this.previewDrive(b.toString("utf8"), org, s, here);
            const out = p.rewritten ? Buffer.from(p.html, "utf8") : b;
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": String(out.length), "x-content-type-options": "nosniff", "cache-control": "private, no-store",
              "referrer-policy": "no-referrer", "content-security-policy": p.rewritten ? Hub.previewCspWithDrive(org, here) : Hub.PREVIEW_CSP });
            res.end(out);
          } else { let j: any; try { j = JSON.parse(b.toString("utf8")); } catch { j = { ok: false, error: "hub_runtime_response_malformed" }; } send(over ? 502 : (r.statusCode === 200 ? 502 : r.statusCode ?? 502), over || r.statusCode === 200 ? { ok: false, error: "hub_runtime_response_malformed" } : j); }
          resolve();
        });
      });
      up.on("error", () => { send(502, { ok: false, error: "hub_runtime_unreachable" }); resolve(); });
      up.end();
    });
  }
  /** A client that sends nothing for this long is cut (tests lower it). */
  static UPLOAD_IDLE_MS = 30_000;
  /** Signed provider webhook -> the installation's ONE org runtime. The hub checks the signature (non-authoritative), keeps
   *  nothing, forwards the raw signed bytes, and acknowledges only after the runtime has committed (else the provider
   *  redelivers). The runtime re-verifies and owns the replay guard. */
  private async ingest(installationId: string, req: IncomingMessage, send: (s: number, b: unknown) => void) {
    const inst = this.ingress.get(installationId), org = inst ? this.orgs.get(inst.orgId) : undefined;
    if (!inst || !org) return send(404, { ok: false, error: "hub_not_found" });
    const chunks: Buffer[] = []; let n = 0;
    for await (const c of req) { n += (c as Buffer).length; if (n > 2 * 1024 * 1024) return send(413, { ok: false, error: "hub_body_too_large" }); chunks.push(c as Buffer); }
    const body = Buffer.concat(chunks).toString("utf8");
    const resend = inst.provider === "resend", h = (n: string) => String(req.headers[n] ?? "");
    const headers = resend ? { id: h("svix-id"), timestamp: h("svix-timestamp"), signature: h("svix-signature") }
      : { id: h("webhook-id"), timestamp: h("webhook-timestamp"), signature: h("webhook-signature") };
    if (inst.secret) {
      try { if (resend) verifySvix(inst.secret, headers, body, this.now()); else verifyWebhook(inst.secret, installationId, headers, body, this.now()); }
      catch { return send(401, { ok: false, error: "hub_signature_invalid" }); }
    } else if (!/^[A-Za-z0-9_-]{1,128}$/.test(headers.id) || !/^\d{9,12}$/.test(headers.timestamp) || !headers.signature || headers.signature.length > 2048 || !body)
      return send(401, { ok: false, error: "hub_signature_missing" }); // structure only: the runtime verifies the signature
    try {
      const r = await callRuntime(org, "/intake/email", { installationId, headers, body });
      const authFail = typeof r.body?.error === "string" && /^intake_(signature|secret)_/.test(r.body.error);
      return send(r.body?.ok ? 200 : authFail ? 401 : r.status >= 500 ? 503 : 422, r.body?.ok ? { ok: true } : { ok: false, error: r.body?.error ?? "hub_runtime_refused" });
    } catch { return send(503, { ok: false, error: "hub_runtime_unreachable" }); }
  }
  private static readonly UI_TYPES: Record<string, string> = { "app.html": "text/html; charset=utf-8", "app.js": "text/javascript; charset=utf-8", "app.css": "text/css; charset=utf-8",
    // Owner UI feedback (Oct 23): one self-hosted font file (Inter 4.1, SIL OFL 1.1; ui/Inter-LICENSE.txt; flat files: the build copies ui/* non-recursively). No package.
    "InterVariable.woff2": "font/woff2" };
  /** The bare host when the hub serves more than one org (or none): plain words, no names, no script. */
  static readonly HOME_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kapelle</title></head>' +
    '<body><main><h1>Kapelle</h1><p>Open your organization from the link in your invitation or sign-in email.</p></main></body></html>';
  private static(res: import("node:http").ServerResponse, name: string) {
    const body = readFileSync(fileURLToPath(new URL(`./ui/${name}`, import.meta.url)));
    // Fable N-2: the font alone may be cached (352 KB; a day, private); the UI itself stays no-store.
    res.writeHead(200, { "content-type": Hub.UI_TYPES[name], "cache-control": name === "InterVariable.woff2" ? "private, max-age=86400" : "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
    res.end(body);
  }
  private relay(send: (s: number, b: unknown) => void, r: { status: number; body: unknown }) { send(r.status, r.body); }
  listen(port = 0, host = "127.0.0.1"): Promise<Server> {
    const server = createServer((req, res) => void this.handle(req, res));
    return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
  }
}
