// Lean runtime (option 3): ONE org's authoritative runtime as a service. Opens the org's SQLite authority (org Tasks via
// the lifted kilgore/task model), access (members, step-up tiers, envelopes), intake (signed email), the kit (two audience
// roots, hosted profile, per-org spend ledger, local private Report store), shadow member replies, and two Unix sockets:
//   - the ACCESS socket the shared hub dials (routine/consequential/intake routes only);
//   - the OPS socket (owner-only, never in hub config): first-admin bootstrap link, envelope-key add/retire, kill flag,
//     backup, and (option A) every `totp`-tier action until an authenticator-app step exists: member invite/remove/role,
//     reply policy approval, intake address issue/revoke. R-5: Ops actions never travel through the hub.
// Start-up sweeps run before any socket listens: spend-ledger recovery, interrupted member replies (closed, not
// regenerated) + lost reply decisions (journalled once), orphan intake files. No Claude, no Reactor, no TCP.
import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { openFrameworkRuntime } from "../service/runtime.js";
import type { SqliteAuthority } from "../service/sqlite-authority.js";
import { SqliteSpendLedger } from "../service/sqlite-effects.js";
import { OrgAccess, AccessError, ACCESS_TABLE_HASH } from "../access/org-access.js";
import { TeamTasks } from "./teamtasks/store.js";
import { teamTaskExecutor, TEAMTASK_WALL_MS, TEAMTASK_MAX_OUTPUT_TOKENS } from "./teamtasks/executor.js";
import { TeamTaskSchedules } from "./teamtasks/schedules.js";
import { HandbookStore } from "./handbook/store.js";
import type { MapFeatures } from "./handbook/context.js";
import { TEAMTASK_RULES_HASH } from "./teamtasks/qualification.js";
import { serveOrgAccess } from "../access/socket.js";
import { OrgIntake, IntakeError } from "./intake.js";
import { orgReadTask } from "./org-tasks.js";
import { writeApprovedNotes } from "./notes.js";
import { MemberReplies, replyPolicySchema, policyHash } from "./member-reply.js";
import { TRANSCRIPTION_PROFILES, transcriptionProfileHash } from "./transcription/profile.js";
import { TranscriptionPolicies, transcriptionPolicySchema, transcriptionPolicyHash } from "./transcription/policy.js";
import { MediaStore } from "./transcription/media.js";
import { TranscriptionJobs } from "./transcription/jobs.js";
import { WebsiteRequests, type HostedAsk } from "./website/requests.js";
import { WebsiteApply } from "./website/apply.js";
import { githubPort, type GithubFetch } from "./website/github.js";
import { WebsiteContent, contentReader } from "./website/content.js";
import { NewsletterReleases, senderAddress, senderDomain, type RecipientsPort } from "./newsletter/release.js";
import { normalizeLinkHosts, CP_SITE } from "./newsletter/render-cp.js";
import type { PreflightFetch } from "./newsletter/image-preflight.js";
import { NewsletterExecutor } from "./newsletter/executor.js";
import { sendIncidents } from "./newsletter/incident.js";
import { AudienceCache, resendBroadcastPort, type ResendFetch } from "./newsletter/resend-broadcast.js";
import { f6EvidenceJson, readAudienceEvidence } from "./newsletter/f6-evidence.js";
import { resendClient, type MailFetch } from "../mail/resend-send.js";
import { newsletterText } from "./chat/tools.js";
import { ImageStore, childDecoder, socketDecoder } from "./images/store.js";
import { SharedDrive } from "./library/drive.js";
import { PublicFiles, driveImagesOf, publishDigest } from "./library/public-files.js";
import { FlyerExtractor } from "./images/extract.js";
import { IMAGE_PROFILES } from "../agent-kit/interactive/openrouter.js";
import { refuseWebsiteRoot } from "./website/content-root.js";
import { hostedInferenceFor } from "../agent-kit/hosted/profile.js";
import { fakeTranscriptionBackend, type TranscriptionBackend } from "./transcription/adapter.js";
import { ChatConversations, type TurnRunner } from "./chat/conversations.js";
import { chatRunner } from "./chat/scheduler.js";
import { ChatTools } from "./chat/tools.js";
import { ChatDrafts } from "./chat/drafts.js";
import { ChatFiles } from "./chat/files.js";
import { interactiveProfileHash, taskProfileHash } from "../agent-kit/interactive/profile.js";
import { taskToolCatalogHash, toolCatalogHash } from "../agent-kit/interactive/catalog.js";
import { INTERACTIVE_PROFILES } from "../agent-kit/interactive/openrouter.js";
import { KitHost, withKitFacts, catalogSha256 } from "../agent-kit/kit-host.js";
import { openKitExecution } from "../agent-kit/kit-execution.js";
import { openKitChat } from "../agent-kit/chat.js";
import { profileHash, type RuntimeCatalog } from "../agent-kit/runtime-catalog.js";
import { openHostedAdapter } from "../agent-kit/hosted/adapter.js";
import type { HostedFetch } from "../agent-kit/hosted/transport.js";
import { OrgReportStore } from "./report-store.js";
import { ASSEMBLER_LIMITS } from "../agent-kit/scope-assembler.js";
import { PACKET_LIMITS } from "../agent-kit/launch-policy.js";
import { backupCoverage, backupOrg, listOrgBackups, pruneOrgBackups } from "./org-backup.js";
import { resendContentPort, readResendKey } from "./resend-content.js";
import { TaskProposals } from "../task-delegation/proposals.js";
import { assert } from "../validation.js";
import type { ClaudeAdapter } from "../worker/execution.js";

/** Intake archiving bounds: the config AND the /ops/intake/archive body (Fable archiving F-1: one definition, refused outside it). */
const intakeArchiveSchema = z.object({ afterDays: z.number().int().min(1).max(3650), budgetEntries: z.number().int().min(50).max(900) }).strict();
const abs = z.string().min(2).max(1000).refine((p) => p.startsWith("/") && resolve(p) === p && !p.includes("/Dropbox/"), "absolute local path (no Dropbox)");
export const orgRuntimeConfigSchema = z.object({
  contract: z.literal("kapelle.org-runtime/v1"),
  orgId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), label: z.string().min(1).max(120),
  stateRoot: abs, folder: abs, accessSocket: abs, opsSocket: abs, groupAccess: z.boolean().default(false),
  rpId: z.string().min(3).max(253), origins: z.array(z.string().regex(/^https:\/\//)).min(1).max(8),
  installations: z.array(z.object({ installationId: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/), domain: z.string().min(3).max(253), secretFile: abs,
    provider: z.enum(["fake", "resend"]).default("fake"),
    // B3: the org's Resend API key (receiving), an owner-only file; required for a resend installation unless a port is injected.
    apiKeyFile: abs.optional() }).strict()).max(8), // P-1: empty = `--intake none` (no email intake; web submissions only)
  catalogPath: abs, catalogSha256: z.string().regex(/^[a-f0-9]{64}$/), hostedProfileId: z.string().min(1).max(100),
  hosted: z.object({ secretFile: abs, monthlyUsd: z.number().positive().max(10_000) }).strict(),
  replyDomain: z.string().min(3).max(253),
  // Build item (d): scheduled per-org backup sets (outside stateRoot and folder), newest `keep` retained.
  backup: z.object({ dir: abs, everyMinutes: z.number().int().min(5).max(7 * 24 * 60), keep: z.number().int().min(1).max(365) }).strict().optional(),
  // Intake archiving (always on; these tune it): keep the intake folder well under the snapshot walk bound.
  intakeArchive: intakeArchiveSchema.optional(),
  // Meeting transcription (Fable R-1/R-4): absent = off. The backend's profile (origin, params, rate, per-job ceilings) is
  // pinned in code; Ops sets only the backend, its owner-only key file, the org's own monthly cap (never shared with
  // inference) and the qualification reference pinned from a report sha.
  transcription: z.object({ backend: z.enum(["fake", "deepgram"]), secretFile: abs.optional(), monthlyUsd: z.number().positive().max(1000),
    qualificationRef: z.string().regex(/^(pending:[a-z0-9 ._-]{0,80}|sha256:[a-f0-9]{64})$/).default("pending:") }).strict()
    .refine((t) => t.backend !== "deepgram" || !!t.secretFile, "transcription_key_required").optional(),
  // Chat agent (PLAN-SLICE-1; absent = off). D-1 (owner, 2026-10-16): chats are private; adminsReadAll stays OFF unless the
  // org decides otherwise (then only conversations created while it is on are admin-readable, and every such read is audited).
  // P-1: a per-member allowance of turns per 24 h (the hosted monthly cap is org-shared). D-4: retention in days.
  // `profile` names a code-pinned interactive profile (catalog hash + caps); requests share the hosted key and monthly cap (D-2).
  chat: z.object({ profile: z.enum(["sonnet"]).default("sonnet"), adminsReadAll: z.boolean().default(false), dailyTurnsPerMember: z.number().int().min(1).max(200).default(20),
    retentionDays: z.number().int().min(30).max(3650).default(365) }).strict().optional(),
  // Website pack v0 (PLAN-WEBSITE-PACK-V0; absent = off): the GitHub repo the reviewer's requests become DRAFT PRs on, the
  // connected identity commits are authored as (Vercel needs a collaborator; Fable R-2 adds a fixed trailer + Co-authored-by),
  // the owner-only fine-grained PAT file, the preview hosts a status URL may point at (R-7), and the daily caps (R-1).
  // Newsletter send slice 1 (S1-b): present = the TOTP step-up is configured; the key file is rendered by Ops (secretsExpected)
  // and read at use, never stored. Releases (approvers, caps) arrive in S1-c.
  // S1-c (Fable answer 3): approvers are EMAILS resolved at use to an active admin/reviewer; caps per R-3 (owner decision 6).
  newsletter: z.object({ totpKeyFile: abs, approvers: z.array(z.string().regex(/^[^@\s]+@[^@\s]+$/).max(320)).max(10).default([]),
    releasesPerMonth: z.number().int().min(1).max(31).default(4), testsPerDay: z.number().int().min(1).max(50).default(12),
    testsPerMemberPerDay: z.number().int().min(1).max(20).default(6),
    // S2-a: the release sender frozen into packages, and the org runtime's own TEST sender (agent@ key copy; B2: never the hub).
    from: z.string().min(3).max(200).optional(), replyTo: z.string().min(3).max(320).optional(), listId: z.string().min(1).max(100).default("unassigned"),
    testFrom: z.string().min(3).max(200).optional(), testKeyFile: abs.optional(),
    // S3-a (Fable R-1, R-4): the EXNA team's full-access release key (read at use) and the field the list id is sent as
    // (segment_id, or the older audience_id: pinned by the qualification). S3-c: key + list + release sender = the executor runs.
    releaseKeyFile: abs.optional(), listField: z.enum(["segment_id", "audience_id"]).default("segment_id"),
    // Package E (Fable E-4): Ops-held link-host extras. Package F (Fable ruling (a)): one deprecation release, so the live org.json
    // still loads: validated with the same exact-host rule, IGNORED (links take any https host with provenance); Package G drops it.
    linkHosts: z.array(z.string().max(253)).max(10).optional(),
    // Package E (Fable E-5, N1): tests also go to these members (<= 3 member ids), resolved to active admins at send time.
    testAlsoTo: z.array(z.string().regex(/^m-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)).max(3).optional() }).strict()
    // Fable cbae22b4 E-9: a test sender on another domain than the release From is refused at load.
    .refine((n) => { try { normalizeLinkHosts(n.linkHosts); return true; } catch { return false; } }, "newsletter_link_hosts_invalid")
    .refine((n) => !n.from || !n.testFrom || (!!senderDomain(n.from) && senderDomain(n.from) === senderDomain(n.testFrom)), "newsletter_sender_invalid")
    .refine((n) => !n.releaseKeyFile || n.listId !== "unassigned", "a release key needs the list id")
    .refine((n) => !n.releaseKeyFile || (!!n.from && !!n.replyTo), "newsletter_sender_not_configured").optional(),
  website: z.object({ repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/), baseBranch: z.string().regex(/^[A-Za-z0-9._-]{1,60}$/).default("main"),
    author: z.object({ name: z.string().min(1).max(100), email: z.string().email().max(200) }).strict(),
    coAuthor: z.object({ name: z.string().min(1).max(100), email: z.string().email().max(200) }).strict(),
    patFile: abs, // Preview hosts: an exact host, "*.<domain>", or "*-<label>.<domain>" = exactly ONE extra DNS label ending in
    // "-<label>" (Vercel team previews: example-org-website-<hash>-example-projects.vercel.app; never all of vercel.app).
    previewHosts: z.array(z.string().regex(/^(\*\.|\*-[a-z0-9-]+\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/)).min(1).max(8),
    dailyApply: z.number().int().min(1).max(50).default(5), dailyRequest: z.number().int().min(1).max(200).default(20) }).strict().optional(),
  // IMAGES-V1 I1 (absent = off; needs chat): flyer/image attachments, sanitized by the separate decoder process. On the org host
  // the decoder is the socket-activated systemd unit (its per-org socket); "child" (a plain process, NOT network-isolated) must
  // say so and is for tests and the development Mac only.
  images: z.object({ decoder: z.discriminatedUnion("mode", [z.object({ mode: z.literal("systemd"), socket: abs }).strict(),
    z.object({ mode: z.literal("child"), node: abs, script: abs, unisolated: z.literal(true) }).strict()]),
    // IMAGES-V1 I2 (owner: hosted-image admission YES): "Read this flyer" with the pinned image profile (off unless set).
    extract: z.boolean().default(false) }).strict().optional(),
  // LIBRARY L2 (Fable L-12): the public files route for shared-drive images a prepared release published. Absent or false =
  // off (the route answers 404, prepare refuses drive images, and the agent's list offers none for newsletters).
  files: z.object({ publicRoute: z.boolean() }).strict().optional(),
  // TEAM-TASKS-V1 T1 (absent = off; needs chat: the interactive profile and tool catalog are the run's pins).
  // T2a: run "on" = the production executor (the chat profile + catalog, one bounded loop, the shared ledger); absent/"off" = approvals refuse.
  teamTasks: z.object({ run: z.enum(["on", "off"]).default("off"),
    // SCHEDULED-TASKS-V1 S1 (Fable C-5): Ops' switch for schedules (the one kill path, with "Pause all" and the Ops pause) and the
    // org's admitted monthly schedule envelope (without one, schedules are propose-only). Off by default.
    schedules: z.object({ run: z.enum(["on", "off"]).default("off"), envelopeUsd: z.number().positive().max(20).optional() }).strict().optional() }).strict().optional(),
  // AGENT-HANDBOOK-V1 H1 (Fable C-6): the approved handbook + system map in chat and team tasks. Absent or enabled:false = OFF
  // (no store, no tables, today's prompts). Enabled with no approved handbook refuses before inference.
  handbook: z.object({ enabled: z.boolean().default(false) }).strict().optional(),
}).strict().refine((c) => !c.images || !!c.chat, "images_need_chat").refine((c) => !c.teamTasks || !!c.chat, "team_tasks_need_chat");
export type OrgRuntimeConfig = z.infer<typeof orgRuntimeConfigSchema>;

