// G-1 Product driver (Ops plan gap 1 + 2). `node g1-load.mjs <worldBase> <seconds> <ratePerOrgPerMin>`; one JSON line out.
// Synthetic data only. Drives, per org and through the same hub session API the review UI uses:
//   member Q&A (agent.ask)                                  every tick
//   adopt -> prepare plan -> approve -> draft               every 3rd tick, as the org's admin (orgs[].admin.email; option A:
//                                                           the email-link session is the step-up, fresh for the first hour)
//   quota: the org with the smallest monthlyUsd is pushed until the hosted spend cap refuses; the refusal shape is recorded
//   backup under load (org-1, at half time): /ops/backup/now, then restore into a NEW root, start a runtime on it, read
//   /ops/status, stop it. Needs org-1's config to carry a `backup` block; otherwise recorded as not_configured.
// Never prints model text: answers are reduced to lengths and statuses. Hub at G1_HUB_URL (default http://127.0.0.1:8700).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { randomUUID } from "node:crypto";
import { restoreOrgBackup } from "../src/org/org-backup.js";
import { notesDigest } from "../src/org/notes.js";

type World = { spool: string; orgs: { orgId: string; root: string; opsSocket: string; monthlyUsd: number;
  admin?: { email: string } }[] };
type OrgOut = { login: number | null; ask: { ok: number; refused: Record<string, number>; errors: Record<string, number>; p50: number | null; p95: number | null };
  plan: { adopted: number; prepared: number; approved: number; drafts: number; skipped: string | null; errors: Record<string, number>; sessionRefreshes: number };
  quota: null | { monthlyUsd: number; asksBeforeRefusal: number | null; refusal: unknown; draftRunFailureReasons?: Record<string, number> | null } };

