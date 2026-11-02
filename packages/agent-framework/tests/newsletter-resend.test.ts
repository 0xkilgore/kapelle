// Newsletter slice 3, S3-a (PLAN-NEWSLETTER-SLICE3; Fable answer 1, R-1..R-5): the Resend broadcast connector and the audience
// reader against a FAKE Resend at the HTTP level, and the F-7 executor over the real connector: the crash matrix, lost
// answers, an incomplete listing, the one-list rule and the post-send "no additions observed" fence. No network.
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { FakeResend } from "../src/org/newsletter/fake-resend.js";
import { resendBroadcastPort, readAudience, AudienceCache } from "../src/org/newsletter/resend-broadcast.js";
import { NewsletterExecutor, Crash } from "../src/org/newsletter/executor.js";
import { transcriptionWorld } from "./transcription-world.js";
import { render } from "../deploy/kapelle-admin.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const ALLOWED = new Set(["POST /broadcasts", "GET /broadcasts/{id}", "POST /broadcasts/{id}/send", "GET /broadcasts", "GET /audiences/{id}/contacts"]);
const keyFile = () => { const d = mkdtempSync(join(tmpdir(), "knl-rk-")), f = join(d, "resend-release.key"); writeFileSync(f, "re_" + "R".repeat(30), { mode: 0o600 }); chmodSync(f, 0o600); return { d, f }; };

