// J2 (owner, Oct 26: photos are "super important"): "Add photos" on the Website page. Up to 6 shared-drive photos (the decoder's
// sanitized JPEG): AT MOST ONE is the event's picture, bound exactly like a checked flyer (I3: the runtime names the file and
// sets the ONE upserted event's image; the card binds it; read back before success); the rest go to the photo gallery, added to
// events.json's galleryPhotos by CODE (newest first) with the files in the SAME draft PR. A gallery-only request needs no ops.
// Real org runtime + hub + decoder; FAKE GitHub; a scripted model; synthetic images only.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { transcriptionWorld } from "./transcription-world.js";
import { hosted } from "./org-meeting-kit.js";
import { FakeGithub } from "../src/org/website/fake-github.js";
import { eventImagePath, galleryPhotoPath, addGalleryPhotos, WEBSITE_IMAGE_POLICY } from "../src/org/website/data.js";
import { failureLabel, persistedReason } from "../src/task-delegation/failure-labels.js";

const DECODER = new URL("../decoder/decode.mjs", import.meta.url).pathname;
const hasDecoder = existsSync(new URL("../decoder/node_modules/sharp/package.json", import.meta.url));
const EVENTS = JSON.stringify({ events: [{ id: "block-party-2026", title: "Block Party", date: "2026-10-18", time: "11:00 AM", location: "Example Park", address: "Springfield, TN",
  description: "Thanks.", type: "community" }], galleryPhotos: ["/images/gallery/IMG_1.jpg"] }, null, 2) + "\n";
const MEETINGS = JSON.stringify({ meetings: [] }, null, 2) + "\n";
const EVENT = { id: "happy-hour-2026-11", title: "Happy Hour", date: "2026-11-19", time: "6:00 PM", location: "Plane Jane", address: "", description: "Neighbors meet.", type: "social" };
const reply = (content: string) => new Response(JSON.stringify({ id: "g", model: hosted.runtime.responseModels?.at(-1) ?? hosted.runtime.model, provider: (hosted.runtime.providerNames ?? hosted.runtime.providers)[0],
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 9000, completion_tokens: 200, total_tokens: 9200, cost: 0.03 } }), { status: 200, headers: { "content-type": "application/json" } });

it("galleryPhotos: new paths first, existing ones skipped, the rest of the file byte-identical; a file without the list refuses", () => {
  const out = addGalleryPhotos(EVENTS, ["/images/gallery/kapelle-aaaaaaaaaaaaaaaa.jpg", "/images/gallery/IMG_1.jpg"]);
  expect(JSON.parse(out).galleryPhotos).toEqual(["/images/gallery/kapelle-aaaaaaaaaaaaaaaa.jpg", "/images/gallery/IMG_1.jpg"]);
  expect(out.replace('"/images/gallery/kapelle-aaaaaaaaaaaaaaaa.jpg",\n    ', "")).toBe(EVENTS);
  expect(addGalleryPhotos(EVENTS, ["/images/gallery/IMG_1.jpg"])).toBe(EVENTS);
  expect(() => addGalleryPhotos(JSON.stringify({ events: [] }), ["/images/gallery/x.jpg"])).toThrow("website_gallery_missing");
  expect(galleryPhotoPath("sha256:" + "ab".repeat(32))).toBe("public/images/gallery/kapelle-abababababababab.jpg");
  expect(persistedReason(failureLabel(new Error("website_gallery_missing")))).toBe("website_gallery_missing");
});

