// Lean runtime step 2 (C-1.4, plan R-7): the org runtime's private access API on a per-org Unix socket. No TCP listener.
// Node has no getpeereid, so the FILESYSTEM MODE IS THE PEER CHECK: the socket directory is 0700 and the socket 0600
// when hub and worker share a uid (co-located step 2), or directory 0710 + socket 0660 owned by the hub's group when they
// run as separate users. Single-user tests cannot prove the cross-user split; it is an Ops precheck (stat both).
// Every error leaves as a fixed reason label; bodies are capped; nothing here logs request content.
import { isRetryableIntakeLabel } from "../org/resend-content.js";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { AccessError, type Authorization, type Envelope, type OrgAccess } from "./org-access.js";
import { WebAuthnError } from "./webauthn.js";
import { IntakeError, type OrgIntake } from "../org/intake.js";
import { TranscriptionRefused } from "../org/transcription/profile.js";

const MAX_BODY = 64 * 1024;
type Signed<T = unknown> = { envelope: Envelope; signature: string; body: T };
export type ConsequentialHandler = (body: unknown, z: Authorization) => Promise<unknown>;
export type RoutineHandler = (body: unknown, member: { memberId: string; role: string; sessionRef: string }) => Promise<unknown>;
/** Transcription T-2: the streamed upload (the ONE route exempt from the 64 KiB JSON body cap). */
export type MediaPutHandler = (uploadId: string, member: { memberId: string; role: string; sessionRef: string },
  req: IncomingMessage, meta: { size: number; contentType: string }) => Promise<unknown>;

async function json(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) { n += (c as Buffer).length; if (n > MAX_BODY) throw new AccessError("access_body_too_large"); chunks.push(c as Buffer); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new AccessError("access_body_malformed"); }
}

