// A real org runtime (FAKE transcription) behind the real hub, with an admin, a reviewer and a contributor who joined from Ops
// links, and helpers to upload, approve (session-bound challenge + act) and reach the Ops socket. Synthetic data only.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { openOrgRuntime } from "../src/org/org-runtime.js";
import { openHub } from "../src/hub/hub-launcher.js";
import { runtimeCatalogSchema, claudeProfileFromBinding } from "../src/agent-kit/runtime-catalog.js";
import { catalogSha256 } from "../src/agent-kit/kit-host.js";
import { TRANSCRIPTION_PROFILES, transcriptionProfileHash } from "../src/org/transcription/profile.js";
import type { TranscriptionBackend } from "../src/org/transcription/adapter.js";
import type { TranscriptionPolicy } from "../src/org/transcription/policy.js";
import type { TurnRunner } from "../src/org/chat/conversations.js";
import { hosted } from "./org-meeting-kit.js";
import { script } from "./org-meeting-script.js";
import { RP, ORIGIN } from "./soft-authenticator.js";

const W4 = { model: "claude-opus-5-5", credentialTeamId: "00000000-0000-4000-8000-000000000001", credentialKind: "claude-code-oauth" as const, runtime: "claude-agent-sdk" as const,
  sdkVersion: "0.2.90", cliVersion: "2.1.295", maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: "isolated" as const, thinking: "adaptive" as const, effort: "high" as const };
export const ATTESTATION = { authority: "Chair, per the EXNA Demo bylaws", announced: true as const, audience: "Members at the October meeting (synthetic)",
  declinedAlternative: "Written comments to the secretary" };
export const policyFor = (version = 1): TranscriptionPolicy => ({ contract: "kapelle.transcription-policy/v1", version, backend: "fake",
  profileHash: transcriptionProfileHash(TRANSCRIPTION_PROFILES.fake), retention: { acceptPlusDays: 7, hardCapDays: 30 },
  noticeText: "This meeting is recorded and transcribed for the meeting notes. Tell the chair if you would rather not be recorded." });

