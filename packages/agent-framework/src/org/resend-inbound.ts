// Lean runtime build item (c): Resend inbound email, per Resend's documented contract (no account, no calls here).
//
// Resend's `email.received` webhook carries METADATA only (ids, from/to/cc/bcc, received_for, subject, attachment
// metadata); the body, headers and attachment bytes come from the Receiving API (GET /emails/receiving/{id},
// GET /emails/receiving/{id}/attachments + each attachment's signed, expiring download_url). Webhooks are signed with
// Svix: headers svix-id / svix-timestamp / svix-signature; signed content `${id}.${timestamp}.${rawBody}`;
// HMAC-SHA256 keyed with the base64-decoded part of the `whsec_` secret; header = space-separated `v1,<base64>` list.
// Sources: resend.com/docs/webhooks/emails/received, /docs/dashboard/receiving/get-email-content,
// /docs/api-reference/emails/{retrieve-received-email,list-received-email-attachments},
// /docs/dashboard/webhooks/verify-webhooks-requests; docs.svix.com/receiving/verifying-payloads/how-manual.
//
// The content fetch is a PORT. Tests use recorded fixtures shaped exactly like the documented responses; the real HTTPS
// client (bearer key, pinned api.resend.com, redirects refused, bounded bodies) is deliberately NOT implemented until an
// account/key and a reviewed adapter exist. MailParser is not needed on this path (the API returns text/html/headers);
// it would only be needed for Resend's optional raw-message download, which we don't use.
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { IntakeError } from "./intake.js";

const refuse = (ok: unknown, reason: string): void => { if (!ok) throw new IntakeError(reason); };

/** Svix verification (Resend webhooks). Throws a fixed IntakeError label; never echoes content. */
export function verifySvix(secret: string, h: { id?: string; timestamp?: string; signature?: string }, rawBody: string, nowMs: number, toleranceSec = 300) {
  refuse(typeof h.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(h.id) && typeof h.timestamp === "string" && /^\d{9,12}$/.test(h.timestamp) && typeof h.signature === "string" && h.signature.length <= 2048,
    "intake_signature_missing");
  refuse(Math.abs(nowMs / 1000 - Number(h.timestamp)) <= toleranceSec, "intake_signature_stale");
  refuse(/^whsec_[A-Za-z0-9+/=]{16,}$/.test(secret), "intake_secret_invalid");
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const want = Buffer.from(createHmac("sha256", key).update(`${h.id}.${h.timestamp}.${rawBody}`).digest("base64"));
  const ok = h.signature!.split(" ").some((s) => {
    const [version, sig] = s.split(",");
    if (version !== "v1" || !sig) return false;
    const got = Buffer.from(sig);
    return got.length === want.length && timingSafeEqual(got, want);
  });
  refuse(ok, "intake_signature_invalid");
}

const addr = z.string().max(998);
/** The documented `email.received` event (unknown extra fields tolerated; required ones strict). */
export const resendReceivedSchema = z.object({
  type: z.literal("email.received"), created_at: z.string(),
  data: z.object({
    email_id: z.string().regex(/^[A-Za-z0-9-]{8,64}$/), created_at: z.string(), message_id: z.string().max(998).nullable().optional(),
    subject: z.string().max(998).nullable().optional(), from: addr, to: z.array(addr).max(50), cc: z.array(addr).max(50).optional(), bcc: z.array(addr).max(50).optional(),
    received_for: z.array(addr).max(50).optional(),
    attachments: z.array(z.object({ id: z.string(), filename: z.string().max(255), content_type: z.string().max(255) }).passthrough()).max(50).optional(),
  }).passthrough(),
}).passthrough();
export type ResendReceived = z.infer<typeof resendReceivedSchema>;

/** Documented Receiving API shapes (only the fields we use). */
export type ResendReceivedEmail = { id: string; message_id?: string | null; subject?: string | null; text: string | null; html: string | null; headers: Record<string, string> };
export type ResendAttachment = { id: string; filename: string; size: number; content_type: string; download_url: string; expires_at: string };
export interface ResendContentPort {
  getReceived(emailId: string): Promise<ResendReceivedEmail>;
  listAttachments(emailId: string): Promise<ResendAttachment[]>;
  download(url: string, maxBytes: number): Promise<Buffer>;
}

/** Conservative HTML -> text for HTML-only messages (never rendered; scripts/styles dropped, tags stripped). Intake-side only:
 *  keep it out of any member-facing path (member replies refuse markup and links regardless). */
export function htmlToText(html: string) {
  return html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Envelope recipients: the address(es) Resend received FOR (forwarding) when present, else the delivered `to` list. */
export const resendRecipients = (d: ResendReceived["data"]) => (d.received_for && d.received_for.length ? d.received_for : d.to);

const TEXT_TYPES = ["text/plain", "text/markdown"];
/** Normalise a verified Resend event + fetched content into the runtime's intake payload (the provider-neutral shape). */
export async function resendToIntake(event: ResendReceived, port: ResendContentPort) {
  const d = event.data, email = await port.getReceived(d.email_id);
  refuse(email.id === d.email_id, "intake_content_mismatch");
  const text = (email.text ?? (email.html ? htmlToText(email.html) : "")).slice(0, 256 * 1024);
  const attachments: { filename: string; content_type: string; content: string }[] = [];
  for (const a of (await port.listAttachments(d.email_id)).slice(0, 10)) {
    const type = a.content_type.split(";")[0].trim().toLowerCase();
    // Only text attachments are fetched; others are recorded by name only (never downloaded).
    if (!TEXT_TYPES.includes(type) || a.size > 256 * 1024) { attachments.push({ filename: a.filename, content_type: a.content_type, content: "" }); continue; }
    attachments.push({ filename: a.filename, content_type: a.content_type, content: (await port.download(a.download_url, 256 * 1024)).toString("base64") });
  }
  const headers = Object.fromEntries(Object.entries(email.headers ?? {}).slice(0, 200).map(([k, v]) => [k.toLowerCase().slice(0, 200), String(v).slice(0, 998)]));
  return { type: "email.received" as const, data: { email_id: d.email_id, message_id: email.message_id ?? d.message_id ?? "", from: d.from,
    to: resendRecipients(d), cc: d.cc ?? [], subject: (email.subject ?? d.subject ?? "").slice(0, 998), text, headers, attachments } };
}
