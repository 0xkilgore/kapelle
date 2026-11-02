// Newsletter slice 2, S2-b (NEWSLETTER-SEND-V1 v2 §4 F-7; PLAN-NEWSLETTER-SLICE2): the release executor over a FAKE provider.
// The 10-step order, the DB-authoritative projection, a crash at every boundary followed by a restart (never a second
// create or send), recovery by reads, and every hold/fail outcome. No network: FakeProvider only.
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { transcriptionWorld } from "./transcription-world.js";
import { FakeResend } from "../src/org/newsletter/fake-resend.js";
import { NewsletterExecutor, Crash } from "../src/org/newsletter/executor.js";
import { UNSUB_ANCHOR } from "../src/org/newsletter/render-cp.js";
import { FakeProvider } from "../src/org/newsletter/fake-provider.js";
import { NEWSLETTER_REASONS } from "../src/org/newsletter/labels.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;

it("executor labels are persisted labels", () => { for (const l of NEWSLETTER_REASONS) { expect(failureLabel(new Error(l)), l).toBe(l); expect(persistedReason(l)).toBe(l); } });

describe.skipIf(!enabled)("newsletter release executor (S2-b, fake provider)", () => {
  async function setup() {
    const audience = { ids: ["c-1", "c-2", "c-3"] as string[] | null };
    const w = await transcriptionWorld({ newsletter: { totpKeyFile: "/nonexistent/totp.key", approvers: ["robin@exna.test"] }, newsletterRecipients: () => audience.ids });
    const nl = w.org.newsletter!, db = () => w.org.sqlite.db;
    nl.recordTransfer({ installationId: w.org.sqlite.identity.installationId, frozenAt: new Date().toISOString(), attestedBy: "owner" });
    let n = 0;
    /** A release in `approved`, as the S1-c verification transaction leaves it. */
    const approved = () => {
      const slug = `2026-11-${String(++n).padStart(2, "0")}-update`;
      const r = nl.prepare({ slug, subject: `Update ${n}`, testSubject: `[TEST] Update ${n}`, from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org",
        html: `<h1>Update ${n}</h1>`, text: `Update ${n}`, renderer: "kapelle.newsletter-renderer/v2", images: [], listId: "aud-1" });
      const op = "op-nl-" + randomUUID(), at = new Date().toISOString();
      w.org.sqlite.write(() => { db().prepare("UPDATE newsletter_releases SET state='approved', operation_id=?, approved_at=? WHERE id=?").run(op, at, r.releaseId);
        db().prepare("INSERT INTO newsletter_effects(release_id,operation_id,approved_by,state,at) VALUES (?,?,'m-robin','approved',?)").run(r.releaseId, op, at); });
      return { ...r, op };
    };
    const state = (id: string) => db().prepare("SELECT e.state, e.label, e.broadcast_id, e.recipient_count, r.state AS rstate FROM newsletter_effects e JOIN newsletter_releases r ON r.id=e.release_id WHERE e.release_id=?").get(id) as any;
    const exec = (p: FakeProvider, crash?: string) => new NewsletterExecutor(w.org.sqlite, { stateRoot: w.cfg.stateRoot, releases: nl, provider: p, audience: { refresh: async () => audience.ids },
      ...(crash ? { crash: (pt: string) => { if (pt === crash) throw new Crash(pt); } } : {}) });
    const calls = (p: FakeProvider, op: string, name: string) => p.calls.filter((c) => c.op === op && (c.arg === name || p.broadcasts.get(c.arg)?.name === name)).length;
    return { w, nl, db, audience, approved, state, exec, calls };
  }

  it("happy path: approved -> projection -> create -> read back -> send -> accepted -> count -> archive_pending; the projection follows the DB", async () => {
    const s = await setup();
    try {
      const p = new FakeProvider(3), r = s.approved();
      expect(await s.exec(p).run(r.releaseId)).toEqual({ state: "archive_pending", label: null });
      expect(s.state(r.releaseId)).toMatchObject({ state: "archive_pending", rstate: "archive_pending", broadcast_id: "bc_1", recipient_count: 3 });
      expect(p.calls.map((c) => c.op)).toEqual(["createDraft", "getBroadcast", "send"]); // no count call: the fence re-reads the audience
      expect((s.db().prepare("SELECT post_send_recipients_sha FROM newsletter_effects WHERE release_id=?").get(r.releaseId) as any).post_send_recipients_sha).toMatch(/^sha256:/);
      expect(p.calls[0].arg).toBe(`kapelle:${r.op}`); // the operationId in the broadcast name (exact-key reconciliation)
      const j = JSON.parse(readFileSync(join(s.w.cfg.stateRoot, "newsletter", "sent.json"), "utf8"));
      expect(j.rows).toEqual([expect.objectContaining({ releaseId: r.releaseId, operationId: r.op, state: "archive_pending", broadcastId: "bc_1", digest: r.digest })]);
      // Running it again does nothing: no second create or send.
      expect((await s.exec(p).run(r.releaseId)).state).toBe("archive_pending");
      expect(p.calls.filter((c) => c.op === "createDraft" || c.op === "send")).toHaveLength(2);
    } finally { await s.w.close(); }
  });

  // Package E (Fable E-2): right before the first mutation the send re-checks every image against the bytes prepare bound;
  // a replaced image fails the release with its own label and NO provider call (a gone one with "unserved").
  it("send-time image re-check: replaced -> failed newsletter_image_changed, gone -> failed newsletter_images_unserved; the provider is never called", async () => {
    const s = await setup();
    try {
      const url = "https://www.example.org/newsletter/2026-10/block-party-yard-sign.jpg", sha = (b: string) => "sha256:" + createHash("sha256").update(b).digest("hex");
      for (const [served, label] of [["new bytes", "newsletter_image_changed"], [null, "newsletter_images_unserved"]] as const) {
        const slug = `2026-12-0${label.length % 9 + 1}-images`;
        const r = s.nl.prepare({ slug, subject: "Images", testSubject: "[TEST] Images", from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org",
          html: `<p><img src="${url}" alt=""></p>${UNSUB_ANCHOR}`, text: "Images", renderer: "kapelle.newsletter-renderer/v3", images: [{ url, sha256: sha("prepared bytes") }], listId: "aud-1" });
        const op = "op-nl-" + randomUUID(), at = new Date().toISOString();
        s.w.org.sqlite.write(() => { s.db().prepare("UPDATE newsletter_releases SET state='approved', operation_id=?, approved_at=? WHERE id=?").run(op, at, r.releaseId);
          s.db().prepare("INSERT INTO newsletter_effects(release_id,operation_id,approved_by,state,at) VALUES (?,?,'m-robin','approved',?)").run(r.releaseId, op, at); });
        const p = new FakeProvider(3), fetched: string[] = [];
        const imageFetch = async (u: string, init: RequestInit) => { fetched.push(u); return served === null ? new Response(null, { status: 404 }) : new Response(init.method === "HEAD" ? null : served, { status: 200, headers: { "content-type": "image/jpeg" } }); };
        const ex = new NewsletterExecutor(s.w.org.sqlite, { stateRoot: s.w.cfg.stateRoot, releases: s.nl, provider: p, audience: { refresh: async () => s.audience.ids }, imageFetch });
        expect(await ex.run(r.releaseId)).toEqual({ state: "failed", label });
        expect(p.calls).toEqual([]); expect(fetched.every((u) => u === url)).toBe(true);
      }
    } finally { await s.w.close(); }
  });

  // Fable E-10 ruling (574d8b5d): the full-access key is read only by mint/send: without it the send refuses (no provider request).
  it("E-10: the broadcast needs the release key file; absent, the send fails provably-not-sent and nothing reaches the provider", async () => {
    const s = await setup();
    try {
      const r = s.approved(), fr = new FakeResend("aud-1"), { resendBroadcastPort } = await import("../src/org/newsletter/resend-broadcast.js");
      const port = resendBroadcastPort({ keyFile: join(s.w.cfg.stateRoot, "absent-release.key"), listId: "aud-1", listField: "segment_id", fetch: fr.fetch as never });
      const ex = new NewsletterExecutor(s.w.org.sqlite, { stateRoot: s.w.cfg.stateRoot, releases: s.nl, provider: port, audience: { refresh: async () => s.audience.ids } });
      expect(await ex.run(r.releaseId)).toEqual({ state: "failed", label: "newsletter_provider_refused" });
      expect(fr.log).toEqual([]);
    } finally { await s.w.close(); }
  });

  // Fable F-1 / E-6': a v3 package without exactly one triple-brace unsubscribe anchor fails at send; the provider is never called.
  it("F-1: a v3 package with no unsubscribe anchor, or the double-brace form, fails newsletter_unsubscribe_invalid; no provider call", async () => {
    const s = await setup();
    try {
      for (const [n, html] of [["1", "<p>no footer</p>"], ["2", '<p><a href="{{RESEND_UNSUBSCRIBE_URL}}">Unsubscribe</a></p>']] as const) {
        const r = s.nl.prepare({ slug: `2026-12-1${n}-unsub`, subject: "U", testSubject: "[TEST] U", from: "EXNA <newsletter@example.org>", replyTo: "hello@example.org",
          html, text: "U", renderer: "kapelle.newsletter-renderer/v3", images: [], listId: "aud-1" });
        const op = "op-nl-" + randomUUID(), at = new Date().toISOString();
        s.w.org.sqlite.write(() => { s.db().prepare("UPDATE newsletter_releases SET state='approved', operation_id=?, approved_at=? WHERE id=?").run(op, at, r.releaseId);
          s.db().prepare("INSERT INTO newsletter_effects(release_id,operation_id,approved_by,state,at) VALUES (?,?,'m-robin','approved',?)").run(r.releaseId, op, at); });
        const p = new FakeProvider(3);
        expect(await s.exec(p).run(r.releaseId)).toEqual({ state: "failed", label: "newsletter_unsubscribe_invalid" });
        expect(p.calls).toEqual([]);
      }
    } finally { await s.w.close(); }
  });

  it("a crash at EVERY boundary, then a restart: never a second create or send; each ends where F-7 says", async () => {
    const s = await setup();
    try {
      const expected: [string, string, number, number][] = [
        ["after-intent", "archive_pending", 1, 1], ["after-create-attempted", "failed", 0, 0], ["after-create", "archive_pending", 1, 1],
        ["after-draft-known", "archive_pending", 1, 1], ["after-send-attempted", "held", 1, 0], ["after-send", "archive_pending", 1, 1],
        ["after-accepted", "archive_pending", 1, 1]];
      for (const [point, final, creates, sends] of expected) {
        const p = new FakeProvider(3), r = s.approved(), name = `kapelle:${r.op}`;
        await expect(s.exec(p, point).run(r.releaseId), point).rejects.toBeInstanceOf(Crash);
        const out = await s.exec(p).run(r.releaseId); // the restarted process
        expect(out.state, point).toBe(final);
        expect(calls(p, "createDraft", name), point + " creates").toBe(creates);
        expect(p.calls.filter((c) => c.op === "send").length, point + " sends").toBe(sends);
        if (point === "after-create-attempted") expect(out.label).toBe("newsletter_create_absent"); // provably never created: a new release needs a new approval
        if (point === "after-send-attempted") expect(s.state(r.releaseId).label).toBe("newsletter_draft_held"); // still a draft: a human decides
        // Settle the held one so the next case is not blocked by it (Ops would do this after looking).
        if (final === "held") s.w.org.sqlite.write(() => s.db().prepare("UPDATE newsletter_effects SET state='failed' WHERE release_id=?").run(r.releaseId));
      }
      function calls(p: FakeProvider, op: string, name: string) { return p.calls.filter((c) => c.op === op && c.arg === name).length; }
    } finally { await s.w.close(); }
  });

  it("provider outcomes: refusal fails, ambiguity holds and blocks every release until reconciled by reads; incomplete or ambiguous listings hold", async () => {
    const s = await setup();
    try {
      // A definite refusal at create: failed, nothing pending.
      const p1 = new FakeProvider(); p1.fault("createDraft", "refuse");
      const r1 = s.approved();
      expect(await s.exec(p1).run(r1.releaseId)).toEqual({ state: "failed", label: "newsletter_provider_refused" });
      // An ambiguous create (it happened, the answer was lost): create_attempted, unsettled, every other release blocked.
      const p2 = new FakeProvider(); p2.fault("createDraft", "throw-after");
      const r2 = s.approved(), r3 = s.approved();
      expect(await s.exec(p2).run(r2.releaseId)).toEqual({ state: "create_attempted", label: "newsletter_provider_uncertain" });
      expect(s.nl.preSendFailures(r3.releaseId)).toContain("newsletter_uncertain_release");
      expect(s.nl.status()).toMatchObject({ unsettled: 1 });
      // Recovery by exact name over a complete listing adopts the draft, and the release completes with ONE create.
      expect((await s.exec(p2).run(r2.releaseId)).state).toBe("archive_pending");
      expect(p2.calls.filter((c) => c.op === "createDraft")).toHaveLength(1);
      // An incomplete listing holds; two drafts with the same name hold (ambiguous).
      const p3 = new FakeProvider(); p3.fault("createDraft", "throw-after"); const r4 = s.approved();
      await s.exec(p3).run(r4.releaseId); p3.listComplete = false;
      expect(await s.exec(p3).run(r4.releaseId)).toMatchObject({ state: "held" });
      expect(s.state(r4.releaseId).label).toBe("newsletter_history_unavailable");
      s.w.org.sqlite.write(() => s.db().prepare("UPDATE newsletter_effects SET state='failed' WHERE release_id=?").run(r4.releaseId));
      const p4 = new FakeProvider(); p4.fault("createDraft", "throw-after"); const r5 = s.approved();
      await s.exec(p4).run(r5.releaseId);
      await p4.createDraft({ name: `kapelle:${r5.op}`, subject: "x", html: "x", text: "x", from: "x", replyTo: "x", listId: "x" }); // someone made a second one
      expect(await s.exec(p4).run(r5.releaseId)).toMatchObject({ state: "held" });
      expect(s.state(r5.releaseId).label).toBe("newsletter_create_ambiguous");
      s.w.org.sqlite.write(() => s.db().prepare("UPDATE newsletter_effects SET state='failed' WHERE release_id=?").run(r5.releaseId));
      // An ambiguous send that DID go out: GET adopts it; a refused send holds the draft for a human.
      const p5 = new FakeProvider(3); p5.fault("send", "throw-after"); const r6 = s.approved();
      expect(await s.exec(p5).run(r6.releaseId)).toMatchObject({ state: "send_attempted" });
      expect((await s.exec(p5).run(r6.releaseId)).state).toBe("archive_pending");
      expect(p5.calls.filter((c) => c.op === "send")).toHaveLength(1);
      const p6 = new FakeProvider(); p6.fault("send", "refuse"); const r7 = s.approved();
      expect(await s.exec(p6).run(r7.releaseId)).toEqual({ state: "held", label: "newsletter_draft_held" });
    } finally { await s.w.close(); }
  });

  it("read-back mismatch fails; a recipient added since approval or the kill switch holds before send; overrun and unknown counts need reconciliation", async () => {
    const s = await setup();
    try {
      const p1 = new FakeProvider(); const r1 = s.approved();
      const orig = p1.getBroadcast.bind(p1);
      p1.getBroadcast = async (id: string) => { const b = await orig(id); return b ? { ...b, subject: "Changed in the dashboard" } : b; };
      expect(await s.exec(p1).run(r1.releaseId)).toEqual({ state: "failed", label: "newsletter_draft_mismatch" });
      expect(p1.calls.filter((c) => c.op === "send")).toHaveLength(0);
      const p2 = new FakeProvider(); const r2 = s.approved();
      s.audience.ids = ["c-1", "c-2", "c-3", "c-4"];
      expect(await s.exec(p2).run(r2.releaseId)).toEqual({ state: "held", label: "newsletter_recipients_changed" });
      s.audience.ids = ["c-1", "c-2"]; // a removal is fine
      s.w.org.sqlite.write(() => s.db().prepare("UPDATE newsletter_effects SET state='failed' WHERE release_id=?").run(r2.releaseId));
      const pk = new FakeProvider(); const rk = s.approved(); s.nl.setKill(true);
      expect(await s.exec(pk).run(rk.releaseId)).toEqual({ state: "approved", label: "newsletter_killed" }); // F-2: stopped before any mutation
      s.nl.setKill(false); s.w.org.sqlite.write(() => s.db().prepare("UPDATE newsletter_effects SET state='failed' WHERE release_id=?").run(rk.releaseId));
      // Answer 1: an addition observed by the re-read right after the send (here: during it) = newsletter_overrun.
      const p3 = new FakeProvider(); const r3 = s.approved(); p3.onSend = () => { s.audience.ids = [...(s.audience.ids ?? []), "c-9"]; };
      expect(await s.exec(p3).run(r3.releaseId)).toEqual({ state: "reconcile_required", label: "newsletter_overrun" });
      s.w.org.sqlite.write(() => s.db().prepare("UPDATE newsletter_effects SET state='failed' WHERE release_id=?").run(r3.releaseId));
      s.audience.ids = ["c-1", "c-2"];
      const p4 = new FakeProvider(); const r4 = s.approved(); p4.onSend = () => { s.audience.ids = null; }; // the post-send read fails
      expect(await s.exec(p4).run(r4.releaseId)).toEqual({ state: "reconcile_required", label: "newsletter_count_unknown" });
    } finally { await s.w.close(); }
  });

  it("an unwritable projection stops before any provider call; a projection AHEAD of the DB (restore) blocks every release", async () => {
    const s = await setup();
    try {
      const dir = join(s.w.cfg.stateRoot, "newsletter");
      rmSync(dir, { recursive: true, force: true }); writeFileSync(dir, "not a directory");
      const p = new FakeProvider(), r = s.approved();
      await expect(s.exec(p).run(r.releaseId)).rejects.toMatchObject({ label: "newsletter_manifest_unwritable" });
      expect(p.calls).toEqual([]);
      expect(s.state(r.releaseId).state).toBe("approved");
      rmSync(dir); mkdirSync(dir, { recursive: true });
      // The JSON names a release the DB does not know (the DB was restored from an older backup).
      writeFileSync(join(dir, "sent.json"), JSON.stringify({ contract: "kapelle.newsletter-manifest/v1", rows: [{ releaseId: "nr_" + "7".repeat(32), slug: "2026-10-07-october",
        digest: "sha256:" + "7".repeat(64), operationId: "op-old", state: "provider_accepted", broadcastId: "bc_old", at: "2026-10-07T19:40:00.000Z" }] }));
      expect(await s.exec(p).recover()).toEqual({ restoreReconcile: true, settled: 0 });
      expect(s.nl.status()).toMatchObject({ unsettled: 0 });
      expect(s.nl.preSendFailures(r.releaseId)).toContain("newsletter_uncertain_release");
      expect(JSON.parse(readFileSync(join(dir, "sent.json"), "utf8")).rows).toHaveLength(1); // never erased
    } finally { await s.w.close(); }
  });

  it("Fable S2-b F-1 regression (her rehearsal): an ahead projection stops run() with ZERO provider calls, the file byte-identical, a .reconcile copy kept", async () => {
    const s = await setup();
    try {
      const dir = join(s.w.cfg.stateRoot, "newsletter"), file = join(dir, "sent.json");
      mkdirSync(dir, { recursive: true });
      const old = JSON.stringify({ contract: "kapelle.newsletter-manifest/v1", rows: [{ releaseId: "nr_" + "6".repeat(32), slug: "2026-10-07-october",
        digest: "sha256:" + "6".repeat(64), operationId: "op-old", state: "provider_accepted", broadcastId: "bc_old", at: "2026-10-07T19:40:00.000Z" }] });
      writeFileSync(file, old);
      const p = new FakeProvider(), r = s.approved();
      for (let i = 0; i < 2; i++) expect(await s.exec(p).run(r.releaseId)).toEqual({ state: "approved", label: "newsletter_restore_reconcile" });
      expect(p.calls).toEqual([]);
      expect(readFileSync(file, "utf8")).toBe(old);
      const copies = readdirSync(dir).filter((n) => n.startsWith("sent.json.reconcile-"));
      expect(copies).toHaveLength(1);
      expect(readFileSync(join(dir, copies[0]), "utf8")).toBe(old);
      expect(s.state(r.releaseId).state).toBe("approved");
      expect(s.nl.status()).toMatchObject({ restoreReconcile: true });
    } finally { await s.w.close(); }
  });

  it("F-2 pre-mutation gate: another unsettled release or the kill switch leaves the row UNCHANGED in approved with no provider call", async () => {
    const s = await setup();
    try {
      const stuck = s.approved(); // another release held for a human (unsettled)
      s.w.org.sqlite.write(() => s.db().prepare("UPDATE newsletter_effects SET state='held', label='newsletter_draft_held', broadcast_id='bc_9' WHERE release_id=?").run(stuck.releaseId));
      expect(s.nl.status()).toMatchObject({ unsettledRows: [{ releaseId: stuck.releaseId, state: "held", label: "newsletter_draft_held", broadcastId: "bc_9" }] }); // N-1
      const p2 = new FakeProvider(), r = s.approved();
      expect(await s.exec(p2).run(r.releaseId)).toEqual({ state: "approved", label: "newsletter_uncertain_release" });
      expect(p2.calls.filter((c) => c.op === "createDraft")).toEqual([]);
      expect(s.state(r.releaseId).state).toBe("approved");
      s.w.org.sqlite.write(() => s.db().prepare("UPDATE newsletter_effects SET state='failed' WHERE release_id=?").run(stuck.releaseId));
      s.nl.setKill(true);
      expect(await s.exec(p2).run(r.releaseId)).toEqual({ state: "approved", label: "newsletter_killed" });
      expect(p2.calls).toEqual([]);
      s.nl.setKill(false);
      expect((await s.exec(p2).run(r.releaseId)).state).toBe("archive_pending"); // proceeds once the facts change
      // N-1: the status lists unsettled rows (here none left).
      expect(s.nl.status()).toMatchObject({ unsettledRows: [] });
    } finally { await s.w.close(); }
  });

  it("F-3 ahead detection: a projection saying 'sent' while the DB is failed or held is flagged; a legitimate create_attempted -> failed is not", async () => {
    for (const [proj, dbState, flagged] of [["provider_accepted", "failed", true], ["archive_pending", "held", true], ["provider_accepted", "reconcile_required", false],
      ["create_attempted", "failed", false], ["draft_known", "approved", true]] as const) {
      const s = await setup();
      try {
        const r = s.approved();
        s.w.org.sqlite.write(() => s.db().prepare("UPDATE newsletter_effects SET state=? WHERE release_id=?").run(dbState, r.releaseId));
        const dir = join(s.w.cfg.stateRoot, "newsletter"); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "sent.json"), JSON.stringify({ contract: "kapelle.newsletter-manifest/v1", rows: [{ releaseId: r.releaseId, slug: "x", digest: r.digest,
          operationId: r.op, state: proj, broadcastId: "bc_1", at: new Date().toISOString() }] }));
        expect((await s.exec(new FakeProvider()).recover()).restoreReconcile, `${proj} vs ${dbState}`).toBe(flagged);
      } finally { await s.w.close(); }
    }
  });
});
