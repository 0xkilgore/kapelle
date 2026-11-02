// Newsletter slice 3: the synthetic-list qualification runner and its verifier (Ops QUALIFICATION-PLAN.md + Fable
// FABLE-REVIEW-NEWSLETTER-S3-QUAL F-1..F-5, N-1..N-4). The PRODUCTION code runs it: the broadcast connector
// (resendBroadcastPort), the audience reader (readAudience + AudienceCache), the F-7 executor over a throwaway SQLite
// authority, and the shared /emails client. The runner adds only guarded setup calls (a separate setup log) and the evidence.
// - F-2 / F-5 guards BEFORE any write: the segment listing holds exactly ONE segment, named kapelle-qual-synthetic, with the
//   given id; its contacts are exactly five, all `delivered+…@resend.dev` sinks or the owner's plus-addresses, with owner+q2
//   (Q4, observable) and owner+q5 (Q8, Q13) present and all subscribed; listField is segment_id or audience_id; Node 24.
// - Addresses are read on the Mac and never written: the report holds contact ids, broadcast ids, routes, status codes and
//   digests only (the verifier refuses any "@" in it). No key or value is printed.
// - Two phases: `run` (Q0-Q12, machine facts) and `finalize` (Q13 read + the owner's console facts: Q0/Q4/Q10 screenshot
//   shas, Q4 receipt counts, Q8 From header), which writes the final report the verifier attests.
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { openSqliteDatabase, SqliteAuthority } from "../../service/sqlite-authority.js";
import { readMailKey, resendClient, type MailFetch } from "../../mail/resend-send.js";
import { AudienceCache, readAudience, resendBroadcastPort, type ResendFetch } from "./resend-broadcast.js";
import { NewsletterExecutor, Crash } from "./executor.js";
import { NewsletterReleases, recipientsDigest, UNSUB_TOKEN } from "./release.js";
import { OrgAccess } from "../../access/org-access.js";

export const QUAL_CONTRACT = "kapelle.newsletter-qualification/v1";
export const QUAL_SEGMENT = "kapelle-qual-synthetic";
/** The connector file the qualification attests (resend-broadcast.ts at the accepted slice-3 head 1874b31a). A test pins it
 *  to the file, so any connector change fails the suite until it is re-pinned, which means re-qualifying. */
export const RESEND_CONNECTOR_SHA = "sha256:349a2a873f22efc909b0ef9a76a382d229261c54859868f9b0b20b031b85ab34";
export const CONNECTOR_PATHS = ["POST /broadcasts", "GET /broadcasts/{id}", "POST /broadcasts/{id}/send", "GET /broadcasts", "GET /audiences/{id}/contacts"] as const;
const ORIGIN = "https://api.resend.com";
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const sha = (s: string | Buffer) => "sha256:" + createHash("sha256").update(s).digest("hex");
export class QualStop extends Error { constructor(readonly label: string) { super(label); } }
const stop = (label: string): never => { throw new QualStop(label); };

/** Routes only: ids and query strings never reach the log. */
export const routeOf = (method: string, url: string) => `${method} ${new URL(url).pathname
  .replace(/^\/(broadcasts|audiences|contacts|emails)\/[^/]+/, "/$1/{id}").replace(/\/contacts\/[^/]+$/, "/contacts/{id}")}`;
type LogRow = { phase: "connector" | "setup" | "emails"; op: string; route: string; status: number | "threw" };

export type QualInput = { keyFile: string; segmentId: string; listField: string; from: string; replyTo: string; owner: string;
  fetch: ResendFetch & MailFetch; stateDir: string; head: string; connectorSha: string; mode: "dry-run" | "live";
  pollMs?: number; pollTimes?: number; now?: () => string };

