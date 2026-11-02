// The Resend send client, shared (newsletter slice 2, Fable plan ruling 2: a MOVE, not a second copy). Moved from
// src/hub/auth-mail.ts unchanged in behaviour: exactly one JSON POST to the pinned https://api.resend.com/emails, the bearer
// key read AT USE from an owner-only file, redirects refused, a deadline, a bounded response, an Idempotency-Key, fixed
// labels (mail_http_<status>[:type=<resend error name>]) - never the provider's message, never the content. Two callers:
// the hub's fixed-template port (B2: sign-in, invite, receipts; no model content ever) and the org runtime's newsletter TEST
// sender (its own key copy). `sent` on an error says whether the message MAY have left (transport failure, timeout, 5xx,
// a 200 without an id): the caller counts that as sent; a definite 4xx never left.
import { closeSync, fstatSync, lstatSync, openSync, readSync, constants } from "node:fs";

export class MailError extends Error { constructor(readonly label: string, readonly sent = false) { super(label); this.name = "MailError"; } }
export const RESEND_SEND_URL = "https://api.resend.com/emails";
export type MailFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal }) => Promise<Response>;
/** One line, no control characters, bounded: header-injection-safe for display names and subjects. */
export const line = (s: string, max = 120) => String(s).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Owner-only regular file (not a link), <= 4 KiB, one token. Refusals name no content. */
export function readMailKey(path: string) {
  const ls = lstatSync(path);
  if (!ls.isFile() || ls.isSymbolicLink()) throw new MailError("mail_key_not_regular_file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if ((st.mode & 0o077) !== 0) throw new MailError("mail_key_not_private");
    if (st.size < 8 || st.size > 4096) throw new MailError("mail_key_invalid");
    const buf = Buffer.alloc(st.size); readSync(fd, buf, 0, st.size, 0);
    const key = buf.toString("utf8").trim();
    if (!/^re_[A-Za-z0-9_]{8,200}$/.test(key)) throw new MailError("mail_key_invalid");
    return key;
  } finally { closeSync(fd); }
}
export const validFrom = (from: string) => /^[^<>@]{0,100}<[^<>@\s]+@[^<>@\s]+\.[a-z]{2,}>$|^[^<>@\s]+@[^<>@\s]+\.[a-z]{2,}$/i.test(from);
/** `replyTo` (Fable S3-b N-1): release-path newsletter tests carry the broadcast's Reply-To, so a test differs from the real
 *  send only by the declared unsubscribe substitution. */
export type ResendMessage = { to: string; subject: string; text: string; html?: string; replyTo?: string; idempotencyKey: string };
/** The client. `from` is a verified sender at Resend, e.g. "EXNA <noreply@exna.example.org>". */
export function resendClient(o: { from: string; apiKeyFile: string; fetch?: MailFetch; timeoutMs?: number }) {
  const from = line(o.from, 200);
  if (!validFrom(from)) throw new MailError("mail_from_invalid");
  const doFetch = o.fetch ?? (fetch as unknown as MailFetch);
  return {
    async send(m: ResendMessage): Promise<{ id: string }> {
      if (process.env.NODE_USE_ENV_PROXY) throw new MailError("mail_ambient_proxy_refused");
      if (!/^[^@\s<>]+@[^@\s<>]+$/.test(m.to)) throw new MailError("mail_to_invalid");
      if (m.replyTo !== undefined && !validFrom(line(m.replyTo, 320))) throw new MailError("mail_reply_to_invalid");
      const key = readMailKey(o.apiKeyFile);
      const body = JSON.stringify({ from, to: [m.to], subject: line(m.subject, 200), text: m.text, ...(m.html !== undefined ? { html: m.html } : {}),
        ...(m.replyTo !== undefined ? { reply_to: line(m.replyTo, 320) } : {}) });
      let res: Response;
      try {
        res = await doFetch(RESEND_SEND_URL, { method: "POST", redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
          headers: { "content-type": "application/json", authorization: "Bearer " + key, "idempotency-key": m.idempotencyKey }, body });
      } catch { throw new MailError("mail_transport_failed", true); }
      let parsed: any = null;
      try { const r = res.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
        if (r) for (;;) { const p = await r.read(); if (p.done) break; size += p.value.length; if (size > 8192) { await r.cancel(); break; } chunks.push(p.value); }
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { parsed = null; }
      if (res.status === 200 && typeof parsed?.id === "string" && /^[A-Za-z0-9-]{1,100}$/.test(parsed.id)) return { id: parsed.id };
      const base = res.status >= 400 && res.status < 600 ? `mail_http_${res.status}` : "mail_http_unexpected";
      const type = typeof parsed?.name === "string" && /^[a-z_]{3,40}$/.test(parsed.name) ? `:type=${parsed.name}` : "";
      throw new MailError(base + type, !(res.status >= 400 && res.status < 500));
    },
  };
}
