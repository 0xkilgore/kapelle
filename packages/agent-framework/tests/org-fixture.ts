// Two synthetic org runtimes (SQLite), one shared hub with fake mail and fake email ingress, and helpers to bootstrap an
// admin, invite members, log in, run authorized actions (option A: email-session step-up; `totp`-tier actions as Ops) and
// deliver signed inbound email. Lean runtime step 4.
import { expect } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { openFrameworkRuntime } from "../src/service/runtime.js";
import type { SqliteAuthority } from "../src/service/sqlite-authority.js";
import { OrgAccess } from "../src/access/org-access.js";
import { serveOrgAccess, type ConsequentialHandler, type RoutineHandler } from "../src/access/socket.js";
import { Hub, type HubOrg } from "../src/hub/hub.js";
import { OrgIntake, signWebhook } from "../src/org/intake.js";
import { RP, ORIGIN } from "./soft-authenticator.js";
import { withKitFacts, type KitHost } from "../src/agent-kit/kit-host.js";
import { orgReadTask } from "../src/org/org-tasks.js";
import { context } from "./fixtures.js";

const shortDir = (p: string) => { const d = realpathSync(mkdtempSync(join("/tmp", p))); chmodSync(d, 0o700); return d; };
export type Member = { memberId: string; email: string; cookie: string };
export type Org = Awaited<ReturnType<typeof makeOrg>>;
export type OrgCore = { orgId: string; rt: Awaited<ReturnType<typeof openFrameworkRuntime>>; sqlite: SqliteAuthority; access: OrgAccess; intake: OrgIntake; folder: string; root: string;
  installationId: string; setKit(kit: KitHost, exec: { resultFacts(): Promise<unknown[]> } | null): void };
type ExtraOut = { routines?: Record<string, RoutineHandler>; actions?: Record<string, ConsequentialHandler>; extra?: Record<string, unknown>; onAccepted?: (intakeId: string) => void };
type Extra = (org: OrgCore) => Promise<ExtraOut> | ExtraOut;