describe.skipIf(!hasDecoder || !process.env.KAPELLE_SCOPED_REACTOR_ROOT || !process.env.KAPELLE_PLATFORM_MODELS_ROOT)("Add photos (J2)", () => {
  it("one photo is the event's picture, two go to the gallery, ONE draft PR; gallery-only needs no ops; refusals; abandoned copies are swept", async () => {
    const sharp = createRequire(new URL("../decoder/package.json", import.meta.url))("sharp");
    const gh = new FakeGithub(undefined, { "src/data/events.json": EVENTS, "src/data/meeting-notes.json": MEETINGS });
    const state = { ops: [{ op: "upsert_event", event: EVENT }] as unknown[], users: [] as string[] };
    const model = async (_u: string, i: any) => { const b = JSON.parse(i.body); state.users.push(String(b.messages?.at(-1)?.content ?? "")); return reply(JSON.stringify({ ops: state.ops })); };
    const w = await transcriptionWorld({ chat: {}, fetch: model as never, githubFetch: gh.fetch, website: { dailyApply: 5 }, websitePoll: { everyMs: 20, maxMs: 200 },
      images: { decoder: { mode: "child", node: process.execPath, script: DECODER, unisolated: true } } });
    const api = (p: string, b: unknown, c = w.robin) => w.post(`/o/exna/api/${p}`, b, c);
    try {
      // Three drive photos (any member may add them; the decoder's normalized JPEG is what is stored).
      const photo = async (colour: string, name: string) => {
        const src = await sharp({ create: { width: 640, height: 480, channels: 3, background: colour } }).jpeg().toBuffer();
        const t = await api("image/upload", { drive: true, fileName: name + ".jpg", size: src.length, contentType: "image/jpeg" }, w.alex);
        return (await (await fetch(`${w.url}/o/exna/upload/${t.result.uploadId}`, { method: "PUT", headers: { "content-type": "image/jpeg", cookie: w.alex }, body: new Uint8Array(src) })).json() as any).sha256 as string;
      };
      const [a, b, c] = [await photo("#2a6", "Porch"), await photo("#a62", "Park"), await photo("#26a", "Pool")];
      const bytes = (h: string) => w.org.library!.drive.bytes(h).data;
      const propose = async (text: string, photos: unknown, cookie = w.robin) => {
        const r = await api("website/request", { text, photos }, cookie); if (!r.ok) return r;
        await w.org.website!.idle(); return (await api("website/read", { requestId: r.result.requestId })).result;
      };
      // Refusals before anything is queued.
      expect((await propose("x", [a, b, c, a, b, c, a].map((sha256) => ({ sha256, use: "gallery" })))).error).toBe("website_photos_invalid"); // > 6
      expect((await propose("x", [{ sha256: a, use: "event" }, { sha256: b, use: "event" }])).error).toBe("website_photos_invalid"); // two pictures
      expect((await propose("x", [{ sha256: a, use: "gallery" }, { sha256: a, use: "gallery" }])).error).toBe("website_photos_invalid"); // the same twice
      expect((await propose("x", [{ sha256: a, use: "cover" }])).error).toBe("website_photos_invalid");
      expect((await propose("x", [{ sha256: "f".repeat(64), use: "gallery" }])).error).toBe("drive_image_unknown");
      expect((await propose("x", [{ sha256: a, use: "gallery" }], w.alex)).error).toBe("access_role_not_permitted"); // a contributor
      // The real thing: the event's picture + two gallery photos.
      const p = await propose("Add the Nov 19 happy hour at Plane Jane, 6 pm, with these photos.", [{ sha256: a, use: "event" }, { sha256: b, use: "gallery" }, { sha256: c, use: "gallery" }]);
      const pic = eventImagePath(EVENT.id, "sha256:" + a), gb = galleryPhotoPath("sha256:" + b), gc = galleryPhotoPath("sha256:" + c);
      expect(p).toMatchObject({ state: "ready", label: null, image: { op: "event.image.attach", policy: WEBSITE_IMAGE_POLICY, eventId: EVENT.id, attachmentId: "drive:" + a, proposalId: null,
        sha256: "sha256:" + a, bytes: bytes(a).length, path: pic }, photos: [{ sha256: "sha256:" + b, path: gb }, { sha256: "sha256:" + c, path: gc }] });
      expect(p.card.files.map((f: any) => f.path)).toEqual(["src/data/events.json", pic, gb, gc]);
      expect(p.card.image).toMatchObject({ attachmentId: "drive:" + a, path: pic });
      expect(state.users.at(-1)).toContain("A photo comes with this request: the runtime attaches it to the ONE event");
      expect(state.users.at(-1)).toContain("Photos for the website's photo gallery come with this request: the runtime adds them.");
      expect(p.summary.lines).toEqual(expect.arrayContaining([`- image ${pic.slice(6)} (a shared-drive photo; becomes public on merge)`,
        `- gallery photo ${gb.slice(6)} (a shared-drive photo; becomes public on merge)`, `- gallery photo ${gc.slice(6)} (a shared-drive photo; becomes public on merge)`]));
      // Approve exactly this card: one commit with the three images and the JSON; the picture is read back.
      expect((await w.act(w.robin, "website.apply", { requestId: p.requestId }, p.card.digest)).ok).toBe(true);
      await w.org.websiteApply!.idle();
      expect((await api("website/read", { requestId: p.requestId })).result.pr).toMatchObject({ state: "done", label: null });
      const commit = gh.refs.get(p.card.branch)!, json = JSON.parse(gh.fileAt(commit, "src/data/events.json")!);
      expect([gh.bytesAt(commit, pic)!.equals(bytes(a)), gh.bytesAt(commit, gb)!.equals(bytes(b)), gh.bytesAt(commit, gc)!.equals(bytes(c))]).toEqual([true, true, true]);
      expect(json.galleryPhotos).toEqual([gb.slice(6), gc.slice(6), "/images/gallery/IMG_1.jpg"]);
      expect(json.events.at(-1)).toEqual({ ...EVENT, image: pic.slice(6) });
      expect(gh.pulls[0].draft).toBe(true); expect(gh.refs.get("main")).toBe(p.baseCommit);
      // Gallery only: the model has nothing to change ({"ops":[]}); the gallery is the change; the preview opens /gallery.
      state.ops = [];
      const g = await propose("Add this photo to the gallery.", [{ sha256: c, use: "gallery" }]);
      expect(g).toMatchObject({ state: "ready", label: null, image: null, summary: { title: "Website: 1 photo for the gallery", previewPath: "/gallery" } });
      expect(g.card.files.map((f: any) => f.path)).toEqual(["src/data/events.json", gc]);
      // Without photos an empty answer is still "not applicable".
      expect((await propose("What time is it?", undefined)).label).toBe("website_request_not_applicable");
      // A failed request's copies are swept; an approved request keeps its copies (the PR's evidence).
      state.ops = [{ op: "upsert_event", event: EVENT }, { op: "upsert_event", event: { ...EVENT, id: "other" } }];
      const failed = await propose("Two events.", [{ sha256: a, use: "event" }, { sha256: b, use: "gallery" }]);
      expect(failed.state).toBe("failed");
      const has = (id: string, name: string) => existsSync(join(w.cfg.stateRoot, "website", id, name));
      expect([has(failed.requestId, "flyer-source.jpg"), has(failed.requestId, gb.split("/").at(-1)!)]).toEqual([true, true]);
      w.org.website!.sweepImages();
      expect([has(failed.requestId, "flyer-source.jpg"), has(failed.requestId, gb.split("/").at(-1)!)]).toEqual([false, false]);
      expect([has(p.requestId, "flyer-source.jpg"), has(p.requestId, gb.split("/").at(-1)!)]).toEqual([true, true]);
    } finally { await w.close(); }
  }, 120_000);
});
