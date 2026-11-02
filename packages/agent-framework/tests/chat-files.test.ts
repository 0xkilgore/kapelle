// Chat agent C-6a (PLAN-SLICE-1 §9; Fable §12(e); owner: Shared files page with provenance). Text uploads to a member's own
// conversation (read only by that conversation's snapshot), an explicit share to members/shared, the read-only files view
// with provenance, and the stored preview HTML. Member EMAIL Q&A never sees uploads. Real org runtime + hub; synthetic data.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { takeSnapshot } from "../src/org/chat/tools.js";
import { stepUpOf } from "../src/access/org-access.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;

describe.skipIf(!enabled)("chat uploads, sharing and the files view", () => {
  it("uploads stay in their conversation; share is explicit; files view with provenance; email Q&A never sees uploads", async () => {
    const w = await transcriptionWorld({ chat: {}, model: true });
    try {
      for (const a of ["chat.upload", "chat.upload.share", "chat.artifact.preview", "files.list", "files.read"]) expect(stepUpOf(a), a).toBe("session");
      const api = (path: string, body: unknown, cookie = w.alex) => w.post(`/o/exna/api/${path}`, body, cookie);
      const memberId = (email: string) => (w.org.sqlite.db.prepare("SELECT member_id FROM access_members WHERE email=?").get(email) as { member_id: string }).member_id;
      const alex = memberId("alex@exna.test"), robin = memberId("robin@exna.test");
      mkdirSync(join(w.cfg.folder, "members", "notes"), { recursive: true });
      writeFileSync(join(w.cfg.folder, "members/notes/2026-10-08.v1.md"), "# October\nThe cleanup is on Oct 31.\n");
      const c1 = (await api("chat/conversation/create", {})).result.conversationId, c2 = (await api("chat/conversation/create", {})).result.conversationId;
      const up = (body: Record<string, unknown>, cookie = w.alex) => api("chat/upload", { conversationId: c1, ...body }, cookie);
      // Refusals.
      for (const fileName of ["flyer.pdf", "../x.md", "a/b.md", ".hidden.md", "page.html", "x"]) expect((await up({ fileName, text: "hi" })).error, fileName).toBe("chat_upload_type_not_admitted");
      expect((await up({ fileName: "a.md", text: " \u0000 " })).error).toBe("chat_upload_empty");
      expect((await up({ fileName: "a.md", text: "x".repeat(48 * 1024 + 1) })).error).toBe("chat_upload_too_large");
      expect((await up({ fileName: "a.md", text: "x" }, w.robin)).error).toBe("chat_conversation_unknown"); // not robin's chat
      // Accepted: in the conversation's own upload folder, hashed; a replay is the same upload; other text under the name refused.
      const u = (await up({ fileName: "Volunteer list.csv", text: "name,shift\nUPLOAD-MARKER-ALEX,9am\n" })).result;
      expect(u).toMatchObject({ uploadId: expect.stringMatching(/^up_[a-f0-9]{32}$/), path: `members/uploads/${alex}/${c1}/Volunteer list.csv`, bytes: 34, sharedPath: null });
      expect(readFileSync(join(w.cfg.folder, u.path), "utf8")).toBe("name,shift\nUPLOAD-MARKER-ALEX,9am\n");
      expect((await up({ fileName: "Volunteer list.csv", text: "name,shift\nUPLOAD-MARKER-ALEX,9am\n" })).result.uploadId).toBe(u.uploadId);
      expect((await up({ fileName: "Volunteer list.csv", text: "changed" })).error).toBe("chat_upload_exists");
      // Snapshots: only c1 sees it; another member's conversation never does.
      expect([...takeSnapshot(w.cfg.folder, "member", alex, c1).files.keys()]).toContain(u.path);
      expect([...takeSnapshot(w.cfg.folder, "member", alex, c2).files.keys()]).not.toContain(u.path);
      const rc = (await api("chat/conversation/create", { scope: "reviewer" }, w.robin)).result.conversationId;
      expect([...takeSnapshot(w.cfg.folder, "reviewer", robin, rc).files.keys()].join()).not.toMatch(/uploads/);
      // Share: explicit, by the uploader only; then every member conversation sees the shared copy.
      expect((await api("chat/upload/share", { uploadId: u.uploadId }, w.robin)).error).toBe("chat_upload_unknown");
      const s = (await api("chat/upload/share", { uploadId: u.uploadId })).result;
      expect(s).toMatchObject({ sharedPath: "members/shared/Volunteer list.csv", sharedAt: expect.any(String) });
      expect((await api("chat/upload/share", { uploadId: u.uploadId })).result.sharedPath).toBe(s.sharedPath);
      expect([...takeSnapshot(w.cfg.folder, "reviewer", robin, rc).files.keys()]).toContain("members/shared/Volunteer list.csv");
      // A second upload of the same name from another chat shares under a suffixed name (never an overwrite).
      const u2 = (await api("chat/upload", { conversationId: c2, fileName: "Volunteer list.csv", text: "other\n" })).result;
      expect((await api("chat/upload/share", { uploadId: u2.uploadId })).result.sharedPath).toBe(`members/shared/Volunteer list-${u2.uploadId.slice(3, 11)}.csv`);
      // Member EMAIL Q&A reads members/notes only: neither the upload nor the shared copy ever reaches its prompt.
      const ask = await api("agent/ask", { question: "Who is on the volunteer list?" });
      expect(ask.ok).toBe(true);
      for (const p of w.prompts.filter((x) => x.kind === "chat")) expect(p.user + p.system).not.toMatch(/UPLOAD-MARKER|Volunteer list/);
      // Files view: alex sees members/ + own uploads; robin (reviewer) sees members/ (not alex's private uploads) + private roots.
      const sub = (await api("intake/upload", { clientRequestId: "req-files-001", title: "Board notes", text: "Budget $450." }, w.robin)).result;
      w.org.files.notesApproved("notes/2026-10-08.v1.md", robin, "op-test-1");
      const la = (await api("files/list", {})).result.files, lr = (await api("files/list", {}, w.robin)).result.files;
      const paths = (l: any[]) => l.map((f) => f.path).sort();
      expect(paths(la)).toEqual(["members/notes/2026-10-08.v1.md", `members/shared/Volunteer list-${u2.uploadId.slice(3, 11)}.csv`, "members/shared/Volunteer list.csv",
        `members/uploads/${alex}/${c1}/Volunteer list.csv`, `members/uploads/${alex}/${c2}/Volunteer list.csv`].sort());
      expect(paths(lr)).toEqual(["members/notes/2026-10-08.v1.md", `members/shared/Volunteer list-${u2.uploadId.slice(3, 11)}.csv`, "members/shared/Volunteer list.csv",
        `reviewers-private/intake/${sub.intakeId}/message.md`].sort());
      expect(la.find((f: any) => f.path === u.path)).toMatchObject({ addedBy: "alex@exna.test", from: "Uploaded in a chat", visibleTo: "Only that chat (and its member)" });
      expect(la.find((f: any) => f.path === "members/shared/Volunteer list.csv")).toMatchObject({ addedBy: "alex@exna.test", from: "Shared from a chat upload", visibleTo: "All members and the agent" });
      expect(la.find((f: any) => f.path === "members/notes/2026-10-08.v1.md")).toMatchObject({ addedBy: "robin@exna.test", from: "Approved meeting notes" });
      expect(lr.find((f: any) => f.path.includes(sub.intakeId))).toMatchObject({ addedBy: "robin@exna.test", from: "Added on the Review page", visibleTo: "Reviewers" });
      // Read: read-only text with its sha; anything outside the member's view is unknown.
      expect((await api("files/read", { path: u.path })).result).toMatchObject({ text: "name,shift\nUPLOAD-MARKER-ALEX,9am\n", sha256: expect.stringMatching(/^sha256:/) });
      for (const path of [u.path, `reviewers-private/intake/${sub.intakeId}/message.md`, "../x.md", "members/../reviewers-private/x.md"])
        expect((await api("files/read", { path }, path === u.path ? w.robin : w.alex)).error, path).toBe("files_unknown");
      // Preview HTML: only the conversation's starter, only a rendered version.
      expect((await api("chat/artifact/preview", { conversationId: c1, artifactId: "art_" + "0".repeat(32), version: 1 })).error).toBe("chat_artifact_unknown");
      expect((await api("chat/artifact/preview", { conversationId: c1, artifactId: "art_" + "0".repeat(32), version: 1 }, w.robin)).error).toBe("chat_conversation_unknown");
      expect(existsSync(join(w.cfg.folder, "members/shared/Volunteer list.csv"))).toBe(true);
    } finally { await w.close(); }
  }, 120_000);
});
