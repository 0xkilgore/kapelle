// Transcription T-2 (plan v2 §4, Fable P-2(i)): header-only container + duration sniffing, with plausibility. Synthetic
// containers only (tests/media-fixtures.ts): no speech, no codec, no dependency.
import { it, expect } from "vitest";
import { mkdtempSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sniffMedia, detectContainer, CONTENT_TYPES } from "../src/org/transcription/media-sniff.js";
import * as F from "./media-fixtures.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "ksniff-")));
let n = 0;
const at = (b: Buffer) => { const p = join(dir, `f${++n}.bin`); writeFileSync(p, b); return p; };
const sniff = (b: Buffer, max = 7200) => sniffMedia(at(b), max);
const refused = (b: Buffer, label: string, max = 7200) => expect(() => sniff(b, max), label).toThrow(label);

it("each admitted container: its type and duration from the header alone", () => {
  expect(sniff(F.wav(30))).toEqual({ container: "wav", durationSec: 30 });
  expect(sniff(F.flac(30))).toEqual({ container: "flac", durationSec: 30 });
  expect(sniff(F.m4a(30))).toEqual({ container: "mp4", durationSec: 30 });          // moov after mdat, as phones write it
  expect(sniff(F.opus(30))).toEqual({ container: "ogg", durationSec: 30 });         // last granule minus pre-skip
  expect(sniff(F.webm(30))).toEqual({ container: "webm", durationSec: 30 });
  const cbr = sniff(F.mp3(30)); expect(cbr.container).toBe("mp3"); expect(cbr.durationSec).toBeCloseTo(30, 0);
  const id3 = sniff(F.mp3(30, { id3: true })); expect(id3.durationSec).toBeCloseTo(30, 0);
  const xing = sniff(F.mp3(30, { xingClaimSec: 30 })); expect(xing.durationSec).toBeCloseTo(30, 0);
  // Every content type the upload admits maps to one of these containers.
  expect(new Set(Object.values(CONTENT_TYPES))).toEqual(new Set(["wav", "flac", "mp4", "ogg", "webm", "mp3"]));
});

it("P-2(i): a header that lies about the duration is refused (WAV exact; others outside a plausible bitrate band)", () => {
  refused(F.wav(5, { claimSec: 7000 }), "media_duration_implausible");   // data chunk larger than the file
  refused(F.wav(5, { claimSec: 1 }), "media_duration_implausible");      // far smaller than the bytes present
  refused(F.flac(5, { claimSec: 7000 }), "media_duration_implausible");
  refused(F.m4a(5, { claimSec: 7000 }), "media_duration_implausible");
  refused(F.opus(5, { claimSec: 7000 }), "media_duration_implausible");
  refused(F.webm(5, { claimSec: 7000 }), "media_duration_implausible");
  refused(F.mp3(5, { xingClaimSec: 7000 }), "media_duration_implausible");
  refused(F.m4a(5, { claimSec: 0.001 }), "media_duration_implausible"); // absurdly high bitrate (e.g. a video track)
});

it("unknown durations, other types and over-long recordings are refused with fixed labels", () => {
  refused(F.webm(5, { noDuration: true }), "media_duration_unknown");     // MediaRecorder-style WebM without Duration
  refused(F.m4a(5, { claimSec: 0 }), "media_duration_unknown");
  refused(F.wav(0), "media_duration_unknown");
  refused(Buffer.from("%PDF-1.7\n" + "x".repeat(500)), "media_type_not_admitted");
  refused(Buffer.from("PK\u0003\u0004" + "x".repeat(500)), "media_type_not_admitted"); // a zip (archive bombs never reach a decoder)
  refused(Buffer.concat([Buffer.from([0xff, 0xfb, 0x18, 0xc4]), Buffer.alloc(30)]), "media_type_not_admitted"); // a lone frame sync, no 2nd frame
  refused(F.wav(130), "media_too_long", 120);
  expect(sniff(F.wav(120), 120).durationSec).toBe(120);
  expect(detectContainer(Buffer.alloc(0))).toBeNull();
});

it("truncated and garbage inputs never throw anything but a fixed label (fuzz)", () => {
  const seeds = [F.wav(3), F.flac(3), F.m4a(3), F.opus(3), F.webm(3), F.mp3(3), F.mp3(3, { xingClaimSec: 3 })];
  const labels = new Set(["media_duration_unknown", "media_duration_implausible", "media_type_not_admitted", "media_too_long"]);
  let i = 0;
  for (const s of seeds) for (const cut of [8, 12, 20, 40, 60, 100, 200]) for (const flip of [-1, 5, 9, 17, 30]) {
    const b = Buffer.from(s.subarray(0, Math.min(s.length, cut + (i++ % 3) * 7)));
    if (flip >= 0 && flip < b.length) b[flip] ^= 0xa5;
    try { sniff(b); } catch (e: any) { expect(labels.has(e?.label), `${e?.message}`).toBe(true); }
  }
});
