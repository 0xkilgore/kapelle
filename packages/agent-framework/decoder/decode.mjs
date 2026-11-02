// IMAGES-V1 I1 (design of record IMAGES-V1.md a5160d58, section 1): the image sanitizer. Runs as its OWN process (the org
// runtime never imports sharp): `node decode.mjs`, NO arguments: the original's bytes on stdin (<= 4 MiB), then on stdout ONE
// JSON header line and, on success, exactly `bytes` bytes of JPEG. No file paths in or out: on the org host the process is a
// systemd socket-activated instance (stdin/stdout = the connection) with no network, no state paths and a DynamicUser.
// Decode and RE-ENCODE (not tag stripping): only the JPEG/PNG/WebP loaders are unblocked in libvips; 20 MP input limit
// before decode; one page only (no animation); orientation applied; sRGB; alpha flattened onto white; longest edge <= 1600;
// a single baseline JPEG <= 1 MiB with NO metadata (no EXIF/GPS/XMP/ICC/comments). One JSON line on stdout; refusals are
// fixed labels, never library messages. Isolation (network, memory, time) is the launcher's job (systemd unit on the org
// host), not this file's.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

export const SANITIZER = "kapelle.image-sanitizer/v1";
export const LIMITS = { inputBytes: 4 * 1024 * 1024, inputPixels: 20_000_000, maxDimension: 10_000, longEdge: 1600, outputBytes: 1024 * 1024 };
const MAGIC = { jpeg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] };
/** The container from its first bytes (the runtime checks the same; the loader must agree). */
export function sniff(b) {
  if (MAGIC.jpeg.every((x, i) => b[i] === x)) return "jpeg";
  if (MAGIC.png.every((x, i) => b[i] === x)) return "png";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

sharp.cache(false);
sharp.concurrency(1);
sharp.block({ operation: ["VipsForeignLoad"] });
sharp.unblock({ operation: ["VipsForeignLoadJpegBuffer", "VipsForeignLoadPngBuffer", "VipsForeignLoadSpngBuffer", "VipsForeignLoadWebpBuffer"] });

export async function sanitize(input) {
  const refuse = (label) => { const e = new Error(label); e.label = label; throw e; };
  if (input.length === 0 || input.length > LIMITS.inputBytes) refuse("image_too_large");
  const kind = sniff(input);
  if (!kind) refuse("image_type_not_admitted");
  const opts = { limitInputPixels: LIMITS.inputPixels, failOn: "warning", animated: false, pages: 1 };
  let meta;
  try { meta = await sharp(input, opts).metadata(); } catch (e) { refuse(/pixel limit/i.test(String(e?.message)) ? "image_too_many_pixels" : "image_unreadable"); }
  if (meta.format !== kind) refuse("image_type_mismatch");
  if ((meta.pages ?? 1) > 1) refuse("image_animated");
  if (!(meta.width > 0 && meta.height > 0) || meta.width > LIMITS.maxDimension || meta.height > LIMITS.maxDimension) refuse("image_dimensions");
  if (meta.width * meta.height > LIMITS.inputPixels) refuse("image_too_many_pixels");
  for (const quality of [82, 74, 66, 58]) {
    let out;
    try {
      out = await sharp(input, opts).rotate().toColorspace("srgb").flatten({ background: "#ffffff" })
        .resize({ width: LIMITS.longEdge, height: LIMITS.longEdge, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true, chromaSubsampling: "4:2:0" }).toBuffer({ resolveWithObject: true });
    } catch { refuse("image_unreadable"); }
    if (out.data.length <= LIMITS.outputBytes) return { data: out.data, width: out.info.width, height: out.info.height, quality, source: kind };
  }
  return refuse("image_output_too_large");
}

// Run as the entry point? Compare REAL paths: on the org host the unit starts /opt/kapelle/current/decoder/decode.mjs through
// the current -> releases/<rel> SYMLINK, while an ES module's import.meta.url is the resolved real path (Director's rehearsal,
// Oct 23: the old URL comparison was false there, so the process exited 0 with no output). Unresolvable = not the entry point.
const realOrNull = (p) => { try { return realpathSync(p); } catch { return null; } };
const isMain = !!process.argv[1] && realOrNull(process.argv[1]) !== null && realOrNull(process.argv[1]) === realOrNull(fileURLToPath(import.meta.url));
if (isMain) {
  const done = (o, data) => { process.stdout.write(JSON.stringify(o) + "\n"); if (data) process.stdout.write(data); process.stdout.end(); process.exitCode = o.ok ? 0 : 1; };
  if (process.argv.length !== 2) done({ ok: false, label: "image_decoder_usage" });
  else {
    const chunks = []; let n = 0, over = false;
    // Over the cap: keep reading and DISCARD (stdin and stdout may be one socket: closing stdin would cut the answer); the
    // unit's RuntimeMaxSec bounds a sender that never stops.
    process.stdin.on("data", (c) => { n += c.length; if (n > LIMITS.inputBytes) { over = true; chunks.length = 0; } else if (!over) chunks.push(c); });
    process.stdin.on("end", async () => {
      try {
        if (over) { const e = new Error("image_too_large"); e.label = "image_too_large"; throw e; }
        const r = await sanitize(Buffer.concat(chunks));
        done({ ok: true, sanitizer: SANITIZER, width: r.width, height: r.height, bytes: r.data.length, quality: r.quality, source: r.source }, r.data);
      } catch (e) { done({ ok: false, label: typeof e?.label === "string" ? e.label : "image_unreadable" }); }
    });
  }
}
