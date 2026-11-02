// Transcription T-2 (plan v2 §4, Fable P-2(i)): header-only container + duration sniffing for the six admitted audio
// containers. No decoding, no dependency. Bounded random-access reads (at most MAX_READS, each <= 64 KiB). The duration is
// only an ESTIMATE for the R-4 reservation, so every result passes a bytes/duration plausibility check: WAV and CBR MP3
// exact; the others within a plausible bitrate band. Unknown or implausible -> a fixed refusal, never a guess.
//
// OSS lift (decision #77): container signatures after file-type (MIT, github.com/sindresorhus/file-type); duration fields
// (WAV data/byteRate, FLAC STREAMINFO, MP4 mvhd, Ogg last granule, Matroska Info/Duration, MP3 Xing/VBRI/CBR) following
// music-metadata's approach (MIT, github.com/Borewit/music-metadata). Adapted: 6 audio containers only, sync bounded reads,
// no tag parsing, fixed refusal labels.
import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { TranscriptionRefused } from "./profile.js";

export type Container = "wav" | "flac" | "mp4" | "ogg" | "webm" | "mp3";
/** Admitted upload content types and the container each must sniff as. */
export const CONTENT_TYPES: Record<string, Container> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/flac": "flac", "audio/x-flac": "flac",
  "audio/mp4": "mp4", "audio/m4a": "mp4", "audio/x-m4a": "mp4", "audio/ogg": "ogg", "audio/opus": "ogg", "audio/webm": "webm",
  "audio/mpeg": "mp3", "audio/mp3": "mp3",
};
/** Plausible kbit/s per container (the whole file over the sniffed duration). WAV is checked exactly instead. */
const BAND: Record<Exclude<Container, "wav">, [number, number]> = { flac: [32, 10_000], mp4: [6, 1_600], ogg: [4, 1_000], webm: [4, 1_000], mp3: [6, 400] };
const MAX_READS = 256, CHUNK = 64 * 1024;

class Reader {
  reads = 0;
  constructor(private readonly fd: number, readonly size: number) {}
  at(pos: number, len: number): Buffer {
    if (++this.reads > MAX_READS) throw new TranscriptionRefused("media_duration_unknown");
    const n = Math.max(0, Math.min(len, CHUNK, this.size - pos)), b = Buffer.alloc(n);
    if (n) readSync(this.fd, b, 0, n, pos);
    return b;
  }
}
const unknown = () => new TranscriptionRefused("media_duration_unknown");
const implausible = () => new TranscriptionRefused("media_duration_implausible");

export function detectContainer(head: Buffer): Container | null {
  const s = (o: number, t: string) => head.length >= o + t.length && head.toString("latin1", o, o + t.length) === t;
  if (s(0, "RIFF") && s(8, "WAVE")) return "wav";
  if (s(0, "fLaC")) return "flac";
  if (s(4, "ftyp")) return "mp4";
  if (s(0, "OggS")) return "ogg";
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return "webm";
  if (s(0, "ID3") || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return "mp3";
  return null;
}

/** Sniff a stored upload. `maxSec` is the profile ceiling (media_too_long above it). */
export function sniffMedia(path: string, maxSec: number): { container: Container; durationSec: number } {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const r = new Reader(fd, fstatSync(fd).size), head = r.at(0, 64);
    const container = detectContainer(head);
    if (!container) throw new TranscriptionRefused("media_type_not_admitted");
    let durationSec: number;
    // A truncated or garbled header that a bounded read runs past is "unknown", never an internal error.
    try { durationSec = ({ wav, flac, mp4, ogg, webm, mp3 } as const)[container](r); }
    catch (e) { if (e instanceof TranscriptionRefused) throw e; throw unknown(); }
    if (!Number.isFinite(durationSec) || durationSec <= 0) throw unknown();
    if (container !== "wav") { const kbps = (r.size * 8) / durationSec / 1000, [lo, hi] = BAND[container]; if (kbps < lo || kbps > hi) throw implausible(); }
    if (durationSec > maxSec) throw new TranscriptionRefused("media_too_long");
    return { container, durationSec };
  } finally { closeSync(fd); }
}

