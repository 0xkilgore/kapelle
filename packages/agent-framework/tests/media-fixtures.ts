// Synthetic audio CONTAINERS for the transcription tests: valid headers + silence/filler payload sized for a chosen duration
// (and, for the lying-header cases, a header that claims more than the bytes can hold). No real speech, no codec work.
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16le = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32be = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

/** PCM WAV, 8 kHz mono 16-bit (16 kB/s). `claimSec` lets the header lie about the data size. */
export function wav(sec: number, o: { claimSec?: number } = {}) {
  const rate = 8000, byteRate = rate * 2, data = Buffer.alloc(Math.round(sec * byteRate)), claim = Math.round((o.claimSec ?? sec) * byteRate);
  const fmt = Buffer.concat([Buffer.from("fmt "), u32le(16), u16le(1), u16le(1), u32le(rate), u32le(byteRate), u16le(2), u16le(16)]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(4 + fmt.length + 8 + data.length), Buffer.from("WAVE"), fmt, Buffer.from("data"), u32le(claim), data]);
}
/** FLAC with a STREAMINFO block (16 kHz) and filler sized for ~200 kbit/s. */
export function flac(sec: number, o: { claimSec?: number } = {}) {
  const rate = 16000, total = Math.round((o.claimSec ?? sec) * rate), si = Buffer.alloc(34);
  si[10] = (rate >> 12) & 0xff; si[11] = (rate >> 4) & 0xff; si[12] = ((rate & 0x0f) << 4) | (0 << 1) | 0; si[13] = (15 << 4) | Math.floor(total / 2 ** 32); si.writeUInt32BE(total % 2 ** 32, 14);
  return Buffer.concat([Buffer.from("fLaC"), Buffer.from([0x80, 0, 0, 34]), si, Buffer.alloc(Math.round(sec * 25_000))]);
}
const box = (type: string, ...kids: Buffer[]) => { const body = Buffer.concat(kids); return Buffer.concat([u32be(8 + body.length), Buffer.from(type, "latin1"), body]); };
/** M4A: ftyp, mdat (filler, ~32 kbit/s) and moov/mvhd at the END (as phones write it). */
export function m4a(sec: number, o: { claimSec?: number } = {}) {
  const scale = 1000, mvhd = Buffer.concat([Buffer.alloc(4), u32be(0), u32be(0), u32be(scale), u32be(Math.round((o.claimSec ?? sec) * scale)), Buffer.alloc(80)]);
  return Buffer.concat([box("ftyp", Buffer.from("M4A "), u32be(0), Buffer.from("M4A isom")), box("mdat", Buffer.alloc(Math.round(sec * 4000))), box("moov", box("mvhd", mvhd))]);
}
const oggPage = (granule: bigint, body: Buffer) => { const h = Buffer.alloc(27); h.write("OggS"); h.writeBigInt64LE(granule, 6); h[26] = 1; return Buffer.concat([h, Buffer.from([body.length]), body]); };
/** Ogg Opus: OpusHead (pre-skip 312), filler (~16 kbit/s), last page granule = 48 kHz samples. */
export function opus(sec: number, o: { claimSec?: number } = {}) {
  const head = Buffer.concat([Buffer.from("OpusHead"), Buffer.from([1, 1]), u16le(312), u32le(48000), Buffer.alloc(3)]);
  return Buffer.concat([oggPage(0n, head), Buffer.alloc(Math.round(sec * 2000)), oggPage(BigInt(Math.round((o.claimSec ?? sec) * 48000) + 312), Buffer.alloc(10))]);
}
/** WebM: EBML header, Segment (unknown size) > Info > TimecodeScale 1 ms + Duration (float64 ms), then a Cluster + filler. */
export function webm(sec: number, o: { claimSec?: number; noDuration?: boolean } = {}) {
  const el = (id: number[], body: Buffer) => Buffer.concat([Buffer.from(id), Buffer.from([0x80 | body.length]), body]);
  const dur = Buffer.alloc(8); dur.writeDoubleBE((o.claimSec ?? sec) * 1000);
  const info = Buffer.concat([el([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])), ...(o.noDuration ? [] : [el([0x44, 0x89], dur)])]);
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], Buffer.from("webm")));
  return Buffer.concat([ebml, Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), el([0x15, 0x49, 0xa9, 0x66], info),
    Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x80]), Buffer.alloc(Math.round(sec * 2000))]);
}
/** MP3 (MPEG-1 Layer III, 32 kbit/s, 32 kHz, mono): CBR frames, or a Xing header with a frame count (`claimSec`). */
export function mp3(sec: number, o: { xingClaimSec?: number; id3?: boolean } = {}) {
  const hdr = Buffer.from([0xff, 0xfb, 0x18, 0xc4]); // v1, L3, no CRC, 32 kbps (idx 1), 32 kHz (idx 2), no pad, mono
  const len = Math.floor((144 * 32000) / 32000), frames = Math.round((sec * 32000) / 1152);
  const frame = () => Buffer.concat([hdr, Buffer.alloc(len - 4)]);
  const out: Buffer[] = [];
  if (o.id3) out.push(Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 10]), Buffer.alloc(10));
  if (o.xingClaimSec !== undefined) { const x = Buffer.alloc(len - 4); x.write("Xing", 17); x.writeUInt32BE(1, 21); x.writeUInt32BE(Math.round((o.xingClaimSec * 32000) / 1152), 25); out.push(Buffer.concat([hdr, x])); }
  for (let i = 0; i < frames; i++) out.push(frame());
  return Buffer.concat(out);
}
