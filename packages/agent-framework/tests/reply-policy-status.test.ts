// Ops request (after the chat content v1 upgrade): /ops/status.replyPolicy {active, pinMatches}, no policy text, so an
// upgrade that moves a pinned hash (the access table, the catalog profile, the reader policy) shows in the normal status
// read instead of only as 'paused' journal rows when members email. Same pin check as the trigger (member-reply R-4).
import { describe, it, expect } from "vitest";
import { transcriptionWorld } from "./transcription-world.js";
import { READER_POLICY_HASH } from "../src/agent-kit/scope-assembler.js";
import { profileHash } from "../src/agent-kit/runtime-catalog.js";
import { ACCESS_TABLE_HASH } from "../src/access/org-access.js";
import { hosted } from "./org-meeting-kit.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;

describe.skipIf(!enabled)("/ops/status.replyPolicy", () => {
  it("none -> {active:false, pinMatches:null}; current pins -> true; a stale access-table pin -> false; no policy text", async () => {
    const w = await transcriptionWorld();
    try {
      const status = async () => (await w.ops("/ops/status", {})).replyPolicy;
      expect(await status()).toEqual({ active: false, pinMatches: null });
      const memberId = (w.org.sqlite.db.prepare("SELECT member_id FROM access_members WHERE email='alex@exna.test'").get() as { member_id: string }).member_id;
      const policy = { contract: "kapelle.member-reply-policy/v1", version: 1, mode: "shadow", senderName: "EXNA notes", members: [{ memberId }],
        sourceAudience: "members", catalogProfileHash: profileHash(hosted), readerPolicyHash: READER_POLICY_HASH, actionTableHash: ACCESS_TABLE_HASH,
        caps: { perMemberPerDay: 10, perOrgPerDay: 100, followUps: 1, maxChars: 2000 }, retentionDays: 90 };
      expect((await w.ops("/ops/policy/approve", { policy })).ok).toBe(true);
      expect(await status()).toEqual({ active: true, pinMatches: true });
      // A policy approved against an older access table (as after WC-2/WC-4 moved it): reported, not hidden.
      expect((await w.ops("/ops/policy/approve", { policy: { ...policy, version: 2, actionTableHash: "sha256:" + "1".repeat(64) } })).ok).toBe(true);
      expect(await status()).toEqual({ active: true, pinMatches: false });
      expect(JSON.stringify(await w.ops("/ops/status", {}))).not.toContain("EXNA notes");
    } finally { await w.close(); }
  });
});
