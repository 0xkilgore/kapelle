// IMAGES-V1 I1 rehearsal client: send ONE file through a decoder socket exactly as the org runtime does (write, half-close,
// read one header line + bytes). `node fixtures/send.mjs <socket> <file>`; prints {header, jpegBytes, sha256, ms}.
import { connect } from "node:net";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const [sock, file] = process.argv.slice(2);
if (!sock || !file || process.argv.length !== 4) { console.error("usage: send.mjs <socket> <file>"); process.exit(2); }
const t0 = Date.now(), s = connect(sock), parts = [];
s.on("error", (e) => { console.log(JSON.stringify({ error: e.code ?? "socket_error", ms: Date.now() - t0 })); process.exit(1); });
s.on("connect", () => s.end(readFileSync(file)));
s.on("data", (c) => parts.push(c));
s.on("end", () => {
  const b = Buffer.concat(parts), nl = b.indexOf(10);
  let header = null; try { header = JSON.parse(b.subarray(0, nl).toString("utf8")); } catch { header = null; }
  const jpeg = nl >= 0 ? b.subarray(nl + 1) : Buffer.alloc(0);
  console.log(JSON.stringify({ header, jpegBytes: jpeg.length, sha256: jpeg.length ? createHash("sha256").update(jpeg).digest("hex") : null, ms: Date.now() - t0 }));
});
