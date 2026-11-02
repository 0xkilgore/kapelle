// Production admin tool for ONE org on one Linux server (deployment package, prepared not run). Bundled by Ops to
// bin/kapelle-admin.mjs. One JSON line out; fixed labels on failure; never prints a secret or model text.
//   render  --org <id> --label <text> --domain <host> --monthly-usd <owner-approved cap> [--installation-id <uuid>] [--profile sonnet|flash-lite] [--root <scratch dir, tests only>]
//   render ... --out <scratch dir>   Package F: the same files into <dir> with the PRODUCTION paths inside (no chgrp, nothing under /etc)
//   validate-config <org.json>       Package F: read-only; the runtime's own schema; exit 0 {ok:true} | exit 1 {ok:false,reason,issues}
//           [--intake resend|fake|none]  (fake = the signed TEST provider, never on a public host; none = no email intake: no
//           installation, no hub ingress, no webhook secret or receive key; reviewers add meeting notes in the web app)
//           [--mail-from "EXNA <noreply@domain>"]  (B2: sign-in/invite mail via Resend; absent = links go to the hub spool)
//           [--transcription fake|deepgram --transcription-usd <owner-approved monthly cap>]  (transcription; absent = off)
//           [--website-repo owner/name --website-author "Name <email>" --website-preview-hosts "*.vercel.app,..."]  (website pack; absent = off)
//           writes <etc>/catalog.json, <etc>/orgs/<id>.json and (with --installation-id) <etc>/hub-config.json, every one parsed by
//           the real schemas before it is written; the catalog pin is computed, never typed. Secrets are FILE PATHS only.
//   verify-qualification <profile: sonnet|flash-lite> <report.json>   Fable F-8: the report attests THIS pinned profile
//   verify-interactive-qualification <report.json>   the chat (interactive) profile's pinned report attests THIS profile
//   pinned-qualification-refs                      Package E (Fable E-16): READ-ONLY: the code-pinned qualification refs
//                                                   {"chat","flyer","teamtask"} (install.sh cross-checks CHAT_REPORT_SHA and
//                                                   TT_REPORT_SHA against them). Reads no file, no secret, no network.
//   verify-flyer-qualification <report.json>        IMAGES-V1: the flyer profile's pinned report attests THIS profile
//   verify-teamtask-qualification <report.json> [sha256:…]  TEAM-TASKS-V1 T2c: a passing live task-path report for THIS chat profile,
//                                                   catalog, task rules and executor (Ops' GO for --team-tasks-run on cites its sha)
//   verify-newsletter-qualification <report.json>    the newsletter slice-3 FINAL live report attests THIS connector (pinned sha);
//                                                    prints the listField and From domain the production render pins
//   render ... [--chat-enable on [--chat-daily-turns <1..200, default 20>] [--chat-admins-read-all off|on, default off]]  (chat; absent = off)
//   render ... [--images-enable on [--images-extract on]]  (IMAGES-V1: chat flyer/image attachments; needs chat; the decoder socket
//              /run/kapelle-images/<org>.sock; --images-extract on = "Read this flyer" (refused until the image profile is qualified))
//   render ... [--team-tasks on [--team-tasks-run on]]  (TEAM-TASKS-V1: the Tasks page; needs chat; --team-tasks-run on installs the
//              production executor (the chat profile + catalog, one model slot shared with chat); without it approvals refuse)
//   render ... [--newsletter-enable on [--newsletter-approvers a@example.org,b@example.com]]  (newsletter slice 1: the TOTP step-up; expects
//              /etc/kapelle/secrets/<org>/totp.key; approvers are emails resolved at use to an active admin/reviewer; absent = off)
//   keypair <privatePemOut>          an Ed25519 envelope key for the hub (0600 PEM); prints the PUBLIC JWK for /ops/envelope-key/add
//   ops <org-config.json> <route> [json-body]   POST to that org's owner-only Ops socket (status, envelope-key/add, reply-kill, backup/now;
//                                               option A: bootstrap/invite, member/{invite,list,role,remove}, policy/approve, intake/token/{issue,revoke})
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { request } from "node:http";
import { orgRuntimeConfigSchema } from "../src/org/org-runtime.js";
import { hubConfigSchema } from "../src/hub/hub-launcher.js";
import { runtimeCatalogSchema } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { OPENROUTER_PROFILES } from "../src/agent-kit/hosted/openrouter.js";
import { verifyQualificationReport } from "../src/agent-kit/hosted/qualification.js";
import { INTERACTIVE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";
import { verifyInteractiveQualificationReport } from "../src/agent-kit/interactive/qualification.js";
import { verifyNewsletterQualificationReport } from "../src/org/newsletter/qualification.js";
import { verifyFlyerQualificationReport } from "../src/agent-kit/interactive/flyer-qualification.js";
import { verifyTeamTaskQualificationReport, TEAMTASK_QUALIFICATION_REF } from "../src/org/teamtasks/qualification.js";
import { IMAGE_PROFILES } from "../src/agent-kit/interactive/openrouter.js";

const out = (v: unknown, code = 0) => { console.log(JSON.stringify(v)); process.exit(code); };
const label = (e: unknown) => (e instanceof Error && /^[a-z][a-z0-9_]{2,63}$/.test(e.message) ? e.message : "admin_error");
const arg = (args: string[], name: string) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : undefined; };
const write = (path: string, value: unknown) => { writeFileSync(path, JSON.stringify(value, null, 1) + "\n", { mode: 0o640 }); chmodSync(path, 0o640); return path; };