async function makeOrg(orgId: string, hubKeys: string, opened: { close(): Promise<void> }[], extra?: Extra) {
  const root = shortDir(`k4-${orgId}-`), state = join(root, "s"), folder = join(root, "f");
  for (const d of [state, folder, join(root, "run")]) mkdirSync(d, { mode: 0o700 });
  // Org Tasks are read from this org's own authority; kit facts attach lazily once a KitHost is opened.
  const holder: { kit: KitHost | null; exec: { resultFacts(): Promise<unknown[]> } | null; authority?: any } = { kit: null, exec: null };
  const base = context();
  const kitFacts = withKitFacts((async () => ({ ...base, definitions: [], resources: [], dispatch: { parents: [], agents: [], tasks: [], sources: [], results: [] } })) as never, () => holder.kit);
  const rt = await openFrameworkRuntime({ stateRoot: state, reactorRoot: process.env.KAPELLE_SCOPED_REACTOR_ROOT!, ownerId: "owner", scopeRef: base.scopeRef,
    taskDelegation: { readTask: (id: string) => orgReadTask(holder.authority, id), permissionRef: "task-delegation:owner" },
    facts: async () => { const f: any = await kitFacts(); return { ...f, dispatch: { ...f.dispatch, results: holder.exec ? await holder.exec.resultFacts() : [] } }; },
    backend: "sqlite" } as never);
  holder.authority = rt.authority;
  opened.push(rt);
  const sqlite = (rt as unknown as { sqlite: SqliteAuthority }).sqlite;
  const access = new OrgAccess(sqlite, { orgId, rpId: RP, origins: [ORIGIN] });
  const kp = generateKeyPairSync("ed25519"); access.addEnvelopeKey("k1", kp.publicKey.export({ format: "jwk" }));
  const keyFile = join(hubKeys, `${orgId}.pem`); writeFileSync(keyFile, kp.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const installationId = `inst-${orgId}`, secret = randomBytes(24).toString("base64url"), domain = `${orgId}.in.kapelle.test`;
  const intake = new OrgIntake(sqlite, { orgId, folder, installations: [{ installationId, secret, domain }] });
  const memberActive = (id: string) => !!sqlite.db.prepare("SELECT 1 FROM access_members WHERE member_id=? AND status='active'").get(id);
  const more = (await extra?.({ orgId, rt, sqlite, access, intake, folder, root, installationId, setKit: (k, e) => { holder.kit = k; holder.exec = e; } })) ?? {};
  const socketPath = join(root, "run", "access.sock");
  const server = await serveOrgAccess(access, socketPath, { intake: { intake, memberActive, onAccepted: more.onAccepted },
    routines: more.routines, actions: more.actions });
  opened.push({ close: () => new Promise<void>((r) => server.close(() => r())) });
  const hubOrg: HubOrg = { orgId, installationId: sqlite.identity.installationId, socketPath, kid: "k1", keyFile, origin: ORIGIN };
  return { orgId, rt, sqlite, access, intake, folder, root, installationId, secret, domain, socketPath, hubOrg, key: kp.privateKey, memberActive, actions: more.actions ?? {}, ...(more.extra ?? {}) };
}

export async function makeWorld(orgIds: string[], extra?: Extra) {
  const opened: { close(): Promise<void> }[] = [], hubKeys = shortDir("k4-hub-"), mail: { orgId: string; to: string; kind: string; link: string }[] = [];
  const orgs: Record<string, Org> = {};
  for (const id of orgIds) orgs[id] = await makeOrg(id, hubKeys, opened, extra);
  const hub = new Hub(Object.values(orgs).map((o) => o.hubOrg), (m) => mail.push(m), () => Date.now(),
    Object.values(orgs).map((o) => ({ installationId: o.installationId, orgId: o.orgId, secret: o.secret })));
  const server = await hub.listen(); opened.push({ close: () => new Promise<void>((r) => server.close(() => r())) });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const http = async (path: string, body?: unknown, cookie = "", headers: Record<string, string> = {}, raw?: string) => {
    const r = await fetch(base + path, { method: body === undefined && raw === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as any, setCookie: r.headers.get("set-cookie") ?? "" };
  };
  const flush = () => new Promise((r) => setImmediate(r));
  const login = async (org: Org, email: string) => {
    mail.length = 0;
    expect((await http(`/o/${org.orgId}/login`, { email })).status).toBe(202);
    await flush();
    const link = mail.find((m) => m.kind === "login" && m.to === email);
    expect(link, `login mail for ${email}`).toBeTruthy();
    const r = await http(`/o/${org.orgId}/magic?token=${new URL(link!.link).searchParams.get("token")}`);
    expect(r.status).toBe(200);
    return r.setCookie.split(";")[0];
  };
  let opn = 0;
  const act = async (org: Org, m: Member, action: string, body: unknown, artifactDigest: string | null = null, operationId = `op-${action}-${String(++opn).padStart(6, "0")}`) => {
    const ch = await http(`/o/${org.orgId}/challenge`, { action, body, artifactDigest, operationId }, m.cookie);
    if (!ch.body.ok) return ch;
    return http(`/o/${org.orgId}/act`, { challengeId: ch.body.challengeId, action, body, artifactDigest, operationId }, m.cookie);
  };
  /** Option A: a `totp`-tier action performed by Ops (the owner-only socket's path), answered in the hub's response shape. */
  const opsAct = async (org: Org, action: string, body: unknown, artifactDigest: string | null = null) => {
    try { const z = org.access.opsAuthorization(action, body, artifactDigest), h = (org.actions as Record<string, ConsequentialHandler>)[action];
      if (!h) return { status: 403, body: { ok: false, error: "access_action_not_installed" } as any };
      return { status: 200, body: { ok: true, authorization: z, result: await h(body, z) } as any };
    } catch (e: any) { return { status: 403, body: { ok: false, error: e?.reason ?? "access_internal_error" } as any }; }
  };
  /** Option A: a member's private submission address is issued by Ops. */
  const issueAddress = (org: Org, m: { memberId: string }) => org.intake.issueToken(m.memberId, org.installationId).address;
  /** Accept an invitation link through the hub: admits the member and returns the session cookie it opens. */
  const accept = async (org: Org, token: string) => {
    const r = await http(`/o/${org.orgId}/invite/accept`, { token });
    expect(r.body.ok, JSON.stringify(r.body)).toBe(true);
    return { memberId: r.body.memberId as string, cookie: r.setCookie.split(";")[0] };
  };
  const admins: Record<string, Member> = {};
  const bootstrap = async (org: Org, email = `admin@${org.orgId}.test`) => {
    const r = await accept(org, org.access.bootstrapInvite(email).token);
    admins[org.orgId] = { memberId: r.memberId, email, cookie: r.cookie };
    return admins[org.orgId];
  };
  const invite = async (org: Org, email: string, role: "admin" | "reviewer" | "contributor"): Promise<Member> => {
    const r = await accept(org, org.access.opsInvite(email, role).token);
    return { memberId: r.memberId, email, cookie: r.cookie };
  };
  /** Deliver a signed inbound email through the hub ingress (fake provider). */
  const deliver = async (org: Org, data: Record<string, unknown>, o: { secret?: string; installationId?: string; timestamp?: number; id?: string; tamper?: boolean } = {}) => {
    const installationId = o.installationId ?? org.installationId, id = o.id ?? `msg_${randomBytes(8).toString("hex")}`;
    const ts = String(Math.floor((o.timestamp ?? Date.now()) / 1000));
    const raw = JSON.stringify({ type: "email.received", data: { email_id: id, message_id: `<${id}@sender.test>`, from: "someone@sender.test", subject: "Meeting notes", cc: [], headers: {}, attachments: [], ...data } });
    const sig = signWebhook(o.secret ?? org.secret, installationId, id, ts, raw);
    return { id, raw, ...(await http(`/ingress/email/${installationId}`, undefined, "", { "webhook-id": id, "webhook-timestamp": ts, "webhook-signature": sig }, o.tamper ? raw.replace("Meeting", "Meetinq") : raw)) };
  };
  return { orgs, hub, http, flush, login, act, opsAct, issueAddress, accept, bootstrap, invite, deliver, mail, admins,
    close: async () => { for (const o of opened.reverse()) await o.close().catch(() => {}); } };
}