/** The scripted hosted model (org-meeting-script): answers AS the pinned profile, recording every prompt for assertions. */
function scriptedModel(prompts: { kind: "draft" | "chat"; system: string; user: string }[]) {
  return async (_url: string, init: any) => {
    const b = JSON.parse(init.body), system = String(b.messages[0].content), user = String(b.messages[1].content);
    const kind = system.includes("frozen copy of the agent") ? "chat" as const : "draft" as const;
    prompts.push({ kind, system, user });
    return new Response(JSON.stringify({ id: "gen-" + prompts.length, model: hosted.runtime.responseModels?.at(-1) ?? hosted.runtime.model,
      provider: (hosted.runtime.providerNames ?? hosted.runtime.providers)[0], choices: [{ finish_reason: "stop", message: { role: "assistant", content: script({ user, kind }) } }],
      usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020, cost: 0.0045 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}
/** Package E: the default image preflight fetch in every test world: CP's site, faked (never the network). Each URL serves
 *  fixed JPEG-typed bytes derived from the URL; a test passes its own fetch to simulate a gone or replaced image. */
export const fakeSiteImages = async (url: string, init: RequestInit) =>
  new Response(init.method === "HEAD" ? null : Buffer.from("IMG:" + url), { status: 200, headers: { "content-type": "image/jpeg" } });
export async function transcriptionWorld(o: { teamTasks?: boolean | "run"; teamTaskSchedules?: Record<string, unknown>; handbook?: Record<string, unknown>; teamTaskExecutor?: unknown; monthlyUsd?: number; backend?: TranscriptionBackend; backup?: boolean; model?: boolean; chat?: Record<string, unknown>; chatRunner?: TurnRunner; fetch?: (url: string, init: any) => Promise<Response>; intakeNone?: boolean; members?: boolean; website?: Record<string, unknown>; githubFetch?: unknown; websitePoll?: { everyMs: number; maxMs: number }; websiteContent?: { start?: boolean; everyMs?: number; deadlineMs?: number }; hostedKeyFile?: string; newsletter?: Record<string, unknown>; newsletterRecipients?: () => string[] | null; newsletterTestFetch?: unknown; newsletterImageFetch?: unknown; newsletterProviderFetch?: unknown; newsletterRetryMs?: number; newsletterAudienceMaxAgeMs?: number; newsletterChallengeFreshMs?: number; images?: Record<string, unknown>; label?: string; files?: Record<string, unknown> } = {}) {
  const prompts: { kind: "draft" | "chat"; system: string; user: string }[] = [];
  const base = realpathSync(mkdtempSync("/tmp/ktw-")); chmodSync(base, 0o700);
  const sub = (r: string, n: string) => { const d = join(r, n); mkdirSync(d, { mode: 0o700 }); return d; };
  const file = (p: string, c: string) => { writeFileSync(p, c, { mode: 0o600 }); return p; };
  const root = sub(base, "exna"), secrets = sub(root, "secrets");
  const catalogPath = file(join(root, "catalog.json"), JSON.stringify(runtimeCatalogSchema.parse({ contract: "kapelle.runtime-catalog/v1", profiles: [claudeProfileFromBinding("claude-current", W4, "x"), hosted] })));
  const cfg = { contract: "kapelle.org-runtime/v1", orgId: "exna", label: o.label ?? "EXNA", stateRoot: sub(root, "state"), folder: sub(root, "folder"), accessSocket: join(sub(root, "run"), "a.sock"),
    opsSocket: join(sub(root, "ops"), "o.sock"), rpId: RP, origins: [ORIGIN], installations: o.intakeNone ? [] : [{ installationId: "inst-exna", domain: "in.exna.test", secretFile: file(join(secrets, "wh"), randomBytes(24).toString("base64url")) }],
    catalogPath, catalogSha256: catalogSha256(catalogPath), hostedProfileId: "hosted-sonnet", hosted: { secretFile: o.hostedKeyFile ?? file(join(secrets, "k"), "sk-or-v1-SYNTHETIC"), monthlyUsd: Number(process.env.KAPELLE_QUALIFY_MAX_USD ?? 5) },
    replyDomain: "reply.exna.test", transcription: { backend: "fake", monthlyUsd: o.monthlyUsd ?? 3 },
    ...(o.backup ? { backup: { dir: join(base, "backups"), everyMinutes: 60, keep: 5 } } : {}),
    ...(o.chat ? { chat: o.chat } : {}),
    ...(o.newsletter ? { newsletter: o.newsletter } : {}),
    ...(o.handbook ? { handbook: o.handbook } : {}),
    ...(o.images ? { images: o.images } : {}),
    ...(o.files ? { files: o.files } : {}),
    ...(o.teamTasks ? { teamTasks: { ...(o.teamTasks === "run" ? { run: "on" } : {}), ...(o.teamTaskSchedules ? { schedules: o.teamTaskSchedules } : {}) } } : {}),
    ...(o.website ? { website: { repo: "0xkilgore/example-org-website", author: { name: "Alex Fixture", email: "alex@users.noreply.github.com" },
      coAuthor: { name: "Kapelle agent", email: "agent@example.org" }, patFile: file(join(secrets, "gh.pat"), "github_pat_SYNTHETIC0123456789abcdefghijklmnop"),
      previewHosts: ["*.vercel.app"], ...o.website } } : {}) };
  const open = () => openOrgRuntime(cfg, { fetchImpl: (o.fetch ?? (o.model ? scriptedModel(prompts) : async () => new Response("{}", { status: 503 }))) as never, ...(o.backend ? { transcriptionBackend: o.backend } : {}), ...(o.chatRunner ? { chatRunner: o.chatRunner } : {}), ...(o.githubFetch ? { githubFetch: o.githubFetch as never } : {}), ...(o.teamTaskExecutor ? { teamTaskExecutor: o.teamTaskExecutor as never } : {}), ...(o.websitePoll ? { websitePoll: o.websitePoll } : {}), ...(o.websiteContent ? { websiteContent: o.websiteContent } : {}), ...(o.newsletterRecipients ? { newsletterRecipients: o.newsletterRecipients } : {}), ...(o.newsletterTestFetch ? { newsletterTestFetch: o.newsletterTestFetch as never } : {}), ...({ newsletterImageFetch: (o.newsletterImageFetch ?? fakeSiteImages) as never }), ...(o.newsletterProviderFetch ? { newsletterProviderFetch: o.newsletterProviderFetch as never } : {}), ...(o.newsletterRetryMs ? { newsletterRetryMs: o.newsletterRetryMs } : {}), ...(o.newsletterAudienceMaxAgeMs ? { newsletterAudienceMaxAgeMs: o.newsletterAudienceMaxAgeMs } : {}), ...(o.newsletterChallengeFreshMs ? { newsletterChallengeFreshMs: o.newsletterChallengeFreshMs } : {}) });
  let org = await open();
  const ops = (route: string, body: unknown = {}): Promise<any> => new Promise((res, rej) => { const data = Buffer.from(JSON.stringify(body));
    const r = request({ socketPath: cfg.opsSocket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
      const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => res(JSON.parse(Buffer.concat(c).toString()))); }); r.on("error", rej); r.end(data); });
  const kp = generateKeyPairSync("ed25519"); await ops("/ops/envelope-key/add", { kid: "k1", publicJwk: kp.publicKey.export({ format: "jwk" }) });
  const mail: any[] = [];
  const hub = await openHub({ contract: "kapelle.hub/v1", listen: { host: "127.0.0.1", port: 0 }, mailSpool: sub(base, "spool"),
    orgs: [{ orgId: "exna", installationId: org.sqlite.identity.installationId, accessSocket: cfg.accessSocket, kid: "k1", keyFile: file(join(base, "k.pem"), kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string), origin: ORIGIN }],
    ingress: [], ...(o.files ? { filesHost: "files.example.org" } : {}) }, { mailer: (m) => mail.push(m) });
  const url = `http://127.0.0.1:${hub.port}`;
  const post = async (path: string, body: unknown, cookie: string) => (await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) })).json() as Promise<any>;
  const join_ = async (link: string) => { const r = await fetch(`${url}/o/exna/invite/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: new URL(link).hash.slice(7) }) });
    return (r.headers.get("set-cookie") ?? "").split(";")[0]; };
  // members:false leaves the org empty (bootstrap tests); otherwise an admin, a reviewer and a contributor join from Ops links.
  const none = o.members === false;
  const admin = none ? "" : await join_((await ops("/ops/bootstrap/invite", { email: "admin@exna.test" })).link);
  const robin = none ? "" : await join_((await ops("/ops/member/invite", { email: "robin@exna.test", role: "reviewer" })).link);
  const alex = none ? "" : await join_((await ops("/ops/member/invite", { email: "alex@exna.test", role: "contributor" })).link);
  const upload = async (cookie: string, b: Buffer, contentType = "audio/wav", fileName = "meeting.wav") => {
    const m = await post("/o/exna/api/media/upload", { fileName, size: b.length, contentType }, cookie);
    if (!m.ok) return m;
    return (await fetch(`${url}/o/exna/upload/${m.result.uploadId}`, { method: "PUT", headers: { "content-type": contentType, cookie }, body: new Uint8Array(b) })).json() as Promise<any>;
  };
  const act = async (cookie: string, action: string, body: unknown, artifactDigest: string | null = null) => {
    const operationId = randomUUID(), ch = await post("/o/exna/challenge", { action, body, artifactDigest, operationId }, cookie);
    if (!ch.ok) return ch;
    return post("/o/exna/act", { challengeId: ch.challengeId, action, body, artifactDigest, operationId }, cookie);
  };
  const start = (cookie: string, up: { jobId: string; audioSha256: string }, attestation: unknown = ATTESTATION) =>
    act(cookie, "transcript.start", { jobId: up.jobId, profileHash: transcriptionProfileHash(TRANSCRIPTION_PROFILES.fake), attestation }, up.audioSha256);
  return { prompts, base, cfg, hub, url, ops, post, mail, admin, robin, alex, join: join_, upload, act, start, get org() { return org; },
    /** Restart the org runtime (same config and store); the hub keeps its sessions. */
    restart: async () => { await org.close(); org = await open(); return org; },
    close: async () => { await hub.close(); await org.close(); } };
}