const bump = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ops = (socket: string, route: string, body: unknown = {}): Promise<any> => new Promise((res, rej) => {
  const data = Buffer.from(JSON.stringify(body));
  const r = request({ socketPath: socket, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (x) => {
    const c: Buffer[] = []; x.on("data", (d) => c.push(d)); x.on("end", () => { try { res(JSON.parse(Buffer.concat(c).toString())); } catch (e) { rej(e); } }); });
  r.on("error", rej); r.end(data);
});

/** Sign in through the hub's spool without disturbing anyone else's mail: only a login mail to this address, newer than the request. */
async function login(hub: string, spool: string, orgId: string, email: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const since = Date.now() - 5;
    const r = await fetch(`${hub}/o/${orgId}/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const mail = readdirSync(spool).map((f) => join(spool, f)).filter((p) => { try { return statSync(p).mtimeMs >= since; } catch { return false; } })
        .map((p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } }).find((m) => m && m.kind === "login" && m.to === email && m.orgId === orgId);
      if (!mail) continue;
      const magic = await fetch(`${hub}/o/${orgId}/magic?token=${new URL(mail.link).searchParams.get("token")}`, { redirect: "manual" });
      const cookie = (magic.headers.get("set-cookie") ?? "").split(";")[0];
      if (cookie) return { status: r.status, cookie };
      break; // token already used (someone else read it): ask again
    }
  }
  return { status: null, cookie: "" };
}

export async function runLoad(worldBase: string, seconds: number, perMin: number, o: { hub?: string; startDelayMs?: number; openRuntime?: (config: unknown) => Promise<{ close(): Promise<void> }> } = {}) {
  const hub = o.hub ?? process.env.G1_HUB_URL ?? "http://127.0.0.1:8700";
  const w = JSON.parse(readFileSync(join(worldBase, "world.json"), "utf8")) as World;
  const out: { startedAt: string; seconds: number; ratePerOrgPerMin: number; orgs: Record<string, OrgOut>; backup: unknown; endedAt?: string } =
    { startedAt: new Date().toISOString(), seconds, ratePerOrgPerMin: perMin, orgs: {}, backup: null };
  const quotaOrg = w.orgs.length >= 2 ? [...w.orgs].sort((a, b) => a.monthlyUsd - b.monthlyUsd)[0].orgId : null;
  const gap = 60_000 / Math.max(perMin, 1);

  const backup = (async () => {
    const org1 = w.orgs[0]; await sleep(seconds * 500);
    const cfg = JSON.parse(readFileSync(join(org1.root, "org-config.json"), "utf8"));
    if (!cfg.backup) return { org: org1.orgId, status: "not_configured" };
    const t0 = performance.now(), b = await ops(org1.opsSocket, "/ops/backup/now"), backupMs = Math.round(performance.now() - t0);
    if (!b.ok) return { org: org1.orgId, status: "backup_refused", error: b.error, backupMs };
    const t1 = performance.now(), newRoot = join(worldBase, `restore-${org1.orgId}-${Date.now()}`);
    const r = restoreOrgBackup(join(cfg.backup.dir, b.set), newRoot, org1.orgId), restoreMs = Math.round(performance.now() - t1);
    const { backup: _drop, ...rest } = cfg;
    const restoredCfg = { ...rest, stateRoot: r.stateRoot, folder: r.folder, accessSocket: r.accessSocket, opsSocket: r.opsSocket };
    const open = o.openRuntime ?? (async (c: unknown) => (await import("../src/org/org-runtime.js")).openOrgRuntime(c));
    const t2 = performance.now(), rt = await open(restoredCfg), startMs = Math.round(performance.now() - t2);
    const st = await ops(r.opsSocket, "/ops/status"); await rt.close();
    return { org: org1.orgId, status: "ok", set: b.set, files: b.files, backupMs, restoreMs, startMs, restoredInstallationId: r.installationId, held: r.held,
      restoredStatusOk: st.ok === true && st.orgId === org1.orgId };
  })().catch((e) => ({ status: "error", error: e instanceof Error && /^[a-z][a-z0-9_]{2,63}$/.test(e.message) ? e.message : "g1_backup_error" }));

  await sleep(o.startDelayMs ?? 3000); // let Ops' intake driver finish its own sign-ins first
  const end = Date.now() + seconds * 1000;
  await Promise.all(w.orgs.map(async (org) => {
    const m: OrgOut = { login: null, ask: { ok: 0, refused: {}, errors: {}, p50: null, p95: null }, plan: { adopted: 0, prepared: 0, approved: 0, drafts: 0, skipped: null, errors: {}, sessionRefreshes: 0 },
      quota: org.orgId === quotaOrg ? { monthlyUsd: org.monthlyUsd, asksBeforeRefusal: null, refusal: null } : null };
    out.orgs[org.orgId] = m;
    const email = org.admin?.email ?? `admin@${org.orgId}.g1.test`;
    let s = await login(hub, w.spool, org.orgId, email);
    m.login = s.status;
    if (!s.cookie) return;
    const api = async (path: string, body: unknown = {}) => (await fetch(`${hub}/o/${org.orgId}/${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: s.cookie }, body: JSON.stringify(body) })).json() as Promise<any>;
    if (!org.admin) m.plan.skipped = "no_admin_in_world";
    // Option A: approvals need a sign-in from the last 60 minutes; a longer run signs in again (counted) and retries once.
    const act = async (action: string, body: unknown, artifactDigest: string | null = null, again = true): Promise<any> => {
      const operationId = randomUUID(), ch = await api("challenge", { action, body, artifactDigest, operationId });
      if (!ch.ok && ch.error === "access_session_not_fresh" && again) {
        const fresh = await login(hub, w.spool, org.orgId, email); m.plan.sessionRefreshes++;
        if (fresh.cookie) { s = fresh; return act(action, body, artifactDigest, false); }
      }
      if (!ch.ok) return ch;
      return api("act", { challengeId: ch.challengeId, action, body, artifactDigest, operationId });
    };
    const lat: number[] = []; let tick = 0, asks = 0, notesApproved = false;
    while (Date.now() < end) {
      tick++;
      const t0 = performance.now(), a = await api("api/agent/ask", { question: `G-1 question ${tick}: when is the cleanup?` }).catch(() => ({ ok: false, error: "g1_fetch_failed" }));
      lat.push(Math.round(performance.now() - t0)); asks++;
      if (!a.ok) bump(m.ask.errors, String(a.error));
      else if (a.result?.status === "ANSWERED" && typeof a.result.answer === "string") m.ask.ok++;
      else {
        bump(m.ask.refused, String(a.result?.reason ?? a.result?.status ?? "unknown"));
        // Quota: the first refusal that is the hosted spend cap (monthly or per-run), not any other refusal.
        if (m.quota && m.quota.refusal === null && /^hosted_(monthly|run)_cap_exceeded$/.test(String(a.result?.reason)))
          { m.quota.asksBeforeRefusal = asks - 1; m.quota.refusal = { path: "ask", status: a.result?.status ?? null, reason: a.result?.reason ?? null }; }
      }
      if (org.admin && tick % 3 === 1) {
        try {
          const intakes = (await api("api/intake/list")).result?.intakes ?? [];
          const next = intakes.find((i: any) => !i.adoptedTaskId);
          if (next) {
            const ad = await act("task.adopt", { intakeId: next.intakeId, title: `G-1 ${next.subject}`.slice(0, 120) });
            if (!ad.ok) bump(m.plan.errors, `adopt:${ad.error}`);
            else {
              m.plan.adopted++;
              const p = await api("api/plan/prepare", { taskId: ad.result.taskId });
              if (!p.ok) bump(m.plan.errors, `prepare:${p.error}`);
              else {
                m.plan.prepared++;
                const pl = p.result, ap = await act("proposal.approve", { proposalId: pl.proposalId, expectedRevision: pl.expectedRevision, version: pl.version, planHash: pl.planHash }, pl.planHash);
                ap.ok ? m.plan.approved++ : bump(m.plan.errors, `approve:${ap.error}`);
              }
            }
          }
        } catch { bump(m.plan.errors, "g1_plan_exception"); }
      }
      // Once a draft exists, approve one synthetic member notes version so Q&A has material (and the model is reached).
      if (org.admin && !notesApproved) {
        const drafts = (await api("api/draft/list")).result?.drafts ?? [];
        if (drafts.length) {
          const md = "# G-1 notes\nThe neighborhood cleanup is on Saturday Oct 31.\nThe start time is being confirmed.\n";
          const n = await act("notes.approve", { meeting: new Date().toISOString().slice(0, 10), reportId: drafts[0].documentId, markdown: md }, notesDigest(md));
          n.ok || n.error === "notes_version_exists" ? (notesApproved = true) : bump(m.plan.errors, `notes:${n.error}`);
        }
      }
      await sleep(gap);
    }
    if (org.admin) { await sleep(2000); m.plan.drafts = ((await api("api/draft/list")).result?.drafts ?? []).length; }
    m.ask.p50 = pct(lat, 0.5); m.ask.p95 = pct(lat, 0.95);
    // The cap can also stop the draft runs first (the quota org may never get notes): report that path too.
    if (m.quota) {
      const st = await ops(org.opsSocket, "/ops/status").catch(() => null);
      m.quota.draftRunFailureReasons = st?.draftRunFailureReasons ?? null;
      const capped = Object.keys(m.quota.draftRunFailureReasons ?? {}).find((k) => /:hosted_(monthly|run)_cap_exceeded$/.test(k));
      if (m.quota.refusal === null && capped) m.quota.refusal = { path: "draft", status: capped.split(":")[0], reason: capped.split(":")[1] };
    }
  }));
  out.backup = await backup;
  out.endedAt = new Date().toISOString();
  return out;
}

if (process.argv[1] && /g1-load\.(m?js|ts)$/.test(process.argv[1])) {
  const [, , base, secs, rate] = process.argv;
  if (!base || !(Number(secs) > 0) || !(Number(rate) > 0)) { console.error("usage: g1-load <worldBase> <seconds> <ratePerOrgPerMin>"); process.exit(2); }
  const r = await runLoad(base, Number(secs), Number(rate));
  console.log(JSON.stringify(r));
  process.exit(0);
}