export async function serveOrgAccess(access: OrgAccess, socketPath: string, o: { actions?: Record<string, ConsequentialHandler>; routines?: Record<string, RoutineHandler>; groupAccess?: boolean;
  mediaPut?: MediaPutHandler;
  /** IMAGES-V1 I1: GET the normalized bytes of one chat image (envelope in a header, action image.read, body {imageId}). */
  imageGet?: (imageId: string, member: { memberId: string; role: string; sessionRef: string }) => Promise<{ data: Buffer; sha256: string }>;
  /** LIBRARY L1: GET one shared-drive image (any member; envelope in a header, action files.image.read, body {sha256}). */
  driveGet?: (sha256: string, member: { memberId: string; role: string; sessionRef: string }) => Promise<{ data: Buffer; sha256: string }>;
  /** LIBRARY L2: the hub's public files route (a service envelope, no member): 200 + bytes, or 404 / 410 / 500. */
  publicFileGet?: (sha256: string) => Promise<{ status: 200; data: Buffer } | { status: 404 | 410 | 500 }>;
  /** Package E (Fable E-11): one draft version's stored preview HTML, for the hub's preview GET (the existing chat.artifact.preview action). */
  previewGet?: (body: { conversationId: string; artifactId: string; version: number }, member: { memberId: string; role: string; sessionRef: string }) => Promise<string>;
  /** S3-c (Fable S3-a wiring): awaited before a challenge is minted, so a synchronous mint guard reads fresh facts. */
  beforeChallenge?: (action: unknown) => Promise<void>;
  intake?: { intake: OrgIntake; memberActive: (memberId: string) => boolean; onAccepted?: (intakeId: string) => void } } = {}): Promise<Server> {
  const dir = lstatSync(dirname(socketPath));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || (dir.mode & 0o777) !== (o.groupAccess ? 0o710 : 0o700))
    throw new AccessError("access_socket_directory_not_private");
  if (existsSync(socketPath)) { if (!lstatSync(socketPath).isSocket()) throw new AccessError("access_socket_path_occupied"); unlinkSync(socketPath); }
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      // T-2 (Fable R-2/P-3): PUT /access/media/upload/<uploadId>, the envelope in a header (body hash over {uploadId, size,
      // contentType}), the audio streamed straight to the org's media store. Nothing else accepts a non-JSON body.
      // IMAGES-V1 I1: GET /access/image/<imageId>: the bytes as image/jpeg, nosniff, never cached.
      const img = /^\/access\/image\/(img_[a-f0-9]{32})$/.exec(req.url ?? "");
      if (img && req.method === "GET") {
        if (!o.imageGet) throw new AccessError("access_route");
        let s: Signed<{ imageId: string }>;
        try { s = JSON.parse(Buffer.from(String(req.headers["x-kapelle-envelope"] ?? ""), "base64url").toString("utf8")); } catch { throw new AccessError("access_envelope_malformed"); }
        if (!(s?.envelope?.action === "image.read" && s.body?.imageId === img[1])) throw new AccessError("access_wrong_audience");
        const member = access.routine(s.envelope, s.signature, s.body);
        const r = await o.imageGet(img[1], member);
        res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(r.data.length), "x-content-type-options": "nosniff", "cache-control": "private, no-store",
          "x-kapelle-sha256": r.sha256 });
        return res.end(r.data);
      }
      // LIBRARY L1: GET /access/drive/image/<sha256>: a drive image's normalized bytes, the chat image GET's shape.
      const dimg = /^\/access\/drive\/image\/([a-f0-9]{64})$/.exec(req.url ?? "");
      if (dimg && req.method === "GET") {
        if (!o.driveGet) throw new AccessError("access_route");
        let s: Signed<{ sha256: string }>;
        try { s = JSON.parse(Buffer.from(String(req.headers["x-kapelle-envelope"] ?? ""), "base64url").toString("utf8")); } catch { throw new AccessError("access_envelope_malformed"); }
        if (!(s?.envelope?.action === "files.image.read" && s.body?.sha256 === dimg[1])) throw new AccessError("access_wrong_audience");
        const member = access.routine(s.envelope, s.signature, s.body);
        const r = await o.driveGet(dimg[1], member);
        res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(r.data.length), "x-content-type-options": "nosniff", "cache-control": "private, no-store",
          "x-kapelle-sha256": r.sha256 });
        return res.end(r.data);
      }
      // LIBRARY L2: GET /access/public/file/<sha256> under a SERVICE envelope (files.public.read). Status carries the state.
      const pf = /^\/access\/public\/file\/([a-f0-9]{64})$/.exec(req.url ?? "");
      if (pf && req.method === "GET") {
        if (!o.publicFileGet) throw new AccessError("access_route");
        let s: Signed<{ sha256: string }>;
        try { s = JSON.parse(Buffer.from(String(req.headers["x-kapelle-envelope"] ?? ""), "base64url").toString("utf8")); } catch { throw new AccessError("access_envelope_malformed"); }
        if (!(s?.envelope?.action === "files.public.read" && s.body?.sha256 === pf[1])) throw new AccessError("access_wrong_audience");
        access.publicFileRead(s.envelope, s.signature, s.body);
        const r = await o.publicFileGet(pf[1]);
        if (r.status !== 200) return send(r.status, { ok: false, error: r.status === 410 ? "files_unpublished" : r.status === 500 ? "files_quarantined" : "files_not_public" });
        res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(r.data.length), "x-kapelle-sha256": pf[1] });
        return res.end(r.data);
      }
      // Package E (Fable E-11): GET /access/chat/preview?conversationId&artifactId&version: one version's stored preview HTML,
      // under the EXISTING routine action chat.artifact.preview (ownership checked by the runtime exactly as the POST path).
      const pv = /^\/access\/chat\/preview\?conversationId=(conv_[a-f0-9]{32})&artifactId=(art_[a-f0-9]{32})&version=([1-9][0-9]{0,4})$/.exec(req.url ?? "");
      if (pv && req.method === "GET") {
        if (!o.previewGet) throw new AccessError("access_route");
        let s: Signed<{ conversationId: string; artifactId: string; version: number }>;
        try { s = JSON.parse(Buffer.from(String(req.headers["x-kapelle-envelope"] ?? ""), "base64url").toString("utf8")); } catch { throw new AccessError("access_envelope_malformed"); }
        if (!(s?.envelope?.action === "chat.artifact.preview" && s.body?.conversationId === pv[1] && s.body?.artifactId === pv[2] && s.body?.version === Number(pv[3])))
          throw new AccessError("access_wrong_audience");
        const member = access.routine(s.envelope, s.signature, s.body);
        const html = Buffer.from(await o.previewGet(s.body, member), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": String(html.length), "x-content-type-options": "nosniff", "cache-control": "private, no-store" });
        return res.end(html);
      }
      // IMAGES-V1 I1: the same streamed PUT carries image tickets (im_) as well as audio (up_); the runtime dispatches by prefix.
      const up = /^\/access\/media\/upload\/((?:up|im)_[a-f0-9]{32})$/.exec(req.url ?? "");
      if (up && req.method === "PUT") {
        if (!o.mediaPut) throw new AccessError("access_route");
        let s: Signed<{ uploadId: string; size: number; contentType: string }>;
        try { s = JSON.parse(Buffer.from(String(req.headers["x-kapelle-envelope"] ?? ""), "base64url").toString("utf8")); } catch { throw new AccessError("access_envelope_malformed"); }
        const meta = { size: Number(req.headers["content-length"]), contentType: String(req.headers["content-type"] ?? "") };
        if (!(s?.envelope?.action === "media.upload" && s.body?.uploadId === up[1] && s.body.size === meta.size && s.body.contentType === meta.contentType)) throw new AccessError("access_wrong_audience");
        const member = access.routine(s.envelope, s.signature, s.body);
        return send(200, { ok: true, ...(await o.mediaPut(up[1], member, req, meta) as object) });
      }
      if (req.method !== "POST") return send(405, { ok: false, error: "access_method" });
      const p = await json(req);
      switch (req.url) {
        case "/access/lookup": { const s = p as Signed<{ email: string }>; return send(200, { ok: true, ...access.lookupMember(s.envelope, s.signature, s.body) }); }
        case "/access/receipt/failed": { const s = p as Signed<any>; return send(200, { ok: true, ...access.receiptFailed(s.envelope, s.signature, s.body) }); }
        case "/access/routine": {
          const s = p as Signed, member = access.routine(s.envelope, s.signature, s.body), h = o.routines?.[s.envelope.action];
          return send(200, { ok: true, member, result: h ? await h(s.body, member) : null });
        }
        case "/access/challenge": { const s = p as Signed<any>; await o.beforeChallenge?.(s?.body?.action); return send(200, { ok: true, ...access.mintChallenge(s.envelope, s.signature, s.body) }); }
        case "/access/act": {
          const s = p as Signed<any>, z = access.authorize(s.envelope, s.signature, s.body);
          const result = s.body.action === "member.invite" ? access.invite(z, s.body.body)
            : s.body.action === "member.remove" ? access.removeMember(z, s.body.body)
            : o.actions?.[s.body.action] ? await o.actions[s.body.action](s.body.body, z) : (() => { throw new AccessError("access_action_not_installed"); })();
          // Option A control 4: who gets a fixed-template receipt (the hub mails it; it never reaches the browser).
          return send(200, { ok: true, authorization: z, result, receipt: access.receiptFor(z) });
        }
        case "/access/invite/info": return send(200, { ok: true, ...access.inviteInfo(p.token) });
        // Option A: accepting the email-link invitation admits the member (no passkey); the hub then opens their session.
        case "/access/invite/accept": return send(200, { ok: true, ...access.acceptInvite(p.token) });
        // Step 4 intake: the hub forwards the RAW signed bytes; the runtime re-verifies and commits before the hub acks.
        case "/intake/email": {
          if (!o.intake) throw new AccessError("access_route");
          const inst = String(p.installationId);
          const r = o.intake.intake.providerOf(inst) === "resend"
            ? await o.intake.intake.receiveResend(inst, p.headers ?? {}, String(p.body), o.intake.memberActive)
            : o.intake.intake.receive(inst, p.headers ?? {}, String(p.body), o.intake.memberActive);
          // After the commit (the hub acks now): a newly accepted intake may trigger the shadow member-reply path.
          if (r.state === "accepted" && !r.replayed && o.intake.onAccepted) { const cb = o.intake.onAccepted; setImmediate(() => cb(r.intakeId)); }
          return send(200, { ok: true, ...r });
        }
        default: return send(404, { ok: false, error: "access_route" });
      }
    } catch (e) {
      // T-2: a refused upload's unread body is discarded (never stored) BEFORE answering, so the hub reads this answer instead of
      // a broken pipe. Bounded by the hub's size cap and idle timeout (and 60 s here).
      if (req.method === "PUT" && !req.readableEnded) await new Promise<void>((r) => { const t = setTimeout(r, 60_000); const done = () => { clearTimeout(t); r(); };
        req.once("end", done); req.once("close", done); req.once("error", done); req.resume(); });
      const reason = e instanceof AccessError || e instanceof WebAuthnError || e instanceof IntakeError ? e.reason : e instanceof TranscriptionRefused ? e.label : "access_internal_error";
      // Fable B3 F-1: a transient intake content-fetch failure is 503 so the provider redelivers; definite refusals stay 403.
      send(reason === "access_internal_error" ? 500 : e instanceof IntakeError && isRetryableIntakeLabel(reason) ? 503 : 403, { ok: false, error: reason });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, o.groupAccess ? 0o660 : 0o600);
  return server;
}
