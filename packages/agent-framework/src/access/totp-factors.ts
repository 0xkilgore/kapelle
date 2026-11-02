// Newsletter send slice 1, S1-b (PLAN-NEWSLETTER-SLICE1; Fable F-2, R-5): the TOTP seed at rest and the enrollment QR.
// - The per-org key file (production /etc/kapelle/secrets/<org>/totp.key, rendered only with a `newsletter` block) is read
//   AT USE with the PAT reader's discipline: a regular file, not a symlink (O_NOFOLLOW), mode 0600 (no group/other bits),
//   owned by the running user, decoding (base64) to exactly 32 bytes. Anything else = totp_key_unavailable. The key is
//   never stored, logged or put in a label; `kid` = the first 16 hex of its sha256, recorded per factor.
// - Seeds are sealed with AES-256-GCM, a fresh 12-byte IV each, AAD = "orgId|memberId|factorId": a ciphertext moved to
//   another org, member or factor does not open. A factor whose kid differs from the key file's (restore on another host,
//   rotation) is unavailable for that factor only; recovery is Ops re-enrollment, never a silent re-encrypt.
// - The enrollment QR is drawn from the otpauth URI with the vendored Nayuki qrcodegen (MIT, src/vendor/qrcodegen/), as
//   rows of "0"/"1" that the page paints on a canvas (no markup from the server).
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { qrcodegen } from "../vendor/qrcodegen/qrcodegen.js";

export { TOTP_REASONS } from "./totp-labels.js";
const unavailable = (): never => { throw new Error("totp_key_unavailable"); };

/** Read and validate the per-org TOTP key file at use. */
export function readTotpKey(path: string): { key: Buffer; kid: string } {
  let fd: number;
  try {
    const ls = lstatSync(path);
    if (!ls.isFile() || ls.isSymbolicLink()) unavailable();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch { return unavailable(); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || st.size < 40 || st.size > 64) unavailable();
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) unavailable();
    const buf = Buffer.alloc(st.size); readSync(fd, buf, 0, st.size, 0);
    const text = buf.toString("utf8").trim();
    if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) unavailable();
    const key = Buffer.from(text, "base64");
    if (key.length !== 32) unavailable();
    return { key, kid: createHash("sha256").update(key).digest("hex").slice(0, 16) };
  } finally { closeSync(fd); }
}
export type SealedSeed = { ct: string; iv: string; tag: string };
const aadOf = (orgId: string, memberId: string, factorId: string) => Buffer.from(`${orgId}|${memberId}|${factorId}`);
export function sealSeed(key: Buffer, seed: Buffer, ids: { orgId: string; memberId: string; factorId: string }): SealedSeed {
  const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aadOf(ids.orgId, ids.memberId, ids.factorId));
  const ct = Buffer.concat([c.update(seed), c.final()]);
  return { ct: ct.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}
/** Open a sealed seed; a wrong key, AAD or tampered ciphertext = totp_key_unavailable (never a partial result). */
export function openSeed(key: Buffer, s: SealedSeed, ids: { orgId: string; memberId: string; factorId: string }) {
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.iv, "base64"));
    d.setAAD(aadOf(ids.orgId, ids.memberId, ids.factorId));
    d.setAuthTag(Buffer.from(s.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]);
  } catch { return unavailable(); }
}
/** The QR modules for a text (byte mode, error correction M) as rows of "0"/"1". */
export function qrRows(text: string) {
  const q = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM), rows: string[] = [];
  for (let y = 0; y < q.size; y++) { let r = ""; for (let x = 0; x < q.size; x++) r += q.getModule(x, y) ? "1" : "0"; rows.push(r); }
  return rows;
}
