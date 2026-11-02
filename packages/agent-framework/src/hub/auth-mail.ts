// B2: the hub's ONLY outbound mail: fixed sign-in, invite and (option A) approval-receipt templates (no model content, ever), sent
// through a port. The Resend client posts exactly one JSON request to the pinned https://api.resend.com/emails, bearer key from
// an owner-only file, redirects refused, a deadline, a bounded response, an Idempotency-Key, and returns fixed labels
// (mail_http_<status>[:type=<resend error name>]) - never the provider's message, never the link. A link is a credential: it is
// never logged and never returned; the hub keeps only counters and the last label.
import { createHash } from "node:crypto";
import { MailError, line, resendClient, type MailFetch } from "../mail/resend-send.js";
// The client moved to src/mail/resend-send.ts (newsletter slice 2); re-exported so the hub's callers are unchanged.
export { MailError, readMailKey, RESEND_SEND_URL, type MailFetch } from "../mail/resend-send.js";

export type AuthMail = { orgId: string; orgLabel: string; to: string; kind: "login" | "invite" | "receipt"; link: string; inviter?: string | null; role?: string | null;
  receipt?: { actor: string; action: string; artifactDigest: string | null; operationId: string; at: string; authn: string } };
export type MailMessage = { to: string; subject: string; text: string; idempotencyKey: string };
export interface AuthMailPort { send(m: MailMessage): Promise<void> }

const ROLE: Record<string, string> = { admin: "an administrator", reviewer: "a reviewer", contributor: "a contributor" };

const DID: Record<string, [string, string]> = { "proposal.approve": ["approved a plan", "Plan"], "notes.approve": ["approved meeting notes for members", "Notes"],
  "task.adopt": ["adopted a submission as a Task", "Item"], "transcript.start": ["started a transcription of a recording", "Audio"],
  "transcript.accept": ["accepted a transcript", "Audio"] };
const AUTHN: Record<string, string> = { "email-session": "signed in with an email link", "ops-socket": "by Ops on the server", totp: "with an authenticator app", passkey: "with a passkey" };
/** The fixed templates. Every variable is a server-held fact (org label, inviter's or actor's verified email, role, action,
 *  digest, operation id, time, the link). */
export function authMailText(m: AuthMail): { subject: string; text: string } {
  const org = line(m.orgLabel || m.orgId);
  if (m.kind === "receipt") {
    // Option A control 4: detection for a compromised mailbox or session. No model text, no document content.
    const r = m.receipt!, [did, what] = DID[r.action] ?? ["did something", "Item"], self = line(r.actor, 200).toLowerCase() === line(m.to, 200).toLowerCase();
    const who = self ? "You" : line(r.actor, 200), digest = r.artifactDigest && /^sha256:[a-f0-9]{64}$/.test(r.artifactDigest) ? r.artifactDigest : null;
    return { subject: `${org}: ${self ? "you" : who} ${did}`, text: [
      `${who} ${did} in ${org}.`, "",
      ...(digest ? [`${what}: ${digest}`] : []), `Reference: ${line(r.operationId, 140)}`, `When: ${line(r.at, 40)} (UTC)`, `How: ${AUTHN[r.authn] ?? "signed in"}`, "",
      `Open ${org}: ${m.link}`, "",
      self ? "If this wasn't you, someone may be able to read this mailbox. Tell your administrator now so they can remove access."
        : "If this looks wrong, check with them, or ask your administrator to remove their access."].join("\n") };
  }
  if (m.kind === "login") return { subject: `Your sign-in link for ${org}`, text: [
    `Use this link to sign in to ${org}. It works once and expires in 15 minutes.`, "", m.link, "",
    "If you didn't ask to sign in, ignore this email. Nothing happens unless the link is used."].join("\n") };
  const inviter = m.inviter ? line(m.inviter, 200) : "An administrator";
  return { subject: `${inviter} invited you to ${org}`, text: [
    `${inviter} invited you to ${org} as ${ROLE[m.role ?? ""] ?? "a member"}.`, "",
    "Open this link to join. It signs you in; next time you sign in with a link sent to this address (no password):", "", m.link, "",
    "The link works once and expires in 7 days. Didn't expect this? Ignore this email. Nothing happens unless the link is used."].join("\n") };
}
export const authMailMessage = (m: AuthMail): MailMessage => ({ to: m.to, ...authMailText(m),
  // Same link -> same key (a retried send is deduplicated by the provider for 24 h); the key does not reveal the link.
  // A receipt's link is the org page, so its key also binds the operation (one receipt per approval and recipient).
  idempotencyKey: "kapelle-auth-" + createHash("sha256").update(`${m.orgId}\0${m.kind}\0${m.to}\0${m.link}${m.kind === "receipt" ? "\0" + m.receipt?.operationId : ""}`).digest("hex").slice(0, 48) });

/** The hub's fixed-template port over the shared client (B2: the hub never sends anything else). */
export function resendSendPort(o: { from: string; apiKeyFile: string; fetch?: MailFetch; timeoutMs?: number }): AuthMailPort {
  const c = resendClient(o);
  return { async send(m) { await c.send({ to: m.to, subject: m.subject, text: m.text, idempotencyKey: m.idempotencyKey }); } };
}

/** For tests and pre-launch: records what WOULD be sent; never prints a link. */
export function fakeMailPort(sink: MailMessage[] = []): AuthMailPort & { sink: MailMessage[] } {
  return { sink, async send(m) { sink.push(m); } };
}
