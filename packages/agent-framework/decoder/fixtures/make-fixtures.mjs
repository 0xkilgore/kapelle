// IMAGES-V1 I1: write the decoder's fixture images to a folder (synthetic pixels only), for the host rehearsal and the
// test suite. `node fixtures/make-fixtures.mjs <outDir>`; prints one JSON line per file {name, bytes, expect}.
// `expect` is the decoder's answer: "ok" or the refusal label.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const out = process.argv[2];
if (!out || process.argv.length !== 3) { console.error("usage: make-fixtures.mjs <outDir>"); process.exit(2); }
mkdirSync(out, { recursive: true });
const solid = (w, h, extra = {}) => sharp({ create: { width: w, height: h, channels: 3, background: "#2a6", ...extra } });
const noise = (w, h) => solid(w, h, { noise: { type: "gaussian", mean: 128, sigma: 40 } });
const jpg = await noise(300, 300).jpeg().toBuffer();
const frames = await Promise.all([solid(16, 16).png().toBuffer(), solid(16, 16, { background: "#a00" }).png().toBuffer()]);
const files = [
  // 20 MP that still fits the 4 MiB input cap (both caps apply): the memory/time ceiling case.
  ["ok-20mp.jpg", await solid(5000, 4000, { noise: { type: "gaussian", mean: 128, sigma: 6 } }).jpeg({ quality: 60 }).toBuffer(), "ok"],
  ["bad-20mp-over-4mib.jpg", await noise(5000, 4000).jpeg({ quality: 90 }).toBuffer(), "image_too_large"],
  ["ok-exif-gps-rotated.jpg", await solid(400, 200).jpeg().withExif({ IFD0: { Make: "SecretCam" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "36/1 10/1 0/1" } }).withMetadata({ orientation: 6 }).toBuffer(), "ok"],
  ["ok-alpha.png", await sharp({ create: { width: 2000, height: 2000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer(), "ok"],
  ["ok-photo.webp", await noise(3000, 2000).webp().toBuffer(), "ok"],
  ["ok-polyglot-trailer.jpg", Buffer.concat([jpg, Buffer.from("<script>x</script>PK\u0003\u0004POLYGLOT")]), "ok"],
  ["bad-bomb-36mp.png", await sharp({ create: { width: 6000, height: 6000, channels: 3, background: "#000" }, limitInputPixels: false }).png({ compressionLevel: 9 }).toBuffer(), "image_too_many_pixels"],
  ["bad-wide-10500.png", await solid(10_500, 20).png().toBuffer(), "image_dimensions"],
  ["bad-animated.webp", await sharp(frames, { join: { animated: true } }).webp().toBuffer(), "image_animated"],
  ["bad-truncated.jpg", jpg.subarray(0, Math.floor(jpg.length / 2)), "image_unreadable"],
  ["bad-svg.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'), "image_type_not_admitted"],
  ["bad-png-sig-svg.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("<svg/>")]), "image_unreadable"],
  ["bad-gif.gif", await solid(8, 8).gif().toBuffer(), "image_type_not_admitted"],
  ["bad-tiff.tif", await solid(8, 8).tiff().toBuffer(), "image_type_not_admitted"],
  ["bad-pdf.pdf", Buffer.from("%PDF-1.7\n1 0 obj<<>>endobj\n"), "image_type_not_admitted"],
  ["bad-over-4mib.jpg", Buffer.concat([jpg, Buffer.alloc(4 * 1024 * 1024)]), "image_too_large"],
];
for (const [name, data, expect] of files) { writeFileSync(join(out, name), data); console.log(JSON.stringify({ name, bytes: data.length, expect })); }
