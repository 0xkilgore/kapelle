// Lean runtime step 4, stage B: signed email intake (Fable step-4 R-1, R-2), quarantine, two audience roots. Fake provider.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { signWebhook, QUARANTINE_CAPS } from "../src/org/intake.js";
import { makeWorld } from "./org-fixture.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const socket = (path: string, route: string, payload: unknown): Promise<any> => new Promise((resolve, reject) => {
  const data = Buffer.from(JSON.stringify(payload));
  const r = request({ socketPath: path, path: route, method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": data.length } }, (res) => {
    const c: Buffer[] = []; res.on("data", (x) => c.push(x)); res.on("end", () => resolve(JSON.parse(Buffer.concat(c).toString())));
  });
  r.on("error", reject); r.end(data);
});

describe.skipIf(!enabled)("org email intake (step 4 stage B)", () => {
  it("R-1/R-2: signed, per-installation, envelope-recipient-only, replay-guarded intake with quarantine and two audience roots", async () => {
    const w = await makeWorld(["org-a", "org-b"]);
    try {
      const A = w.orgs["org-a"], B = w.orgs["org-b"];
      for (const o of [A, B]) { await w.bootstrap(o); expect(readdirSync(o.folder).sort()).toEqual(["members", "reviewers-private"]); }
      const alex = await w.invite(A, "alex@a.test", "contributor");
      const addr = w.issueAddress(w.orgs["org-a"], alex) as string;
      expect(addr).toMatch(/^intake\+[A-Za-z0-9]+@org-a\.in\.kapelle\.test$/);

      // Accepted: one record, files only under reviewers-private, a duplicate delivery replays it, a conflict is refused.
      const ok = await w.deliver(A, { to: [addr], text: "Cleanup confirmed for Oct 31.", attachments: [{ filename: "agenda.md", content_type: "text/markdown", content: Buffer.from("# Agenda").toString("base64") },
        { filename: "flyer.pdf", content_type: "application/pdf", content: Buffer.from("%PDF").toString("base64") }] }, { id: "msg_cleanup_0001" });
      expect(ok.status).toBe(200);
      expect(ok.body).toEqual({ ok: true }); // the provider gets an ack, never content or intake state
      const recs = A.sqlite.db.prepare("SELECT * FROM intake_records").all() as any[];
      expect(recs).toHaveLength(1);
      expect(recs[0]).toMatchObject({ state: "accepted", member_id: alex.memberId });
      const files = JSON.parse(recs[0].files);
      expect(files.refused).toEqual([{ name: "attachment-2-flyer.pdf", reason: "intake_attachment_type_not_admitted" }]);
      const dir = join(A.folder, "reviewers-private", "intake", recs[0].intake_id);
      expect(readFileSync(join(dir, "message.md"), "utf8")).toContain("Cleanup confirmed for Oct 31.");
      // Intake never writes to the members audience (only the empty notes skeleton exists there).
      expect(readdirSync(join(A.folder, "members"))).toEqual(["notes"]);
      expect(readdirSync(join(A.folder, "members", "notes"))).toEqual([]);
      const again = await w.http(`/ingress/email/${A.installationId}`, undefined, "", { "webhook-id": ok.id, "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": signWebhook(A.secret, A.installationId, ok.id, String(Math.floor(Date.now() / 1000)), ok.raw) }, ok.raw);
      expect(again.status).toBe(200);
      expect(A.sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_records").get()).toEqual({ n: 1 });
      const conflict = await w.deliver(A, { to: [addr], text: "DIFFERENT body, same provider event id" }, { id: "msg_cleanup_0001" });
      expect([conflict.status, conflict.body.error]).toEqual([422, "intake_payload_conflict"]);

      // R-1: bad signature, stale timestamp, tampered bytes, unknown installation, wrong installation secret -> refused at the hub.
      expect((await w.deliver(A, { to: [addr] }, { secret: "wrong-secret" })).status).toBe(401);
      expect((await w.deliver(A, { to: [addr] }, { timestamp: Date.now() - 600_000 })).status).toBe(401);
      expect((await w.deliver(A, { to: [addr] }, { tamper: true })).status).toBe(401);
      expect((await w.deliver(A, { to: [addr] }, { installationId: "inst-nowhere" })).status).toBe(404);
      expect((await w.deliver(A, { to: [addr] }, { installationId: B.installationId, secret: A.secret })).status).toBe(401);
      // R-1: the runtime RE-VERIFIES the raw bytes; a hub that skipped (or lied) cannot inject.
      const forged = await socket(A.socketPath, "/intake/email", { installationId: A.installationId, headers: { id: "msg_forged_0001", timestamp: String(Math.floor(Date.now() / 1000)), signature: "v1,AAAA" },
        body: JSON.stringify({ type: "email.received", data: { email_id: "msg_forged_0001", message_id: "<x>", from: "x", to: [addr], subject: "s" } }) });
      expect(forged).toEqual({ ok: false, error: "intake_signature_invalid" });

      // R-2: quarantine (metadata only, no echo) for unknown / revoked / quoted-only / other-org / ambiguous / inactive.
      const quarantinedBefore = A.intake.quarantined().length;
      const q = async (data: Record<string, unknown>, o: Parameters<typeof w.deliver>[2] = {}) => { const r = await w.deliver(A, data, o); expect(r.status).toBe(200); expect(r.body).toEqual({ ok: true }); };
      await q({ to: ["intake+UNKNOWNTOKEN0000000000@org-a.test.kapelle.test"], text: "who am i" });
      await q({ to: ["board@org-a.test.kapelle.test"], text: `please file this — my address is ${addr}` }); // token only in the body
      await q({ to: [addr.replace("org-a", "org-b")], text: "my org-a token sent to the org-a installation but org-b domain" });
      await q({ to: [addr, `intake+OTHERTOKEN00000000000@org-a.test.kapelle.test`], text: "two of ours" });
      // Same human in org B: an org-b token never resolves at org A.
      const alexB = await w.invite(B, "alex@a.test", "contributor");
      const addrB = w.issueAddress(w.orgs["org-b"], alexB) as string;
      await q({ to: [addrB.replace("org-b", "org-a")], text: "org-b token at org-a" });
      // Spoofed From / poisoned Reply-To / forwarded header change nothing about attribution.
      const spoof = await w.deliver(A, { to: [addr], from: "robin@a.test", headers: { "reply-to": "attacker@evil.test" }, text: "---------- Forwarded message ---------\nFrom: robin@a.test" });
      expect(spoof.status).toBe(200);
      const spoofRec = A.sqlite.db.prepare("SELECT member_id, state FROM intake_records WHERE provider_event_id=?").get(spoof.id);
      expect(spoofRec).toEqual({ member_id: alex.memberId, state: "accepted" });
      // Revocation: new token issued -> old address quarantines; explicit revoke -> quarantines.
      const addr2 = w.issueAddress(w.orgs["org-a"], alex) as string;
      await q({ to: [addr], text: "old token" });
      A.intake.revokeTokens(alex.memberId, A.installationId);
      await q({ to: [addr2], text: "revoked token" });
      const reasons = A.intake.quarantined().slice(quarantinedBefore).map((r) => r.reason);
      expect(reasons).toEqual(["intake_token_unknown", "intake_token_missing", "intake_not_addressed_here", "intake_recipient_ambiguous", "intake_token_unknown",
        "intake_token_revoked", "intake_token_revoked"]);
      // Quarantine keeps metadata only: no file, no member, no body.
      for (const r of A.sqlite.db.prepare("SELECT * FROM intake_records WHERE state='quarantined'").all() as any[]) {
        expect([r.files, r.member_id, r.message_id]).toEqual([null, null, null]);
        expect(existsSync(join(A.folder, "reviewers-private", "intake", r.intake_id))).toBe(false);
      }
      // Org B saw nothing of org A's traffic.
      expect(B.sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_records").get()).toEqual({ n: 0 });
      // Quarantine caps evict the oldest with an audit row.
      for (let i = 0; i < QUARANTINE_CAPS.rows + 3; i++) {
        const raw = JSON.stringify({ type: "email.received", data: { email_id: `msg_flood_${String(i).padStart(6, "0")}`, message_id: "<f>", from: "x", to: ["nobody@org-a.test.kapelle.test"], subject: "s" } });
        A.intake.receive(A.installationId, { id: `msg_flood_${String(i).padStart(6, "0")}`, timestamp: String(Math.floor(Date.now() / 1000)),
          signature: signWebhook(A.secret, A.installationId, `msg_flood_${String(i).padStart(6, "0")}`, String(Math.floor(Date.now() / 1000)), raw) }, raw, A.memberActive);
      }
      expect(A.intake.quarantined().length).toBe(QUARANTINE_CAPS.rows);
      expect((A.sqlite.db.prepare("SELECT COUNT(*) AS n FROM intake_audit WHERE event='quarantine_evicted'").get() as { n: number }).n).toBeGreaterThanOrEqual(10);
    } finally { await w.close(); }
  }, 180_000);
});
