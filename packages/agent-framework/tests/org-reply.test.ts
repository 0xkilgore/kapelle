// Lean runtime step 4, stage D: the adopted 1:1 member reply path in SHADOW mode (Fable step-4 R-3..R-7). Two demo orgs,
// fake model, fake mail. Nothing is ever sent: there is no transport, and 'sent' is unrepresentable for member replies.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeWorld } from "./org-fixture.js";
import { meetingKit, meetingCycle, requestsLog, hosted } from "./org-meeting-kit.js";
import { script } from "./org-meeting-script.js";
import { MemberReplies, policyHash, type ReplyPolicy } from "../src/org/member-reply.js";
import { ACCESS_TABLE_HASH } from "../src/access/org-access.js";
import { READER_POLICY_HASH } from "../src/agent-kit/scope-assembler.js";
import { profileHash } from "../src/agent-kit/runtime-catalog.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/member-reply-golden.json", import.meta.url)), "utf8"));
const settle = async (org: any, intakeId: string) => { for (let i = 0; i < 200; i++) { const r = org.replies.existing(intakeId); if (r && r.reason !== "generation_in_progress") return r; await new Promise((x) => setTimeout(x, 10)); } throw new Error("reply never settled"); };

describe.skipIf(!enabled)("shadow member replies (step 4 stage D)", () => {
  it("golden shadow replies for both orgs; R-3 triggers, R-4 pins, R-5 structural shadow, R-6 disclosure, replay", async () => {
    const w = await makeWorld(["org-a", "org-b"], meetingKit(script));
    try {
      const people: Record<string, any> = {};
      for (const id of ["org-a", "org-b"]) {
        const o = w.orgs[id] as any, g = golden.orgs[id];
        people[id] = await meetingCycle(w, o, { meeting: g.meeting, notes: g.notes, date: g.date, title: g.title });
        // R-6 sentinels in the reviewers-private root: text (intake), file TITLE and PATH, and a Task body.
        const { writeFileSync, mkdirSync } = await import("node:fs");
        mkdirSync(join(o.folder, "reviewers-private", "drafts"), { recursive: true, mode: 0o700 });
        writeFileSync(join(o.folder, "reviewers-private", "drafts", `SENTINEL-RP-PATH-${id}.md`), `# SENTINEL-RP-TITLE-${id}\nSENTINEL-RP-TEXT-${id}\n`, { mode: 0o600 });
        const t = people[id].taskId, rev = (await o.rt.authority.backend.read(t, "kilgore/task")).nativeRevision;
        await o.rt.authority.orgTaskCommand({ operationId: `body-${id}-0001`, documentId: t, documentType: "kilgore/task", expectedRevision: rev, type: "UPDATE_BODY",
          input: { bodyMarkdown: `SENTINEL-TASKBODY-${id} private context` } }, `member:${id}:${people[id].robin.memberId}:v${o.access.membershipVersion()}`);
        // A reviewer's own Q&A turn (prior chat history) must never reach a contributor's prompt.
        await w.http(`/o/${id}/api/agent/ask`, { question: `SENTINEL-ROBIN-CHAT-${id} what did the notes say?` }, people[id].robin.cookie);
        // R-4 + option A: policy.approve is `totp` tier: refused in the app (reviewer and admin alike, nothing written), approved
        // by Ops over the exact policy (artifact digest = policy hash).
        const policy: ReplyPolicy = { contract: "kapelle.member-reply-policy/v1", version: 1, mode: "shadow", senderName: "Neighborhood notes",
          members: [{ memberId: people[id].alex.memberId }], sourceAudience: "members",
          catalogProfileHash: profileHash(hosted), readerPolicyHash: READER_POLICY_HASH, actionTableHash: ACCESS_TABLE_HASH,
          caps: { perMemberPerDay: 6, perOrgPerDay: 100, followUps: 1, maxChars: 2000 }, retentionDays: 90 };
        expect((await w.act(o, people[id].robin, "policy.approve", policy, policyHash(policy))).body.error).toBe("access_step_up_required");
        expect((await w.act(o, w.admins[id], "policy.approve", policy, policyHash(policy))).body.error).toBe("access_step_up_required");
        expect(o.sqlite.db.prepare("SELECT COUNT(*) AS n FROM member_reply_policy").get()).toEqual({ n: 0 });
        expect((await w.opsAct(o, "policy.approve", policy, policyHash(policy))).body.result).toMatchObject({ policyHash: policyHash(policy) });
        expect(o.sqlite.db.prepare("SELECT approved_by FROM member_reply_policy WHERE active=1").get()).toEqual({ approved_by: "ops" });
      }
      const mailBefore = w.mail.length;
      const ask = async (id: string, text: string, data: Record<string, unknown> = {}) => {
        const o = w.orgs[id] as any, d = await w.deliver(o, { to: [people[id].addr], subject: "Question", text, ...data });
        expect(d.status).toBe(200);
        const intakeId = (o.sqlite.db.prepare("SELECT intake_id FROM intake_records WHERE provider_event_id=?").get(d.id) as { intake_id: string }).intake_id;
        return { intakeId, row: await settle(o, intakeId), d };
      };

      // R-7 golden: the four content cases in both orgs, exact answers + citations; bytes go only to the stored address.
      for (const c of golden.cases) {
        const { row } = await ask(c.org, c.question);
        expect([row.decision, row.reason], `${c.org}/${c.id}`).toEqual([c.decision, null]);
        const bytes = String(row.bytes), body = bytes.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim();
        // The member-facing body: no machine citation markers, one plain source line (the journal keeps the citations).
        expect(body.replace(/\r\n/g, "\n"), `${c.org}/${c.id}`).toBe(c.body);
        expect(body).not.toMatch(/\.md#L\d/);
        expect(JSON.parse(String(row.citations)).map((x: any) => [x.path, x.startLine]), `${c.org}/${c.id}`).toEqual(c.citations);
        expect(bytes).toMatch(new RegExp(`^From: "Neighborhood notes" <agent@reply\\.${c.org}\\.kapelle\\.test>\\r\\nTo: <${people[c.org].alex.email.replace(".", "\\.")}>\\r\\n`));
        expect(bytes).toContain("Auto-Submitted: auto-replied");
        expect(bytes).not.toMatch(/^(Cc|Bcc|Reply-To):/im);
        expect(row).toMatchObject({ recipient: people[c.org].alex.email, policy_version: 1, catalog_profile_hash: profileHash(hosted), outbox: "shadowed" });
        expect(String(row.ledger_session)).toMatch(/^[0-9a-f-]{36}$/);
      }

      const A = w.orgs["org-a"] as any;
      // Destination: spoofed From, poisoned Reply-To, CC -> still only the stored verified address, no Cc/Reply-To.
      const spoof = await ask("org-a", "When is the cleanup?", { from: "attacker@evil.test", cc: ["victim@else.test"], headers: { "reply-to": "attacker@evil.test" } });
      expect(spoof.row.decision).toBe("shadowed");
      expect(String(spoof.row.bytes)).toMatch(/\r\nTo: <alex@org-a\.test>\r\n/);
      expect(String(spoof.row.bytes)).not.toMatch(/evil\.test|else\.test/);
      // Threading binds to the validated intake Message-ID, headers are model-free.
      expect(String(spoof.row.bytes)).toContain(`In-Reply-To: <${spoof.d.id}@sender.test>`);

      // R-3 trigger refusals, each journalled.
      expect((await ask("org-a", "When?", { headers: { "Auto-Submitted": "auto-replied" } })).row).toMatchObject({ decision: "refused", reason: "trigger_auto_submitted" });
      expect((await ask("org-a", "When?", { headers: { Precedence: "bulk" } })).row).toMatchObject({ decision: "refused", reason: "trigger_bulk_precedence" });
      const ours = "<reply_aaaa@reply.test-a.kapelle.test> <reply_bbbb@reply.test-a.kapelle.test>";
      expect((await ask("org-a", "When?", { headers: { References: ours } })).row).toMatchObject({ decision: "refused", reason: "trigger_follow_up_cap" });
      // Robin is a member but not in the policy list.
      const robinAddr = w.issueAddress(w.orgs["org-a"], people["org-a"].robin);
      const rd = await w.deliver(A, { to: [robinAddr], subject: "Q", text: "When is the cleanup?" });
      const rid = (A.sqlite.db.prepare("SELECT intake_id FROM intake_records WHERE provider_event_id=?").get(rd.id) as any).intake_id;
      expect(await settle(A, rid)).toMatchObject({ decision: "refused", reason: "trigger_member_not_permitted" });
      // Member rate cap (6/day for Alex: 4 golden + spoof + this one), then refused.
      expect((await ask("org-a", "When is the cleanup?")).row.decision).toBe("shadowed");
      expect((await ask("org-a", "When is the cleanup?")).row).toMatchObject({ decision: "refused", reason: "trigger_member_rate_cap" });
      // Kill flag, then STOP (member paused), both journalled.
      A.replies.setKill(true);
      expect((await ask("org-b", "Anything new?")).row).toMatchObject({ decision: "shadowed", reason: null }); // org B unaffected by A's kill flag
      expect((await ask("org-a", "When?")).row).toMatchObject({ decision: "refused", reason: "trigger_org_killed" });
      A.replies.setKill(false);
      // R-4: any pin mismatch pauses (e.g. the host's catalog profile changed after approval).
      const B = w.orgs["org-b"] as any;
      B.hostPins.catalogProfileHash = "sha256:" + "0".repeat(64);
      expect((await ask("org-b", "When is the planting day?")).row).toMatchObject({ decision: "paused", reason: "policy_pin_mismatch" });
      B.hostPins.catalogProfileHash = profileHash(hosted);
      expect((await ask("org-b", "STOP")).row).toMatchObject({ decision: "refused", reason: "member_stopped" });
      expect((await ask("org-b", "When is the planting day?")).row).toMatchObject({ decision: "refused", reason: "member_stopped" });

      // Replay / crash: a redelivery or a second trigger of the same intake never produces a second row or generation.
      const first = await ask("org-a", "What time does the cleanup start?");
      const gens = requestsLog.length;
      expect(await A.replies.onIntake(first.intakeId)).toMatchObject({ reply_id: first.row.reply_id });
      expect(requestsLog.length).toBe(gens);
      expect((A.sqlite.db.prepare("SELECT COUNT(*) AS n FROM member_replies WHERE intake_id=?").get(first.intakeId) as any).n).toBe(1);
      // An interrupted generation (reserved, never shadowed) is closed at start-up, not regenerated.
      A.sqlite.db.prepare("INSERT INTO member_replies(reply_id,intake_id,member_id,decision,reason,at) VALUES ('reply_crash_test_0001','intake_crashtestcrashtest00000000',NULL,'refused','generation_in_progress',?)").run(new Date().toISOString());
      A.sqlite.db.prepare("INSERT INTO member_reply_outbox(reply_id,state,at) VALUES ('reply_crash_test_0001','reserved',?)").run(new Date().toISOString());
      A.replies.recoverAtStart();
      expect(A.sqlite.db.prepare("SELECT reason FROM member_replies WHERE reply_id='reply_crash_test_0001'").get()).toEqual({ reason: "reply_interrupted_not_regenerated" });

      // A crash between the intake commit and the trigger: the start-up sweep journals it exactly once.
      const lost = await w.deliver(A, { to: [people["org-a"].addr], subject: "Q", text: "When is the cleanup?" });
      const lostId = (A.sqlite.db.prepare("SELECT intake_id FROM intake_records WHERE provider_event_id=?").get(lost.id) as any).intake_id;
      await settle(A, lostId);
      A.sqlite.db.prepare("DELETE FROM member_reply_outbox WHERE reply_id=(SELECT reply_id FROM member_replies WHERE intake_id=?)").run(lostId);
      A.sqlite.db.prepare("DELETE FROM member_replies WHERE intake_id=?").run(lostId); // simulate: the decision was never written
      expect(await A.replies.resumeAtStart()).toEqual([lostId]);
      expect(A.replies.existing(lostId)).toBeTruthy();
      expect(await A.replies.resumeAtStart()).toEqual([]);
      // R-5 structural shadow: no transport, no send method, 'sent' unrepresentable; no reply mail ever left.
      expect(() => A.sqlite.db.prepare("UPDATE member_reply_outbox SET state='sent'").run()).toThrow(/CHECK constraint/);
      expect(Object.getOwnPropertyNames(MemberReplies.prototype).filter((n) => /send|transport|deliver|smtp/i.test(n))).toEqual([]);
      const src = readFileSync(fileURLToPath(new URL("../src/org/member-reply.ts", import.meta.url)), "utf8");
      expect(src).not.toMatch(/\bfetch\(|node:(http|https|net|tls)|nodemailer/);
      expect(w.mail.slice(mailBefore).filter((m) => m.kind !== "login" && m.kind !== "invite")).toEqual([]);
      expect((A.sqlite.db.prepare("SELECT COUNT(*) AS n FROM member_reply_outbox WHERE state='shadowed'").get() as any).n).toBeGreaterThan(0);

      // R-6 disclosure: every prompt built for a member, every reply byte, the member's audit view and chat answers are
      // free of reviewers-private text/title/path, Task bodies, the reviewer's chat turns, and the other org.
      const memberPrompts = requestsLog.filter((r) => r.kind === "chat" && !/SENTINEL-ROBIN-CHAT/.test(r.user.split("QUESTION:").pop() ?? ""));
      expect(memberPrompts.length).toBeGreaterThan(10);
      const forbidden = /SENTINEL-(RP|TASKBODY|ORGB-SPEAKER)|SENTINEL-ROBIN-CHAT|reviewers-private|intake_|drafts\//;
      for (const p of memberPrompts) {
        const own = p.orgId === "org-a" ? /SENTINEL-RP-[A-Z]+-org-b|ORGB/ : /SENTINEL-RP-[A-Z]+-org-a|4f2a/;
        expect(p.user, p.orgId).not.toMatch(forbidden);
        expect(p.user, p.orgId).not.toMatch(own);
        expect(p.user).toMatch(/FILES \(frozen copy, [12] files?;/); // only the members notes versions are counted
      }
      for (const id of ["org-a", "org-b"]) {
        const view = (await w.http(`/o/${id}/api/audit/read`, {}, people[id].alex.cookie)).body.result as any[];
        expect(view.length).toBeGreaterThan(0);
        expect(view.every((r) => r.member_id === people[id].alex.memberId)).toBe(true);
        // The member's own submissions appear as the audit's source trigger (their own intake ids); nothing else may.
        const content = new RegExp(forbidden.source.replace("|intake_", ""), "g");
        expect([...new Set([...JSON.stringify(view).matchAll(content)].map((m) => m[0]))]).toEqual([]);
        const o = w.orgs[id] as any;
        for (const r of view) expect((o.sqlite.db.prepare("SELECT member_id FROM intake_records WHERE intake_id=?").get(r.intake_id) as any)?.member_id).toBe(people[id].alex.memberId);
        const all = (await w.http(`/o/${id}/api/audit/read`, {}, people[id].robin.cookie)).body.result as any[];
        // Reviewers see every row; in org-a that includes Robin's own refused trigger, which Alex must not see.
        if (id === "org-a") expect(all.length).toBeGreaterThan(view.length); else expect(all.length).toBeGreaterThanOrEqual(view.length);
      }
    } finally { await w.close(); }
  }, 600_000);
});