it("R-1/R-3 connector + audience against the fake: four broadcast calls + contacts only; statuses; pagination; incomplete = says so; failures labelled", async () => {
  const { d, f } = keyFile();
  try {
    const fr = new FakeResend("aud_exna"), port = resendBroadcastPort({ keyFile: f, listId: "aud_exna", listField: "segment_id", fetch: fr.fetch as never });
    const pkg = { name: "kapelle:op-1", subject: "S", html: "<p>x</p>", text: "x", from: "EXNA <n@example.org>", replyTo: "h@example.org", listId: "aud_exna" };
    const { id } = await port.createDraft(pkg);
    expect(await port.getBroadcast(id)).toMatchObject({ id, name: "kapelle:op-1", status: "draft", subject: "S", htmlSha256: expect.stringMatching(/^sha256:/), listId: "aud_exna" });
    expect(await port.getBroadcast("bc_404")).toBeNull();
    expect(await port.send(id)).toEqual({ accepted: true });
    expect((await port.getBroadcast(id))!.status).toBe("queued");
    await expect(port.send(id)).rejects.toMatchObject({ label: "newsletter_provider_refused", sent: false }); // a 4xx never happened
    for (let i = 2; i <= 5; i++) await port.createDraft({ ...pkg, name: `kapelle:op-${i}` });
    expect(await port.listBroadcasts()).toEqual({ complete: true, items: expect.arrayContaining([expect.objectContaining({ name: "kapelle:op-5" })]) });
    expect((await port.listBroadcasts()).items).toHaveLength(5); // pages of 2
    fr.fault("GET", /^\/broadcasts$/, 500, 1);
    expect((await port.listBroadcasts()).complete).toBe(false);
    expect((await resendBroadcastPort({ keyFile: f, listId: "aud_exna", listField: "segment_id", fetch: fr.fetch as never, maxPages: 1 }).listBroadcasts()).complete).toBe(false); // the cap
    fr.fault("POST", /\/send$/, 503); const id2 = (await port.createDraft({ ...pkg, name: "kapelle:op-6" })).id;
    await expect(port.send(id2)).rejects.toMatchObject({ label: "newsletter_provider_uncertain", sent: true }); // a 5xx may have happened
    fr.fault("POST", /^\/broadcasts$/, "throw-before");
    await expect(port.createDraft({ ...pkg, name: "kapelle:op-7" })).rejects.toMatchObject({ label: "newsletter_provider_uncertain", sent: true });
    await expect(resendBroadcastPort({ keyFile: join(d, "missing.key"), listId: "aud_exna", listField: "segment_id", fetch: fr.fetch as never }).createDraft(pkg))
      .rejects.toMatchObject({ label: "newsletter_provider_refused", sent: false }); // key read at use; no request without it
    // Audience: every page; eligible = not unsubscribed; ids only, sorted; a failed page or the cap = null.
    fr.setContacts(5, [2]);
    expect(await readAudience({ keyFile: f, audienceId: "aud_exna", fetch: fr.fetch as never })).toEqual(["ct_1", "ct_3", "ct_4", "ct_5"]);
    fr.fault("GET", /contacts$/, 500, 1);
    expect(await readAudience({ keyFile: f, audienceId: "aud_exna", fetch: fr.fetch as never })).toBeNull();
    expect(await readAudience({ keyFile: f, audienceId: "aud_exna", fetch: fr.fetch as never, maxPages: 2 })).toBeNull();
    // The cache the synchronous gates read: null once stale (fail closed).
    let now = 0; const cache = new AudienceCache(() => readAudience({ keyFile: f, audienceId: "aud_exna", fetch: fr.fetch as never }), 60_000, () => now);
    expect(cache.current()).toBeNull();
    await cache.refresh(); expect(cache.current()).toHaveLength(4);
    now = 61_000; expect(cache.current()).toBeNull();
    // R-1: nothing but the four broadcast endpoints and the contacts listing was ever called; every call carried the key.
    expect(new Set(fr.log)).toEqual(ALLOWED);
    expect(fr.keys.every((k) => k === "Bearer re_" + "R".repeat(30))).toBe(true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

it("R-4 render: --newsletter-list-id brings the list id AND the release key together (secretsExpected only then); a bad id or a missing sender refuses", () => {
  const root = mkdtempSync(join(tmpdir(), "knl-r4-"));
  try {
    const base = { org: "exna", label: "Example Park", domain: "agent.example.org", monthlyUsd: 15, root, intake: "none" as const };
    expect(render({ ...base, newsletter: { enable: "on" } }).secretsExpected.some((p) => p.endsWith("resend-release.key"))).toBe(false);
    // S3-c: the release key starts the executor, so the list id needs the release sender (From + Reply-To) too.
    expect(() => render({ ...base, newsletter: { enable: "on", listId: "aud_exna" } })).toThrow("render_newsletter_sender_required");
    const r = render({ ...base, newsletter: { enable: "on", listId: "aud_exna", from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org" } });
    expect(r.secretsExpected.map((p) => p.replace(root, ""))).toContain("/etc/kapelle/secrets/exna/resend-release.key");
    expect(JSON.parse(readFileSync(r.orgConfig, "utf8")).newsletter).toMatchObject({ listId: "aud_exna", releaseKeyFile: root + "/etc/kapelle/secrets/exna/resend-release.key", listField: "segment_id" });
    expect(() => render({ ...base, newsletter: { enable: "on", listId: "../x" } })).toThrow("render_newsletter_list_id_invalid");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe.skipIf(!enabled)("the executor over the real connector (S3-a, R-2, R-5, answer 1)", () => {
  async function setup() {
    const { d, f } = keyFile(), fr = new FakeResend("aud_exna"); fr.setContacts(3);
    const cache = new AudienceCache(() => readAudience({ keyFile: f, audienceId: "aud_exna", fetch: fr.fetch as never }));
    const w = await transcriptionWorld({ newsletter: { totpKeyFile: "/nonexistent/totp.key", approvers: ["robin@exna.test"] }, newsletterRecipients: () => cache.current() });
    const nl = w.org.newsletter!, db = () => w.org.sqlite.db;
    nl.recordTransfer({ installationId: w.org.sqlite.identity.installationId, frozenAt: new Date().toISOString(), attestedBy: "owner" });
    let n = 0;
    const approved = async (listId = "aud_exna") => {
      await cache.refresh();
      const r = nl.prepare({ slug: `2026-12-${String(++n).padStart(2, "0")}-update`, subject: `Update ${n}`, testSubject: `[TEST] Update ${n}`, from: "EXNA <n@example.org>",
        replyTo: "h@example.org", html: `<p>Update ${n}</p>`, text: `Update ${n}`, renderer: "kapelle.newsletter-renderer/v2", images: [], listId });
      const op = "op-nl-" + randomUUID(), at = new Date().toISOString();
      w.org.sqlite.write(() => { db().prepare("UPDATE newsletter_releases SET state='approved', operation_id=?, approved_at=? WHERE id=?").run(op, at, r.releaseId);
        db().prepare("INSERT INTO newsletter_effects(release_id,operation_id,approved_by,state,at) VALUES (?,?,'m','approved',?)").run(r.releaseId, op, at); });
      return { ...r, op };
    };
    const exec = (crash?: string) => new NewsletterExecutor(w.org.sqlite, { stateRoot: w.cfg.stateRoot, releases: nl, listId: "aud_exna", audience: cache,
      provider: resendBroadcastPort({ keyFile: f, listId: "aud_exna", listField: "segment_id", fetch: fr.fetch as never }),
      ...(crash ? { crash: (p: string) => { if (p === crash) throw new Crash(p); } } : {}) });
    const settle = (id: string) => w.org.sqlite.write(() => db().prepare("UPDATE newsletter_effects SET state='failed' WHERE release_id=?").run(id));
    const per = (name: string) => { const ids = fr.broadcasts.filter((b) => b.name === name).map((b) => b.id); return {
      creates: ids.length, sends: fr.log.filter((l) => l === "POST /broadcasts/{id}/send").length }; };
    return { d, fr, w, db, approved, exec, settle, per, close: async () => { await w.close(); rmSync(d, { recursive: true, force: true }); } };
  }

  // S3 live run 2026-10-29: Resend answered 429 to POST /send after a burst of reads. Through the REAL connector and the fake:
  // one 429 on /send is retried and the release completes with exactly ONE broadcast sent; 429s on every attempt leave nothing
  // sent (a 4xx refusal, never assumed sent); a 429 in the middle of the pre-send reads is absorbed too.
  it("429 on /send: retried once -> exactly one broadcast sent; 429 on every attempt -> nothing sent, not assumed sent; a 429 mid-read is absorbed", async () => {
    const s = await setup();
    try {
      const sentCount = () => s.fr.broadcasts.filter((b) => b.status !== "draft").length;
      const a = await s.approved();
      s.fr.fault("POST", /^\/broadcasts\/[^/]+\/send$/, 429, 1);
      s.fr.fault("GET", /^\/audiences\/[^/]+\/contacts$/, 429, 1);
      expect(await s.exec().run(a.releaseId)).toEqual({ state: "archive_pending", label: null });
      expect([sentCount(), s.fr.log.filter((l) => l === "POST /broadcasts/{id}/send").length]).toEqual([1, 2]); // one 429'd attempt + one accepted
      const b = await s.approved();
      s.fr.fault("POST", /^\/broadcasts\/[^/]+\/send$/, 429, 5);
      const before = sentCount(), out = await s.exec().run(b.releaseId);
      expect(out.state).not.toBe("archive_pending");
      expect(sentCount()).toBe(before); // nothing went out for b
      s.fr.clearFaults();
    } finally { await s.close(); }
  }, 60_000);

  it("happy path, the crash matrix with restarts, lost answers and an incomplete listing: POST /broadcasts <= 1 and /send <= 1 per release", async () => {
    const s = await setup();
    try {
      const r = await s.approved();
      expect(await s.exec().run(r.releaseId)).toEqual({ state: "archive_pending", label: null });
      expect(s.db().prepare("SELECT recipient_count, post_send_recipients_sha FROM newsletter_effects WHERE release_id=?").get(r.releaseId)).toEqual({ recipient_count: 3, post_send_recipients_sha: expect.stringMatching(/^sha256:/) });
      const cases: [string, string][] = [["after-intent", "archive_pending"], ["after-create-attempted", "failed"], ["after-create", "archive_pending"], ["after-draft-known", "archive_pending"],
        ["after-send-attempted", "held"], ["after-send", "archive_pending"], ["after-accepted", "archive_pending"]];
      for (const [point, final] of cases) {
        const sendsBefore = s.fr.log.filter((l) => l === "POST /broadcasts/{id}/send").length, x = await s.approved();
        await expect(s.exec(point).run(x.releaseId), point).rejects.toBeInstanceOf(Crash);
        expect((await s.exec().run(x.releaseId)).state, point).toBe(final);
        expect(s.fr.broadcasts.filter((b) => b.name === `kapelle:${x.op}`).length, point + " creates").toBeLessThanOrEqual(1);
        expect(s.fr.log.filter((l) => l === "POST /broadcasts/{id}/send").length - sendsBefore, point + " sends").toBeLessThanOrEqual(1);
        if (final !== "archive_pending") s.settle(x.releaseId);
      }
      // Lost answers: create happened (adopted by exact name), send happened (adopted by GET): one each.
      s.fr.fault("POST", /^\/broadcasts$/, "throw-after"); const a = await s.approved();
      expect((await s.exec().run(a.releaseId)).state).toBe("create_attempted");
      expect((await s.exec().run(a.releaseId)).state).toBe("archive_pending");
      expect(s.fr.broadcasts.filter((b) => b.name === `kapelle:${a.op}`)).toHaveLength(1);
      s.fr.fault("POST", /\/send$/, "throw-after"); const b = await s.approved(), sends = s.fr.log.filter((l) => l === "POST /broadcasts/{id}/send").length;
      expect((await s.exec().run(b.releaseId)).state).toBe("send_attempted");
      expect((await s.exec().run(b.releaseId)).state).toBe("archive_pending");
      expect(s.fr.log.filter((l) => l === "POST /broadcasts/{id}/send").length - sends).toBe(1);
      // An incomplete listing during recovery holds (never "absent").
      s.fr.fault("POST", /^\/broadcasts$/, "throw-after"); const c = await s.approved();
      await s.exec().run(c.releaseId); s.fr.fault("GET", /^\/broadcasts$/, 500, 5);
      expect(await s.exec().run(c.releaseId)).toMatchObject({ state: "held" });
      expect(new Set(s.fr.log)).toEqual(ALLOWED);
    } finally { await s.close(); }
  });

  it("Fable S3-a F-1: a read-back that FAILS (503) keeps draft_known and retries the read (one draft only); a missing draft (404) fails", async () => {
    const s = await setup();
    try {
      const r = await s.approved();
      s.fr.fault("GET", /^\/broadcasts\/bc_/, 503, 1);
      expect(await s.exec().run(r.releaseId)).toEqual({ state: "draft_known", label: "newsletter_provider_uncertain" });
      expect(s.fr.log.filter((l) => l === "POST /broadcasts/{id}/send")).toHaveLength(0);
      expect((await s.exec().run(r.releaseId)).state).toBe("archive_pending"); // the READ is retried, nothing recreated
      expect(s.fr.broadcasts.filter((b) => b.name === `kapelle:${r.op}`)).toHaveLength(1);
      const g = await s.approved();
      s.fr.fault("GET", /^\/broadcasts\/bc_/, 503, 1);
      await s.exec().run(g.releaseId);
      s.fr.broadcasts.splice(s.fr.broadcasts.findIndex((b) => b.name === `kapelle:${g.op}`), 1); // the draft is gone (deleted in the dashboard)
      expect(await s.exec().run(g.releaseId)).toEqual({ state: "failed", label: "newsletter_draft_mismatch" });
    } finally { await s.close(); }
  });

  it("R-2 one list: a package naming another list fails at read-back with no send; answer 1: an addition during the send = overrun, an unreadable audience = count_unknown", async () => {
    const s = await setup();
    try {
      const other = await s.approved("aud_other");
      expect(await s.exec().run(other.releaseId)).toEqual({ state: "failed", label: "newsletter_draft_mismatch" });
      expect(s.fr.log.filter((l) => l === "POST /broadcasts/{id}/send")).toHaveLength(0);
      const r = await s.approved();
      s.fr.onSend = () => { s.fr.contacts.push({ id: "ct_99", email: "new@example.org", unsubscribed: false }); };
      expect(await s.exec().run(r.releaseId)).toEqual({ state: "reconcile_required", label: "newsletter_overrun" });
      s.settle(r.releaseId); s.fr.contacts.pop(); s.fr.onSend = () => { s.fr.fault("GET", /contacts$/, 500, 5); };
      const u = await s.approved();
      expect(await s.exec().run(u.releaseId)).toEqual({ state: "reconcile_required", label: "newsletter_count_unknown" });
      // A removal before the send is fine: N shrinks, no addition observed.
      s.settle(u.releaseId); s.fr.onSend = null; s.fr.clearFaults();
      const rm = await s.approved(); s.fr.contacts[0].unsubscribed = true;
      expect((await s.exec().run(rm.releaseId)).state).toBe("archive_pending");
    } finally { await s.close(); }
  });
});

// Fable cbae22b4 E-10: the full_access broadcast key is broader than any credential Kapelle held, so its client is pinned: one
// origin and exactly the five calls (POST /broadcasts, GET /broadcasts/{id}, POST /broadcasts/{id}/send, GET /broadcasts,
// GET /audiences/{id}/contacts), never a redirect. Every method of the port and the audience reader, recorded.
it("E-10: the broadcast client reaches ONE origin and exactly the five calls; nothing else is reachable", async () => {
  const { d, f } = keyFile();
  try {
    const fr = new FakeResend("aud_exna"), seen: { method: string; url: string; redirect: string; auth: string }[] = [];
    const fetch = (async (url: string, init: any) => { seen.push({ method: init.method, url, redirect: init.redirect, auth: init.headers?.authorization ?? init.headers?.Authorization }); return (fr.fetch as any)(url, init); }) as never;
    const port = resendBroadcastPort({ keyFile: f, listId: "aud_exna", listField: "segment_id", fetch });
    const { id } = await port.createDraft({ name: "kapelle:op-1", subject: "S", html: "<p>x</p>", text: "x", from: "EXNA <n@example.org>", replyTo: "h@example.org", listId: "aud_exna" });
    await port.getBroadcast(id); await port.send(id); await port.listBroadcasts();
    fr.setContacts(3); await readAudience({ keyFile: f, audienceId: "aud_exna", fetch });
    const ALLOWED = [/^POST \/broadcasts$/, /^GET \/broadcasts\/[A-Za-z0-9_-]+$/, /^POST \/broadcasts\/[A-Za-z0-9_-]+\/send$/, /^GET \/broadcasts\?limit=100(&after=[^&]+)?$/,
      /^GET \/audiences\/aud_exna\/contacts\?limit=100(&after=[^&]+)?$/];
    expect(seen.length).toBeGreaterThanOrEqual(5);
    for (const c of seen) {
      expect(c.url.startsWith("https://api.resend.com/")).toBe(true);
      expect(c.redirect).toBe("error");
      expect(c.auth).toBe("Bearer " + readFileSync(f, "utf8").trim()); // Fable 574d8b5d: every broadcast call is signed by the RELEASE key
      const call = `${c.method} ${c.url.slice("https://api.resend.com".length)}`;
      expect([call, ALLOWED.some((re) => re.test(call))]).toEqual([call, true]);
    }
    expect(new Set(seen.map((c) => ALLOWED.findIndex((re) => re.test(`${c.method} ${c.url.slice(22)}`)))).size).toBe(5); // all five exercised
  } finally { rmSync(d, { recursive: true, force: true }); }
});