const readSecret = (path: string) => {
  const st = lstatSync(path);
  assert(st.isFile() && !st.isSymbolicLink() && (st.mode & 0o077) === 0 && st.size > 0 && st.size <= 4096, "org_secret_file_invalid");
  return readFileSync(path, "utf8").trim();
};
// The pinned setup (catalog file, host pins) changed under a running runtime: a fixed refusal, never an internal error.
const SETUP_CHANGED = new Set(["runtime_catalog_changed", "kit_pin_differs", "org_catalog_pin_mismatch"]);
function setupGuard<T extends Record<string, (...a: any[]) => Promise<unknown>>>(m: T): T {
  return Object.fromEntries(Object.entries(m).map(([k, f]) => [k, async (...a: any[]) => {
    try { return await f(...a); } catch (e) { if (e instanceof Error && SETUP_CHANGED.has(e.message)) throw new AccessError("setup_changed"); throw e; } }])) as T;
}
const errLabel = (e: unknown) => e instanceof AccessError || e instanceof IntakeError ? e.reason : "ops_internal_error";
const noClaude: ClaudeAdapter = { sdkVersion: "none", cliVersion: "none", async run() { throw Error("kit_claude_runtime_not_installed"); } };

/** Open one org runtime. `fetchImpl` is injectable for tests (fake provider); production uses the global fetch. */
export async function openOrgRuntime(raw: unknown, o: { fetchImpl?: HostedFetch; now?: () => string; resendPort?: import("./resend-inbound.js").ResendContentPort;
  resendFetch?: import("./resend-content.js").ResendFetch; transcriptionBackend?: TranscriptionBackend; chatRunner?: TurnRunner; githubFetch?: GithubFetch; websitePoll?: { everyMs: number; maxMs: number };
  /** TEAM-TASKS-V1 T1: the run executor (tests: a FAKE; T2 brings the shared bounded runner). Absent = approvals refuse. */
  teamTaskExecutor?: import("./teamtasks/store.js").TeamTaskExecutor;
  /** WC-2 (tests): the website content schedule; production = a start-up sync, then every 6 h, 60 s deadline. */
  websiteContent?: { start?: boolean; everyMs?: number; deadlineMs?: number };
  /** Newsletter slice 1 (tests): the authoritative audience; production has none until slice 3 (null = unknown, fail closed). */
  newsletterRecipients?: RecipientsPort;
  /** S2-a (tests): the fetch behind the newsletter test sender (production: the pinned Resend client's own fetch). */
  newsletterTestFetch?: MailFetch;
  /** Package E (Fable E-2): the fetch behind the newsletter image preflight (production: the global fetch; tests: a fake). */
  newsletterImageFetch?: PreflightFetch;
  /** S3-c (tests): the fetch behind the broadcast connector and the audience reader (a fake Resend; production: global fetch). */
  newsletterProviderFetch?: ResendFetch;
  /** S3-c (tests): the executor's retry schedule (production: every 5 min). */
  newsletterRetryMs?: number;
  /** SCHEDULED-TASKS-V1 S1: the schedule wake-up tick (default 60 s; tests may shorten it). */
  scheduleTickMs?: number;
  /** S3-c (tests): how long a cached audience read counts as current (production: 5 min). */
  newsletterAudienceMaxAgeMs?: number;
  /** S3-c (tests): the challenge-time refresh is skipped while the cache is younger than this (production: 5 s). */
  newsletterChallengeFreshMs?: number } = {}) {
  const c = orgRuntimeConfigSchema.parse(raw);
  for (const d of [c.stateRoot, c.folder, dirname(c.accessSocket), dirname(c.opsSocket)]) {
    const st = lstatSync(d); assert(st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.(), "org_directory_invalid");
  }
  assert(dirname(c.accessSocket) !== dirname(c.opsSocket), "org_ops_socket_must_be_separate");
  assert((lstatSync(dirname(c.opsSocket)).mode & 0o077) === 0, "org_ops_socket_directory_not_private");
  assert(catalogSha256(c.catalogPath) === c.catalogSha256, "org_catalog_pin_mismatch");
  const inside = (p: string, root: string) => p === root || p.startsWith(root + "/");
  if (c.backup) assert(![c.stateRoot, c.folder].some((r) => inside(c.backup!.dir, r) || inside(r, c.backup!.dir)), "org_backup_dir_overlaps");
  const holder: { kit: KitHost | null; exec: ReturnType<typeof openKitExecution> | null; authority?: any } = { kit: null, exec: null };
  // An org runtime's base facts are empty: every definition, binding and budget comes from the kit (its own agents).
  const kitFacts = withKitFacts((async () => ({ definitions: [], resources: [], connectionRefs: [], runtimeBindingRefs: [], runtimeBindingContracts: {}, scheduleRefs: [],
    budgetPolicyRefs: [], artifacts: [], effects: [], deliveryReceipts: [], dispatch: { parents: [], agents: [], tasks: [], sources: [], results: [] } })) as never, () => holder.kit);
  const rt = await openFrameworkRuntime({ stateRoot: join(c.stateRoot, "authority"), reactorRoot: "/unused-reactor", ownerId: "owner", scopeRef: c.orgId, backend: "sqlite",
    taskDelegation: { readTask: (id: string) => orgReadTask(holder.authority, id), permissionRef: "task-delegation:owner" },
    facts: async () => { const f: any = await kitFacts(); return { ...f, dispatch: { ...f.dispatch, results: holder.exec ? await holder.exec.resultFacts() : [] } }; } } as never);
  holder.authority = rt.authority;
  const servers: Server[] = [];
  const backups = { timer: null as NodeJS.Timeout | null, running: null as Promise<unknown> | null, last: null as null | { set: string; at: string; files: number }, lastError: null as string | null, ok: 0, failed: 0 };
  const timers: NodeJS.Timeout[] = []; // background schedules (intake archiving); cleared on close
  const idle: (() => Promise<unknown>)[] = []; // background queues to let finish on close (transcription)
  const close = async () => {
    for (const f of idle) await f().catch(() => {});
    if (backups.timer) clearInterval(backups.timer);
    for (const t of timers) clearInterval(t);
    await backups.running?.catch(() => {});
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
    holder.exec?.close();
    await rt.close();
  };
  try {
    const sqlite = (rt as unknown as { sqlite: SqliteAuthority }).sqlite;
    sqlite.db.exec("CREATE TABLE IF NOT EXISTS intake_archive(intake_id TEXT PRIMARY KEY, archived_at TEXT NOT NULL) STRICT;");
    sqlite.db.exec("CREATE TABLE IF NOT EXISTS intake_adoptions(intake_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, member_id TEXT NOT NULL, at TEXT NOT NULL) STRICT;" +
      "CREATE TABLE IF NOT EXISTS plan_pending(task_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, source_hash TEXT NOT NULL) STRICT;");
    const access = new OrgAccess(sqlite, { orgId: c.orgId, rpId: c.rpId, origins: c.origins, label: c.label, totpKeyFile: c.newsletter?.totpKeyFile ?? null }, o.now);
    // Newsletter slice 1: the fixture-only release core; its guard and in-transaction hook complete newsletter.send (TOTP).
    const nlc = c.newsletter;
    // S3-c (R-2, R-8): the executor exists only with the EXNA release key + a real list id + the release sender (the schema
    // refuses a key without them). One list id feeds the broadcast and the audience reader. The synchronous gates read the
    // cached eligible set (null once stale: fail closed); every path that gates refreshes it first (Fable S3-a wiring).
    const live = nlc?.releaseKeyFile && nlc.listId !== "unassigned" && nlc.from && nlc.replyTo ? { keyFile: nlc.releaseKeyFile, listId: nlc.listId, listField: nlc.listField } : null;
    const pfetch = o.newsletterProviderFetch ? { fetch: o.newsletterProviderFetch } : {};
    // F6-S (Fable 83a20aeb + Addendum 1): the cache's walk is the evidence walk (same requests as readAudience, no second walk);
    // every COMPLETE walk is also the F-6 suppression sync, recorded in the DB only (counts + hashes, no address, no contact id).
    // A failed walk records nothing (F-6 fails closed).
    const cache = live && !o.newsletterRecipients ? new AudienceCache(async () => {
      const r = await readAudienceEvidence({ keyFile: live.keyFile, audienceId: live.listId, ...pfetch });
      if (!r) return null;
      try { newsletter?.recordServerSuppressionSync(r.evidence, (at) => f6EvidenceJson(at, r.evidence)); } catch { /* not recorded: F-6 stays as it was */ }
      return r.eligible;
    }, o.newsletterAudienceMaxAgeMs) : null;
    let refreshing: Promise<unknown> | null = null; // one read at a time; concurrent callers share it
    const audience = { refresh: async () => { if (!cache) return o.newsletterRecipients?.() ?? null;
        refreshing ??= cache.refresh().catch(() => null).finally(() => { refreshing = null; }); await refreshing; return cache.current(); },
      current: () => cache ? cache.current() : o.newsletterRecipients?.() ?? null,
      /** Fable S3-c1 N-1: the challenge hook runs BEFORE the envelope is verified, so it is rate-bound: no read while the
       *  last one is younger than 5 s (the executor still re-reads right before and after the send). */
      freshForChallenge: () => { const age = cache?.ageMs() ?? null; return age !== null && age >= 0 && age < (o.newsletterChallengeFreshMs ?? 5_000); } };
    const imageFetch: PreflightFetch = o.newsletterImageFetch ?? ((u, i) => fetch(u, i));
    const newsletter = nlc ? new NewsletterReleases(sqlite, { orgId: c.orgId, installationId: sqlite.identity.installationId, approvers: nlc.approvers,
      releasesPerMonth: nlc.releasesPerMonth, recipients: audience.current, imageFetch, testAlsoTo: nlc.testAlsoTo ?? [],
      sender: nlc.from && nlc.replyTo ? { from: nlc.from, replyTo: nlc.replyTo, listId: nlc.listId } : null,
      // Conflict 1: the agent@ key is the CURRENT team's: its tests are previews (they never satisfy gate 1 / F-4).
      // S3-b (answer 3, R-6): with the EXNA team's release key + list + release From, tests go out the RELEASE way (same team,
      // domain, key and From as the broadcast; path "release", which can satisfy gate 1); otherwise the agent@ preview path.
      // One path per configuration; earlier preview rows stay previews.
      // Package E, Fable E-10 ruling (574d8b5d) (b): tests ALWAYS use the sending-only test key; the full-access release key is
      // read only by the mint/send executor. The path is "release" iff the test address equals the release From's address (the
      // ONE E-9 extraction) and the list is configured; the test email then carries the release From verbatim (what members see).
      test: nlc.testFrom && nlc.testKeyFile ? (() => {
        const release = !!nlc.from && nlc.listId !== "unassigned" && senderAddress(nlc.testFrom) !== null && senderAddress(nlc.testFrom) === senderAddress(nlc.from);
        return { path: release ? "release" as const : "preview" as const, perMemberPerDay: nlc.testsPerMemberPerDay, perOrgPerDay: nlc.testsPerDay,
          ...resendClient({ from: release ? nlc.from! : nlc.testFrom, apiKeyFile: nlc.testKeyFile, ...(o.newsletterTestFetch ? { fetch: o.newsletterTestFetch } : {}) }) };
      })() : null }, o.now) : null;
    if (newsletter) access.installTotpHooks({ guard: (x) => newsletter.mintGuard(x), inTxn: (x) => newsletter.approveInTxn(x) });
    const executor = live && newsletter ? new NewsletterExecutor(sqlite, { stateRoot: c.stateRoot, releases: newsletter, audience, listId: live.listId, imageFetch,
      provider: resendBroadcastPort({ keyFile: live.keyFile, listId: live.listId, listField: live.listField, ...pfetch }) }, o.now) : null;
    // Fable answer 2: the fixed-template incident mail goes out through the same team's client (release key + release From).
    const incidentMail = live ? resendClient({ from: nlc!.from!, apiKeyFile: live.keyFile, ...(o.newsletterTestFetch ? { fetch: o.newsletterTestFetch } : {}) }) : null;
    // R-8: never blocks the approval. One run at a time in the background: recover() first, then every release that can move
    // (approved; a draft whose read-back was uncertain; an accepted send awaiting its fence). A kick while running queues one more pass.
    const nlRun = { running: null as Promise<void> | null, again: false, closed: false, last: null as null | { releaseId: string; state: string; label: string | null; at: string },
      lastError: null as string | null };
    const kick = () => {
      if (!executor || nlRun.closed) return;
      if (nlRun.running) { nlRun.again = true; return; }
      nlRun.running = (async () => {
        do {
          nlRun.again = false;
          try {
            const rec = await executor.recover();
            if (!rec.restoreReconcile) {
              const ids = sqlite.read(() => sqlite.db.prepare("SELECT release_id FROM newsletter_effects WHERE state IN ('approved','draft_known','provider_accepted') ORDER BY at, release_id").all() as { release_id: string }[]);
              for (const { release_id } of ids) { if (nlRun.closed) break; const r = await executor.run(release_id); nlRun.last = { releaseId: release_id, ...r, at: new Date().toISOString() }; }
            }
            // Each transition that needs a person mails the active admins once (held, reconcile_required, a restore).
            await sendIncidents(sqlite, { send: incidentMail ? (m) => incidentMail.send(m) : null, restoreReconcile: () => sqlite.read(() => newsletter!.restoreReconcile()),
              now: () => new Date().toISOString() });
            nlRun.lastError = null;
            if (rec.restoreReconcile) break;
          } catch (e) { nlRun.lastError = e instanceof Error && /^newsletter_[a-z_]+$/.test(e.message) ? e.message : "newsletter_executor_error"; }
        } while (nlRun.again && !nlRun.closed);
      })().finally(() => { nlRun.running = null; });
    };
    const tProfile = c.transcription ? TRANSCRIPTION_PROFILES[c.transcription.backend] : null;
    if (c.transcription?.secretFile) readSecret(c.transcription.secretFile); // a bad key file fails at start, not on the first job
    const tPolicies = new TranscriptionPolicies(sqlite, { profileHash: () => tProfile ? transcriptionProfileHash(tProfile) : null }, o.now);
    // T-2: audio only under stateRoot/media (outside the backed-up folder, R-7); absent when transcription is off.
    const media = tProfile ? new MediaStore(sqlite, { stateRoot: c.stateRoot, profile: tProfile }, o.now) : null;
    const needMedia = () => { if (!media) throw new AccessError("transcription_not_configured"); return media; };
    // A Resend installation needs a content port; no real Resend HTTP client exists in this build, so production cannot
    // call Resend until a reviewed adapter (account + key) is supplied.
    // B3: a resend installation gets the real Receiving API client from its key file (checked now: a bad key fails at start,
    // not on the first email), unless a port is injected (tests).
    const portFor = (i: OrgRuntimeConfig["installations"][number]) => {
      if (o.resendPort) return o.resendPort;
      assert(i.apiKeyFile && existsSync(i.apiKeyFile), "org_resend_key_missing");
      readResendKey(i.apiKeyFile!);
      return resendContentPort({ apiKeyFile: i.apiKeyFile!, fetch: o.resendFetch });
    };
    const intake = new OrgIntake(sqlite, { orgId: c.orgId, folder: c.folder, installations: c.installations.map((i) => ({ installationId: i.installationId, domain: i.domain,
      secret: readSecret(i.secretFile), provider: i.provider, ...(i.provider === "resend" ? { resend: portFor(i) } : {}) })) }, o.now);
    const catalog = JSON.parse(readFileSync(c.catalogPath, "utf8")) as RuntimeCatalog;
    const profile = catalog.profiles.find((p) => p.id === c.hostedProfileId && p.runtime.kind === "hosted-api");
    assert(profile, "org_hosted_profile_not_in_catalog");
    const ledger = new SqliteSpendLedger(sqlite, { monthlyUsd: c.hosted.monthlyUsd }, o.now);
    ledger.recoverAtStart();
    const loadHostedProvider = async (hash: string) => { assert(hash === profileHash(profile!), "kit_hosted_profile_not_admitted");
      return openHostedAdapter({ profile: profile!, secretFile: c.hosted.secretFile, ledger, ...(o.fetchImpl ? { fetch: o.fetchImpl } : {}) }); };
    const reports = new OrgReportStore(join(c.stateRoot, "reports"), { ownerId: "owner", scopeRef: c.orgId });
    const kit = KitHost.open({ contract: "kapelle.kit-host/v1", catalogPath: c.catalogPath, catalogSha256: c.catalogSha256, stateDir: join(c.stateRoot, "kit"),
      permissionRef: "task-delegation:owner", workspaceRoot: c.folder, scopeRoots: [
        { id: "rp", path: join(c.folder, "reviewers-private"), label: "Reviewers (private)", projects: [`${c.orgId}-reviewers`] },
        { id: "mem", path: join(c.folder, "members"), label: "Members", projects: [c.orgId] }] }, rt.authority);
    const exec = openKitExecution({ root: join(c.stateRoot, "workers"), authority: rt.authority, kit, token: () => "org-runtime-local", loadProvider: async () => noClaude,
      loadHostedProvider, publisher: reports, checkHostPins: async () => { assert(catalogSha256(c.catalogPath) === c.catalogSha256, "org_catalog_pin_mismatch"); },
      readTask: (id: string) => orgReadTask(rt.authority, id) });
    holder.kit = kit; holder.exec = exec;
    const chat = openKitChat({ kit, authority: rt.authority, root: join(c.stateRoot, "kit", "chats"), token: () => "org-runtime-local", loadProvider: async () => noClaude,
      loadHostedProvider, checkHostPins: async () => { assert(catalogSha256(c.catalogPath) === c.catalogSha256, "org_catalog_pin_mismatch"); } });
    // The org's two standing agents (idempotent by name): a reviewers-private meeting preparer and a members Q&A agent.
    const agent = async (name: string, purpose: string, scope: { rootId: string; relativeDirectory: string }) => {
      const existing = (await rt.authority.listInstances()).find((i: any) => i.name === name);
      if (existing) return (existing as any).instanceId as string;
      const req = { kind: "generic", operationId: randomUUID(), name, purpose, instructions: "", defaultScopes: [{ kind: "folder", ...scope }], runtime: c.hostedProfileId };
      return (await kit.create({ ...req, manifestHash: kit.preview(req).manifestHash })).instanceId;
    };
    const preparer = await agent("Meeting preparer", "Draft meeting notes from submitted material for reviewers.", { rootId: "rp", relativeDirectory: "intake" });
    const membersQa = await agent("Members Q&A", "Answer members' questions from approved member notes only.", { rootId: "mem", relativeDirectory: "notes" });
    const api = new TaskProposals(rt.authority);
    // A member's conversation id is derived server-side from org + member, never chosen by the client.
    const conversationOf = (memberId: string) => { const h = createHash("sha256").update(`${c.orgId}:${memberId}`).digest("hex");
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };
    const principal = (memberId: string) => `member:${c.orgId}:${memberId}:v${access.membershipVersion()}`;
    const memberActive = (id: string) => !!sqlite.db.prepare("SELECT 1 FROM access_members WHERE member_id=? AND status='active'").get(id);
    const replies = new MemberReplies(sqlite, { orgId: c.orgId, folder: c.folder, replyDomain: c.replyDomain, catalogProfileHash: () => profileHash(profile!), memberActive,
      ask: async (memberId, question) => chat.ask(membersQa, { operationId: randomUUID(), conversationId: conversationOf(memberId), question }) as never,
      ledgerSessions: () => (sqlite.db.prepare("SELECT key FROM effects WHERE kind='hosted-inference' ORDER BY rowid").all() as { key: string }[]).map((r) => r.key) }, o.now);
    // Start-up sweeps, before any listener: lost reply decisions, interrupted generations, orphan intake files.
    const swept = { orphans: intake.sweepOrphans(), replies: await replies.resumeAtStart() };
    // Intake archiving: the preparer's snapshot walks reviewers-private/intake, which the assembler refuses past 1000 entries.
    // Oldest first, processed submissions (reply decision journalled) move to reviewers-private/archive/intake (outside the
    // preparer's scope): everything older than afterDays, and more while the folder is over budgetEntries. The newest
    // KEEP_ADOPTED adopted ones stay (a plan's retained context). The DB is the source of truth: archive = record then rename,
    // restore = un-record then rename, and every run first reconciles a directory left on the wrong side by a crash.
    const IN_DIR = join(c.folder, "reviewers-private", "intake"), ARCH_DIR = join(c.folder, "reviewers-private", "archive", "intake"), KEEP_ADOPTED = 4;
    const archiveCfg = { afterDays: c.intakeArchive?.afterDays ?? 60, budgetEntries: c.intakeArchive?.budgetEntries ?? 600 };
    const archived = (id: string) => !!sqlite.db.prepare("SELECT 1 FROM intake_archive WHERE intake_id=?").get(id);
    const entriesIn = () => existsSync(IN_DIR) ? readdirSync(IN_DIR).reduce((n, d) => n + 1 + (lstatSync(join(IN_DIR, d)).isDirectory() ? readdirSync(join(IN_DIR, d)).length : 0), 0) : 0;
    const audit = (event: string, id: string, detail: string) => sqlite.write(() => sqlite.db.prepare("INSERT INTO intake_audit(at,event,intake_id,detail) VALUES (?,?,?,?)").run(new Date().toISOString(), event, id, detail));
    const archiveStats = { runs: 0, moved: 0, lastRun: null as string | null };
    // WC-1 N-1: the archive renames never land in (or come from) the website copy.
    const moveIntake = (from: string, to: string) => { refuseWebsiteRoot(c.folder, from, (l) => new AccessError(l)); refuseWebsiteRoot(c.folder, to, (l) => new AccessError(l)); renameSync(from, to); };
    const reconcileArchive = () => {
      refuseWebsiteRoot(c.folder, ARCH_DIR, (l) => new AccessError(l));
      mkdirSync(ARCH_DIR, { recursive: true, mode: 0o700 });
      for (const d of readdirSync(IN_DIR)) if (/^intake_[a-f0-9]{32}$/.test(d) && archived(d) && !existsSync(join(ARCH_DIR, d))) moveIntake(join(IN_DIR, d), join(ARCH_DIR, d));
      for (const d of readdirSync(ARCH_DIR)) if (/^intake_[a-f0-9]{32}$/.test(d) && !archived(d) && !existsSync(join(IN_DIR, d))) moveIntake(join(ARCH_DIR, d), join(IN_DIR, d));
    };
    const archiveIntake = (o2: { afterDays?: number; budgetEntries?: number } = {}) => {
      const afterDays = o2.afterDays ?? archiveCfg.afterDays, budget = o2.budgetEntries ?? archiveCfg.budgetEntries;
      reconcileArchive();
      const keep = new Set((sqlite.db.prepare("SELECT intake_id FROM intake_adoptions ORDER BY at DESC LIMIT ?").all(KEEP_ADOPTED) as { intake_id: string }[]).map((r) => r.intake_id));
      const candidates = sqlite.db.prepare(`SELECT r.intake_id, r.received_at FROM intake_records r LEFT JOIN intake_archive a USING(intake_id)
        WHERE r.state='accepted' AND a.intake_id IS NULL AND (r.installation_id = 'web-reviewer' OR EXISTS (SELECT 1 FROM member_replies m WHERE m.intake_id = r.intake_id)) ORDER BY r.received_at, r.intake_id`).all() as { intake_id: string; received_at: string }[];
      const cutoff = Date.now() - afterDays * 86_400_000;
      let entries = entriesIn(); const moved: string[] = [];
      for (const r of candidates) {
        if (keep.has(r.intake_id)) continue;
        if (!(Date.parse(r.received_at) < cutoff) && entries <= budget) break; // oldest first: nothing later qualifies either
        const src = join(IN_DIR, r.intake_id);
        const n = existsSync(src) ? 1 + readdirSync(src).length : 0;
        sqlite.write(() => sqlite.db.prepare("INSERT INTO intake_archive(intake_id, archived_at) VALUES (?, ?)").run(r.intake_id, new Date().toISOString()));
        if (n) moveIntake(src, join(ARCH_DIR, r.intake_id));
        audit("intake_archived", r.intake_id, entries > budget ? "over_budget" : "older_than_" + afterDays + "d");
        entries -= n; moved.push(r.intake_id);
      }
      archiveStats.runs++; archiveStats.moved += moved.length; archiveStats.lastRun = new Date().toISOString();
      return { moved: moved.length, intakeEntries: entriesIn() };
    };
    const restoreIntake = (id: string) => {
      if (!/^intake_[a-f0-9]{32}$/.test(id) || !archived(id)) throw new AccessError("intake_not_archived");
      sqlite.write(() => sqlite.db.prepare("DELETE FROM intake_archive WHERE intake_id=?").run(id));
      if (existsSync(join(ARCH_DIR, id))) moveIntake(join(ARCH_DIR, id), join(IN_DIR, id));
      audit("intake_restored", id, "ops");
      return { restored: id, intakeEntries: entriesIn() };
    };
    const firstArchive = archiveIntake();
    const archiveTimer = setInterval(() => { try { archiveIntake(); } catch { /* next run reconciles */ } }, 86_400_000); archiveTimer.unref();
    timers.push(archiveTimer);
    let runChain: Promise<unknown> = Promise.resolve(); // approved plans run one at a time per org
    // G-1 finding: a plan's material is the adopted submission's own files plus, for retained context, the message of up to
    // three earlier adopted submissions, within the packet budget (ASSEMBLER_LIMITS.maxFiles documents, a file over
    // maxFileBytes counting as its chunks). Never the whole intake folder: that overflowed after a handful of emails.
    const planMaterial = (taskId: string) => {
      const own = sqlite.db.prepare("SELECT intake_id, at FROM intake_adoptions WHERE task_id=?").get(taskId) as { intake_id: string; at: string } | undefined;
      if (!own) throw new AccessError("plan_task_not_adopted");
      if (sqlite.db.prepare("SELECT 1 FROM intake_archive WHERE intake_id=?").get(own.intake_id)) throw new AccessError("plan_material_archived");
      const dirOf = (id: string) => join(c.folder, "reviewers-private", "intake", id);
      const docs = (bytes: number) => bytes <= ASSEMBLER_LIMITS.maxFileBytes ? 1 : Math.ceil(bytes / (ASSEMBLER_LIMITS.maxFileBytes * 0.9)) + 1;
      let budget = ASSEMBLER_LIMITS.maxFiles;
      const select: string[] = [];
      const take = (id: string, name: string) => { const n = docs(statSync(join(dirOf(id), name)).size); if (n > budget) return false; budget -= n; select.push(`${id}/${name}`); return true; };
      const ownFiles = readdirSync(dirOf(own.intake_id)).filter((f) => /\.(md|markdown|txt|csv)$/i.test(f)).sort((x, y) => (x === "message.md" ? -1 : y === "message.md" ? 1 : x.localeCompare(y)));
      if (!ownFiles.includes("message.md") || !take(own.intake_id, "message.md")) throw new AccessError("plan_material_too_large");
      for (const f of ownFiles.filter((x) => x !== "message.md")) take(own.intake_id, f);
      const earlier = sqlite.db.prepare("SELECT intake_id FROM intake_adoptions WHERE task_id<>? AND at<=? ORDER BY at DESC LIMIT 3").all(taskId, own.at) as { intake_id: string }[];
      for (const e of earlier) if (existsSync(join(dirOf(e.intake_id), "message.md"))) take(e.intake_id, "message.md");
      return select;
    };
    const planMaterialError = (e: unknown) => e instanceof AccessError ? e
      : new AccessError(e instanceof Error && e.message === "kit_scope_scope_too_many_entries" ? "plan_intake_folder_full"
        : e instanceof Error && /^kit_scope_(scope_overflow|scope_file_too_large)$/.test(e.message) ? "plan_material_too_large" : "plan_material_unavailable");
    // Attribution (B, Fable step-4 ruling; shadow trial only): the native approval names the org owner (review-intent v3
    // binds owner == actor), so "approved by" comes from the Authorization (option A: email-session) recorded in this org's authority
    // database, joined on the approval operationId and checked: the native approval's planHash must equal the Authorization's
    // artifact digest (A-1). Read-only; an Authorization without a matching native approval is reported as unmatched.
    const approvals = async () => {
      const rows = sqlite.db.prepare(`SELECT a.operation_id, a.member_id, a.artifact_digest, a.at, a.authn, c.membership_version, m.email
        FROM access_authorizations a JOIN access_challenges c ON c.id = a.challenge_id LEFT JOIN access_members m ON m.member_id = a.member_id
        WHERE a.action = 'proposal.approve' ORDER BY a.at DESC LIMIT 200`).all() as { operation_id: string; member_id: string; artifact_digest: string | null; at: string; authn: string; membership_version: number; email: string | null }[];
      return Promise.all(rows.map(async (r) => {
        const p: any = await api.lookup(r.operation_id).catch(() => null), ap = p?.approval;
        const matched = !!ap && ap.operationId === r.operation_id && ap.planHash === r.artifact_digest;
        return { operationId: r.operation_id, matched, proposalId: matched ? p.proposalId : null, taskId: matched ? p.versions.at(-1).draft.taskId : null,
          dispatchId: matched ? p.dispatchId : null, version: matched ? ap.version : null, planHash: matched ? ap.planHash : null, approvedAt: matched ? ap.occurredAt : r.at,
          approvedBy: { memberId: r.member_id, email: r.email, membershipVersion: r.membership_version }, authn: r.authn, artifactDigest: r.artifact_digest };
      }));
    };
    const reviewer = (m: { role: string }) => { if (!["admin", "reviewer"].includes(m.role)) throw new AccessError("access_role_not_permitted"); };
    // T-3 (Fable R-1/R-4): the transcription job queue, its OWN ledger kind and cap (never the inference ledger). Unlike the
    // hosted ledger, no start-up release: a queued job holds the reservation its approval authorised (P-4); the jobs recover
    // `sending` themselves (complete transcript -> settle from its manifest; else unsettled), before any listener.
    const tLedger = tProfile ? new SqliteSpendLedger(sqlite, { monthlyUsd: c.transcription!.monthlyUsd }, o.now, "transcription") : null;
    const tBackend = !tProfile ? null : o.transcriptionBackend ?? (tProfile.backend === "fake" ? fakeTranscriptionBackend() : null); // deepgram transport: T-7
    const tJobs = tProfile && tLedger ? new TranscriptionJobs(sqlite, { folder: c.folder, media: media!, profile: tProfile, policies: tPolicies, backend: tBackend, ledger: tLedger,
      qualified: tProfile.backend === "fake" || /^sha256:/.test(c.transcription!.qualificationRef), audit }, o.now) : null;
    const tRecovered = tJobs?.recover() ?? null;
    if (tJobs) {
      idle.push(() => tJobs.idle());
      // D-2 retention: a daily sweep (also run at start by recover(), and on the Ops route).
      const sweepTimer = setInterval(() => { try { tJobs.sweep(); } catch { /* the next run retries */ } }, 86_400_000); sweepTimer.unref(); timers.push(sweepTimer);
    }
    const needJobs = () => { if (!tJobs) throw new AccessError("transcription_not_configured"); return tJobs; };
    // C-2: conversations and asynchronous turns (the C-3 scheduler is the runner). Interrupted turns never re-run.
    // C-3: the scheduler runs each turn on the shared hosted ledger. A `pending:` profile makes no request (R-8) except
    // through an injected FAKE fetch (tests) — production never injects one.
    const chatProfile = c.chat ? INTERACTIVE_PROFILES[c.chat.profile] : null;
    // C-4: the runtime's tools over a per-turn snapshot of the conversation's scope; drafting needs an envelope (C-5).
    // C-5: the draft envelope (E-1..E-6). Its Records Task is a native org Task under the approval's operationId (E-4).
    const drafts: ChatDrafts | null = c.chat ? new ChatDrafts(sqlite, { orgId: c.orgId, folder: c.folder, profileHash: interactiveProfileHash(chatProfile!), toolCatalogHash: toolCatalogHash(),
      turnCaps: chatProfile!.turn, conversation: (memberId: string, id: unknown) => chatStore!.own(memberId, id),
      createTask: async (z, b) => {
        const { documentId } = await rt.authority.allocate(b.documentKey, "kilgore/task", b.title);
        const r = await rt.authority.orgTaskCommand({ operationId: z.operationId, documentId, documentType: "kilgore/task", expectedRevision: 0, type: "CREATE_TASK",
          input: { id: documentId, title: b.title, ownerId: "owner", source: "HUMAN", sourceRef: b.sourceRef } }, principal(z.memberId),
          { memberId: z.memberId, action: z.action, bodyHash: z.bodyHash, operationId: z.operationId });
        return { taskId: documentId, accepted: r.result.disposition === "ACCEPTED" };
      } }, o.now) : null;
    // AGENT-HANDBOOK-V1 H1: the store exists only when enabled (its tables are created then, like schedules'); the map states the
    // installed features, read when a map is made (so features set up below are seen).
    const handbookStore = c.handbook?.enabled ? new HandbookStore(sqlite, o.now) : null;
    const mapFeatures = (): MapFeatures => ({ chat: !!c.chat, teamTasks: !!c.teamTasks && c.teamTasks.run === "on", schedules: c.teamTasks?.schedules?.run === "on",
      website: !!c.website, newsletter: !!c.newsletter, images: !!c.images, transcription: !!c.transcription });
    const handbookContext = handbookStore ? { handbook: () => handbookStore.active(), handbookVersion: (v: number) => handbookStore.get(v), features: mapFeatures } : null;
    const chatTools: ChatTools | null = c.chat ? new ChatTools(sqlite, { folder: c.folder, stateRoot: c.stateRoot, envelopeFor: (t: string) => drafts!.envelopeOfTurn(t),
      bindEnvelope: (t, conv, h) => drafts!.bindTurn(t, conv, h), ...(handbookContext ? { context: { handbook: handbookContext.handbook, features: mapFeatures } } : {}) }, o.now) : null;
    const runner: TurnRunner | null = !c.chat ? null : o.chatRunner ?? chatRunner({ profile: chatProfile!, secretFile: c.hosted.secretFile, ledger, tools: chatTools!,
      ...(o.fetchImpl ? { fetch: o.fetchImpl, allowUnqualified: true } : {}) });
    const chatStore: ChatConversations | null = c.chat ? new ChatConversations(sqlite, { ...c.chat, memberActive, runner,
      otherBusy: (): boolean => teamTasks?.busy() ?? false }, o.now) : null;
    const chatRecovered = chatStore ? { interrupted: chatStore.recover(), ...chatStore.sweep() } : null;
    const titlesBackfilled = chatStore ? chatStore.backfillTitles() : 0; // P-3: pre-WC-4 chats, once per start
    if (chatStore) {
      idle.unshift(async () => { chatStore.abortAll(); await chatStore.idle(); });
      const chatTimer = setInterval(() => { try { chatStore.sweep(); } catch { /* the next run retries */ } }, 86_400_000); chatTimer.unref(); timers.push(chatTimer);
    }
    const needChat = () => { if (!chatStore) throw new AccessError("chat_not_configured"); return chatStore; };
    /** J2 option a (Director; chats stay private): a newsletter draft's conversation for this member: their own (or admin-
     *  readable, as before), or, for a reviewer/admin, one whose draft its owner shared with reviewers right now. Only the draft
     *  is reachable this way (the preview, Send me a test, publish); never the conversation itself. */
    const draftConversation = (m: { memberId: string; role: string }, conversationId: unknown, artifactId: unknown, o: { ownerOnly?: boolean } = {}) => {
      try { return o.ownerOnly ? needChat().own(m.memberId, conversationId).id : needChat().read(m as never, { conversationId }).conversation.conversationId; }
      catch (e) {
        if (["admin", "reviewer"].includes(m.role) && typeof conversationId === "string" && typeof artifactId === "string" && chatTools?.sharedNow(artifactId, conversationId)) return conversationId;
        throw e;
      }
    };
    // IMAGES-V1 I1 (Ops, Oct 19): a missing decoder never breaks org start; uploads refuse with image_decoder_unavailable
    // and Ops status shows decoderAvailable:false. The runtime never imports sharp (the decoder is its own process/unit).
    const images = c.images ? new ImageStore(sqlite, { stateRoot: c.stateRoot, decoder: c.images.decoder.mode === "systemd" ? socketDecoder({ socket: c.images.decoder.socket })
      : childDecoder({ node: c.images.decoder.node, script: c.images.decoder.script }) }, o.now) : null;
    if (images) { images.sweep(); const t = setInterval(() => { try { images.sweep(); } catch { /* the next run retries */ } }, 3_600_000); t.unref(); timers.push(t); }
    const needImages = () => { if (!images) throw new AccessError("image_not_configured"); return images; };
    const flyers = images && c.images!.extract ? new FlyerExtractor(sqlite, { images, profile: IMAGE_PROFILES.sonnet, ledger, secretFile: c.hosted.secretFile,
      ...(o.fetchImpl ? { fetch: o.fetchImpl, allowUnqualified: true } : {}) }, o.now) : null;
    const needFlyers = () => { if (!flyers) throw new AccessError("image_extract_not_configured"); return flyers; };
    // C-6a: chat text uploads (+ explicit share to members/shared) and the read-only Shared files page with provenance.
    // WC-1: the read-only copy of the org's public website content (members/website/), through a GET-only view of the port.
    const websiteContent = c.website ? new WebsiteContent(sqlite, { folder: c.folder, repo: c.website.repo, baseBranch: c.website.baseBranch, deadlineMs: o.websiteContent?.deadlineMs,
      // Package F delta A-4: with the newsletter on, the set lists the site images a newsletter may use (site-images.md).
      ...(c.newsletter ? { siteImagesBase: CP_SITE } : {}),
      reader: () => contentReader(githubPort({ repo: c.website!.repo, patFile: c.website!.patFile, ...(o.githubFetch ? { fetch: o.githubFetch } : {}) })) }, o.now) : null;
    if (websiteContent) {
      // WC-2 (Fable R-8): never delays the listeners or fails the start (the sync records its own outcome); every 6 h after.
      const first = o.websiteContent?.start === false ? null : setImmediate(() => { void websiteContent.sync("start").catch(() => {}); });
      const t = setInterval(() => { void websiteContent.sync("timer").catch(() => {}); }, o.websiteContent?.everyMs ?? 6 * 3_600_000); t.unref(); timers.push(t);
      idle.push(async () => { if (first) clearImmediate(first); clearInterval(t); await websiteContent.idle(); });
    }
    // LIBRARY L1: the shared drive (Files tab). Images need the decoder (image.upload {drive}); text files do not.
    const publicRoute = !!c.files?.publicRoute && !!c.newsletter;
    const drive = new SharedDrive(sqlite, { stateRoot: c.stateRoot, folder: c.folder, orgId: c.orgId, newsletterImages: publicRoute }, o.now);
    if (images) images.drive = drive;
    // LIBRARY L2: what is public, and the P-2 sweep (hourly; also after each publish).
    const publicFiles = new PublicFiles(sqlite, drive, { orgId: c.orgId, enabled: publicRoute }, o.now);
    // LIBRARY L2 (P-1): each rendered newsletter version's drive images (what its prepare would publish) and the exact digest
    // the publish approval binds; the card shows name, size, bytes, full hash, thumbnail and the public URL.
    const withDriveImages = (conversationId: string, rows: Record<string, unknown>[]) => rows.map((v) => {
      if (v.kind !== "newsletter" || !v.html_sha256) return v;
      const html = chatTools?.previewHtml(conversationId, String(v.artifact_id), Number(v.version)) ?? null;
      const shas = html ? driveImagesOf(html, c.orgId) : [];
      return shas.length ? { ...v, publish: { digest: publishDigest(shas), images: shas.map((h) => drive.info(h) ?? { sha256: h, missing: true }) } } : v;
    });
    // The agent's list follows the route switch at start, but only once the drive has had an image (no new file otherwise).
    if (drive.everHadImages()) drive.writeList();
    { publicFiles.sweep(); const t = setInterval(() => { try { publicFiles.sweep(); } catch { /* the next run retries */ } }, 3_600_000); t.unref(); timers.push(t); }
    const files = new ChatFiles(sqlite, { folder: c.folder, conversation: (memberId: string, id: unknown) => needChat().own(memberId, id), website: () => websiteContent,
      drive: () => drive }, o.now);
    // Website pack v0 (W-2): reviewer requests -> proposals. ONE qualified hosted request each (the catalog's Sonnet
    // one-POST profile, tools [], the shared monthly cap), on the org's single website chain.
    const websiteAsk: HostedAsk = async ({ system, user, sessionId }) => {
      const adapter = await loadHostedProvider(profileHash(profile!)), l = (profile as any).limits;
      let out: { text: string; providerCostUsd: number } | null = null;
      await adapter.run({ ...hostedInferenceFor(profile as never, { maxOutputTokens: l.maxOutputTokens, maxBudgetUsd: l.maxBudgetUsd, timeoutMs: l.timeoutMs }), system, user } as never,
        sessionId, AbortSignal.timeout(l.timeoutMs + 5_000), { runtime: () => {}, output: (v: any) => { out = v; }, uncertain: () => {} } as never);
      if (!out) throw new Error("hosted_execution_unconfirmed");
      return { text: (out as { text: string }).text, costUsd: (out as { providerCostUsd: number }).providerCostUsd };
    };
    const website = c.website ? new WebsiteRequests(sqlite, { stateRoot: c.stateRoot, folder: c.folder, dailyRequest: c.website.dailyRequest, baseBranch: c.website.baseBranch,
      github: () => githubPort({ repo: c.website!.repo, patFile: c.website!.patFile, ...(o.githubFetch ? { fetch: o.githubFetch } : {}) }), ask: websiteAsk }, o.now) : null;
    // W-3: approved proposals -> draft PRs through the runtime connector (intent before writes, read-first resume).
    const websiteApply = website ? new WebsiteApply(sqlite, { repo: c.website!.repo, baseBranch: c.website!.baseBranch, author: c.website!.author, coAuthor: c.website!.coAuthor,
      previewHosts: c.website!.previewHosts, dailyApply: c.website!.dailyApply, origin: c.origins[0], orgId: c.orgId,
      github: () => githubPort({ repo: c.website!.repo, patFile: c.website!.patFile, ...(o.githubFetch ? { fetch: o.githubFetch } : {}) }), requests: website,
      ...(o.websitePoll ? { poll: o.websitePoll } : {}) }, o.now) : null;
    const websiteRecovered = website ? { requests: website.recover(), prs: websiteApply!.recover() } : null;
    // Fable I3 note: abandoned flyer snapshots (failed, or prepared and never approved for 7 days) go at start and daily.
    if (website) { try { website.sweepImages(); } catch { /* the next run retries */ }
      const t = setInterval(() => { try { website.sweepImages(); } catch { /* the next run retries */ } }, 86_400_000); t.unref(); timers.push(t); }
    // TEAM-TASKS-V1 T1: team tasks (the org's one agent identity; pins = the chat profile, tool catalog, access table, executor).
    // T2a: the production executor only when Ops turned it on; tests inject a FAKE executor or a fake provider (fetchImpl).
    const ttExecutor = o.teamTaskExecutor ?? (c.teamTasks?.run === "on" ? teamTaskExecutor({ profile: chatProfile!, secretFile: c.hosted.secretFile, ledger,
      ...(o.fetchImpl ? { fetch: o.fetchImpl, allowUnqualified: true } : {}) }) : null);
    // Fable T2a N-3: a pending profile installs no executor, and the plan pins say so ("none").
    const ttLive = ttExecutor && (!("qualified" in ttExecutor) || ttExecutor.qualified) ? ttExecutor : null;
    let schedules: TeamTaskSchedules | null = null; // S1: wired below (the store asks its gate before every step)
    // Shared by the store and S1's schedules (a schedule's limits may lower this budget, never raise it).
    const ttBudget = c.teamTasks ? { requests: chatProfile!.turn.requests, toolCalls: chatProfile!.turn.toolCalls, wallMs: TEAMTASK_WALL_MS, maxOutputTokens: TEAMTASK_MAX_OUTPUT_TOKENS,
      usd: chatProfile!.turn.usd } : null;
    const ttMemberOf = (id: string) => sqlite.db.prepare("SELECT role FROM access_members WHERE member_id=? AND status='active'").get(id) as { role: string } | undefined ?? null;
    const ttLedgerRows = (prefix: string) => sqlite.db.prepare("SELECT key, state, cost_usd FROM effects WHERE key LIKE ? ESCAPE '\\' ORDER BY key").all(prefix.replace(/[%_]/g, (x) => "\\" + x) + "%") as never;
    const teamTasks = c.teamTasks ? new TeamTasks(sqlite, { orgId: c.orgId, folder: c.folder, stateRoot: c.stateRoot, executor: ttLive, ...(handbookContext ? { context: handbookContext } : {}),
      scheduleGate: (attemptId: string) => schedules?.gate(attemptId) ?? null, onAttemptEnd: (attemptId: string) => schedules?.onAttemptEnd(attemptId),
      modelBusy: (): boolean => chatStore?.busy() ?? false,
      upload: (memberId: string, uploadId: unknown): { uploadId: string; name: string; bytes: Buffer; sha256: string } => files.adoptable(memberId, uploadId),
      // Evidence-inheritance (A): task plans bind the profile AS TASKS RECEIVE IT (the task tool view), not the chat catalog.
      pins: () => ({ agentId: `org-agent:${c.orgId}`, profileId: chatProfile!.id, profileHash: taskProfileHash(chatProfile!), toolCatalogHash: taskToolCatalogHash(),
        accessTableHash: ACCESS_TABLE_HASH, executor: ttLive?.id ?? "none" }),
      // Long output (Fable R-1): a new plan allows a 16k reply and an 8-minute wall (a plan approved before keeps its 4,096 / 2 min).
      budget: ttBudget!, memberOf: ttMemberOf, ledgerRows: ttLedgerRows }, o.now) : null;
    // SCHEDULED-TASKS-V1 S1: standing schedules over the same store (pins = the four the qualification report pins, C-3).
    if (teamTasks && c.teamTasks?.schedules) {
      const sc = c.teamTasks.schedules;
      schedules = new TeamTaskSchedules(sqlite, { orgId: c.orgId, folder: c.folder, store: teamTasks,
        pins: () => ({ rulesHash: TEAMTASK_RULES_HASH, profileHash: taskProfileHash(chatProfile!), toolCatalogHash: taskToolCatalogHash(), accessTableHash: ACCESS_TABLE_HASH,
          // H2 (D-3) + Fable N-1 in code: with the handbook on, the active handbook is a pin; a schedule approved without it pauses.
          ...(handbookStore ? { handbook: ((h) => h ? { version: h.version, sha256: h.sha256 } : null)(handbookStore.active()) } : {}) }),
        ceiling: ttBudget!, memberOf: ttMemberOf, ledgerRows: ttLedgerRows, config: () => ({ run: sc.run === "on", envelopeUsd: sc.envelopeUsd ?? null }),
        busy: (): boolean => teamTasks.busy() || (chatStore?.busy() ?? false) }, o.now);
    }
    const teamTasksRecovered = teamTasks ? teamTasks.recover() : null;
    // The timer is only a wake-up hint (design §3): a tick at start (after recover) and every minute; it never runs inference itself.
    if (schedules) { const sch = schedules, tick = () => { try { sch.tick(); } catch { /* the next tick retries */ } };
      const first = setImmediate(tick), t = setInterval(tick, o.scheduleTickMs ?? 60_000); t.unref(); timers.push(t); idle.push(async () => { clearImmediate(first); clearInterval(t); }); }
    const needSchedules = () => { if (!schedules) throw new AccessError("teamtask_tool_not_admitted"); return schedules; };
    // AGENT-HANDBOOK-V1 H2: the handbook actions; refused with handbook_not_enabled when org.json handbook is absent/false.
    const needHandbook = () => { if (!handbookStore) throw new AccessError("handbook_not_enabled"); return handbookStore; };
    const reviewerOnly = (role: string) => { if (!["admin", "reviewer"].includes(role)) throw new AccessError("access_role_not_permitted"); };
    const handbookCost = (bytes: number) => { const tokens = Math.ceil(bytes / 3), r = chatProfile?.pricing;
      return { tokens, usdPerRequest: r ? Math.round(tokens * r.inputUsdPerMTok / 1e6 * r.reservationMargin * 1e6) / 1e6 : null }; };
    if (teamTasks) idle.push(async () => { teamTasks.stop(); await teamTasks.idle(); });
    const needTeamTasks = () => { if (!teamTasks) throw new AccessError("teamtask_tool_not_admitted"); return teamTasks; };
    const memberRole = (memberId: string) => ({ memberId, role: (sqlite.db.prepare("SELECT role FROM access_members WHERE member_id=? AND status='active'").get(memberId) as { role: string } | undefined)?.role ?? "none" });
    if (website) idle.push(async () => { await website.idle(); await websiteApply!.idle(); websiteApply!.stop(); });
    // S3-c (R-8): at start (recover first), then a retry pass every 5 min for releases whose last read was uncertain.
    if (executor) {
      const first = setImmediate(kick), t = setInterval(kick, o.newsletterRetryMs ?? 300_000); t.unref(); timers.push(t);
      idle.push(async () => { clearImmediate(first); clearInterval(t); nlRun.closed = true; await nlRun.running; });
    }
    const needWebsite = () => { if (!website) throw new AccessError("website_not_configured"); return website; };
    // T-5 (Fable §15(a)): transcripts are plan material only through their OWN standing agent, scoped to
    // reviewers-private/transcripts (an agent may read only its own scopes), so they never touch the intake preparer's walk.
    const tPreparer = tJobs ? await agent("Transcript preparer", "Draft meeting notes from an adopted part of a meeting transcript for reviewers.", { rootId: "rp", relativeDirectory: "transcripts" }) : null;
    // The Task text and packet framing ride in the same 128 KiB packet: keep 16 KiB for them.
    const TRANSCRIPT_CAPS = { maxFiles: ASSEMBLER_LIMITS.maxFiles, maxBytes: PACKET_LIMITS.maxBytes - 16 * 1024 };
    /** What a Task's plan reads: a transcript Task -> exactly its adopted parts via the Transcript preparer (P-1: no retained
     *  context); an intake Task -> the intake material via the Meeting preparer, as before. */
    const materialFor = (taskId: string) => {
      const t = !tJobs ? undefined : sqlite.db.prepare("SELECT job_id, first_part, last_part FROM transcript_adoptions WHERE task_id=?").get(taskId) as { job_id: string; first_part: number; last_part: number } | undefined;
      if (!t) return { instanceId: preparer, relativeDirectory: "intake", select: planMaterial(taskId), instructions: "Draft meeting notes from the submitted material only." };
      const r = needJobs().partRange({ transcriptJobId: t.job_id, parts: [t.first_part, t.last_part] }, TRANSCRIPT_CAPS);
      return { instanceId: tPreparer!, relativeDirectory: "transcripts", select: r.select,
        instructions: "Draft meeting notes from the adopted transcript excerpt only. Speaker labels are automatic estimates: do not name speakers." };
    };
    const installationId = c.installations[0]?.installationId ?? null;
    servers.push(await serveOrgAccess(access, c.accessSocket, { groupAccess: c.groupAccess,
      // S3-c (Fable S3-a wiring): the newsletter.send mint guard reads the audience synchronously: refresh it first. The action
      // string is the ONLY thing read from the (not yet verified) body; rate-bound per Fable S3-c1 N-1.
      beforeChallenge: async (action) => { if (action === "newsletter.send" && newsletter && !audience.freshForChallenge()) await audience.refresh(); },
      mediaPut: async (id, m, req, meta) => !id.startsWith("im_") ? needMedia().put(id, m, req, meta)
        : needImages().isDriveTicket(id) ? needImages().putDrive(id, m, req, meta) : needImages().put(id, m, req, meta),
      // IMAGES-V1 I3: reviewers also see an image bound to a website request (it is about to become public) for its card.
      // Package E (Fable E-11): the same ownership check as the chat.artifact.preview POST.
      previewGet: async (b, m) => { const conv = { id: draftConversation(m, b.conversationId, b.artifactId, { ownerOnly: true }) };
        // P2 K1: what Open preview SHOWS (an older rendering is shown with the current renderer, never stored).
        const d = chatTools!.displayHtml(conv.id, b.artifactId, b.version); if (d === null) throw new AccessError("chat_artifact_unknown"); return d.html; },
      driveGet: async (h) => drive.read(h),
      publicFileGet: async (h) => publicFiles.read(h),
      imageGet: async (id, m) => { try { return needImages().read(m, { imageId: id }); }
        catch (e) { const w = ["admin", "reviewer"].includes(m.role) && website ? website.boundImage(id) : null; if (w) return w; throw e; } },
      // N-2: a failed trigger is audited (visible in Ops status), and the start-up sweep retries it once.
      intake: { intake, memberActive, onAccepted: (id) => { void replies.onIntake(id).catch((e) => {
        try { sqlite.write(() => sqlite.db.prepare("INSERT INTO intake_audit(at,event,intake_id,detail) VALUES (?, 'reply_trigger_failed', ?, ?)").run(new Date().toISOString(), id, errLabel(e))); } catch { /* store fault */ }
      }); } },
      // Option A: intake.token.issue/revoke are `totp` tier (they decide who can submit), so they are Ops routes, not routines.
      routines: setupGuard({
        // T-2 (Fable R-2/P-3): mint a single-use upload id bound to this member, hub session, size and type.
        "media.upload": async (b: any, m) => needMedia().mint(m, b),
        // T-6: what the reviewer UI needs to start a job: the configured profile hash, the active policy's notice + retention.
        "transcript.list": async (_b, m) => { reviewer(m); const p = tPolicies.active();
          return { jobs: needJobs().list(), profileHash: transcriptionProfileHash(tProfile!), limits: tProfile!.limits,
            policy: p ? { version: p.policy.version, noticeText: p.policy.noticeText, retention: p.policy.retention } : null }; },
        "transcript.read": async (b: any, m) => { reviewer(m); return needJobs().read(b); },
        // Website pack v0 (reviewers): a request becomes a proposal asynchronously; the card renders from website.read.
        // IMAGES-V1 I3: with flyerProposalId, the reviewer's own checked flyer image goes with the request (event.image.attach).
        "website.request": async (b: any, m) => { reviewer(m); const w = needWebsite();
          const { fromTask, photos, ...rest } = b ?? {};
          // J2 (Add photos): live shared-drive photos by content hash (re-hashed by the drive), each for the event or the gallery.
          if (photos !== undefined && (!Array.isArray(photos) || photos.length > 6 || photos.some((p: any) => !p || typeof p.sha256 !== "string" || !["event", "gallery"].includes(p.use))))
            throw new AccessError("website_photos_invalid");
          const drivePhotos = (photos ?? []).map((p: any) => { const d = drive.read(p.sha256); return { sha256: "sha256:" + d.sha256, data: d.data, use: p.use as "event" | "gallery" }; });
          // TEAM-TASKS T3: a request made from a VERIFIED team-task result keeps that reference (re-verified now, audience-checked).
          return w.request(m.memberId, rest, rest?.flyerProposalId !== undefined ? needFlyers().source(m, rest.flyerProposalId) : null,
            fromTask !== undefined ? needTeamTasks().websiteSource(m, fromTask) : null, drivePhotos); },
        "website.read": async (b: any, m) => { reviewer(m); needWebsite(); return websiteApply!.prStatus(String(b?.requestId ?? "")); },
        // Update the open draft (C-4): the open/merged state of PRs an unapproved proposal could update is read from GitHub first (cached 60 s).
        "website.list": async (_b, m) => { reviewer(m); const w = needWebsite(); await websiteApply!.refreshTargets();
          return { requests: w.list().requests.map((r: any) => websiteApply!.view(r.requestId)) }; },
        // Owner (Oct 23): discard a proposal that was never approved (any reviewer; out of the list; its flyer copy removed).
        "website.discard": async (b: any, m) => { reviewer(m); needWebsite().discard(m.memberId, b ?? {}); return { discarded: true }; },
        "website.preview.check": async (b: any, m) => { reviewer(m); needWebsite(); return websiteApply!.checkPreview(String(b?.requestId ?? "")); },
        // P-2(a): a reviewer adds meeting notes as text (<= 48 KiB .md/.txt or pasted); never a reply trigger.
        "intake.upload": async (b: any, m) => { reviewer(m); return intake.submitWeb(m.memberId, b ?? {}); },
        "agent.ask": async (b: any, m) => chat.ask(membersQa, { operationId: randomUUID(), conversationId: conversationOf(m.memberId), question: String(b.question ?? "").slice(0, 2000) }),
        "notes.read": async () => ({ files: readdirSync(join(c.folder, "members", "notes")).filter((f) => /^\d{4}-\d{2}-\d{2}\.v\d+\.md$/.test(f)).sort() }),
        // Members audience only: one approved notes version by exact file name (no paths).
        "notes.get": async (b: any) => { const f = String(b.file ?? ""); if (!/^\d{4}-\d{2}-\d{2}\.v\d+\.md$/.test(f)) throw new AccessError("notes_file_invalid");
          return { file: f, markdown: readFileSync(join(c.folder, "members", "notes", f), "utf8") }; },
        "draft.list": async (_b, m) => { reviewer(m);
          const byDispatch = new Map((await approvals()).filter((a) => a.matched).map((a) => [a.dispatchId, a]));
          return { drafts: await Promise.all(reports.list().map(async (d) => { const a = byDispatch.get(d.dispatchId);
            return { ...d, title: await orgReadTask(rt.authority, d.taskId).then((t) => t.title, () => null),
              approvedBy: a ? { email: a.approvedBy.email, membershipVersion: a.approvedBy.membershipVersion, planHash: a.planHash, approvedAt: a.approvedAt, authn: a.authn } : null }; })) }; },
        "approval.list": async (_b, m) => { reviewer(m);
          return { approvals: await Promise.all((await approvals()).map(async (a) => ({ ...a, title: a.taskId ? await orgReadTask(rt.authority, a.taskId).then((t) => t.title, () => null) : null }))) }; },
        "draft.read": async (b: any, m) => { reviewer(m); return { document: reports.readDocument(String(b.documentId)) ?? null }; },
        // Reviewers see accepted submissions (subject + submitter + time) to choose what to adopt; never quarantine content.
        "intake.list": async (_b, m) => { reviewer(m);
          return { intakes: (sqlite.db.prepare(`SELECT r.intake_id, r.member_id, r.received_at FROM intake_records r LEFT JOIN intake_archive a USING(intake_id)
            WHERE r.state='accepted' AND a.intake_id IS NULL ORDER BY r.received_at DESC LIMIT 100`).all() as any[])
            .filter((r) => existsSync(join(c.folder, "reviewers-private", "intake", r.intake_id, "message.md"))).map((r) => {
            const msg = readFileSync(join(c.folder, "reviewers-private", "intake", r.intake_id, "message.md"), "utf8");
            const email = (sqlite.db.prepare("SELECT email FROM access_members WHERE member_id=?").get(r.member_id) as { email: string } | undefined)?.email ?? null;
            const firstLine = msg.split("\n\n").slice(1).join("\n").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l) ?? "";
            return { intakeId: r.intake_id, subject: (/^Subject: (.*)$/m.exec(msg)?.[1] ?? "").slice(0, 200), snippet: firstLine.slice(0, 140), from: email, receivedAt: r.received_at,
              adoptedTaskId: (sqlite.db.prepare("SELECT task_id FROM intake_adoptions WHERE intake_id=?").get(r.intake_id) as { task_id: string } | undefined)?.task_id ?? null };
          }) }; },
        // Reviewers: the system prepares the exact plan for an adopted Task (snapshot of reviewers-private/intake, the
        // preparer agent, the fixed instructions); approval is a separate consequential action on its plan hash.
        "plan.prepare": async (b: any, m) => { reviewer(m);
          const taskId = String(b.taskId), mat = materialFor(taskId);
          const snap = await kit.snapshot({ instanceId: mat.instanceId, scope: { kind: "folder", rootId: "rp", relativeDirectory: mat.relativeDirectory }, select: mat.select })
            .catch((e) => { throw planMaterialError(e); });
          const sourceHash = createHash("sha256").update(JSON.stringify(snap.manifest.entries)).digest("hex"), files = snap.manifest?.entries?.length ?? null;
          const shape = (p: any) => { const last = p.versions.at(-1)!; return { proposalId: p.proposalId, expectedRevision: p.revision, version: last.version, planHash: last.planHash, plan: last.plan, files }; };
          // N-3: an unapproved plan for the same Task over the same material is returned again, not duplicated; new
          // material gets a new plan (the older one simply stays unapproved).
          const open = sqlite.db.prepare("SELECT proposal_id, source_hash FROM plan_pending WHERE task_id=?").get(taskId) as { proposal_id: string; source_hash: string } | undefined;
          if (open?.source_hash === sourceHash) { const p: any = await api.read(open.proposal_id); if (!p.dispatchId) return shape(p); }
          const op = randomUUID(), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
          const roster = await rt.authority.taskDelegationAgents(taskId, { operationId: op, expiresAt, instanceId: mat.instanceId, source: snap.source });
          const ag: any = roster.agents.find((x: any) => x.id === mat.instanceId);
          if (!ag?.available) throw new AccessError("plan_agent_unavailable");
          const p = (await api.create({ operationId: op, draft: { operationId: op, taskId, revision: roster.task.revision, agentId: mat.instanceId, recipient: ag.recipient, grantPlan: ag.grantPlan,
            sourceHash: roster.task.sourceHash, includeNotes: true, includeComments: false, includeReferences: false, instructions: mat.instructions } }))!;
          sqlite.write(() => sqlite.db.prepare("INSERT INTO plan_pending(task_id,proposal_id,source_hash) VALUES (?,?,?) ON CONFLICT(task_id) DO UPDATE SET proposal_id=excluded.proposal_id, source_hash=excluded.source_hash").run(taskId, p.proposalId, sourceHash));
          return shape(p); },
        // Audience-filtered (reviewers: all rows; a member: their own), with the member's email for display.
        "audit.read": async (_b, m) => replies.audit(m).map((r) => ({ ...r,
          member_email: r.member_id ? (sqlite.db.prepare("SELECT email FROM access_members WHERE member_id=?").get(String(r.member_id)) as { email: string } | undefined)?.email ?? null : null })),
        // C-2 chat: the member's own conversations; reads/polls re-check visibility each time (D-1).
        "chat.conversation.create": async (b: any, m) => needChat().create(m, b ?? {}),
        "chat.conversation.rename": async (b: any, m) => needChat().rename(m, b ?? {}),
        // J2: with {drafts: true}, also the member's OWN newsletter drafts (the Newsletter page); never another member's.
        "chat.conversation.list": async (b: any, m) => { const l = needChat().list(m);
          if (b?.drafts !== true) return l;
          // J2 option a: reviewers and admins also see the drafts OTHER members shared with reviewers (never their chats).
          return { ...l, drafts: chatTools ? chatTools.newsletterDrafts(l.conversations.map((c: any) => c.conversationId)) : [],
            sharedDrafts: chatTools && ["admin", "reviewer"].includes(m.role) ? chatTools.newsletterDrafts([], { sharedBy: "others", memberId: m.memberId }) : [] }; },
        // J2 option a: the owner shares one newsletter draft with reviewers, or stops (audited).
        "chat.draft.share": async (b: any, m) => { const conv = needChat().own(m.memberId, b?.conversationId);
          if (!chatTools) throw new AccessError("chat_not_configured"); return chatTools.shareDraft(conv.id, b?.artifactId, m.memberId, b?.share !== false); },
        "chat.conversation.read": async (b: any, m) => { const r = needChat().read(m, b ?? {});
          // Cards render from runtime rows only (R-4): the open envelope and the artifact versions with their provenance.
          return { ...r, envelope: r.adminRead ? null : drafts!.open(r.conversation.conversationId), artifacts: r.adminRead ? [] : withDriveImages(r.conversation.conversationId, chatTools!.versions(r.conversation.conversationId)),
            // PACKAGE P: a member's link the drafting turn left out, said in plain words under the reply (never silent).
            linkGaps: r.adminRead ? null : chatTools!.memberLinkGaps(r.conversation.conversationId),
            uploads: r.adminRead ? [] : files.uploads(m.memberId, r.conversation.conversationId),
            images: r.adminRead || !images ? [] : images.list(m.memberId, r.conversation.conversationId),
            flyers: r.adminRead || !flyers ? [] : flyers.list(m.memberId, r.conversation.conversationId) }; },
        "chat.draft.card": async (b: any, m) => { needChat(); return drafts!.card(m.memberId, b ?? {}); },
        "chat.upload": async (b: any, m) => files.upload(m.memberId, b ?? {}),
        // IMAGES-V1 I1: mint a single-use image upload for one's own conversation; the bytes arrive on the streamed PUT.
        "image.upload": async (b: any, m) => needImages().mint(m, b ?? {}),
        // IMAGES-V1 I2: the member confirmed sending this flyer to the hosted model; the proposal comes back to check.
        "image.extract": async (b: any, m) => needFlyers().extract(m, b ?? {}),
        "image.proposal.save": async (b: any, m) => needFlyers().save(m, b ?? {}),
        "chat.upload.share": async (b: any, m) => files.share(m.memberId, b ?? {}),
        // The stored preview HTML of one version in the member's own conversation (the UI puts it in a sandboxed iframe).
        "chat.artifact.preview": async (b: any, m) => { const conv = { id: draftConversation(m, b?.conversationId, b?.artifactId, { ownerOnly: true }) };
          const d = chatTools!.displayHtml(conv.id, String(b?.artifactId ?? ""), Number(b?.version));
          if (d === null) throw new AccessError("chat_artifact_unknown");
          return { html: d.html, rerendered: d.rerendered }; },
        "files.list": async (_b, m) => ({ ...files.list(m), images: drive.list().map((i) => i.published ? { ...i, sentIn: publicFiles.sentReleasesOf(i.sha256) } : i),
          imagesEnabled: !!images, publicRoute }),
        // LIBRARY L1 (Fable P-4): the shared drive.
        "files.upload": async (b: any, m) => drive.uploadText(m, b ?? {}),
        "files.delete": async (b: any, m) => drive.remove(m, b ?? {}),
        "image.drive.save": async (b: any, m) => needImages().saveToDrive(m, b ?? {}),
        // S1-b: enrolling an authenticator (session-fresh routine actions; the Ops-minted token binds the member).
        "totp.enroll.start": async (b: any, m) => access.totpEnrollStart(m, b ?? {}),
        "totp.enroll.confirm": async (b: any, m) => access.totpEnrollConfirm(m, b ?? {}),
        // S2-a (Fable R-4): freeze a release from a reviewed chat newsletter version the approver can read.
        "newsletter.release.prepare": async (b: any, m) => {
          if (!newsletter) throw new AccessError("totp_not_configured");
          if (!["admin", "reviewer"].includes(m.role)) throw new AccessError("access_role_not_permitted"); // Fable S2-a N-2
          const conv = { conversationId: draftConversation(m, b?.conversationId, b?.artifactId) }; // own, admin-readable, or shared (J2 a)
          const d = chatTools!.newsletterVersion(conv.conversationId, String(b?.artifactId ?? ""), Number(b?.version));
          if (!d) throw new AccessError("newsletter_draft_unavailable");
          // LIBRARY L2 (Fable Addendum 3): a draft with shared-drive images is prepared ONLY through newsletter.release.publish.
          if (driveImagesOf(d.html, c.orgId).length) throw new AccessError("newsletter_release_needs_publish");
          await audience.refresh(); // S3-c: the recipient snapshot is a FRESH read, never a stale cache
          return newsletter.prepareDraft({ title: d.content.title, html: d.html, text: newsletterText(d.content), renderer: d.renderer, links: d.links });
        },
        // S2-a (Fable R-1/R-2): "Send me a test" to the member's own verified email.
        "newsletter.test": async (b: any, m) => { if (!newsletter) throw new AccessError("totp_not_configured"); return newsletter.sendTest(m.memberId, b ?? {}); },
        // S2-c (Fable R-8): the release card's facts (admins/reviewers).
        "newsletter.release.view": async (b: any, m) => {
          if (!newsletter) throw new AccessError("totp_not_configured");
          if (!["admin", "reviewer"].includes(m.role)) throw new AccessError("access_role_not_permitted");
          if (audience.current() === null) await audience.refresh(); // the card's "current recipients": refreshed once stale
          return newsletter.card(m.memberId, b ?? {});
        },
        // WC-2 (Fable R-8): a reviewer refreshes the website copy (12 per org per 24 h; joins a running sync).
        "website.content.refresh": async (_b, m) => { reviewer(m); if (!websiteContent) throw new AccessError("website_not_configured"); return { ...(await websiteContent.refresh()), status: websiteContent.status() }; },
        "files.read": async (b: any, m) => files.read(m, b ?? {}),
        "chat.turn.start": async (b: any, m) => needChat().startTurn(m, b ?? {}),
        // H2 cite chips: {map:true} also returns the turn's frozen system map, after readTurn's owner check.
        "chat.turn.read": async (b: any, m) => { const r = needChat().readTurn(m, b ?? {}); return b?.map === true ? { ...r, map: chatTools?.mapOf(String(b.turnId)) ?? null } : r; },
        "chat.turn.stop": async (b: any, m) => needChat().stopTurn(m, b ?? {}),
        // TEAM-TASKS-V1 T1: typed text only (F-1); prepare-only plans; reads within the audience.
        "teamtask.disclose": async (b: any, m) => needTeamTasks().disclose(m, b ?? {}),
        "teamtask.create": async (b: any, m) => needTeamTasks().create(m, b ?? {}),
        "teamtask.propose": async (b: any, m) => needTeamTasks().propose(m, b ?? {}),
        // SCHEDULED-TASKS-V1 S1: routine schedule actions (the handler checks roles and the audience).
        "teamtask.schedule.propose": async (b: any, m) => needSchedules().propose(m, b ?? {}),
        "teamtask.schedule.read": async (b: any, m) => needSchedules().read(m, b ?? {}),
        "teamtask.schedule.list": async (_b, m) => needSchedules().list(m),
        "teamtask.schedule.pause": async (b: any, m) => needSchedules().pause(m, b ?? {}),
        "teamtask.schedule.pause.all": async (_b, m) => needSchedules().pauseAll(m),
        // H2: read (any member; the handbook is members-readable) and preview an edit (reviewers; NOTHING is written).
        "handbook.read": async (b: any, _m) => { const h = needHandbook(), v = b?.version === undefined ? null : Number(b.version);
          const pick = v === null ? h.active() : h.get(v);
          if (v !== null && !pick) throw new AccessError("handbook_input_invalid");
          return { enabled: true, handbook: pick ? { version: pick.version, content: pick.content, sha256: pick.sha256, bytes: pick.bytes, approvedAt: pick.approvedAt } : null,
            activeVersion: h.active()?.version ?? null, history: h.history() }; },
        "handbook.propose": async (b: any, m) => { const h = needHandbook(); reviewerOnly(m.role);
          const p = h.preview(b?.content);
          // Fable C-E: what an approval interrupts, content-free (H1's handbookGate makes both true).
          return { ...p, cost: handbookCost(p.bytes), schedulesToPause: schedules ? schedules.activeTitles() : [], inFlight: teamTasks ? teamTasks.handbookImpact() : { running: 0, plans: 0 } }; },
        "teamtask.read": async (b: any, m) => {
          if (b?.resultId) return needTeamTasks().result(m, b);
          if (b?.mapOf) return needTeamTasks().mapOf(m, b); // H2: a system-map chip (audience-checked like the task)
          const t = needTeamTasks().read(m, b ?? {});
          // T3: Website requests made from this task's verified results, with their current PR state; "verified" only after the
          // pack read back the commit (pr.state done), never on allocation or an open request.
          const outcomes = website ? website.fromTask(t.taskId).map((id) => { const v = websiteApply!.view(id) as any;
            return { kind: "website", requestId: id, state: v.state, label: v.label, title: v.summary?.title ?? null,
              pr: v.pr ? { state: v.pr.state, number: v.pr.number, url: v.pr.url, previewPageUrl: v.pr.previewPageUrl, verified: v.pr.state === "done" } : null }; }) : [];
          return { ...t, outcomes }; },
        "teamtask.list": async (_b, m) => ({ ...needTeamTasks().list(m), scheduler: needTeamTasks().schedulerFact() }),
        "member.me": async (_b, m) => ({ memberId: m.memberId, role: m.role, orgId: c.orgId, label: c.label, transcription: !!tJobs, chat: !!chatStore, website: !!website,
          newsletter: !!newsletter,
          // USABILITY v1: the UI shows "Send me a test" only when a test sender exists, and hides email-intake wording without intake.
          // Package E (Ops, 24 Oct): and only to the roles newsletter.test admits (admins/reviewers), so a contributor is never offered it.
          newsletterTest: !!(nlc && nlc.testFrom && nlc.testKeyFile) && ["admin", "reviewer"].includes(m.role), // E-10 (b): tests need the test key
          emailIntake: c.installations.length > 0, images: !!images, imageExtract: !!flyers && flyers.qualified, teamTasks: !!teamTasks, handbook: !!handbookStore,
          email: (sqlite.db.prepare("SELECT email FROM access_members WHERE member_id=?").get(m.memberId) as { email: string }).email }),
      }),
      actions: setupGuard({
        "task.adopt": async (b: any, z) => {
          // T-5: a transcript part range (Fable R-5): validated against the caps, one Task per range, sourceRef bound natively.
          if (b?.transcriptJobId !== undefined) {
            const r = needJobs().partRange(b, TRANSCRIPT_CAPS);
            if (sqlite.db.prepare("SELECT 1 FROM transcript_adoptions WHERE job_id=? AND first_part=? AND last_part=?").get(r.jobId, r.first, r.last)) throw new AccessError("adopt_already_adopted");
            // Fable T-5 N-1: two Tasks over the same transcript lines would duplicate the notes material.
            if (sqlite.db.prepare("SELECT 1 FROM transcript_adoptions WHERE job_id=? AND first_part<=? AND last_part>=?").get(r.jobId, r.last, r.first)) throw new AccessError("adopt_transcript_parts_overlap");
            const { documentId } = await rt.authority.allocate(`adopt-transcript:${r.jobId}:${r.first}-${r.last}`, "kilgore/task", String(b.title));
            const res = await rt.authority.orgTaskCommand({ operationId: z.operationId, documentId, documentType: "kilgore/task", expectedRevision: 0, type: "CREATE_TASK",
              input: { id: documentId, title: String(b.title), ownerId: "owner", source: "HUMAN", sourceRef: `transcript:${r.jobId}#p${r.first}-p${r.last}` } }, principal(z.memberId),
              { memberId: z.memberId, action: z.action, bodyHash: z.bodyHash, operationId: z.operationId });
            if (res.result.disposition === "ACCEPTED")
              sqlite.write(() => sqlite.db.prepare("INSERT INTO transcript_adoptions(task_id,job_id,first_part,last_part,member_id,at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
                .run(documentId, r.jobId, r.first, r.last, z.memberId, new Date().toISOString()));
            return { ...res, taskId: documentId };
          }
          // One Task per intake: a recorded adoption refuses a second adopt; the allocation is also keyed by the intake, so
          // even a racing second adopt reaches the same document and cannot create another Task.
          const intakeId = String(b.intakeId);
          if (!(sqlite.db.prepare("SELECT 1 FROM intake_records WHERE intake_id=? AND state='accepted'").get(intakeId))) throw new AccessError("adopt_intake_unknown");
          if (sqlite.db.prepare("SELECT 1 FROM intake_adoptions WHERE intake_id=?").get(intakeId)) throw new AccessError("adopt_already_adopted");
          if (sqlite.db.prepare("SELECT 1 FROM intake_archive WHERE intake_id=?").get(intakeId)) throw new AccessError("adopt_intake_archived");
          const { documentId } = await rt.authority.allocate(`adopt:${intakeId}`, "kilgore/task", String(b.title));
          const r = await rt.authority.orgTaskCommand({ operationId: z.operationId, documentId, documentType: "kilgore/task", expectedRevision: 0, type: "CREATE_TASK",
            input: { id: documentId, title: String(b.title), ownerId: "owner", source: "HUMAN", sourceRef: `intake:${intakeId}` } }, principal(z.memberId),
            { memberId: z.memberId, action: z.action, bodyHash: z.bodyHash, operationId: z.operationId });
          if (r.result.disposition === "ACCEPTED")
            sqlite.write(() => sqlite.db.prepare("INSERT INTO intake_adoptions(intake_id,task_id,member_id,at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run(intakeId, documentId, z.memberId, new Date().toISOString()));
          return { ...r, taskId: documentId };
        },
        "proposal.approve": async (b: any, z) => {
          // A-1: the approval must be over the exact plan: the bound artifact digest IS the plan hash being approved.
          if (!z.artifactDigest || z.artifactDigest !== b.planHash) throw new AccessError("approve_plan_digest_mismatch");
          const item = (await api.approveAndSend(String(b.proposalId), { operationId: z.operationId, expectedRevision: b.expectedRevision, version: b.version, planHash: b.planHash })).item;
          // The approved plan runs once, in the background; the reviewer polls draft.list.
          // N-4: a run that ends without a published draft (refused at claim, provider rejected, uncertain) is audited with
          // its fixed label or settled status, and counted in Ops status, so a missing draft is explainable.
          if (item?.dispatchId) { const id = item.dispatchId;
            const failed = (detail: string) => { try { sqlite.write(() => sqlite.db.prepare("INSERT INTO intake_audit(at,event,intake_id,detail) VALUES (?, 'draft_run_failed', NULL, ?)").run(new Date().toISOString(), detail)); } catch { /* store fault */ } };
            // Runs are chained per org: a second approval while the preparer is busy waits instead of failing kit_instance_busy.
            runChain = runChain.then(() => exec.run(id)).then(() => exec.drain()).then(() => exec.status(id)).then((st: any) => { if (st?.status !== "REPORT_PUBLISHED")
              failed(`${String(st?.status ?? "draft_run_unknown").slice(0, 40)}${/^[a-z][a-z0-9_]{2,63}$/.test(String(st?.reason)) ? ":" + st.reason : ""}`); },
              (e) => failed(e instanceof Error && /^[a-z][a-z0-9_]{2,63}$/.test(e.message) ? e.message : "draft_run_error"));
          }
          return item;
        },
        // N-2: every approved notes version links to a real private draft.
        "notes.approve": async (b: any, z) => { const draft = reports.readDocument(String(b.reportId));
          if (!draft) throw new AccessError("notes_report_unknown");
          const r = writeApprovedNotes(c.folder, z, b, draft.markdown); files.notesApproved(r.path, z.memberId, z.operationId); return r; },
        // T-3: transcription (session-fresh start with the audio digest + attestation; discard releases a queued reservation).
        "transcript.start": async (b: any, z) => needJobs().start(z, b),
        // C-5: approve exactly the draft plan card (session-fresh; artifact digest = the card hash).
        "chat.draft.approve": async (b: any, z) => { needChat(); return drafts!.approve(z, b ?? {}); },
        // Website pack W-3: approve exactly the proposal card (session-fresh); the push runs on the website chain.
        "website.apply": async (b: any, z) => { needWebsite(); return websiteApply!.approve(z, b ?? {}); },
        // TEAM-TASKS-V1 T1 (session-fresh): approve exactly one plan (artifact digest = plan digest); cancel; mark a verified result done.
        "teamtask.approve": async (b: any, z) => needTeamTasks().approve(z, memberRole(z.memberId), b ?? {}),
        "teamtask.schedule.approve": async (b: any, z) => needSchedules().approve(z, memberRole(z.memberId), b ?? {}),
        "teamtask.schedule.resume": async (b: any, z) => needSchedules().resume(z, memberRole(z.memberId), b ?? {}),
        "teamtask.schedule.run_now": async (b: any, z) => needSchedules().runNow(z, memberRole(z.memberId), b ?? {}),
        // H2: activate EXACTLY the previewed text (artifact digest = its sha256) from the version the editor started from; the same
        // authority transaction pauses every active schedule (D-3). Receipts to the actor and every admin (receiptFor).
        "handbook.approve": async (b: any, z) => { const h = needHandbook(); reviewerOnly(memberRole(z.memberId).role);
          if (!z.artifactDigest) throw new AccessError("handbook_digest_mismatch"); // Fable C-B: the challenge binds the text's digest
          let paused = 0;
          const v = h.approve({ content: b?.content, expectedPrev: b?.expectedPrev ?? null, expectedSha256: z.artifactDigest, proposedBy: z.memberId, approvedBy: z.memberId,
            onActivate: (version) => { paused = schedules ? schedules.pauseForHandbook(version) : 0; } });
          return { version: v.version, sha256: v.sha256, schedulesPaused: paused }; },
        "teamtask.cancel": async (b: any, z) => needTeamTasks().cancel(z, memberRole(z.memberId), b ?? {}),
        "teamtask.complete": async (b: any, z) => needTeamTasks().complete(z, memberRole(z.memberId), b ?? {}),
        // S1-c: the approval (authorization + `approved` effect) was written in the TOTP verification transaction; this reads it.
        // S3-c (R-8): the response returns now; the executor starts in the background.
        // LIBRARY L2 (Fable Addendum 3, P-1..P-3): prepare a release whose draft carries shared-drive images. The approval binds
        // the exact set of hashes (artifact digest); the images are published first, then the usual prepare fetches them at
        // their real public URLs (E-2) exactly as a mail client will. A failed prepare leaves them to the sweep (P-2).
        "newsletter.release.publish": async (b: any, z) => {
          if (!newsletter) throw new AccessError("totp_not_configured");
          const m = memberRole(z.memberId);
          if (!["admin", "reviewer"].includes(m.role)) throw new AccessError("access_role_not_permitted");
          const conv = { conversationId: draftConversation(m as never, b?.conversationId, b?.artifactId) }; // own, admin-readable, or shared (J2 a)
          const d = chatTools!.newsletterVersion(conv.conversationId, String(b?.artifactId ?? ""), Number(b?.version));
          if (!d) throw new AccessError("newsletter_draft_unavailable");
          const shas = driveImagesOf(d.html, c.orgId);
          if (!shas.length) throw new AccessError("newsletter_release_no_drive_images");
          if (z.artifactDigest !== publishDigest(shas)) throw new AccessError("newsletter_publish_list_changed");
          const pub = publicFiles.publish(z.memberId, shas);
          try {
            await audience.refresh();
            const r = await newsletter.prepareDraft({ title: d.content.title, html: d.html, text: newsletterText(d.content), renderer: d.renderer, links: d.links });
            publicFiles.link(r.releaseId, shas, conv.conversationId, String(b.artifactId));
            return { ...r, published: pub.published, alreadyPublic: pub.already };
          } finally { publicFiles.sweep(); } // superseded prepares of this draft, or this one if it failed (P-2)
        },
        "files.unpublish": async (b: any, z) => publicFiles.unpublish(memberRole(z.memberId), b ?? {}),
        "newsletter.send": async (b: any) => { if (!newsletter) throw new AccessError("totp_not_configured"); setImmediate(kick); return newsletter.view(b?.releaseId); },
        "transcript.discard": async (b: any, z) => needJobs().discard(z, b),
        // T-4: accepting starts the D-2 clock (audio deleted at accept + acceptPlusDays; 0 = now).
        "transcript.accept": async (b: any, z) => needJobs().accept(z, b),
        // `totp` tier: refused before this handler until an authenticator-app step exists; Ops uses /ops/policy/approve meanwhile.
        "policy.approve": async (b: any, z) => replies.approvePolicy(z, b),
      }),
    }));
    // One backup at a time; a scheduled tick while one runs is skipped. Failures are counted with a fixed label, never thrown.
    const backupNow = async () => {
      if (!c.backup) throw new AccessError("org_backup_not_configured");
      if (backups.running) throw new AccessError("org_backup_in_progress");
      const p = (async () => {
        try {
          const { dir, set } = await backupOrg({ orgId: c.orgId, authority: rt.authority, sqlite, stateRoot: c.stateRoot, folder: c.folder, backupRoot: c.backup!.dir, now: o.now });
          const pruned = pruneOrgBackups(c.backup!.dir, c.orgId, c.backup!.keep);
          backups.last = { set: basename(dir), at: set.at, files: set.files.length }; backups.lastError = null; backups.ok++;
          return { ...backups.last, skipped: set.skipped.length, pruned: pruned.length };
        } catch (e) {
          backups.failed++; backups.lastError = e instanceof Error && /^[a-z][a-z0-9_]{2,63}$/.test(e.message) ? e.message : "org_backup_failed";
          throw new AccessError(backups.lastError);
        } finally { backups.running = null; }
      })();
      backups.running = p;
      return p;
    };
    if (c.backup) {
      backups.timer = setInterval(() => { if (!backups.running) void backupNow().catch(() => {}); }, c.backup.everyMinutes * 60_000);
      backups.timer.unref();
      // Overdue at start (none yet, or the newest is older than the interval): take one now, in the background.
      const newest = listOrgBackups(c.backup.dir, c.orgId)[0];
      const newestAt = newest ? Date.parse(JSON.parse(readFileSync(join(c.backup.dir, newest, "set.json"), "utf8")).at) : 0;
      if (Date.now() - newestAt >= c.backup.everyMinutes * 60_000) setImmediate(() => { if (!backups.running) void backupNow().catch(() => {}); });
    }
    servers.push(await serveOps(c.opsSocket, {
      "/ops/backup/now": () => backupNow(),
      "/ops/intake/archive": (b) => {
        // Fable archiving F-1: an override must be within the same bounds as the config; anything else is refused, not clamped.
        const p = intakeArchiveSchema.partial().safeParse(b ?? {});
        if (!p.success) throw new AccessError("intake_archive_params_invalid");
        return archiveIntake(p.data);
      },
      "/ops/intake/restore": (b) => restoreIntake(String(b?.intakeId ?? "")),
      // B1 / option A: the first admin's one-time email link (this socket is owner-only; the link is given out of band).
      // Fable P-R1: the link is the ONE secret-bearing field (no separate token); revocable by email or invitation id.
      "/ops/bootstrap/invite": (b) => { const { token, ...r } = access.bootstrapInvite(String(b.email ?? "")); return { ...r, link: `${c.origins[0]}/o/${c.orgId}/invite#token=${token}` }; },
      "/ops/bootstrap/revoke": (b) => access.opsRevokeInvitations("bootstrap", b ?? {}),
      // Option A: the `totp`-tier actions, here until an authenticator-app step exists (refused in the app meanwhile).
      "/ops/member/list": () => ({ members: access.opsMembers() }),
      "/ops/member/invite": (b) => { const { token, ...r } = access.opsInvite(String(b?.email ?? ""), b?.role); return { ...r, link: `${c.origins[0]}/o/${c.orgId}/invite#token=${token}` }; },
      "/ops/member/invite/revoke": (b) => access.opsRevokeInvitations("member", b ?? {}),
      "/ops/member/remove": (b) => access.opsRemoveMember(String(b?.email ?? "")),
      "/ops/member/role": (b) => access.opsSetRole(String(b?.email ?? ""), b?.role),
      "/ops/policy/approve": (b) => {
        const p = replyPolicySchema.safeParse(b?.policy);
        if (!p.success) throw new AccessError("reply_policy_invalid");
        return replies.approvePolicy(access.opsAuthorization("policy.approve", p.data, policyHash(p.data)), p.data);
      },
      "/ops/intake/token/issue": (b) => {
        if (!intake.emailConfigured) throw new AccessError("intake_not_configured");
        const inst = b?.installationId === undefined ? installationId! : String(b.installationId);
        if (!c.installations.some((i) => i.installationId === inst)) throw new AccessError("intake_installation_unknown");
        const m = access.opsMembers().find((x) => x.email === String(b?.email ?? "").toLowerCase() && x.status === "active");
        if (!m) throw new AccessError("access_member_unknown");
        return { email: m.email, ...intake.issueToken(m.memberId, inst) };
      },
      // Option A / Fable R-3: the transcription policy (backend profile, retention, notice text) is `totp` tier, so Ops approves it.
      "/ops/transcription/policy/approve": (b) => {
        if (!tProfile) throw new AccessError("transcription_not_configured");
        const p = transcriptionPolicySchema.safeParse(b?.policy);
        if (!p.success) throw new AccessError("transcription_policy_invalid");
        if (p.data.profileHash !== transcriptionProfileHash(tProfile)) throw new AccessError("transcription_policy_profile_mismatch");
        return tPolicies.approve(access.opsAuthorization("transcription.policy.approve", p.data, transcriptionPolicyHash(p.data)), p.data);
      },
      // T-4 (D-2): a hold pauses both deletion clocks (explicit authority, audited); a sweep applies them now.
      "/ops/transcription/hold": (b) => needJobs().hold(b?.jobId, b?.on === true, b?.reason),
      "/ops/transcription/sweep": () => needJobs().sweep(),
      "/ops/chat/sweep": () => needChat().sweep(),
      // TEAM-TASKS-V1 N-6: resolve Needs reconciliation from durable evidence only; and the team-task kill switch.
      // S2 (Fable N-3): after the normal reconcile, settle held schedule reservations whose ledger rows are now definitive.
      "/ops/teamtasks/reconcile": (b) => { const r = needTeamTasks().reconcile(b); return schedules ? { ...r, scheduleBudget: schedules.settleHeld() } : r; },
      // S1 (Fable F-1): the Ops pause also aborts a running schedule-attached attempt (ordinary attempts keep their behaviour).
      "/ops/teamtasks/pause": (b) => { const r = needTeamTasks().setPaused(b?.on === true); if (b?.on === true) schedules?.abortRunning(); return r; },
      // Website pack (Fable R-6): resume an unsettled push read-first (never a blind retry).
      // S1-b: Ops mints a single-use 15-minute enrollment link (token in the fragment) and revokes factors.
      "/ops/totp/enroll": (b) => { const { token, ...r } = access.opsTotpEnroll(String(b?.email ?? "")); return { ...r, link: `${c.origins[0]}/o/${c.orgId}/#totp?token=${token}` }; },
      "/ops/totp/revoke": (b) => access.opsTotpRevoke(String(b?.email ?? "")),
      // S1-c: the runtime-local newsletter kill switch (checked at mint and inside the approval transaction).
      "/ops/newsletter/kill": (b) => { if (!newsletter) throw new AccessError("totp_not_configured"); return newsletter.setKill(!!b?.on); },
      // S2-c (Fable R-9): the owner's offline send-history index (Ops socket only; counts returned, no entries echoed).
      // S3-c (Fable R-7): the cutover facts, owner-attested, validated and audited by hash (the fixture recorders stay test-only).
      "/ops/newsletter/transfer": (b) => { if (!newsletter) throw new AccessError("totp_not_configured"); return newsletter.transferOps(b); },
      "/ops/newsletter/suppression-sync": (b) => { if (!newsletter) throw new AccessError("totp_not_configured"); return newsletter.suppressionSyncOps(b); },
      "/ops/newsletter/old-audience-retired": (b) => { if (!newsletter) throw new AccessError("totp_not_configured"); return newsletter.oldAudienceRetiredOps(b); },
      "/ops/newsletter/history/import": (b) => { if (!newsletter) throw new AccessError("totp_not_configured"); return newsletter.importHistoryOps(b ?? {}); },
      "/ops/website/resume": (b) => { needWebsite(); return websiteApply!.resume(String(b?.operationId ?? "")); },
      "/ops/intake/token/revoke": (b) => {
        if (!intake.emailConfigured) throw new AccessError("intake_not_configured");
        const m = access.opsMembers().find((x) => x.email === String(b?.email ?? "").toLowerCase());
        if (!m) throw new AccessError("access_member_unknown");
        intake.revokeTokens(m.memberId); return { email: m.email, revoked: true };
      },
      "/ops/envelope-key/add": (b) => { access.addEnvelopeKey(String(b.kid), b.publicJwk); return { kid: b.kid }; },
      "/ops/envelope-key/retire": (b) => { access.retireEnvelopeKey(String(b.kid)); return { kid: b.kid }; },
      "/ops/reply-kill": (b) => { replies.setKill(!!b.on); return { on: !!b.on }; },
      "/ops/status": () => ({ orgId: c.orgId, installationId: sqlite.identity.installationId, membershipVersion: access.membershipVersion(), preparer, membersQa, swept,
        // P-1: email intake (null under `--intake none`); web submissions are counted separately.
        intake: c.installations.length ? { installations: c.installations.map((i) => ({ installationId: i.installationId, provider: i.provider, domain: i.domain })) } : null,
        teamTasks: teamTasks ? { recovered: teamTasksRecovered } : null,
        website: website ? { repo: c.website!.repo, dailyRequest: c.website!.dailyRequest, dailyApply: c.website!.dailyApply, recovered: websiteRecovered, prs: websiteApply!.ledger.status() } : null,
        websiteContent: websiteContent ? websiteContent.status() : null,
        // Member-reply policy (no policy text): active, and whether its pins match this host (false = triggers pause).
        replyPolicy: replies.policyStatus(),
        totp: access.totpStatus(),
        // S3-c (R-8): the executor runs only with key + list id + sender; its last result and error label (no content).
        images: images ? images.stats() : null,
        // LIBRARY L1/L2: content-free counts (drive images, bytes, removed, text files; public / unpublished / quarantined / incidents).
        library: { publicRoute, ...drive.stats(), ...publicFiles.stats() },
        newsletter: newsletter ? { ...newsletter.status(), providerConfigured: !!executor,
          executor: executor ? { running: !!nlRun.running, last: nlRun.last, lastError: nlRun.lastError } : null } : null,
        webSubmissions: (sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_records WHERE installation_id='web-reviewer'").get() as { n: number }).n,
        triggerFailures: (sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_audit WHERE event='reply_trigger_failed'").get() as { n: number }).n,
        transcription: tProfile ? { backend: tProfile.backend, profileId: tProfile.id, profileHash: transcriptionProfileHash(tProfile), monthlyUsd: c.transcription!.monthlyUsd,
          qualificationRef: c.transcription!.qualificationRef, limits: tProfile.limits, policy: ((p) => p ? { hash: p.hash, version: p.policy.version } : null)(tPolicies.active()),
          ...media!.stats(), ...tJobs!.deletionStats(), spend: tLedger!.status(), recovered: tRecovered,
          // Fable T-5 N-2: the Transcript preparer's walk bound (1000 entries) counts these, like the intake folder.
          transcriptEntries: readdirSync(tJobs!.dir).reduce((n, d) => n + 1 + (statSync(join(tJobs!.dir, d)).isDirectory() ? readdirSync(join(tJobs!.dir, d)).length : 0), 0) } : null,
        chat: chatStore ? { ...chatStore.stats(), recovered: chatRecovered, titlesBackfilled, profileId: chatProfile!.id, qualificationRef: chatProfile!.qualificationRef } : null,
        // N-3 (option A): approval receipts the hub could not send, by mail label.
        receiptFailures: (sqlite.db.prepare("SELECT reason FROM access_audit WHERE action='receipt.failed'").all() as { reason: string }[]).reduce((m, r) => {
          const k = r.reason.replace(/^receipt_send_failed:/, "").replace(/;to:.*$/, ""); m[k] = (m[k] ?? 0) + 1; return m; }, {} as Record<string, number>),
        draftRunFailures: (sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_audit WHERE event='draft_run_failed'").get() as { n: number }).n,
        draftRunFailureReasons: Object.fromEntries((sqlite.db.prepare("SELECT detail, COUNT(*) AS n FROM intake_audit WHERE event='draft_run_failed' GROUP BY detail").all() as { detail: string; n: number }[]).map((r) => [r.detail, r.n])),
        intakeArchive: { ...archiveCfg, ...archiveStats, startMoved: firstArchive.moved, archivedTotal: (sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_archive").get() as { n: number }).n, intakeEntries: entriesIn() },
        backup: c.backup ? { everyMinutes: c.backup.everyMinutes, keep: c.backup.keep, running: !!backups.running, last: backups.last, lastError: backups.lastError, ok: backups.ok, failed: backups.failed,
          sets: listOrgBackups(c.backup.dir, c.orgId).length,
          // B1 (Fable B-5): per directory, files live vs in the newest set, and any unclassified state dir (content-free counts).
          coverage: (() => { try { return backupCoverage({ orgId: c.orgId, stateRoot: c.stateRoot, folder: c.folder, backupRoot: c.backup!.dir }); }
            catch { return { error: "org_backup_coverage_unreadable" }; } })() } : null }),
    }));
    return { library: { drive, publicFiles }, handbook: handbookStore, config: c, rt, sqlite, access, intake, kit, exec, chat, replies, reports, api, preparer, membersQa, swept, backupNow, transcription: { profile: tProfile, policies: tPolicies, media, jobs: tJobs, ledger: tLedger }, conversations: chatStore, drafts, chatTools, files, website, websiteApply, websiteContent, newsletter, teamTasks,
      /** S3-c: the background executor (null without key + list + sender); `idle` resolves when the current pass ends. */
      images,
      newsletterRun: executor ? { kick, idle: async () => { while (nlRun.running) await nlRun.running; }, audience } : null, close };
  } catch (e) { await close().catch(() => {}); throw e; }
}

/** The owner-only Ops socket: JSON POST routes, fixed error labels, 0600 in a 0700 directory, never dialled by the hub. */
async function serveOps(path: string, routes: Record<string, (body: any) => unknown | Promise<unknown>>) {
  if (existsSync(path)) { assert(lstatSync(path).isSocket(), "ops_socket_path_occupied"); unlinkSync(path); }
  const server = createServer(async (req, res) => {
    const send = (s: number, b: unknown) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    try {
      const chunks: Buffer[] = []; let n = 0;
      for await (const x of req) { n += (x as Buffer).length; if (n > 64 * 1024) return send(413, { ok: false, error: "ops_body_too_large" }); chunks.push(x as Buffer); }
      const route = routes[req.url ?? ""];
      if (req.method !== "POST" || !route) return send(404, { ok: false, error: "ops_route" });
      send(200, { ok: true, ...(await route(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}) as object) });
    } catch (e) { send(403, { ok: false, error: errLabel(e) }); }
  });
  await new Promise<void>((r, j) => { server.once("error", j); server.listen(path, () => r()); });
  chmodSync(path, 0o600);
  return server;
}