/** The server layout, in ONE place (deploy/systemd/*.service and deploy/README.md use the same paths). `root` is "" on the
 *  server and a scratch directory in tests. */
export function layout(o: { org: string; root?: string }) {
  const r = (p: string) => (o.root ?? "") + p, etc = r("/etc/kapelle"), orgVar = r(`/var/lib/kapelle/${o.org}`);
  return {
    etc, catalog: join(etc, "catalog.json"), orgConfig: join(etc, "orgs", `${o.org}.json`), hubConfig: join(etc, "hub-config.json"),
    stateRoot: join(orgVar, "state"), folder: join(orgVar, "folder"), opsSocket: join(orgVar, "ops", "ops.sock"),
    accessSocket: r(`/run/kapelle-access/${o.org}/access.sock`), backupDir: r(`/var/backups/kapelle/${o.org}`),
    webhookSecret: join(etc, "secrets", o.org, "resend-webhook.whsec"), openrouterKey: join(etc, "secrets", o.org, "openrouter.key"),
    resendApiKey: join(etc, "secrets", o.org, "resend-api.key"), // B3: the org's Resend key for the Receiving API
    envelopeKey: join(etc, "secrets", "hub", `${o.org}-envelope.pem`), hubSpool: r("/var/lib/kapelle-hub/spool"),
    // B2: the hub's Resend SENDING key (sign-in/invite links only), readable by the hub user only.
    hubMailKey: join(etc, "secrets", "hub", "resend-send.key"),
    // Transcription (Fable R-1): the org's Deepgram key, owner-only, read by that org's runtime only.
    transcriptionKey: join(etc, "secrets", o.org, "deepgram.key"),
    // Website pack: the org's fine-grained GitHub PAT (one repo; contents/PR write, metadata/statuses/deployments read).
    githubPat: join(etc, "secrets", o.org, "github-website.pat"),
    // Newsletter send slice 1 (Fable R-5): the per-org TOTP seed key (32 random bytes, base64, 0600 org user), outside the
    // DB and the backup set; expected only when the newsletter block is rendered.
    totpKey: join(etc, "secrets", o.org, "totp.key"),
    // Newsletter slice 2 (Fable R-10): the org runtime's copy of the agent@ send-only key, for TEST sends only.
    newsletterTestKey: join(etc, "secrets", o.org, "resend-test.key"),
    // Newsletter slice 3 (Fable R-4): the EXNA team's full-access release key (by secret request; never the hub's).
    newsletterReleaseKey: join(etc, "secrets", o.org, "resend-release.key"),
  };
}

