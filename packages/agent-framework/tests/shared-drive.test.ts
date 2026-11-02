// LIBRARY L1 (Fable FABLE-REVIEW-ORG-FILE-LIBRARY-R2 Addendum 3 P-4): the Files tab is the team's shared drive on the droplet.
// Images arrive through the I3 sanitizer only (the decoder's normalized JPEG), once per content hash, under stateRoot/library;
// any member sees them and the agent's list (members/drive/images.md); a chat image stays chat-private until its owner saves it;
// reviewers/admins remove; nothing is public. Synthetic pixels and text.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { transcriptionWorld } from "./transcription-world.js";
import { DRIVE_LIST_FILE } from "../src/org/library/drive.js";
import { driveUrlSha, drivePublicUrl, imageUrl } from "../src/org/newsletter/render-cp.js";
import { siteImagesOf } from "../src/org/chat/tools.js";

const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const decoderOk = existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const enabled = decoderOk && !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const H = "a".repeat(64);

it("the drive URL rule: exactly https://files.example.org/o/<org>/files/<64 hex>.jpg; the agent's list reads the drive file too", () => {
  const u = drivePublicUrl("exna", H);
  expect(u).toBe(`https://files.example.org/o/exna/files/${H}.jpg`);
  expect([driveUrlSha(u), imageUrl(u)]).toEqual([{ orgId: "exna", sha256: H }, u]);
  for (const bad of [u.replace("files.", "files2."), u.replace(".jpg", ".png"), u + "?x=1", u.replace("https:", "http:"), u.replace(H, H.slice(1)), u.replace(H, H.toUpperCase()),
    u.replace("/files/", "/drive/image/"), `https://agent.example.org/o/exna/files/${H}.jpg`, u.replace("files.example.org", "FILES.example.org")])
    expect([bad, driveUrlSha(bad), imageUrl(bad)]).toEqual([bad, null, null]);
  const snap = { files: new Map([[DRIVE_LIST_FILE, { lines: ["# Shared drive images", "", `- ${u} (Porch party, 800x600)`, `- https://evil.example/x.jpg (bad)`] }]]) } as never;
  expect(siteImagesOf(snap)).toEqual([u]);
});