function wav(r: Reader) {
  let pos = 12, byteRate = 0;
  while (pos + 8 <= r.size) {
    const h = r.at(pos, 8), id = h.toString("latin1", 0, 4), len = h.readUInt32LE(4);
    if (id === "fmt ") { const f = r.at(pos + 8, 16); if (f.length < 16) throw unknown(); byteRate = f.readUInt32LE(8);
      if (!byteRate || byteRate !== f.readUInt32LE(4) * f.readUInt16LE(12)) throw implausible(); }
    if (id === "data") {
      if (!byteRate) throw unknown();
      // Exact: the data chunk must really be in the file (a streaming placeholder or a lying size is refused).
      // Trailing chunks (LIST, id3) are small: allow at most max(4 KiB, 1%) after the data, never 'audio' the header hides.
      const avail = r.size - (pos + 8);
      if (len > avail || avail - len > Math.max(4096, avail * 0.01)) throw implausible();
      return len / byteRate;
    }
    pos += 8 + len + (len & 1);
  }
  throw unknown();
}

function flac(r: Reader) {
  let pos = 4;
  for (let i = 0; i < 64 && pos + 4 <= r.size; i++) {
    const h = r.at(pos, 4), type = h[0] & 0x7f, len = h.readUIntBE(1, 3);
    if (type === 0) {
      const b = r.at(pos + 4, 34); if (b.length < 18) throw unknown();
      const rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const total = (b[13] & 0x0f) * 2 ** 32 + b.readUInt32BE(14);
      if (!rate || !total) throw unknown();
      return total / rate;
    }
    if (h[0] & 0x80) break;
    pos += 4 + len;
  }
  throw unknown();
}

/** MP4 boxes: [size u32][type]; size 1 = 64-bit size follows; size 0 = to the end. moov may sit after mdat. */
function mp4(r: Reader) {
  const walk = (start: number, end: number, want: string): number | null => {
    let pos = start;
    while (pos + 8 <= end) {
      const h = r.at(pos, 16); let size = h.readUInt32BE(0), hdr = 8;
      const type = h.toString("latin1", 4, 8);
      if (size === 1) { if (h.length < 16) return null; size = Number(h.readBigUInt64BE(8)); hdr = 16; } else if (size === 0) size = end - pos;
      if (size < hdr || pos + size > end) return null;
      if (type === want) return pos + hdr;
      pos += size;
    }
    return null;
  };
  const moov = walk(0, r.size, "moov"); if (moov === null) throw unknown();
  const moovEnd = moov - 8 + r.at(moov - 8, 4).readUInt32BE(0);
  const mvhd = walk(moov, Math.min(moovEnd, r.size), "mvhd"); if (mvhd === null) throw unknown();
  const b = r.at(mvhd, 32);
  const [scale, dur] = b[0] === 1 ? [b.readUInt32BE(20), Number(b.readBigUInt64BE(24))] : [b.readUInt32BE(12), b.readUInt32BE(16)];
  if (!scale || !dur || dur === 0xffffffff) throw unknown();
  return dur / scale;
}

function ogg(r: Reader) {
  const first = r.at(0, 128); if (first.length < 47) throw unknown();
  const segs = first[26], body = 27 + segs, pkt = first.subarray(body);
  let rate: number, skip = 0;
  if (pkt.toString("latin1", 0, 8) === "OpusHead") { rate = 48_000; skip = pkt.readUInt16LE(10); }
  else if (pkt[0] === 1 && pkt.toString("latin1", 1, 7) === "vorbis") rate = pkt.readUInt32LE(12);
  else throw new TranscriptionRefused("media_type_not_admitted");
  const tail = r.at(Math.max(0, r.size - CHUNK), CHUNK), at = tail.lastIndexOf("OggS");
  if (at < 0 || at + 14 > tail.length || !rate) throw unknown();
  const granule = Number(tail.readBigInt64LE(at + 6));
  if (granule <= skip) throw unknown();
  return (granule - skip) / rate;
}