export function render(o: { org: string; label: string; domain: string; monthlyUsd: number; root?: string; out?: string; installationId?: string; profile?: keyof typeof OPENROUTER_PROFILES;
  intake?: "resend" | "fake" | "none"; mailFrom?: string; transcription?: "fake" | "deepgram"; transcriptionUsd?: number;
  website?: { repo: string; author: string; previewHosts: string; coAuthor?: string };
  chat?: { enable?: string; dailyTurns?: string; adminsReadAll?: string }; images?: { enable?: string; extract?: string }; teamTasks?: { enable?: string; run?: string }; newsletter?: { enable?: string; approvers?: string; from?: string; replyTo?: string; testFrom?: string; listId?: string } }) {
  // Fable deploy review: the org's monthly model spend cap is an OWNER decision, never a default.
  if (!(Number.isFinite(o.monthlyUsd) && o.monthlyUsd > 0 && o.monthlyUsd <= 10_000)) throw new Error("render_monthly_usd_required");
  const intake = o.intake ?? "resend";
  // The transcription monthly cap is an OWNER decision (D-1), separate from inference, never a default.
  if (o.transcription && !(["fake", "deepgram"].includes(o.transcription) && Number.isFinite(o.transcriptionUsd) && o.transcriptionUsd! > 0 && o.transcriptionUsd! <= 1000))
    throw new Error("render_transcription_invalid");
  if (!["resend", "fake", "none"].includes(intake)) throw new Error("render_intake_invalid");
  const email = intake !== "none";
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(o.org)) throw new Error("render_org_invalid");
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(o.domain)) throw new Error("render_domain_invalid");
  const L = layout({ org: o.org, root: o.root }), profile = OPENROUTER_PROFILES[o.profile ?? "sonnet"];
  if (o.newsletter && o.newsletter.enable !== "on") throw new Error("render_newsletter_enable_required");
  if (o.newsletter?.listId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(o.newsletter.listId)) throw new Error("render_newsletter_list_id_invalid");
  // S3-c (R-2): the list id brings the release key, which starts the executor: it needs the release sender too.
  if (o.newsletter?.listId && !(o.newsletter.from && o.newsletter.replyTo)) throw new Error("render_newsletter_sender_required");
  // Package F (Fable, Ops' pre-switch check): --out <dir> writes the SAME files into a scratch dir, with the production paths
  // INSIDE them (unlike --root, which prefixes every path); no chgrp, nothing under /etc. validate-config then checks the result.
  if (o.out !== undefined && (o.root !== undefined || !isAbsolute(o.out) || /^\/(etc|var|run)(\/|$)/.test(o.out))) throw new Error("render_out_invalid");
  const at = (p: string) => o.out === undefined ? p : p === L.catalog ? join(o.out, "catalog.json") : p === L.orgConfig ? join(o.out, "orgs", `${o.org}.json`) : join(o.out, "hub-config.json");
  for (const d of o.out === undefined ? [L.etc, join(L.etc, "orgs")] : [join(o.out, "orgs")]) mkdirSync(d, { recursive: true, mode: o.out === undefined ? 0o750 : 0o700 });
  write(at(L.catalog), runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [profile] }));
  const origin = `https://${o.domain}`;
  const org = orgRuntimeConfigSchema.parse({ contract: "kapelle.org-runtime/v1", orgId: o.org, label: o.label, stateRoot: L.stateRoot, folder: L.folder,
    accessSocket: L.accessSocket, opsSocket: L.opsSocket, groupAccess: true, rpId: o.domain, origins: [origin],
    installations: email ? [{ installationId: `${intake}-${o.org}`, domain: `in.${o.domain}`, secretFile: L.webhookSecret, provider: intake,
      ...(intake === "resend" ? { apiKeyFile: L.resendApiKey } : {}) }] : [],
    catalogPath: L.catalog, catalogSha256: catalogSha256(at(L.catalog)), hostedProfileId: profile.id,
    hosted: { secretFile: L.openrouterKey, monthlyUsd: o.monthlyUsd }, replyDomain: `reply.${o.domain}`,
    backup: { dir: L.backupDir, everyMinutes: 360, keep: 8 },
    ...(o.transcription ? { transcription: { backend: o.transcription, monthlyUsd: o.transcriptionUsd, ...(o.transcription === "deepgram" ? { secretFile: L.transcriptionKey } : {}) } } : {}),
    // Chat (owner/Director 2026-10-17): on only with --chat-enable on; the interactive profile is code-pinned and qualified; draft
    // envelopes are 5 turns / $2 (code); per-member turns per 24 h default 20; admins read all stays OFF unless explicitly "on" (D-1).
    ...(chatBlock(o.chat) ? { chat: chatBlock(o.chat) } : {}),
    // IMAGES-V1 I1: flyer/image attachments through the org's socket-activated decoder (deploy/systemd/kapelle-image-decode@).
    ...(imagesBlock(o.images, o.org, !!chatBlock(o.chat)) ? { images: imagesBlock(o.images, o.org, true) } : {}),
    ...(teamTasksBlock(o.teamTasks, !!chatBlock(o.chat)) ? { teamTasks: teamTasksBlock(o.teamTasks, true) } : {}),
    ...(o.newsletter ? { newsletter: { totpKeyFile: L.totpKey, approvers: (o.newsletter.approvers ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
      ...(o.newsletter.from ? { from: o.newsletter.from } : {}), ...(o.newsletter.replyTo ? { replyTo: o.newsletter.replyTo } : {}),
      ...(o.newsletter.testFrom ? { testFrom: o.newsletter.testFrom, testKeyFile: L.newsletterTestKey } : {}),
      // R-4: the list id and the release key come together from ONE flag (a key without a list, or the reverse, cannot render).
      ...(o.newsletter.listId ? { listId: o.newsletter.listId, releaseKeyFile: L.newsletterReleaseKey } : {}) } } : {}),
    ...(o.website ? { website: { repo: o.website.repo, author: person(o.website.author), coAuthor: person(o.website.coAuthor ?? "Kapelle agent <agent@example.org>"),
      patFile: L.githubPat, previewHosts: o.website.previewHosts.split(",").map((h) => h.trim()).filter(Boolean) } } : {}) });
  write(at(L.orgConfig), org);
  // Run as root (the runbook), render sets the group itself so a missed chgrp cannot leave the org unable to read its config.
  if (o.out === undefined) setGroup([L.catalog, L.orgConfig], `kapelle-${o.org}`);
  let hub: unknown = null;
  if (o.installationId) {
    hub = hubConfigSchema.parse({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 8700 }, mailSpool: L.hubSpool,
      orgs: [{ orgId: o.org, installationId: o.installationId, accessSocket: L.accessSocket, kid: "k1", keyFile: L.envelopeKey, origin }],
      // Fable deploy R-1: NO webhook secret on the hub; it routes, the org runtime verifies.
      ingress: email ? [{ installationId: `${intake}-${o.org}`, orgId: o.org, provider: intake }] : [],
      labels: { [o.org]: o.label }, ...(o.mailFrom ? { mail: { provider: "resend", from: o.mailFrom, apiKeyFile: L.hubMailKey } } : {}) });
    write(at(L.hubConfig), hub);
    if (o.out === undefined) setGroup([L.hubConfig], "kapelle-hub");
  }
  return { catalog: at(L.catalog), catalogSha256: org.catalogSha256, orgConfig: at(L.orgConfig), hubConfig: o.installationId ? at(L.hubConfig) : null, profileId: profile.id, ...(o.out !== undefined ? { out: o.out } : {}),
    monthlyUsd: o.monthlyUsd, mail: o.mailFrom ? "resend" : "spool", intake,
    secretsExpected: [...(email ? [L.webhookSecret] : []), L.openrouterKey, L.envelopeKey, ...(intake === "resend" ? [L.resendApiKey] : []), ...(o.transcription === "deepgram" ? [L.transcriptionKey] : []), ...(o.website ? [L.githubPat] : []), ...(o.newsletter ? [L.totpKey] : []), ...(o.newsletter?.testFrom ? [L.newsletterTestKey] : []), ...(o.newsletter?.listId ? [L.newsletterReleaseKey] : [])], directoriesExpected: [L.stateRoot, L.folder, join(L.opsSocket, ".."), L.backupDir, L.hubSpool] };
}

