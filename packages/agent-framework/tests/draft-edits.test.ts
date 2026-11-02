// PACKAGE P: exact, atomic draft edits + the member-link check (pure functions), and the edit tool end to end over ChatTools.
// Cases follow the semantics of Aider's search/replace edits (exact match; missing or ambiguous search refuses; no partial apply)
// and Codex apply-patch (a patch applies to its exact parent or not at all); written here, not copied (pattern reference only).
// Synthetic content.
import { describe, it, expect } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { randomUUID } from "node:crypto";
import { applyDraftEdits, canonicalUrl, draftListFields, entryTitles, memberLinks, missingMemberLinks } from "../src/org/chat/draft-edits.js";
import { transcriptionWorld } from "./transcription-world.js";
import { ChatTools } from "../src/org/chat/tools.js";

const NL = () => ({ title: "November in Example Park", headerPhotos: ["https://www.example.org/images/a.jpg", "https://www.example.org/images/b.jpg",
  "https://www.example.org/images/c.jpg", "https://www.example.org/images/d.jpg"],
  sections: [{ heading: "Block Party", body: "Over 300 neighbors came. See you next year.", links: [{ text: "Photos", url: "https://www.example.org/gallery" }] },
    { heading: "Cleanup", body: "The cleanup is on Oct 31 at 9 am." }],
  sources: [{ path: "members/notes/2026-10-08.v1.md", line: 2 }] });