/** Matroska/WebM: EBML header, then Segment > Info > (TimecodeScale, Duration). Recorders that omit Duration are refused. */
function webm(r: Reader) {
  const head = r.at(0, CHUNK);
  const vint = (pos: number, keepMarker: boolean): [number, number] => {
    const b = head[pos]; if (b === undefined || b === 0) throw unknown();
    let len = 1; while (!(b & (0x80 >> (len - 1)))) len++;
    if (len > 8 || pos + len > head.length) throw unknown();
    let v = keepMarker ? b : b & (0xff >> len), allOnes = (b & (0xff >> len)) === (0xff >> len);
    for (let i = 1; i < len; i++) { v = v * 256 + head[pos + i]; if (head[pos + i] !== 0xff) allOnes = false; }
    return [keepMarker ? v : allOnes ? -1 : v, len];
  };
  const element = (pos: number) => { const [id, il] = vint(pos, true), [size, sl] = vint(pos + il, false); return { id, data: pos + il + sl, size }; };
  const root = element(0); if (root.id !== 0x1a45dfa3) throw unknown();
  const seg = element(root.data + root.size); if (seg.id !== 0x18538067) throw unknown();
  let pos = seg.data;
  while (pos < head.length) {
    const e = element(pos);
    if (e.id === 0x1f43b675) break; // a Cluster before Info: no header duration
    if (e.id === 0x1549a966) {
      let scale = 1_000_000, duration = 0, p = e.data;
      while (p < e.data + e.size && p < head.length) {
        const c = element(p);
        if (c.id === 0x2ad7b1) { scale = 0; for (let i = 0; i < c.size; i++) scale = scale * 256 + head[c.data + i]; }
        if (c.id === 0x4489) duration = c.size === 4 ? head.readFloatBE(c.data) : c.size === 8 ? head.readDoubleBE(c.data) : 0;
        p = c.data + c.size;
      }
      if (!duration || !scale) throw unknown();
      return (duration * scale) / 1e9;
    }
    if (e.size < 0) throw unknown();
    pos = e.data + e.size;
  }
  throw unknown();
}

const MP3_KBPS = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] } as const;
const MP3_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] } as const;
function mp3(r: Reader) {
  let start = 0;
  const id3 = r.at(0, 10);
  if (id3.toString("latin1", 0, 3) === "ID3") start = 10 + ((id3[6] & 0x7f) << 21 | (id3[7] & 0x7f) << 14 | (id3[8] & 0x7f) << 7 | (id3[9] & 0x7f)) + (id3[5] & 0x10 ? 10 : 0);
  const frame = (pos: number) => {
    const h = r.at(pos, 4); if (h.length < 4 || h[0] !== 0xff || (h[1] & 0xe0) !== 0xe0) return null;
    const ver = (h[1] >> 3) & 3, layer = (h[1] >> 1) & 3, bi = h[2] >> 4, si = (h[2] >> 2) & 3, pad = (h[2] >> 1) & 1, mono = (h[3] >> 6) === 3;
    if (ver === 1 || layer !== 1 || bi === 0 || bi === 15 || si === 3) return null; // Layer III only; no free format
    const v = ver === 3 ? 1 : 2, kbps = MP3_KBPS[v][bi], rate = MP3_RATES[ver === 3 ? 1 : ver === 2 ? 2 : 25][si];
    const spf = v === 1 ? 1152 : 576, len = Math.floor(((spf / 8) * kbps * 1000) / rate) + pad;
    return { v, kbps, rate, spf, len, mono };
  };
  const f = frame(start); if (!f) throw new TranscriptionRefused("media_type_not_admitted");
  if (!frame(start + f.len)) throw new TranscriptionRefused("media_type_not_admitted"); // two consecutive frames, not a stray 0xFFE
  const side = f.v === 1 ? (f.mono ? 17 : 32) : (f.mono ? 9 : 17), x = r.at(start + 4 + side, 16), tag = x.toString("latin1", 0, 4);
  if (tag === "Xing" || tag === "Info") { if (!(x.readUInt32BE(4) & 1)) throw unknown(); return (x.readUInt32BE(8) * f.spf) / f.rate; }
  const vbri = r.at(start + 36, 18);
  if (vbri.toString("latin1", 0, 4) === "VBRI") return (vbri.readUInt32BE(14) * f.spf) / f.rate;
  const tail = r.at(Math.max(0, r.size - 128), 128), v1 = tail.length === 128 && tail.toString("latin1", 0, 3) === "TAG" ? 128 : 0;
  return ((r.size - start - v1) * 8) / (f.kbps * 1000); // CBR: exact by construction
}
