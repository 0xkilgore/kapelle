// Fable P-R1 (CP install incident, 2026-10-16: a raw bootstrap token reached a chat transcript). Ops can revoke an
// unconsumed bootstrap or member invitation by email or invitation id (audited), and the two Ops invite responses carry
// ONE secret-bearing field (the link), never a separate token. Real org runtime + hub; synthetic data.
import { describe, it, expect } from "vitest";
import { transcriptionWorld } from "./transcription-world.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const tokenOf = (link: string) => new URL(link).hash.slice(7);

describe.skipIf(!enabled)("Ops invitation revoke (P-R1)", () => {
  it("bootstrap and member invites: link only, revocable by email or id, audited; consumed ones untouched", async () => {
    const w = await transcriptionWorld({ members: false });
    try {
      const b = await w.ops("/ops/bootstrap/invite", { email: "Admin@exna.test" });
      expect(Object.keys(b).sort()).toEqual(["email", "invitationId", "link", "ok"]);
      expect(JSON.stringify(b).match(new RegExp(tokenOf(b.link), "g"))).toHaveLength(1); // the token appears once: inside the link
      expect(await w.ops("/ops/bootstrap/revoke", {})).toEqual({ ok: false, error: "access_invite_invalid" });
      expect(await w.ops("/ops/bootstrap/revoke", { email: "nobody@exna.test" })).toEqual({ ok: false, error: "access_invite_unknown" });
      expect(await w.ops("/ops/bootstrap/revoke", { email: "admin@exna.test" })).toEqual({ ok: true, revoked: 1, invitationIds: [b.invitationId] });
      expect(await w.ops("/ops/bootstrap/revoke", { email: "admin@exna.test" })).toEqual({ ok: false, error: "access_invite_unknown" });
      // The revoked link no longer opens or joins.
      const info = await fetch(`${w.url}/o/exna/invite/info`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: tokenOf(b.link) }) });
      expect((await info.json()).error).toBe("access_invite_expired");
      expect(await w.join(b.link)).toBe("");
      // A new bootstrap link works; once consumed, revoke cannot touch it.
      const b2 = await w.ops("/ops/bootstrap/invite", { email: "admin@exna.test" });
      expect(await w.join(b2.link)).toMatch(/^kh_exna=/);
      expect(await w.ops("/ops/bootstrap/revoke", { invitationId: b2.invitationId })).toEqual({ ok: false, error: "access_invite_unknown" });
      // Member invites: link only; revoke by id; a bootstrap revoke never touches a member invite (and vice versa).
      const m = await w.ops("/ops/member/invite", { email: "robin@exna.test", role: "reviewer" });
      expect(Object.keys(m).sort()).toEqual(["email", "invitationId", "link", "ok", "role"]);
      expect(await w.ops("/ops/bootstrap/revoke", { invitationId: m.invitationId })).toEqual({ ok: false, error: "access_invite_unknown" });
      expect(await w.ops("/ops/member/invite/revoke", { invitationId: m.invitationId })).toEqual({ ok: true, revoked: 1, invitationIds: [m.invitationId] });
      expect(await w.join(m.link)).toBe("");
      expect(await w.ops("/ops/member/invite/revoke", { invitationId: "../../x" })).toEqual({ ok: false, error: "access_invite_invalid" });
      // Audited (Ops actor, the invitation id, the kind), never the token.
      const audit = w.org.sqlite.db.prepare("SELECT member_id, action, outcome, reason, operation_id FROM access_audit WHERE reason LIKE '%revoked%' ORDER BY rowid").all();
      expect(audit).toEqual([
        { member_id: "ops", action: "member.invite", outcome: "refused", reason: "authn:ops-socket;revoked:bootstrap", operation_id: b.invitationId },
        { member_id: "ops", action: "member.invite", outcome: "refused", reason: "authn:ops-socket;revoked:member", operation_id: m.invitationId }]);
      expect(JSON.stringify(w.org.sqlite.db.prepare("SELECT * FROM access_audit").all())).not.toContain(tokenOf(m.link));
    } finally { await w.close(); }
  }, 120_000);
});