describe.skipIf(!enabled)("the shared drive (L1)", () => {
  it("upload (sanitized, once per hash), save from chat (owner only), any member lists and reads, the agent's list file, reviewers remove, text files", async () => {
    const sharp = createRequire(new URL("../decoder/package.json", import.meta.url))("sharp");
    const w = await transcriptionWorld({ chat: {}, images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true } } });
    try {
      const api = (p: string, b: unknown, c = w.alex) => w.post(`/o/exna/api/${p}`, b, c);
      const put = async (bytes: Buffer, o: { contentType?: string; cookie?: string; drive?: boolean; conversationId?: string; fileName?: string } = {}) => {
        const c = o.cookie ?? w.alex, ct = o.contentType ?? "image/jpeg";
        const t = await api("image/upload", { ...(o.drive === false ? { conversationId: o.conversationId } : { drive: true, fileName: o.fileName ?? "Porch party.jpg" }), size: bytes.length, contentType: ct }, c);
        if (!t.ok) return t;
        return (await fetch(`${w.url}/o/exna/upload/${t.result.uploadId}`, { method: "PUT", headers: { "content-type": ct, cookie: c }, body: new Uint8Array(bytes) })).json() as Promise<any>;
      };
      const src = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 200, g: 90, b: 40 } } }).jpeg().withExif({ IFD0: { Make: "SecretCam" } }).toBuffer();
      // A drive upload: the normalized JPEG only, named by its hash, metadata gone; the original is not kept.
      const up = await put(src);
      expect(up).toMatchObject({ ok: true, drive: true, deduplicated: false, name: "Porch party", width: 640, height: 480, addedBy: "alex@exna.test", from: "Uploaded to the shared drive", published: false });
      const h = up.sha256 as string, lib = join(w.cfg.stateRoot, "library");
      expect(readdirSync(lib).filter((f) => !f.startsWith("."))).toEqual([h + ".jpg"]);
      const stored = readFileSync(join(lib, h + ".jpg"));
      expect([stored.includes("SecretCam"), stored.subarray(0, 3).toString("hex")]).toEqual([false, "ffd8ff"]);
      expect(JSON.stringify(readdirSync(w.cfg.folder, { recursive: true }))).not.toMatch(/\.jpg/); // never under the folder
      // The same image again is one drive image; a non-image type is refused before any bytes.
      expect(await put(src, { fileName: "Again" })).toMatchObject({ ok: true, deduplicated: true, sha256: h });
      expect((await api("image/upload", { drive: true, fileName: "x", size: 10, contentType: "image/svg+xml" })).error).toBe("image_type_not_admitted");
      expect((await api("image/upload", { drive: true, fileName: "../x", size: 10, contentType: "image/jpeg" })).error).toBe("drive_name_invalid");
      // Bytes that are not the declared type are refused by the sniff (an HTML file sent as a JPEG).
      expect((await put(Buffer.from("<html><script>alert(1)</script></html>"), { fileName: "evil" })).error).toBe("image_type_mismatch");
      // The agent's list exists; with the public files route off (this org has no newsletter) it names no addresses (L2 tests
      // the route-on list: one line per image with the public URL it will have, name and size).
      const listFile = readFileSync(join(w.cfg.folder, DRIVE_LIST_FILE), "utf8");
      expect([listFile.includes("can't be used in a newsletter yet"), listFile.includes(drivePublicUrl("exna", h))]).toEqual([true, false]);
      // Any member (robin, a reviewer; admin) lists it and reads the thumbnail through the hub; no session = no bytes.
      const ls = (await api("files/list", {}, w.robin)).result;
      expect(ls.images).toEqual([expect.objectContaining({ sha256: h, name: "Porch party", published: false })]);
      expect(ls.files.find((f: any) => f.path === DRIVE_LIST_FILE)).toMatchObject({ from: "The list of shared drive images", visibleTo: "All members and the agent" });
      const g = await fetch(`${w.url}/o/exna/drive/image/${h}`, { headers: { cookie: w.robin } });
      expect([g.status, g.headers.get("content-type"), g.headers.get("x-content-type-options"), g.headers.get("cache-control"), g.headers.get("content-security-policy")])
        .toEqual([200, "image/jpeg", "nosniff", "private, no-store", "default-src 'none'; sandbox"]);
      expect(Buffer.from(await g.arrayBuffer()).equals(stored)).toBe(true);
      expect((await fetch(`${w.url}/o/exna/drive/image/${h}`)).status).toBe(401);
      expect((await (await fetch(`${w.url}/o/exna/drive/image/${"b".repeat(64)}`, { headers: { cookie: w.robin } })).json()).error).toBe("drive_image_unknown");
      // A chat image stays chat-private until its OWNER saves it; another member cannot save it.
      const conv = (await api("chat/conversation/create", {})).result.conversationId;
      const other = await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 10, g: 160, b: 90 } } }).png().toBuffer();
      const ci = await put(other, { drive: false, conversationId: conv, contentType: "image/png" });
      expect(ci).toMatchObject({ ok: true, imageId: expect.stringMatching(/^img_/) });
      expect((await api("files/list", {})).result.images.length).toBe(1);
      expect((await api("image/drive/save", { imageId: ci.imageId, name: "Garden" }, w.robin)).error).toBe("image_unknown");
      const saved = (await api("image/drive/save", { imageId: ci.imageId, name: "Garden" })).result;
      expect(saved).toMatchObject({ name: "Garden", width: 300, height: 200, from: "Saved from a chat", deduplicated: false });
      expect((await api("image/drive/save", { imageId: ci.imageId, name: "Garden" })).result.deduplicated).toBe(true);
      expect((await api("files/list", {}, w.admin)).result.images.map((i: any) => i.name)).toEqual(["Garden", "Porch party"]);
      // Text straight into the drive (members/shared), with provenance; an existing name is refused.
      expect((await api("files/upload", { fileName: "volunteers.md", text: "# Volunteers\nSam, Ali\n" })).result).toMatchObject({ path: "members/shared/volunteers.md" });
      expect((await api("files/upload", { fileName: "volunteers.md", text: "other" })).error).toBe("chat_upload_exists");
      expect((await api("files/upload", { fileName: "run.sh", text: "x" })).error).toBe("chat_upload_type_not_admitted");
      expect((await api("files/list", {}, w.robin)).result.files.find((f: any) => f.path === "members/shared/volunteers.md"))
        .toMatchObject({ addedBy: "alex@exna.test", from: "Uploaded to the shared drive", visibleTo: "All members and the agent" });
      // Removal: reviewers and admins only; journaled; the list file and the bytes follow.
      expect((await api("files/delete", { sha256: h })).error).toBe("access_role_not_permitted");
      expect((await api("files/delete", { sha256: h }, w.robin)).result).toEqual({ removed: h });
      expect(existsSync(join(lib, h + ".jpg"))).toBe(false);
      expect(readFileSync(join(w.cfg.folder, DRIVE_LIST_FILE), "utf8")).not.toContain(h);
      expect((await api("files/delete", { path: "members/shared/volunteers.md" }, w.admin)).result).toEqual({ removed: "members/shared/volunteers.md" });
      expect((await api("files/delete", { path: "members/notes/x.md" }, w.admin)).error).toBe("files_unknown");
      expect(w.org.sqlite.db.prepare("SELECT event FROM library_journal ORDER BY seq").all().map((r: any) => r.event))
        .toEqual(["uploaded", "saved_from_chat", "uploaded", "removed", "removed"]);
    } finally { await w.close(); }
  }, 120_000);
});