describe("applyDraftEdits (exact, atomic)", () => {
  it("one replace changes exactly that field; every other byte is the parent's", () => {
    const p = NL(), r = applyDraftEdits("newsletter", p, [{ op: "replace_text", field: "sections[0].heading", old: "Block Party", new: "Block Party 2026" }]);
    expect(r.ok).toBe(true);
    const c = (r as any).content;
    expect(c.sections[0].heading).toBe("Block Party 2026");
    expect(JSON.stringify({ ...c, sections: [{ ...c.sections[0], heading: "Block Party" }, c.sections[1]] })).toBe(JSON.stringify(p));
    expect((r as any).changed).toEqual(["sections[0].heading"]);
    expect(p.sections[0].heading).toBe("Block Party"); // the parent is never mutated
  });
  it("a substring replace inside a body (exactly one occurrence)", () => {
    const r = applyDraftEdits("newsletter", NL(), [{ op: "replace_text", field: "sections[1].body", old: "9 am", new: "10 am" }]);
    expect((r as any).content.sections[1].body).toBe("The cleanup is on Oct 31 at 10 am.");
  });
  it("Aider: missing SEARCH text refuses; ambiguous SEARCH refuses; no fuzzy or whitespace-folded match", () => {
    expect(applyDraftEdits("newsletter", NL(), [{ op: "replace_text", field: "title", old: "December", new: "x" }])).toMatchObject({ ok: false, error: "draft_edit_not_found" });
    expect(applyDraftEdits("newsletter", { ...NL(), title: "Park news, Park fun" }, [{ op: "replace_text", field: "title", old: "Park", new: "x" }])).toMatchObject({ ok: false, error: "draft_edit_ambiguous" });
    expect(applyDraftEdits("newsletter", NL(), [{ op: "replace_text", field: "title", old: "November  in", new: "x" }])).toMatchObject({ ok: false, error: "draft_edit_not_found" });
    expect(applyDraftEdits("newsletter", NL(), [{ op: "replace_text", field: "title", old: "november in", new: "x" }])).toMatchObject({ ok: false, error: "draft_edit_not_found" });
  });
  it("Fable PP-1/PP-2: the same field twice in one call is a conflict; a failing edit reports its position; titles re-anchor", () => {
    expect(applyDraftEdits("newsletter", NL(), [{ op: "replace_text", field: "title", old: "November", new: "December" }, { op: "replace_text", field: "title", old: "Example", new: "C" }]))
      .toMatchObject({ ok: false, error: "draft_edit_conflict" });
    expect(applyDraftEdits("newsletter", NL(), [{ op: "replace_text", field: "title", old: "November", new: "December" }, { op: "replace_text", field: "sections[1].body", old: "nope", new: "x" }]))
      .toEqual({ ok: false, error: "draft_edit_not_found", at: 1, current: "The cleanup is on Oct 31 at 9 am." });
    expect(entryTitles("newsletter", NL())).toEqual([{ index: 0, heading: "Block Party" }, { index: 1, heading: "Cleanup" }]);
    // In order: an add shifts the index a later edit names.
    const r = applyDraftEdits("newsletter", NL(), [{ op: "add_entry", after: -1, entry: { heading: "First", body: "x" } }, { op: "replace_text", field: "sections[1].heading", old: "Block Party", new: "Block Party!" }]) as any;
    expect(r.content.sections.map((x: any) => x.heading)).toEqual(["First", "Block Party!", "Cleanup"]);
  });
  it("P run 3: a refused list edit returns the field's CURRENT list, so the retry is exact (the live draft-edit-photos failure)", () => {
    const withImg: any = { ...NL(), sections: NL().sections.map((x, i) => i === 1 ? { ...x, images: [{ url: "https://www.example.org/images/a.jpg", alt: "", position: "above" }] } : x) };
    const add = [{ url: "https://www.example.org/images/b.jpg", alt: "Crowd", caption: "Block Party", position: "left" }];
    const r = applyDraftEdits("newsletter", withImg, [{ op: "set_list", field: "sections[1].images", old: [], new: add }]);
    expect(r).toEqual({ ok: false, error: "draft_edit_not_found", at: 0, current: withImg.sections[1].images });
    const retry = applyDraftEdits("newsletter", withImg, [{ op: "set_list", field: "sections[1].images", old: (r as any).current, new: add }]) as any;
    expect(retry.content.sections[1].images).toEqual(add);
    expect(applyDraftEdits("newsletter", withImg, [{ op: "remove_entry", index: 1, oldTitle: "Block Party" }])).toEqual({ ok: false, error: "draft_edit_not_found", at: 0, current: "Cleanup" });
    // Fable F-2': every list field, keyed by name (the hint's `lists`); agendas have none.
    expect(draftListFields("newsletter", withImg)).toEqual({ headerPhotos: NL().headerPhotos, "sections[0].images": [], "sections[0].links": NL().sections[0].links,
      "sections[1].images": withImg.sections[1].images, "sections[1].links": [] });
    expect(draftListFields("agenda", { meeting: "m", date: "2026-11-10", items: [{ title: "x" }], sources: [] })).toEqual({});
  });
  it("Codex: all or nothing (a later edit that fails leaves no earlier edit applied)", () => {
    const p = NL();
    const r = applyDraftEdits("newsletter", p, [{ op: "replace_text", field: "title", old: "November", new: "December" }, { op: "replace_text", field: "sections[1].body", old: "nope", new: "x" }]);
    expect(r).toEqual({ ok: false, error: "draft_edit_not_found", at: 1, current: "The cleanup is on Oct 31 at 9 am." });
    expect(p.title).toBe("November in Example Park");
  });
  it("lists change only against their exact current value; unknown fields and out-of-range entries refuse", () => {
    const p = NL(), photos = [...p.headerPhotos];
    const swap = [...photos]; swap[0] = "https://www.example.org/images/e.jpg";
    expect((applyDraftEdits("newsletter", p, [{ op: "set_list", field: "headerPhotos", old: photos, new: swap }]) as any).content.headerPhotos).toEqual(swap);
    expect(applyDraftEdits("newsletter", p, [{ op: "set_list", field: "headerPhotos", old: swap, new: photos }])).toMatchObject({ ok: false, error: "draft_edit_not_found" });
    expect(applyDraftEdits("newsletter", p, [{ op: "set_list", field: "sections[1].links", old: [], new: [{ text: "Sign up", url: "https://x.example/s" }] }]).ok).toBe(true);
    expect(applyDraftEdits("newsletter", p, [{ op: "replace_text", field: "sections[5].body", old: "a", new: "b" }])).toMatchObject({ ok: false, error: "draft_edit_field_unknown" });
    expect(applyDraftEdits("newsletter", p, [{ op: "replace_text", field: "sources", old: "a", new: "b" }])).toMatchObject({ ok: false, error: "draft_edit_field_unknown" });
    expect(applyDraftEdits("agenda", { meeting: "Nov", date: "2026-11-10", items: [{ title: "Budget" }], sources: [] }, [{ op: "set_list", field: "headerPhotos", old: [], new: [] }]))
      .toMatchObject({ ok: false, error: "draft_edit_field_unknown" });
  });
  it("entries: add after N, remove with the exact title; agenda optional fields set from empty", () => {
    const p = NL();
    const add = applyDraftEdits("newsletter", p, [{ op: "add_entry", after: 0, entry: { heading: "Thanks", body: "Thank you, volunteers." } }]) as any;
    expect(add.content.sections.map((x: any) => x.heading)).toEqual(["Block Party", "Thanks", "Cleanup"]);
    expect(applyDraftEdits("newsletter", p, [{ op: "remove_entry", index: 1, oldTitle: "Block Party" }])).toMatchObject({ ok: false, error: "draft_edit_not_found" });
    expect((applyDraftEdits("newsletter", p, [{ op: "remove_entry", index: 1, oldTitle: "Cleanup" }]) as any).content.sections.length).toBe(1);
    const ag = { meeting: "November meeting", date: "2026-11-10", items: [{ title: "Budget" }], sources: [] };
    expect((applyDraftEdits("agenda", ag, [{ op: "replace_text", field: "items[0].owner", old: "", new: "Sam" }]) as any).content.items[0]).toEqual({ title: "Budget", owner: "Sam" });
    expect(applyDraftEdits("agenda", { ...ag, items: [{ title: "Budget", owner: "Ali" }] }, [{ op: "replace_text", field: "items[0].owner", old: "", new: "Sam" }]))
      .toMatchObject({ ok: false, error: "draft_edit_ambiguous" });
  });
  it("member links: https addresses from the member's words (trailing punctuation dropped); missing = carried nowhere in the draft", () => {
    expect(memberLinks("Please add the sign-up link https://forms.example/blockparty. Also (https://x.example/a)! and http://insecure.example")).toEqual(["https://forms.example/blockparty", "https://x.example/a"]);
    const c = NL();
    expect(missingMemberLinks("Include https://www.example.org/gallery please", c)).toEqual([]);
    expect(missingMemberLinks("Include https://forms.example/blockparty please", c)).toEqual(["https://forms.example/blockparty"]);
    expect(missingMemberLinks("Use https://www.example.org/images/a.jpg as a header photo", c)).toEqual([]);
    expect(missingMemberLinks("no links here", c)).toEqual([]);
    // Fable PP-4: canonical comparison (a re-serialised URL is not a false refusal) and the explicit leaveOut escape.
    expect(canonicalUrl("https://WWW.example.org/gallery")).toBe("https://www.example.org/gallery");
    expect(missingMemberLinks("Include https://WWW.example.org/gallery please", c)).toEqual([]);
    expect(missingMemberLinks("Drop https://forms.example/old please", c, [{ url: "https://forms.example/old" }])).toEqual([]);
    expect(missingMemberLinks("Use https://forms.example/a and https://forms.example/b", c, [{ url: "https://forms.example/a" }])).toEqual(["https://forms.example/b"]);
  });
});

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
describe.skipIf(!enabled)("edit_draft_artifact over ChatTools", () => {
  it("stale parent refuses; an edit keeps untouched fields byte-identical; a member link missing refuses the save; linkGaps says it", async () => {
    const w = await transcriptionWorld({ chat: {} });
    try {
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, "members/notes/2026-10-08.v1.md"), "# October\nBlock Party drew over 300 neighbors.\n");
      const conv = (await w.post("/o/exna/api/chat/conversation/create", {}, w.robin)).result.conversationId;
      const tools = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
      const db = w.org.sqlite.db;
      // A member turn: the message row is what the link check reads.
      const turn = async (text: string) => {
        const turnId = "turn_" + randomUUID().replaceAll("-", "");
        db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,'user',?,?,?)").run("msg_" + randomUUID(), conv, turnId, text, "x", new Date().toISOString());
        const ctx = { turnId, conversationId: conv, memberId: "m", scope: "member" as const };
        await tools.begin(ctx);
        return { ctx, answer: () => db.prepare("INSERT INTO chat_messages(id,conversation_id,turn_id,role,text,sha256,at) VALUES (?,?,?,'assistant',?,?,?)").run("msg_" + randomUUID(), conv, turnId, "ok", "x", new Date().toISOString()) };
      };
      const content = { title: "November in Example Park", sections: [{ heading: "Block Party", body: "Over 300 neighbors came.", links: [{ text: "Sign up", url: "https://forms.example/blockparty" }] },
        { heading: "Cleanup", body: "Oct 31 at 9 am." }], sources: [{ path: "members/notes/2026-10-08.v1.md", line: 2 }] };
      // Turn 1: the member gives a link; a draft WITHOUT it is refused; with it, saved.
      const t1 = await turn("Draft the newsletter and include the sign-up link https://forms.example/blockparty.");
      const bad = JSON.parse(JSON.stringify(content)); delete bad.sections[0].links;
      expect(await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: bad }), t1.ctx)).toEqual({ ok: false, error: "draft_member_link_missing", hint: { missing: ["https://forms.example/blockparty"] } });
      const v1 = JSON.parse(((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content }), t1.ctx)) as any).content);
      t1.answer();
      expect(tools.memberLinkGaps(conv)).toBeNull();
      // Fable PP-6: with no draft plan open (a plain chat turn; a team task never has one), the edit tool refuses exactly as write does.
      const plain = new ChatTools(w.org.sqlite, { folder: w.cfg.folder, stateRoot: w.cfg.stateRoot, envelopeFor: () => null });
      const tp = await turn("Change the title.");
      await plain.begin(tp.ctx);
      const args = JSON.stringify({ artifactId: v1.artifactId, parentVersion: 1, parentSha256: v1.sha256, edits: [{ op: "replace_text", field: "title", old: "November", new: "December" }] });
      expect([await plain.call("edit_draft_artifact", args, tp.ctx), await plain.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content }), tp.ctx)])
        .toEqual([{ ok: false, error: "chat_tool_needs_draft_plan" }, { ok: false, error: "chat_tool_needs_draft_plan" }]);
      tp.answer();
      // Turn 2: an exact edit. Stale parent refuses; the right parent saves v2 where only the heading changed.
      const t2 = await turn("Change the Block Party heading to Block Party 2026. Change nothing else.");
      const edit = (parentVersion: number, parentSha256: string, edits: unknown[]) => tools.call("edit_draft_artifact", JSON.stringify({ artifactId: v1.artifactId, parentVersion, parentSha256, edits }), t2.ctx);
      const h = [{ op: "replace_text", field: "sections[0].heading", old: "Block Party", new: "Block Party 2026" }];
      expect(await edit(1, "sha256:" + "0".repeat(64), h)).toEqual({ ok: false, error: "draft_edit_stale", hint: { latestVersion: 1, latestSha256: v1.sha256 } });
      expect(await edit(2, v1.sha256, h)).toEqual({ ok: false, error: "draft_edit_stale", hint: { latestVersion: 1, latestSha256: v1.sha256 } });
      expect(await edit(1, v1.sha256, [{ op: "replace_text", field: "sections[0].body", old: "nope", new: "x" }]))
        .toEqual({ ok: false, error: "draft_edit_not_found", hint: { failedEdit: 0, current: "Over 300 neighbors came.", entries: [{ index: 0, heading: "Block Party" }, { index: 1, heading: "Cleanup" }],
          // Fable F-2': every list field's current value, so ONE refusal re-anchors the whole next call.
          lists: { headerPhotos: [], "sections[0].images": [], "sections[0].links": content.sections[0].links, "sections[1].images": [], "sections[1].links": [] } } });
      const v2 = JSON.parse(((await edit(1, v1.sha256, h)) as any).content);
      expect(v2).toMatchObject({ saved: true, version: 2, editedFrom: { version: 1, sha256: v1.sha256 }, changed: ["sections[0].heading"] });
      expect(tools.versions(conv).at(-1)).toMatchObject({ version: 2, editedFrom: { version: 1, sha256: v1.sha256 }, changed: ["sections[0].heading"], leftOut: null });
      // An edit on the now-old parent is stale (v2 exists).
      expect(await edit(1, v1.sha256, [{ op: "replace_text", field: "title", old: "November", new: "December" }])).toEqual({ ok: false, error: "draft_edit_stale", hint: { latestVersion: 2, latestSha256: v2.sha256 } });
      t2.answer();
      const rows = db.prepare("SELECT version, sha256 FROM chat_artifact_versions WHERE artifact_id=? ORDER BY version").all(v1.artifactId) as any[];
      const read = (r: any) => JSON.parse(readFileSync(join(w.cfg.stateRoot, "chat", "artifacts", conv, v1.artifactId, `v${r.version}.${r.sha256}.json`), "utf8")).content;
      const c1 = read(rows[0]), c2 = read(rows[1]);
      expect(c2.sections[0].heading).toBe("Block Party 2026");
      expect(JSON.stringify({ ...c2, sections: [{ ...c2.sections[0], heading: c1.sections[0].heading }, c2.sections[1]] })).toBe(JSON.stringify(c1)); // untouched-links, byte-for-byte
      // Turn 3: the member asks to DROP the sign-up link. Removing it WITHOUT leaveOut is refused (the URL is in the member's
      // message), nothing is saved, so there is no gap line either; with leaveOut and its reason it saves and the card shows it.
      const t3 = await turn("Remove the sign-up link https://forms.example/blockparty, it's closed.");
      const drop = { op: "set_list", field: "sections[0].links", old: content.sections[0].links, new: [] };
      expect(await tools.call("edit_draft_artifact", JSON.stringify({ artifactId: v1.artifactId, parentVersion: 2, parentSha256: v2.sha256, edits: [drop] }), t3.ctx))
        .toEqual({ ok: false, error: "draft_member_link_missing", hint: { missing: ["https://forms.example/blockparty"] } });
      const v3 = JSON.parse(((await tools.call("edit_draft_artifact", JSON.stringify({ artifactId: v1.artifactId, parentVersion: 2, parentSha256: v2.sha256, edits: [drop],
        leaveOut: [{ url: "https://forms.example/blockparty", reason: "the member said the sign-up is closed" }] }), t3.ctx)) as any).content);
      t3.answer();
      expect(v3).toMatchObject({ saved: true, version: 3, leftOut: ["https://forms.example/blockparty"], changed: ["sections[0].links"] });
      expect(tools.memberLinkGaps(conv)).toBeNull(); // left out explicitly: no gap line; the card shows "Left out"
      // The end-of-turn line (a backstop): a version saved this turn without the URL and without leaveOut is said.
      const t4 = await turn("Also add https://forms.example/volunteer to the cleanup section.");
      db.prepare("UPDATE chat_artifact_versions SET turn_id=?, left_out=NULL WHERE artifact_id=? AND version=3").run(t4.ctx.turnId, v1.artifactId);
      t4.answer();
      expect(tools.memberLinkGaps(conv)).toEqual({ turnId: t4.ctx.turnId, missing: ["https://forms.example/volunteer"] });
      db.prepare("UPDATE chat_artifact_versions SET turn_id=?, left_out=? WHERE artifact_id=? AND version=3").run(t3.ctx.turnId, JSON.stringify([{ url: "https://forms.example/blockparty", reason: "the member said the sign-up is closed" }]), v1.artifactId);
      expect(tools.versions(conv).at(-1)).toMatchObject({ leftOut: [{ url: "https://forms.example/blockparty", reason: "the member said the sign-up is closed" }] });
    } finally { await w.close(); }
  }, 60_000);
});
