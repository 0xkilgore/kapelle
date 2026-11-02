// Newsletter slice 3, S3-c (Fable answer 2): the FIXED-template incident mail from the org runtime to every active admin, for
// a release that needs a person (held, reconcile_required) and for restore_reconcile_required. The template is a constant;
// it carries the release id, a short content digest, the state, the label and the time ONLY (never the slug or subject:
// both derive from model text). Idempotency-Key = kapelle-nl-incident-<releaseId>-<state>, one per admin (suffix: the admin's
// member id), so each transition mails once. A mail failure is a label on the effect row (or the meta for a restore), never a
// retry loop: the row is marked BEFORE the send, so a crash mid-send never mails twice.
import type { SqliteAuthority } from "../../service/sqlite-authority.js";
import { MailError, type ResendMessage } from "../../mail/resend-send.js";
import { NEWSLETTER_REASONS } from "./labels.js";

export const INCIDENT_STATES = ["held", "reconcile_required"] as const;
const known = new Set<string>(NEWSLETTER_REASONS);

/** The whole template. Every value is an id, a hex digest, a fixed state, a fixed label or an ISO time. */
export function incidentMessage(i: { releaseId: string; digest: string | null; state: string; label: string | null; at: string }) {
  const lines = ["A newsletter release needs a person before anything else is sent.", "",
    `Release: ${i.releaseId}`, `Content digest: ${i.digest ? i.digest.replace(/^sha256:/, "").slice(0, 12) : "none"}`,
    `State: ${i.state}`, `Reason: ${i.label && known.has(i.label) ? i.label : "unlabeled"}`, `Time: ${i.at}`, "",
    "Nothing is resent automatically. Ops reconciles it from the runtime status."];
  return { subject: "Kapelle: a newsletter release needs attention", text: lines.join("\n") + "\n" };
}

export async function sendIncidents(a: SqliteAuthority, o: { send: ((m: ResendMessage) => Promise<{ id: string }>) | null; restoreReconcile: () => boolean;
  now: () => string }) {
  const rows = a.read(() => a.db.prepare(`SELECT e.release_id, e.state, e.label, r.digest FROM newsletter_effects e JOIN newsletter_releases r ON r.id=e.release_id
    WHERE e.state IN (${INCIDENT_STATES.map((s) => `'${s}'`).join(",")}) AND (e.incident_mail IS NULL OR e.incident_mail NOT LIKE e.state || ':%')`).all() as
    { release_id: string; state: string; label: string | null; digest: string }[]);
  const due: { key: string; mark: (v: string) => void; i: Parameters<typeof incidentMessage>[0] }[] = rows.map((r) => ({ key: `${r.release_id}-${r.state}`,
    i: { releaseId: r.release_id, digest: r.digest, state: r.state, label: r.label, at: o.now() },
    mark: (v: string) => a.write(() => a.db.prepare("UPDATE newsletter_effects SET incident_mail=? WHERE release_id=?").run(`${r.state}:${v}`, r.release_id)) }));
  const meta = (k: string) => a.read(() => (a.db.prepare("SELECT value FROM newsletter_meta WHERE key=?").get(k) as { value: string } | undefined)?.value ?? null);
  if (o.restoreReconcile() && !meta("restoreIncidentMail")) due.push({ key: "restore-restore_reconcile_required",
    i: { releaseId: "restore", digest: null, state: "restore_reconcile_required", label: "newsletter_restore_reconcile", at: o.now() },
    mark: (v) => a.write(() => a.db.prepare("INSERT INTO newsletter_meta(key,value) VALUES ('restoreIncidentMail',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(v)) });
  if (!due.length) return 0;
  const admins = a.read(() => a.db.prepare("SELECT member_id, email FROM access_members WHERE role='admin' AND status='active' ORDER BY member_id").all() as { member_id: string; email: string }[]);
  for (const d of due) {
    d.mark("sending"); // before the send: a crash here leaves "sending", which is never mailed again
    if (!o.send) { d.mark("mail_not_configured"); continue; }
    if (!admins.length) { d.mark("no_active_admin"); continue; }
    const m = incidentMessage(d.i), failed: string[] = [];
    for (const ad of admins) {
      try { await o.send({ to: ad.email, subject: m.subject, text: m.text, idempotencyKey: `kapelle-nl-incident-${d.key}-${ad.member_id}` }); }
      catch (e) { failed.push(e instanceof MailError ? e.label : "mail_transport_failed"); }
    }
    d.mark(failed.length ? `failed:${failed.length}/${admins.length}:${failed[0]}` : `sent:${admins.length}`);
  }
  return due.length;
}