/** F-2: a resend.dev sink, or the owner's own address with a +tag. */
export function allowedAddress(email: string, owner: string) {
  const o = /^([^+@\s]+)@([^@\s]+)$/.exec(owner.toLowerCase()), e = email.toLowerCase();
  if (/^delivered\+[a-z0-9-]{1,40}@resend\.dev$/.test(e)) return true;
  return !!o && new RegExp(`^${o[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\+[a-z0-9-]{1,40}@${o[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(e);
}
const plus = (owner: string, tag: string) => { const [l, d] = owner.toLowerCase().split("@"); return `${l}+${tag}@${d}`; };

export async function runQualification(i: QualInput) {
  const now = i.now ?? (() => new Date().toISOString()), runId = "qual-" + randomUUID().replaceAll("-", "").slice(0, 16);
  // ---- F-5 guards (no call yet) ----
  if (i.listField !== "segment_id" && i.listField !== "audience_id") stop("qual_list_field_invalid");
  if (!ID.test(i.segmentId)) stop("qual_segment_id_invalid");
  if (!/^24\./.test(process.versions.node)) stop("qual_node_not_24");
  if (!/^[^+@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(i.owner)) stop("qual_owner_invalid");
  if (i.mode === "live" && i.connectorSha !== RESEND_CONNECTOR_SHA) stop("qual_connector_not_pinned");
  readMailKey(i.keyFile); // the shape and mode checks; the value is never kept here
  const log: LogRow[] = [], ctx = { phase: "connector" as LogRow["phase"], op: "none", dropNextCreate: false };
  const tracked = (async (url: string, init: any) => {
    const row: LogRow = { phase: ctx.phase, op: ctx.op, route: routeOf(init.method, url), status: "threw" }; log.push(row);
    const res = await i.fetch(url, init); row.status = res.status;
    // Q7: the answer to ONE create is lost after the provider acted on it.
    if (ctx.dropNextCreate && row.route === "POST /broadcasts") { ctx.dropNextCreate = false; await res.arrayBuffer().catch(() => null); throw new TypeError("answer lost (qualification)"); }
    return res;
  }) as ResendFetch & MailFetch;
  const raw = async (method: string, path: string, body?: unknown) => {
    const prev = ctx.phase; ctx.phase = "setup";
    try {
      const res = await tracked(ORIGIN + path, { method, redirect: "error", signal: AbortSignal.timeout(20_000),
        headers: { authorization: "Bearer " + readMailKey(i.keyFile), accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}) } as never);
      let json: any = null; try { json = await res.json(); } catch { json = null; }
      return { status: res.status, json };
    } finally { ctx.phase = prev; }
  };
  const errName = (j: any) => typeof j?.name === "string" && /^[a-z_]{1,40}$/.test(j.name) ? j.name : null;

  // ---- Q0 (F-2): zero blast radius, read before any write ----
  const segs = await raw("GET", "/audiences");
  const segList = Array.isArray(segs.json?.data) ? segs.json.data : null;
  if (segs.status !== 200 || !segList) stop("qual_segments_unreadable");
  if (segList!.length === 0 && !segs.json.has_more) stop("qual_segments_none"); // Fable S3-q N-1: e.g. segments listed elsewhere
  if (segList!.length !== 1 || segs.json.has_more) stop("qual_blast_radius_segments");
  if (segList![0].id !== i.segmentId || segList![0].name !== QUAL_SEGMENT) stop("qual_segment_refused");
  const contacts: { id: string; email: string; unsubscribed: boolean; keys: string[] }[] = [];
  for (let after: string | null = null, page = 0; page < 10; page++) {
    const r = await raw("GET", `/audiences/${i.segmentId}/contacts?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (r.status !== 200 || !Array.isArray(r.json?.data)) stop("qual_contacts_unreadable");
    for (const c of r.json.data) { if (typeof c?.id !== "string" || !ID.test(c.id) || typeof c.email !== "string") stop("qual_contacts_unreadable");
      contacts.push({ id: c.id, email: c.email, unsubscribed: c.unsubscribed === true, keys: Object.keys(c).sort() }); after = c.id; }
    if (!r.json.has_more) break;
    if (page === 9) stop("qual_blast_radius_contacts");
  }
  if (contacts.length !== 5) stop("qual_blast_radius_contacts");
  if (!contacts.every((c) => allowedAddress(c.email, i.owner))) stop("qual_blast_radius_contacts");
  if (contacts.some((c) => c.unsubscribed)) stop("qual_contacts_not_fresh");
  const c2 = contacts.find((c) => c.email.toLowerCase() === plus(i.owner, "q2")), c5 = contacts.find((c) => c.email.toLowerCase() === plus(i.owner, "q5"));
  if (!c2 || !c5) stop("qual_owner_contacts_missing");
  const q0 = { segments: 1, segmentName: QUAL_SEGMENT, contacts: contacts.length, contactIds: contacts.map((c) => c.id).sort(), q2ContactId: c2!.id, q5ContactId: c5!.id,
    sinks: contacts.filter((c) => /@resend\.dev$/i.test(c.email)).length };
  const q9 = { contactFields: [...new Set(contacts.flatMap((c) => c.keys))].sort() };

  // ---- the production pieces over a throwaway authority ----
  const db = openSqliteDatabase(join(i.stateDir, "qualification.sqlite"), { create: true });
  const installationId = randomUUID();
  const a = new SqliteAuthority(db, { binding: "newsletter-qualification", authorityId: randomUUID(), driveId: randomUUID(), installationId }, { create: true });
  new OrgAccess(a, { orgId: "qualification", rpId: "localhost", origins: ["https://localhost"], label: "Qualification", totpKeyFile: null }, now); // its tables (the release facts read them)
  const cache = new AudienceCache(() => readAudience({ keyFile: i.keyFile, audienceId: i.segmentId, fetch: tracked }));
  const releases = new NewsletterReleases(a, { orgId: "qualification", installationId, approvers: [], releasesPerMonth: 31, recipients: () => cache.current(),
    sender: { from: i.from, replyTo: i.replyTo, listId: i.segmentId } }, now);
  releases.recordTransfer({ installationId, frozenAt: now(), attestedBy: "qualification" });
  let crashAt: string | null = null;
  const executor = (field: "segment_id" | "audience_id") => new NewsletterExecutor(a, { stateRoot: i.stateDir, releases, audience: cache, listId: i.segmentId,
    provider: resendBroadcastPort({ keyFile: i.keyFile, listId: i.segmentId, listField: field, fetch: tracked }),
    crash: (p) => { if (p === crashAt) { crashAt = null; throw new Crash(p); } } }, now);
  let n = 0;
  // Q1 attempts get the plan's names (kapelle:qual-q1-<field>-<ts>: the executor names a draft kapelle:<operationId>).
  const approve = async (opId?: string) => {
    n++; await cache.refresh();
    const body = `Kapelle newsletter qualification ${runId} #${n}. A synthetic test, not a newsletter.`;
    const r = releases.prepare({ slug: `${now().slice(0, 10)}-kapelle-qualification-${n}`, subject: `Kapelle qualification ${n}`, testSubject: `[TEST] Kapelle qualification ${n}`,
      from: i.from, replyTo: i.replyTo, html: `<p>${body}</p><p>Unsubscribe: ${UNSUB_TOKEN}</p>`, text: `${body}\n\nUnsubscribe: ${UNSUB_TOKEN}\n`,
      renderer: "kapelle.newsletter-renderer/v2", images: [], listId: i.segmentId });
    if (!r.recipientsKnown || r.recipientCount < 1) stop("qual_audience_unreadable");
    const op = opId ?? "op-qual-" + randomUUID(), at = now();
    a.write(() => { a.db.prepare("UPDATE newsletter_releases SET state='approved', operation_id=?, approved_at=? WHERE id=?").run(op, at, r.releaseId);
      a.db.prepare("INSERT INTO newsletter_effects(release_id,operation_id,approved_by,state,at) VALUES (?,?, 'qualification', 'approved', ?)").run(r.releaseId, op, at); });
    return { releaseId: r.releaseId, op };
  };
  const row = (id: string) => a.read(() => a.db.prepare("SELECT state, label, broadcast_id, recipient_count, post_send_recipients_sha FROM newsletter_effects WHERE release_id=?").get(id) as
    { state: string; label: string | null; broadcast_id: string | null; recipient_count: number | null; post_send_recipients_sha: string | null });
  const count = (op: string, route: string) => log.filter((l) => l.phase === "connector" && l.op === op && l.route === route).length;

  // ---- Q1 (+ R-2 single id) and the main release up to draft_known ----
  const q1: { attempts: { field: string; op: string; state: string; label: string | null }[]; accepted: string | null; echoedListId: boolean | null; audienceReadable: boolean } =
    { attempts: [], accepted: null, echoedListId: null, audienceReadable: false };
  let main: { releaseId: string; op: string } | null = null, field = i.listField as "segment_id" | "audience_id";
  for (const f of field === "segment_id" ? ["segment_id", "audience_id"] as const : ["audience_id"] as const) {
    const rel = await approve(`qual-q1-${f}-${now().replace(/\D/g, "").slice(0, 17)}`); q1.audienceReadable = cache.current() !== null;
    ctx.op = rel.op; crashAt = "after-draft-known";
    let out: { state: string; label: string | null };
    try { out = await executor(f).run(rel.releaseId); } catch (e) { if (!(e instanceof Crash)) throw e; out = { state: row(rel.releaseId).state, label: null }; }
    q1.attempts.push({ field: f, op: rel.op, ...out });
    if (out.state === "draft_known") { main = rel; field = f; q1.accepted = f; break; }
    if (out.label !== "newsletter_provider_refused") stop("qual_create_failed");
  }
  if (!main) stop("qual_list_field_refused");
  if (!q1.audienceReadable) stop("qual_single_id_unreadable"); // R-2: the contacts read must work with the SAME id
  const bid = row(main!.releaseId).broadcast_id!;
  ctx.op = main!.op;
  const back = await resendBroadcastPort({ keyFile: i.keyFile, listId: i.segmentId, listField: field, fetch: tracked }).getBroadcast(bid);
  q1.echoedListId = back?.listId === undefined ? null : back.listId === i.segmentId;
  const q2: { statuses: string[] } = { statuses: [] };
  const rawStatus = async () => { const r = await raw("GET", `/broadcasts/${bid}`); return typeof r.json?.status === "string" && /^[a-z_]{1,30}$/.test(r.json.status) ? r.json.status : "unreadable"; };
  q2.statuses.push(await rawStatus());

  // ---- Q4: unsubscribe q2 AFTER the draft exists, then send through the executor (Q5 fence, Q6 counts) ----
  const un = await raw("PATCH", `/audiences/${i.segmentId}/contacts/${c2!.id}`, { unsubscribed: true });
  if (un.status !== 200) stop("qual_setup_unsubscribe_failed");
  const before = await cache.refresh();
  if (!before || before.includes(c2!.id)) stop("qual_unsubscribe_not_visible");
  ctx.op = main!.op;
  const sent = await executor(field).run(main!.releaseId);
  const after = row(main!.releaseId);
  const q4 = { unsubscribedContactId: c2!.id, excludedBeforeSend: true, approvedCount: 5, eligibleAtSend: before!.length, state: sent.state };
  const q5 = { beforeSha: recipientsDigest(before!), afterSha: after.post_send_recipients_sha, equal: after.post_send_recipients_sha === recipientsDigest(before!), state: after.state, label: after.label };
  for (let k = 0; k < (i.pollTimes ?? 24); k++) {
    const s = await rawStatus(); if (s !== q2.statuses.at(-1)) q2.statuses.push(s);
    if (s === "sent") break;
    await new Promise((r) => setTimeout(r, i.pollMs ?? 5_000));
  }
  // Q6: per release (operationId); the deliberate second send is a SETUP call (outside the executor and the connector set).
  const again = await raw("POST", `/broadcasts/${bid}/send`, {});
  const q6 = { op: main!.op, createPosts: count(main!.op, "POST /broadcasts"), sendPosts: count(main!.op, "POST /broadcasts/{id}/send"),
    secondSend: { status: again.status, error: errName(again.json) } };

  // ---- Q11 (F-4): archive_pending is terminal: three more passes (kick, retry, restart) make no provider write ----
  const writesBefore = log.filter((l) => l.phase === "connector" && l.route.startsWith("POST")).length;
  ctx.op = "q11";
  await executor(field).run(main!.releaseId); await executor(field).run(main!.releaseId);
  const restarted = executor(field); await restarted.recover(); await restarted.run(main!.releaseId);
  const q11 = { passes: 3, providerWrites: log.filter((l) => l.phase === "connector" && l.route.startsWith("POST")).length - writesBefore,
    sendPosts: log.filter((l) => l.phase === "connector" && l.route === "POST /broadcasts/{id}/send").length, state: row(main!.releaseId).state,
    secondSendRefused: again.status >= 400 && again.status < 500 };

  // ---- Q3: listing order and pagination (three drafts, never sent; limit=1 walk is a setup read) ----
  ctx.op = "q3";
  const port = resendBroadcastPort({ keyFile: i.keyFile, listId: i.segmentId, listField: field, fetch: tracked });
  const made: string[] = [];
  for (let k = 1; k <= 3; k++) made.push((await port.createDraft({ name: `kapelle-qual:${runId}:q3-${k}`, subject: `Kapelle qualification listing ${k}`,
    html: "<p>listing</p>", text: "listing", from: i.from, replyTo: i.replyTo, listId: i.segmentId })).id);
  const walked: string[] = [], hasMore: boolean[] = [];
  for (let after: string | null = null, page = 0; page < 200; page++) {
    const r = await raw("GET", `/broadcasts?limit=1${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    if (r.status !== 200 || !Array.isArray(r.json?.data)) break;
    for (const b of r.json.data) if (typeof b?.id === "string") { walked.push(b.id); after = b.id; }
    hasMore.push(!!r.json.has_more); if (!r.json.has_more || !r.json.data.length) break;
  }
  const listed = await port.listBroadcasts();
  const pos = made.map((id) => walked.indexOf(id));
  const q3 = { created: made.length, eachOnce: made.every((id) => walked.filter((x) => x === id).length === 1), newestFirst: pos.every((p, k) => k === 0 || p < pos[k - 1]),
    oldestFirst: pos.every((p, k) => k === 0 || p > pos[k - 1]), pages: hasMore.length, lastHasMore: hasMore.at(-1) ?? null, connectorComplete: listed.complete,
    connectorFound: made.every((id) => listed.items.some((x) => x.id === id)),
    // Fable delta 4: the connector lists 100 per page, so its page cap cannot be hit live with a handful of drafts.
    pageCapIncomplete: "not exercised live; covered by the unit test (tests/newsletter-resend.test.ts)" };

  // ---- Q7: the create answer is lost; recover() adopts the draft by exact name (no second create); never sent ----
  const lost = await approve(); ctx.op = lost.op; ctx.dropNextCreate = true;
  const lostRun = await executor(field).run(lost.releaseId);
  const rec = await executor(field).recover();
  const q7 = { op: lost.op, afterRun: lostRun.state, afterRecover: row(lost.releaseId).state, settled: rec.settled, createPosts: count(lost.op, "POST /broadcasts"),
    sendPosts: count(lost.op, "POST /broadcasts/{id}/send") };

  // ---- Q8: a release-path test via /emails with the release key and From, to owner+q5 ----
  ctx.phase = "emails"; ctx.op = "q8";
  let q8: { status: number | "failed"; emailId: string | null; fromDomain: string; label: string | null };
  const fromDomain = (/@([^>\s]+)>?$/.exec(i.from)?.[1] ?? "").toLowerCase();
  try {
    const m = await resendClient({ from: i.from, apiKeyFile: i.keyFile, fetch: tracked }).send({ to: c5!.email, subject: "[TEST] Kapelle qualification (release path)",
      text: `Kapelle newsletter qualification ${runId}: the release-path test.\n`, replyTo: i.replyTo, idempotencyKey: `kapelle-qual-${runId}-q8` });
    q8 = { status: 200, emailId: m.id, fromDomain, label: null };
  } catch (e) { q8 = { status: "failed", emailId: null, fromDomain, label: e instanceof Error ? e.message.slice(0, 80) : "mail_failed" }; }
  ctx.phase = "connector";

  // ---- Q12: the connector's path set ----
  const connectorRoutes = [...new Set(log.filter((l) => l.phase === "connector").map((l) => l.route))].sort();
  const q12 = { connectorRoutes, exact: connectorRoutes.join() === [...CONNECTOR_PATHS].sort().join(),
    emailsRoutes: [...new Set(log.filter((l) => l.phase === "emails").map((l) => l.route))] };
  db.close();
  const pass = {
    q0: true, q1: q1.accepted !== null && q1.audienceReadable && q1.echoedListId !== false,
    q4: q4.state === "archive_pending" && q4.eligibleAtSend === 4, q5: q5.equal && q5.state === "archive_pending" && q5.label === null,
    q6: q6.createPosts === 1 && q6.sendPosts === 1 && again.status >= 400 && again.status < 500,
    q7: q7.afterRun === "create_attempted" && q7.afterRecover === "draft_known" && q7.createPosts === 1 && q7.sendPosts === 0,
    q8: q8.status === 200, q11: q11.providerWrites === 0 && q11.sendPosts === 1 && q11.state === "archive_pending" && q11.secondSendRefused, q12: q12.exact,
  };
  return { contract: QUAL_CONTRACT, phase: "run", mode: i.mode, runId, at: now(), head: i.head, connectorSha: i.connectorSha, node: process.versions.node,
    listField: q1.accepted, fromDomain, segmentId: i.segmentId, broadcastIds: { main: bid, listing: made }, q0, q1, q2, q3, q4, q5, q6, q7, q8, q9, q11, q12,
    pathLog: log.map(({ phase, op, route, status }) => ({ phase, op, route, status })), pass, passed: Object.values(pass).every(Boolean) };
}

/** Owner's console facts (F-2 Q0, F-3 Q4, Q8 header, Q10), entered after the run; shas of screenshots, never the images. */
/** Q4 (plan): the console's per-broadcast recipients == 4, q2 == 0, q1/q3/q4 sinks and q5 delivered once each; the verifier
 *  checks presence and consistency, the read-back carries the truth. Q13 is a RECORDED fact, not a pass condition. */
export type OwnerFacts = { q0ConsoleSha: string; q4: { recipientsShown: number; q2Received: number; sinksDelivered: number; q5Delivered: number; recipientsScreenshotSha: string };
  q8: { fromHeaderMatches: boolean; received: boolean }; q10: { onlyKapelleKeyCanSend: boolean; siteKeyAbsent: boolean; keyScope: string; screenshotSha: string };
  q13: { clickedUnsubscribe: boolean } };
const SHOT = /^sha256:[a-f0-9]{64}$/;
export function ownerFactsValid(f: any): f is OwnerFacts {
  return !!f && SHOT.test(f.q0ConsoleSha) && [f.q4?.recipientsShown, f.q4?.q2Received, f.q4?.sinksDelivered, f.q4?.q5Delivered].every(Number.isInteger) && SHOT.test(f.q4?.recipientsScreenshotSha)
    && typeof f.q8?.fromHeaderMatches === "boolean" && typeof f.q8?.received === "boolean" && typeof f.q10?.onlyKapelleKeyCanSend === "boolean"
    && typeof f.q10?.siteKeyAbsent === "boolean" && /^[a-z_]{1,30}$/.test(f.q10?.keyScope ?? "") && SHOT.test(f.q10?.screenshotSha) && typeof f.q13?.clickedUnsubscribe === "boolean";
}

/** Phase 2: Q13 (the real unsubscribe link, clicked by the owner in q5's mail, reads back as unsubscribed) + the owner facts. */
export async function finalizeQualification(run: any, facts: unknown, i: { keyFile: string; fetch: ResendFetch; now?: () => string }) {
  if (run?.contract !== QUAL_CONTRACT || run.phase !== "run") stop("qual_run_report_invalid");
  if (!ownerFactsValid(facts)) stop("qual_owner_facts_invalid");
  const ids = await readAudience({ keyFile: i.keyFile, audienceId: run.segmentId, fetch: i.fetch });
  const q13 = { q5ContactId: run.q0.q5ContactId, clicked: (facts as OwnerFacts).q13.clickedUnsubscribe, readable: ids !== null,
    q5Unsubscribed: ids !== null && !ids.includes(run.q0.q5ContactId) };
  const f = facts as OwnerFacts;
  const pass = { ...run.pass, q4: run.pass.q4 && f.q4.recipientsShown === 4 && f.q4.q2Received === 0 && f.q4.sinksDelivered === run.q0.sinks && f.q4.q5Delivered === 1,
    q8: run.pass.q8 && f.q8.received && f.q8.fromHeaderMatches };
  return { ...run, phase: "final", finalizedAt: (i.now ?? (() => new Date().toISOString()))(), ownerFacts: f, q13, pass, passed: Object.values(pass).every(Boolean) };
}

export type NewsletterQualificationVerdict = { ok: true; listField: string; fromDomain: string; head: string; reportSha256: string } | { ok: false; reason: string };
/** `kapelle-admin verify-newsletter-qualification <report>`: the final LIVE report attests THIS connector (file sha) and pins
 *  listField + the From domain for the production render. */
export function verifyNewsletterQualificationReport(reportBytes: Buffer, current: { connectorSha: string } = { connectorSha: RESEND_CONNECTOR_SHA }): NewsletterQualificationVerdict {
  let r: any;
  try { r = JSON.parse(reportBytes.toString("utf8")); } catch { return { ok: false, reason: "qualification_report_malformed" }; }
  if (r?.contract !== QUAL_CONTRACT || r.phase !== "final" || r.mode !== "live") return { ok: false, reason: "qualification_report_not_final_live" };
  if (reportBytes.toString("utf8").includes("@")) return { ok: false, reason: "qualification_report_has_address" };
  if (r.connectorSha !== current.connectorSha) return { ok: false, reason: "qualification_connector_mismatch" };
  if (r.listField !== "segment_id" && r.listField !== "audience_id") return { ok: false, reason: "qualification_list_field_invalid" };
  if (!/^[a-f0-9]{40}$/.test(r.head ?? "") || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(r.fromDomain ?? "")) return { ok: false, reason: "qualification_report_malformed" };
  if (!ownerFactsValid(r.ownerFacts)) return { ok: false, reason: "qualification_owner_facts_invalid" };
  const need = ["q0", "q1", "q4", "q5", "q6", "q7", "q8", "q11", "q12"]; // the plan's PASS set; Q2, Q3, Q9, Q10, Q13 are recorded facts
  if (!need.every((k) => r.pass?.[k] === true) || r.passed !== true) return { ok: false, reason: "qualification_report_not_passing" };
  // Consistency (the verifier checks presence and agreement, not the truth of console facts).
  const routes = new Set((r.pathLog ?? []).filter((l: any) => l.phase === "connector").map((l: any) => l.route));
  if ([...routes].sort().join() !== [...CONNECTOR_PATHS].sort().join()) return { ok: false, reason: "qualification_path_set_mismatch" };
  // A 429 row is "rate limited, not processed" (retried by the connector): it is not a send.
  const sends = (r.pathLog ?? []).filter((l: any) => l.phase === "connector" && l.route === "POST /broadcasts/{id}/send" && l.status !== 429).length;
  if (sends !== 1 || r.q6?.sendPosts !== 1 || r.q6?.createPosts !== 1) return { ok: false, reason: "qualification_send_count_mismatch" };
  return { ok: true, listField: r.listField, fromDomain: r.fromDomain, head: r.head, reportSha256: sha(reportBytes) };
}
