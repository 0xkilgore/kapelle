// Newsletter send, slice 1, S1-a (PLAN-NEWSLETTER-SLICE1; Fable F-3, R-10): HOTP/TOTP over node:crypto, no dependency.
// - HOTP (RFC 4226 §5.3): HMAC-SHA1 over the 8-byte big-endian counter, dynamic truncation (low nibble of the last byte
//   picks 4 bytes, top bit masked), modulo 10^digits, zero-padded. RFC 4226 Appendix D vectors in tests/totp.test.ts.
// - TOTP (RFC 6238): counter = floor(unix seconds / 30). Verification tries T-1, T, T+1 (one step either way), compares
//   with timingSafeEqual over every candidate (no early exit) and returns the MATCHED COUNTER, so the caller can require
//   matched > last accepted counter (Fable F-1). RFC 6238 Appendix B SHA-1 vectors in the tests.
// - Base32 (RFC 4648, alphabet A-Z2-7, unpadded on output) for the secret, and the otpauth:// URI an authenticator reads.
// Algorithms after RFC 4226 (https://www.rfc-editor.org/rfc/rfc4226) and RFC 6238 (https://www.rfc-editor.org/rfc/rfc6238);
// own code. otplib / thirty-two / hi-base32 (MIT) were pattern references only.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP = { stepSec: 30, digits: 6, window: 1, seedBytes: 20 } as const;
const MAX_COUNTER = 0xffff_ffff_ffff_ffffn;

/** RFC 4226 HOTP value for one counter. */
export function hotp(secret: Buffer, counter: number | bigint, digits: number = TOTP.digits) {
  const c = BigInt(counter);
  if (c < 0n || c > MAX_COUNTER || !Number.isInteger(digits) || digits < 6 || digits > 8) throw new Error("totp_arg_invalid");
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(c);
  const h = createHmac("sha1", secret).update(msg).digest(), off = h[h.length - 1] & 0x0f;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}
/** The TOTP time-step counter for a moment (ms since the epoch). */
export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP.stepSec);
/** RFC 6238 TOTP value at a moment. */
export const totp = (secret: Buffer, nowMs: number, digits: number = TOTP.digits) => hotp(secret, totpStep(nowMs), digits);

/** Verify a six-digit code against T-1, T, T+1. Returns the matched counter (the largest if several match), else null.
 *  Every candidate is computed and compared in constant time; a malformed code is compared too (against a dummy). */
export function verifyTotp(secret: Buffer, code: unknown, nowMs: number) {
  const ok = typeof code === "string" && /^[0-9]{6}$/.test(code);
  const given = Buffer.from(ok ? code : "------"), t = totpStep(nowMs);
  let matched: number | null = null;
  for (let c = t - TOTP.window; c <= t + TOTP.window; c++) {
    if (c < 0) continue;
    const eq = timingSafeEqual(Buffer.from(hotp(secret, c)), given);
    if (eq && ok) matched = c;
  }
  return matched;
}
export const newSeed = () => randomBytes(TOTP.seedBytes);

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** RFC 4648 base32, unpadded. */
export function base32Encode(b: Buffer) {
  let out = "", bits = 0, value = 0;
  for (const byte of b) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
/** RFC 4648 base32 decode: case-insensitive, optional trailing "=" padding; anything else (or bad length) refused. */
export function base32Decode(s: string) {
  const t = s.toUpperCase().replace(/=+$/, "");
  if (!/^[A-Z2-7]*$/.test(t) || [1, 3, 6].includes(t.length % 8)) throw new Error("totp_base32_invalid");
  const out: number[] = []; let bits = 0, value = 0;
  for (const ch of t) { value = (value << 5) | ALPHABET.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
/** The otpauth:// URI an authenticator app reads: issuer and label percent-encoded (":" and spaces included). */
export function otpauthUri(o: { issuer: string; account: string; secret: Buffer }) {
  const issuer = encodeURIComponent(o.issuer), account = encodeURIComponent(o.account);
  return `otpauth://totp/${issuer}:${account}?secret=${base32Encode(o.secret)}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP.digits}&period=${TOTP.stepSec}`;
}
/** The secret as an authenticator user types it: groups of four. */
export const groupedSecret = (secret: Buffer) => base32Encode(secret).replace(/(.{4})(?=.)/g, "$1 ");
