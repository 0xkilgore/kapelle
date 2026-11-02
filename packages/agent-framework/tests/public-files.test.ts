// LIBRARY L2 (Fable threat model L-2/L-4/L-7/L-8/L-10/L-12; FABLE-REVIEW-ORG-FILE-LIBRARY-R2 R-1..R-4, Addenda 1-3 P-1..P-5):
// a shared-drive image is public ONLY after a reviewer's publish-on-prepare of a newsletter release that uses it. On the
// dedicated files host the hub serves exactly GET/HEAD /o/<org>/files/<sha256>.jpg with byte-exact headers; 404 before
// publish, 410 after unpublish (bytes kept), 500 + an incident when the stored bytes stop matching the hash. The draft preview
// shows drive images through the logged-in route under a CSP that admits only that route. Synthetic pixels, fake providers.
import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DRIVE_LIST_FILE } from "../src/org/library/drive.js";
import { publishDigest } from "../src/org/library/public-files.js";
import { Hub } from "../src/hub/hub.js";
import { filesHost, publicFilesWorld } from "./public-files-world.js";

const decoderOk = existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const enabled = decoderOk && !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe.skipIf(!enabled)("public drive images (L2)", () => {
  it("404 until prepared; prepare needs the publish approval of exactly the listed hashes; then the files host serves byte-exact; test send renders", async () => {
    const s = await publicFilesWorld();
    const cache = Hub.FILES.cacheMs; Hub.FILES.cacheMs = 0;
    try {
      expect(readFileSync(join(s.w.cfg.folder, DRIVE_LIST_FILE), "utf8")).toContain(`- ${s.url} (Porch party, 800x600)`);
      const v = await s.draft(true);
      expect(v.saved).toBe(true);
      const body = { conversationId: s.conv, artifactId: v.artifactId, version: v.version };
      // The draft preview: the drive image through the logged-in route, and the CSP admits exactly that route.
      const q = new URLSearchParams({ conversationId: s.conv, artifactId: v.artifactId, version: String(v.version) });
      const pv = await fetch(`${s.w.url}/o/exna/preview?${q}`, { headers: { cookie: s.w.robin } }), html = await pv.text();
      const origin = s.w.org.config.origins[0] ?? "";
      expect(html).not.toContain(s.url);
      const link = (html.match(/src="(https?:\/\/[^"/]+)(\/o\/exna\/drive\/preview\/[a-f0-9]{64}\?t=[A-Za-z0-9_-]{43})"/) ?? []) as string[];
      expect(link[2]).toContain(`/o/exna/drive/preview/${s.h}?t=`);
      expect(pv.headers.get("content-security-policy")).toBe(Hub.PREVIEW_CSP.replace("; base-uri", ` ${link[1]}/o/exna/drive/preview/; base-uri`));
      // The preview link works without a cookie (a sandboxed frame has none), only for that hash; a made-up token is 404.
      const viaLink = await fetch(s.w.url + link[2], { headers: { "sec-fetch-site": "cross-site" } });
      expect([viaLink.status, viaLink.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
      expect((await fetch(s.w.url + link[2].replace(s.h, "d".repeat(64)))).status).toBe(404);
      expect((await fetch(s.w.url + link[2].replace(/t=.*/, "t=" + "A".repeat(43)))).status).toBe(404);
      expect(origin).toBeTruthy();
      // L-10: a drive file is 404 until a release is prepared (GET and HEAD).
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(404);
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`, { method: "HEAD" })).status).toBe(404);
      // The routine prepare refuses a draft with drive images; the publish approval must bind exactly the listed hashes.
      expect((await s.api("newsletter/release/prepare", body)).error).toBe("newsletter_release_needs_publish");
      expect((await s.w.act(s.w.robin, "newsletter.release.publish", body, publishDigest(["b".repeat(64)]))).error).toBe("newsletter_publish_list_changed");
      expect((await s.w.act(s.w.alex, "newsletter.release.publish", body, publishDigest([s.h]))).ok).toBe(false); // contributors cannot publish
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(404);
      const r = await s.w.act(s.w.robin, "newsletter.release.publish", body, publishDigest([s.h]));
      expect(r.ok).toBe(true);
      expect(r.result).toMatchObject({ releaseId: expect.stringMatching(/^nr_/), published: [s.h], alreadyPublic: [] });
      // L-2: byte-exact headers, the bytes ARE the hash, HEAD has no body, no cookies.
      const g = await filesHost(s.port, `/o/exna/files/${s.h}.jpg`);
      expect(g.status).toBe(200);
      expect(g.headers).toMatchObject({ ...Hub.FILE_HEADERS, "content-length": String(g.body.length) });
      expect(g.headers["set-cookie"]).toBeUndefined();
      expect(sha(g.body)).toBe(s.h);
      const hd = await filesHost(s.port, `/o/exna/files/${s.h}.jpg`, { method: "HEAD" });
      expect([hd.status, hd.body.length, hd.headers["content-length"]]).toEqual([200, 0, String(g.body.length)]);
      // R-1: nothing else on the files host (other paths, methods, the app, the drive route, an unknown org).
      for (const [p, m] of [[`/o/exna/files/${s.h}.jpg`, "POST"], ["/", "GET"], ["/o/exna/", "GET"], [`/o/exna/drive/image/${s.h}`, "GET"], [`/o/other/files/${s.h}.jpg`, "GET"],
        [`/o/exna/files/${s.h}.png`, "GET"], [`/o/exna/files/${s.h.toUpperCase()}.jpg`, "GET"], ["/ui/app.js", "GET"]] as const)
        expect([p, m, (await filesHost(s.port, p, { method: m })).status]).toEqual([p, m, 404]);
      // The app host never serves the files route.
      expect((await fetch(`${s.w.url}/o/exna/files/${s.h}.jpg`)).status).toBe(404);
      // The test email renders the real image (the preflight fetched the public URL); nothing about drive routes in it.
      const t = await s.api("newsletter/test", { releaseId: r.result.releaseId });
      expect(t.result).toMatchObject({ state: "sent" });
      expect(s.sent.at(-1).body.html).toContain(s.url);
      expect(s.sent.at(-1).body.html).not.toContain("/drive/image/");
      // R-4: publishing the same bytes again is the same URL, nothing newly published, one journal line.
      const again = await s.w.act(s.w.robin, "newsletter.release.publish", body, publishDigest([s.h]));
      expect(again.result).toMatchObject({ releaseId: r.result.releaseId, published: [], alreadyPublic: [s.h] });
      expect(s.w.org.sqlite.db.prepare("SELECT COUNT(*) AS n FROM library_journal WHERE event='published'").get()).toEqual({ n: 1 });
      // A published image can't be removed from the drive until an admin unpublishes it.
      expect((await s.api("files/delete", { sha256: s.h })).error).toBe("drive_image_published");
      expect((await s.api("files/list", {}, s.w.alex)).result.images[0]).toMatchObject({ sha256: s.h, published: true, sentIn: [] });
      expect((await s.w.ops("/ops/status")).library).toMatchObject({ publicRoute: true, images: 1, public: 1, unpublished: 0, quarantined: 0, incidents: 0 });
    } finally { Hub.FILES.cacheMs = cache; await s.close(); }
  }, 120_000);

  it("P-2 abandon -> 410 unless referenced; a sent release needs the admin override; R-2 mismatch -> 500 + incident; rate limits per forwarded IP", async () => {
    const s = await publicFilesWorld();
    const saved = { ...Hub.FILES };
    try {
      const v = await s.draft(true), body = { conversationId: s.conv, artifactId: v.artifactId, version: v.version };
      // With the real 60 s cache: a 404 just before publishing is NOT cached (the prepare's own preflight follows its publish).
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(404);
      const r = await s.w.act(s.w.robin, "newsletter.release.publish", body, publishDigest([s.h]));
      expect(r.ok).toBe(true);
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(200);
      Hub.FILES.cacheMs = 0;
      const lib = s.w.org.library;
      // Not abandoned yet: the newest prepare of its draft, 0 days old.
      expect(lib.publicFiles.sweep()).toEqual({ unpublished: 0 });
      // 15 days unsent -> abandoned -> 410 (the bytes stay on disk).
      s.w.org.sqlite.db.prepare("UPDATE library_release_refs SET at=? WHERE release_id=?").run(new Date(Date.now() - 15 * 86_400_000).toISOString(), r.result.releaseId);
      expect(lib.publicFiles.sweep()).toEqual({ unpublished: 1 });
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(410);
      expect(existsSync(join(s.w.cfg.stateRoot, "library", s.h + ".jpg"))).toBe(true);
      // Re-preparing identical content returns the SAME release and restarts its 14-day clock (it stays public after a sweep).
      expect((await s.w.act(s.w.robin, "newsletter.release.publish", body, publishDigest([s.h]))).result).toMatchObject({ releaseId: r.result.releaseId, published: [s.h] });
      expect(lib.publicFiles.sweep()).toEqual({ unpublished: 0 });
      // P-2: a release that FAILED before sending is dead too (mark it failed, sweep -> 410).
      s.w.org.sqlite.db.prepare("INSERT INTO newsletter_effects(release_id,operation_id,approved_by,state,at) VALUES (?,?,?,?,?)").run(r.result.releaseId, randomUUID(), "m", "failed", new Date().toISOString());
      expect(lib.publicFiles.sweep()).toEqual({ unpublished: 1 });
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(410);
      // Publish again (a fresh prepare of a new version), then pretend that release SENT: unpublish needs the admin override.
      const v2 = await s.draft(true, "Porch party, again"), b2 = { conversationId: s.conv, artifactId: v2.artifactId, version: v2.version };
      const r2 = await s.w.act(s.w.robin, "newsletter.release.publish", b2, publishDigest([s.h]));
      expect(r2.result).toMatchObject({ published: [s.h] });
      expect(r2.result.releaseId).not.toBe(r.result.releaseId);
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(200);
      s.w.org.sqlite.db.prepare("INSERT INTO newsletter_effects(release_id,operation_id,approved_by,state,at) VALUES (?,?,?,?,?)").run(r2.result.releaseId, randomUUID(), "m", "provider_accepted", new Date().toISOString());
      // Sent: 30 days later it is still public (a sent release's images stay).
      s.w.org.sqlite.db.prepare("UPDATE library_release_refs SET at=? WHERE release_id=?").run(new Date(Date.now() - 30 * 86_400_000).toISOString(), r2.result.releaseId);
      expect(lib.publicFiles.sweep()).toEqual({ unpublished: 0 });
      expect((await s.w.act(s.w.robin, "files.unpublish", { sha256: s.h })).ok).toBe(false); // admins only
      expect((await s.w.act(s.w.admin, "files.unpublish", { sha256: s.h })).error).toBe("files_used_in_sent_newsletter");
      const un = await s.w.act(s.w.admin, "files.unpublish", { sha256: s.h, override: true });
      expect(un.result).toMatchObject({ unpublished: s.h, sentReleases: [expect.stringMatching(/november-in-example-org$/)] });
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(410);
      // R-2: the stored bytes change on disk -> 500, an incident, quarantined (never served even if the bytes come back).
      s.w.org.sqlite.db.prepare("UPDATE public_files SET state='public' WHERE sha256=?").run(s.h);
      const file = join(s.w.cfg.stateRoot, "library", s.h + ".jpg"), good = readFileSync(file);
      chmodSync(file, 0o600); writeFileSync(file, Buffer.concat([good, Buffer.from("x")]));
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(500);
      writeFileSync(file, good);
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(500);
      expect(s.w.org.sqlite.db.prepare("SELECT label FROM library_incidents").all()).toEqual([{ label: "library_hash_mismatch" }]);
      expect((await s.w.ops("/ops/status")).library).toMatchObject({ quarantined: 1, incidents: 1 });
      // L-8: per forwarded client address (from loopback) and global.
      Hub.FILES.perIp = 3;
      for (let i = 0; i < 3; i++) expect((await filesHost(s.port, `/o/exna/files/${"c".repeat(64)}.jpg`, { xff: "198.51.100.7" })).status).toBe(404);
      expect((await filesHost(s.port, `/o/exna/files/${"c".repeat(64)}.jpg`, { xff: "198.51.100.7" })).status).toBe(429);
      expect((await filesHost(s.port, `/o/exna/files/${"c".repeat(64)}.jpg`, { xff: "10.0.0.1, 198.51.100.8" })).status).toBe(404); // Caddy's appended entry counts
    } finally { Object.assign(Hub.FILES, saved); await s.close(); }
  }, 120_000);

  it("L-12: with the route off the agent's list names no addresses, publish refuses, and the files host is 404", async () => {
    const s = await publicFilesWorld({ publicRoute: false });
    try {
      const list = readFileSync(join(s.w.cfg.folder, DRIVE_LIST_FILE), "utf8");
      expect([list.includes("can't be used in a newsletter yet"), list.includes(s.url)]).toEqual([true, false]);
      expect((await filesHost(s.port, `/o/exna/files/${s.h}.jpg`)).status).toBe(404);
      expect((await s.w.ops("/ops/status")).library).toMatchObject({ publicRoute: false, images: 1, public: 0 });
    } finally { await s.close(); }
  }, 120_000);
});
