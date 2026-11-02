// Lean runtime (option 3): the shared hub as a service, from an install config. The hub knows each org ONLY by its
// access socket (never the Ops socket), its per-org envelope signing key file and origin, plus the email-ingress
// installations pinned to one org each. Mail transport in this build is a local SPOOL directory (dev/testing: login and
// invite links are written as private files); a real sender is a later, separately reviewed adapter.
import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Hub, type Mailer } from "./hub.js";
import { authMailMessage, readMailKey, resendSendPort, MailError, type AuthMailPort } from "./auth-mail.js";
import { assert } from "../validation.js";

const abs = z.string().min(2).max(1000).refine((p) => p.startsWith("/") && resolve(p) === p && !p.includes("/Dropbox/"), "absolute local path (no Dropbox)");
export const hubConfigSchema = z.object({
  contract: z.literal("kapelle.hub/v1"),
  listen: z.object({ host: z.literal("127.0.0.1"), port: z.number().int().min(0).max(65535) }).strict(),
  mailSpool: abs,
  orgs: z.array(z.object({ orgId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), installationId: z.string().regex(/^[0-9a-f-]{36}$/), accessSocket: abs,
    kid: z.string().regex(/^[A-Za-z0-9_-]{2,64}$/), keyFile: abs, origin: z.string().regex(/^https:\/\//) }).strict()).min(1).max(200),
  // secretFile is optional and ABSENT in production (Fable deploy R-1): the hub then holds no webhook secret.
  ingress: z.array(z.object({ installationId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/), orgId: z.string(), secretFile: abs.optional(), provider: z.enum(["fake", "resend"]).default("fake") }).strict()).max(400),
  // B2: sign-in and invite links by email through Resend (fixed templates only). Absent: links go to the spool (development).
  mail: z.object({ provider: z.literal("resend"), from: z.string().min(3).max(200), apiKeyFile: abs }).strict().optional(),
  // Org display names for the auth mail (falls back to the org id).
  labels: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), z.string().min(1).max(120)).optional(),
  // LIBRARY L2 (Fable R-1): the dedicated host for published shared-drive images. Requests for it reach ONLY the files route.
  filesHost: z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/).max(253).optional(),
}).strict();

export function spoolMailer(dir: string): Mailer {
  const st = lstatSync(dir);
  assert(st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) === 0, "hub_mail_spool_not_private");
  return (m, done) => {
    try { const f = join(dir, `${new Date().toISOString().replace(/[:.]/g, "")}-${randomUUID()}.json`); writeFileSync(f, JSON.stringify(m), { mode: 0o600, flag: "wx" }); chmodSync(f, 0o600); }
    catch { done?.("mail_spool_write_failed"); return; }
    done?.(null);
  };
}
const secret = (p: string) => { const st = lstatSync(p); assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0, "hub_secret_file_invalid"); return readFileSync(p, "utf8").trim(); };

/** A Mailer over an AuthMailPort: fire-and-forget (the hub already answered the request identically for members and
 *  non-members), counters and the last fixed label only; never the link. */
export function portMailer(port: AuthMailPort, labels: Record<string, string> = {}) {
  const stats = { sent: 0, failed: 0, lastError: null as string | null };
  const mailer: Mailer = (m, done) => { void port.send(authMailMessage({ ...m, orgLabel: labels[m.orgId] ?? m.orgId }))
    .then(() => { stats.sent++; done?.(null); }, (e) => { stats.failed++; stats.lastError = e instanceof MailError ? e.label : "mail_error"; done?.(stats.lastError); }); };
  return { mailer, stats };
}

/** Fable EXNA-PROD mail ruling C-2: the mail counters as ONE content-free journald line (counts + a fixed label; never an
 *  address, link or token), hourly and at shutdown, so Ops can compare them with the provider's dashboard. `null` stats
 *  (spool / injected mailer) log nothing. Counters reset on restart: the check sums lines across restarts. */
export function mailCountLine(stats: { sent: number; failed: number; lastError: string | null } | null) {
  if (!stats) return null;
  const lastError = stats.lastError === null ? null : /^[a-z][a-z0-9_:=.,-]{1,80}$/.test(stats.lastError) ? stats.lastError : "mail_error";
  return JSON.stringify({ mail: { sent: stats.sent, failed: stats.failed, lastError } });
}
export function startMailCountLog(stats: Parameters<typeof mailCountLine>[0], log: (line: string) => void = (l) => console.log(l), everyMs = 3_600_000) {
  const emit = () => { const l = mailCountLine(stats); if (l) log(l); };
  const t = setInterval(emit, everyMs); t.unref();
  return { emit, stop: () => { clearInterval(t); emit(); } };
}

export async function openHub(raw: unknown, o: { mailer?: Mailer; mailPort?: AuthMailPort } = {}) {
  const c = hubConfigSchema.parse(raw);
  // Mail: an injected Mailer (tests) wins; else a configured port (Resend, or an injected fake port); else the spool.
  const pm = !o.mailer && (o.mailPort || c.mail) ? portMailer(o.mailPort ?? resendSendPort({ from: c.mail!.from, apiKeyFile: c.mail!.apiKeyFile }), c.labels ?? {}) : null;
  if (c.mail && !o.mailPort) readMailKey(c.mail.apiKeyFile); // fail at start on a bad key file, not on the first sign-in
  for (const i of c.ingress) assert(c.orgs.some((x) => x.orgId === i.orgId), "hub_ingress_unknown_org");
  const hub = new Hub(c.orgs.map((x) => ({ orgId: x.orgId, installationId: x.installationId, socketPath: x.accessSocket, kid: x.kid, keyFile: x.keyFile, origin: x.origin })),
    o.mailer ?? pm?.mailer ?? spoolMailer(c.mailSpool), () => Date.now(), c.ingress.map((i) => ({ installationId: i.installationId, orgId: i.orgId, secret: i.secretFile ? secret(i.secretFile) : null, provider: i.provider })), { filesHost: c.filesHost ?? null });
  const server = await hub.listen(c.listen.port, c.listen.host);
  return { hub, server, port: (server.address() as { port: number }).port, mail: pm?.stats ?? null, close: () => new Promise<void>((r) => server.close(() => r())) };
}