/** The --chat-* argv: a flag present without a value reads as "" so chatBlock refuses it (Fable N-1: a bare trailing
 *  --chat-enable used to read as absent and render chat off silently). No --chat-* flag at all = undefined (chat off). */
export function chatArgs(args: string[]) {
  const v = (n: string) => args.includes("--" + n) ? (arg(args, n) ?? "") : undefined;
  const c = { enable: v("chat-enable"), dailyTurns: v("chat-daily-turns"), adminsReadAll: v("chat-admins-read-all") };
  return Object.values(c).some((x) => x !== undefined) ? c : undefined;
}

function teamTasksBlock(t: { enable?: string; run?: string } | undefined, chat: boolean) {
  if (!t) return null;
  if (t.enable !== "on") throw new Error("render_team_tasks_enable_required");
  if (!chat) throw new Error("render_team_tasks_need_chat");
  if (t.run !== undefined && t.run !== "on") throw new Error("render_team_tasks_run_invalid");
  return { run: t.run === "on" ? "on" as const : "off" as const };
}
function imagesBlock(i: { enable?: string; extract?: string } | undefined, org: string, chat: boolean) {
  if (!i) return null;
  if (i.enable !== "on") throw new Error("render_images_enable_required");
  if (!chat) throw new Error("render_images_need_chat");
  if (i.extract !== undefined && i.extract !== "on") throw new Error("render_images_extract_invalid");
  return { decoder: { mode: "systemd" as const, socket: `/run/kapelle-images/${org}.sock` }, extract: i.extract === "on" };
}
function chatBlock(c: { enable?: string; dailyTurns?: string; adminsReadAll?: string } | undefined) {
  if (!c || (c.enable === undefined && c.dailyTurns === undefined && c.adminsReadAll === undefined)) return null;
  if (c.enable !== "on") throw new Error("render_chat_enable_required");
  const turns = c.dailyTurns === undefined ? 20 : Number(c.dailyTurns);
  if (!(Number.isInteger(turns) && turns >= 1 && turns <= 200)) throw new Error("render_chat_daily_turns_invalid");
  if (c.adminsReadAll !== undefined && !["on", "off"].includes(c.adminsReadAll)) throw new Error("render_chat_admins_read_all_invalid");
  return { profile: "sonnet", adminsReadAll: c.adminsReadAll === "on", dailyTurnsPerMember: turns, retentionDays: 365 };
}
/** "Name <email>" -> {name, email} (render input; the schema validates the address). */
function person(v: string) { const m = /^\s*([^<>]{1,100}?)\s*<([^<>\s]{3,200})>\s*$/.exec(v); if (!m) throw new Error("render_website_identity_invalid"); return { name: m[1], email: m[2] }; }
/** As root only: chgrp to a system group read from /etc/group (no group -> a fixed refusal, never a silent root:root file). */
function setGroup(files: string[], group: string) {
  if (process.getuid?.() !== 0) return;
  const line = readFileSync("/etc/group", "utf8").split("\n").find((l) => l.split(":")[0] === group);
  const gid = line ? Number(line.split(":")[2]) : NaN;
  if (!Number.isInteger(gid)) throw new Error("render_group_missing");
  for (const f of files) chownSync(f, 0, gid);
}
const ops = (socket: string, route: string, body: unknown): Promise<any> => new Promise((res, rej) => {
  const data = Buffer.from(JSON.stringify(body ?? {}));
  const r = request({ socketPath: socket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
    const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch (e) { rej(e); } }); });
  r.on("error", rej); r.end(data);
});

