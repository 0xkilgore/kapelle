// P2 K1 (owner, Oct 26: "we had the old colors"): Open preview of a version an OLDER renderer made shows its stored typed content
// rendered NOW by the current renderer (navy v3), in memory only: the stored rendering, the row and the release path are unchanged.
// P2 (same day): the chat's system map says how drafting works; a team task's map is byte-for-byte unchanged. Synthetic text only.
import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, chmodSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { SqliteAuthority, openSqliteDatabase } from "../src/service/sqlite-authority.js";
import { ChatTools, RENDERER_VERSION } from "../src/org/chat/tools.js";
import { CP_THEME } from "../src/org/newsletter/render-cp.js";
import { systemMap, type MapFeatures } from "../src/org/handbook/context.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

it("K1: an older rendering is shown re-rendered by the current renderer, never stored and never releasable; a current one is served as stored", async () => {
  const d = realpathSync(mkdtempSync("/tmp/kpr-")); chmodSync(d, 0o700);
  const a = new SqliteAuthority(openSqliteDatabase(join(d, "a.sqlite"), { create: true }), { binding: "t", authorityId: randomUUID(), driveId: randomUUID(), installationId: randomUUID() }, { create: true });
  const folder = join(d, "org"), stateRoot = join(d, "state");
  mkdirSync(join(folder, "members", "notes"), { recursive: true }); writeFileSync(join(folder, "members/notes/2026-10-08.md"), "# October\nBlock Party drew 1,400 neighbors.\n");
  const tools = new ChatTools(a, { folder, stateRoot, envelopeFor: () => ({ envelopeId: "env_" + "a".repeat(32), snapshotHash: "x" }) });
  const conv = "conv_" + "1".repeat(32), ctx = { turnId: "turn_" + "2".repeat(32), conversationId: conv, memberId: "m", scope: "member" as const };
  a.db.prepare("CREATE TABLE IF NOT EXISTS chat_messages(id TEXT, conversation_id TEXT, turn_id TEXT, role TEXT, text TEXT, sha256 TEXT, at TEXT, seq INTEGER PRIMARY KEY AUTOINCREMENT)").run();
  await tools.begin(ctx);
  const v = JSON.parse((await tools.call("write_draft_artifact", JSON.stringify({ kind: "newsletter", content: { title: "October",
    sections: [{ heading: "Block Party", body: "1,400 neighbors came." }], sources: [{ path: "members/notes/2026-10-08.md", line: 2 }] } }), ctx) as any).content);
  await tools.call("render_newsletter_preview", JSON.stringify({ artifactId: v.artifactId, version: 1 }), ctx);
  // Current renderer: the stored bytes, unchanged.
  const current = tools.displayHtml(conv, v.artifactId, 1)!;
  expect(current.rerendered).toBe(false);
  expect(current.html).toBe(tools.previewHtml(conv, v.artifactId, 1));
  expect(tools.newsletterVersion(conv, v.artifactId, 1)).not.toBeNull();
  // An older renderer's rendering (as a draft from before Oct 24 has): plain, no theme.
  const old = "<!doctype html><html><body><h1>October</h1><h2>Block Party</h2><p>1,400 neighbors came.</p></body></html>", hs = sha(old);
  const dir = join(stateRoot, "chat", "artifacts", conv, v.artifactId);
  writeFileSync(join(dir, `v1.${hs}.html`), old);
  a.write(() => a.db.prepare("UPDATE chat_artifact_versions SET html_sha256=?, renderer_version=? WHERE artifact_id=? AND version=1").run(hs, "kapelle.newsletter-renderer/v2", v.artifactId));
  const files = readdirSync(dir).sort();
  const shown = tools.displayHtml(conv, v.artifactId, 1)!;
  expect(shown.rerendered).toBe(true);
  expect(shown.html).toContain(CP_THEME.primaryDark); // the navy header: today's design
  expect(shown.html).toContain("1,400 neighbors came.");
  expect(shown.html).not.toBe(old);
  // Nothing stored or changed; the release path still refuses the old rendering (the agent renders it again inside a plan).
  expect(readdirSync(dir).sort()).toEqual(files);
  expect(a.db.prepare("SELECT html_sha256, renderer_version FROM chat_artifact_versions WHERE artifact_id=? AND version=1").get(v.artifactId)).toEqual({ html_sha256: hs, renderer_version: "kapelle.newsletter-renderer/v2" });
  expect(tools.previewHtml(conv, v.artifactId, 1)).toBe(old);
  expect(tools.newsletterVersion(conv, v.artifactId, 1)).toBeNull();
  expect(RENDERER_VERSION).not.toBe("kapelle.newsletter-renderer/v2");
  // Unknown version / another conversation: null (the action refuses chat_artifact_unknown).
  expect(tools.displayHtml(conv, v.artifactId, 9)).toBeNull();
  expect(tools.displayHtml("conv_" + "9".repeat(32), v.artifactId, 1)).toBeNull();
});

it("P2 system map: a chat run says the plan card is approved in the chat; a team task's map is unchanged", () => {
  const F: MapFeatures = { chat: true, teamTasks: true, schedules: true, website: true, newsletter: true, images: false, transcription: false };
  const base = { id: "x", snapshotHash: "sha256:" + "1".repeat(64), generatedAt: "t", paths: ["members/notes/2026-10-08.md"], features: F, tools: ["read_org_file"] };
  const line = "- Drafting: in a chat, the member approves a draft plan card; the agent then saves the draft there, with Open preview (reviewers can send a test).";
  expect(systemMap({ ...base, chat: true })!.text).toContain(line + "\n");
  const task = systemMap(base)!.text;
  expect(task).not.toContain("Drafting:");
  expect(task).toBe(systemMap({ ...base, chat: false })!.text);
});