if (process.argv[1] && /kapelle-admin\.(m?js|ts)$/.test(process.argv[1])) {
  const [, , cmd, ...rest] = process.argv;
  try {
    if (cmd === "render") {
      const need = (n: string) => { const v = arg(rest, n); if (!v) throw new Error("render_missing_" + n.replace(/-/g, "_")); return v; };
      out({ ok: true, ...render({ org: need("org"), label: need("label"), domain: need("domain"), monthlyUsd: Number(need("monthly-usd")), root: arg(rest, "root"), out: arg(rest, "out"), installationId: arg(rest, "installation-id"),
        profile: (arg(rest, "profile") as never) ?? undefined, intake: (arg(rest, "intake") as never) ?? undefined, mailFrom: arg(rest, "mail-from"),
        transcription: (arg(rest, "transcription") as never) ?? undefined, transcriptionUsd: arg(rest, "transcription-usd") === undefined ? undefined : Number(arg(rest, "transcription-usd")),
        chat: chatArgs(rest), images: rest.includes("--images-enable") ? { enable: arg(rest, "images-enable") ?? "", ...(rest.includes("--images-extract") ? { extract: arg(rest, "images-extract") ?? "" } : {}) } : undefined,
        teamTasks: rest.includes("--team-tasks") ? { enable: arg(rest, "team-tasks") ?? "", ...(rest.includes("--team-tasks-run") ? { run: arg(rest, "team-tasks-run") ?? "" } : {}) } : undefined,
        newsletter: rest.includes("--newsletter-enable") ? { enable: arg(rest, "newsletter-enable") ?? "", approvers: arg(rest, "newsletter-approvers"),
          from: arg(rest, "newsletter-from"), replyTo: arg(rest, "newsletter-reply-to"), testFrom: arg(rest, "newsletter-test-from"),
          listId: arg(rest, "newsletter-list-id") } : undefined,
        website: arg(rest, "website-repo") ? { repo: arg(rest, "website-repo")!, author: need("website-author"), previewHosts: need("website-preview-hosts"), coAuthor: arg(rest, "website-co-author") } : undefined }) });
    } else if (cmd === "verify-interactive-qualification") {
      const [reportPath] = rest; if (!reportPath) throw new Error("verify_qualification_usage");
      const v = verifyInteractiveQualificationReport(INTERACTIVE_PROFILES.sonnet, readFileSync(reportPath)); out(v, v.ok ? 0 : 1);
    } else if (cmd === "pinned-qualification-refs") {
      out({ chat: INTERACTIVE_PROFILES.sonnet.qualificationRef, flyer: IMAGE_PROFILES.sonnet.qualificationRef, teamtask: TEAMTASK_QUALIFICATION_REF });
    } else if (cmd === "verify-flyer-qualification") {
      // IMAGES-V1 I2c: the flyer profile's pinned report attests THIS profile (hash, rules hash, image caps).
      const [reportPath] = rest; if (!reportPath) throw new Error("verify_qualification_usage");
      const v = verifyFlyerQualificationReport(IMAGE_PROFILES.sonnet, readFileSync(reportPath)); out(v, v.ok ? 0 : 1);
    } else if (cmd === "verify-teamtask-qualification") {
      const [reportPath, expected] = rest; if (!reportPath) throw new Error("verify_qualification_usage");
      const v = verifyTeamTaskQualificationReport(INTERACTIVE_PROFILES.sonnet, readFileSync(reportPath), expected); out(v, v.ok ? 0 : 1);
    } else if (cmd === "validate-config") {
      // Package F (Fable, Ops' pre-switch check): READ-ONLY. Parse <org.json> with the runtime's own orgRuntimeConfigSchema: exit 0
      // {ok:true}, or exit 1 with a fixed reason (+ the zod path and message per issue). No writes, no secret read (key FILE paths are
      // strings), no file-existence check, no network.
      const [file] = rest; if (!file || rest.length !== 1) { out({ ok: false, reason: "validate_config_usage" }, 2); }
      let text: string; try { text = readFileSync(file, "utf8"); } catch { out({ ok: false, reason: "org_config_unreadable" }, 1); }
      let json: unknown; try { json = JSON.parse(text!); } catch { out({ ok: false, reason: "org_config_malformed" }, 1); }
      const p = orgRuntimeConfigSchema.safeParse(json);
      out(p.success ? { ok: true } : { ok: false, reason: "org_config_invalid", issues: p.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: String(i.message).slice(0, 200) })) }, p.success ? 0 : 1);
    } else if (cmd === "verify-newsletter-qualification") {
      const [reportPath] = rest; if (!reportPath) throw new Error("verify_qualification_usage");
      const v = verifyNewsletterQualificationReport(readFileSync(reportPath)); out(v, v.ok ? 0 : 1);
    } else if (cmd === "verify-qualification") {
      const [key, reportPath] = rest; const profile = OPENROUTER_PROFILES[key as keyof typeof OPENROUTER_PROFILES];
      if (!profile || !reportPath) throw new Error("verify_qualification_usage");
      const v = verifyQualificationReport(profile, readFileSync(reportPath)); out(v, v.ok ? 0 : 1);
    } else if (cmd === "keypair") {
      const path = rest[0]; if (!path) throw new Error("keypair_missing_path"); if (existsSync(path)) throw new Error("keypair_exists");
      const kp = generateKeyPairSync("ed25519");
      writeFileSync(path, kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600, flag: "wx" });
      out({ ok: true, privateKey: path, publicJwk: kp.publicKey.export({ format: "jwk" }) });
    } else if (cmd === "ops") {
      const [configPath, route, body] = rest; if (!configPath || !route) throw new Error("ops_usage");
      if (!/^\/ops\/[a-z/-]{2,40}$/.test(route)) throw new Error("ops_route_invalid");
      const c = orgRuntimeConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
      const r = await ops(c.opsSocket, route, body ? JSON.parse(body) : {}); out(r, r.ok ? 0 : 1);
    } else out({ ok: false, error: "usage: render|validate-config|keypair|ops|verify-qualification|verify-interactive-qualification|pinned-qualification-refs|verify-newsletter-qualification|verify-flyer-qualification|verify-teamtask-qualification" }, 2);
  } catch (e) { out({ ok: false, error: label(e) }, 1); }
}
