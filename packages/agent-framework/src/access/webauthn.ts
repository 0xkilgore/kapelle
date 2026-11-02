// Lean runtime step 2 (Fable C-1, plan R-4): WebAuthn registration/assertion verification AT THE ORG RUNTIME with
// node:crypto only. Own code written from W3C WebAuthn Level 2 (§6.1 authenticator data, §7.1 registration, §7.2
// assertion) and RFC 8949 (CBOR) / RFC 9053 (COSE keys); SimpleWebAuthn (MIT) and tiny-cbor (MIT) were pattern
// references only (no code lifted, no package added).
//
// Bounds (R-4): CBOR is definite-length only, nesting <= 8, items <= 256, input <= 4 KiB; clientDataJSON <= 2 KiB;
// assertion authenticatorData <= 512 B; crossOrigin === true refused; COSE algorithms limited to ES256 (-7) and
// EdDSA/Ed25519 (-8). Attestation statements are NOT trusted (fmt is ignored): registration proves possession of the new
// key via the runtime challenge + UV, which is what C-1 needs; it does not prove authenticator make/model.
import { createHash, createPublicKey, verify, type JsonWebKey, type KeyObject } from "node:crypto";

export class WebAuthnError extends Error { constructor(readonly reason: string) { super(reason); this.name = "WebAuthnError"; } }
const fail = (reason: string): never => { throw new WebAuthnError(reason); };
const check = (ok: unknown, reason: string): void => { if (!ok) fail(reason); };
export const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
export const fromB64u = (s: unknown, max: number, reason: string) => {
  check(typeof s === "string" && s.length > 0 && s.length <= Math.ceil((max * 4) / 3) + 4 && /^[A-Za-z0-9_-]+$/.test(s), reason);
  const b = Buffer.from(s as string, "base64url");
  check(b.length > 0 && b.length <= max, reason);
  return b;
};
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();

// ---- bounded CBOR (definite-length major types 0-5 and 7 simple/true/false/null; no tags, floats, indefinite) ----
type Cbor = number | bigint | Buffer | string | Cbor[] | Map<Cbor, Cbor> | boolean | null;
export function decodeCbor(input: Buffer, o: { maxBytes?: number; allowTrailing?: boolean } = {}): { value: Cbor; length: number } {
  check(input.length > 0 && input.length <= (o.maxBytes ?? 4096), "cbor_size");
  let pos = 0, items = 0;
  const byte = () => { check(pos < input.length, "cbor_truncated"); return input[pos++]; };
  const take = (n: number) => { check(Number.isSafeInteger(n) && n >= 0 && pos + n <= input.length, "cbor_truncated"); const b = input.subarray(pos, pos + n); pos += n; return b; };
  const argument = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return byte();
    if (info === 25) return take(2).readUInt16BE(0);
    if (info === 26) return take(4).readUInt32BE(0);
    if (info === 27) { const v = take(8).readBigUInt64BE(0); check(v <= BigInt(Number.MAX_SAFE_INTEGER), "cbor_integer_range"); return Number(v); }
    return fail("cbor_indefinite_or_reserved");
  };
  const item = (depth: number): Cbor => {
    check(depth <= 8, "cbor_nesting"); check(++items <= 256, "cbor_items");
    const head = byte(), major = head >> 5, info = head & 31;
    switch (major) {
      case 0: return argument(info);
      case 1: return -1 - argument(info);
      case 2: return Buffer.from(take(argument(info)));
      case 3: { const s = take(argument(info)).toString("utf8"); return s; }
      case 4: { const n = argument(info); check(n <= 64, "cbor_items"); return Array.from({ length: n }, () => item(depth + 1)); }
      case 5: {
        const n = argument(info); check(n <= 64, "cbor_items");
        const m = new Map<Cbor, Cbor>();
        for (let i = 0; i < n; i++) { const k = item(depth + 1); check(typeof k === "number" || typeof k === "string", "cbor_map_key"); check(!m.has(k), "cbor_duplicate_key"); m.set(k, item(depth + 1)); }
        return m;
      }
      case 7: return info === 20 ? false : info === 21 ? true : info === 22 ? null : fail("cbor_unsupported_simple");
      default: return fail("cbor_unsupported_major");
    }
  };
  const value = item(0);
  check(o.allowTrailing || pos === input.length, "cbor_trailing_bytes");
  return { value, length: pos };
}

// ---- COSE public keys (ES256 / EdDSA only) ----
export const COSE_ALGORITHMS = { ES256: -7, EdDSA: -8 } as const;
export function coseToKey(cose: Cbor): { alg: number; jwk: JsonWebKey; key: KeyObject } {
  check(cose instanceof Map, "cose_not_map");
  const m = cose as Map<Cbor, Cbor>, kty = m.get(1), alg = m.get(3);
  if (alg === COSE_ALGORITHMS.ES256) {
    const x = m.get(-2), y = m.get(-3);
    check(kty === 2 && m.get(-1) === 1 && Buffer.isBuffer(x) && (x as Buffer).length === 32 && Buffer.isBuffer(y) && (y as Buffer).length === 32, "cose_es256_invalid");
    const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: b64u(x as Buffer), y: b64u(y as Buffer) };
    return { alg: alg as number, jwk, key: createPublicKey({ key: jwk, format: "jwk" }) };
  }
  if (alg === COSE_ALGORITHMS.EdDSA) {
    const x = m.get(-2);
    check(kty === 1 && m.get(-1) === 6 && Buffer.isBuffer(x) && (x as Buffer).length === 32, "cose_eddsa_invalid");
    const jwk: JsonWebKey = { kty: "OKP", crv: "Ed25519", x: b64u(x as Buffer) };
    return { alg: alg as number, jwk, key: createPublicKey({ key: jwk, format: "jwk" }) };
  }
  return fail("cose_algorithm_not_allowed");
}

// ---- authenticator data (§6.1) ----
export type AuthData = { rpIdHash: Buffer; up: boolean; uv: boolean; at: boolean; ed: boolean; signCount: number;
  credential?: { id: Buffer; cose: Cbor } };
export function parseAuthData(b: Buffer, max: number): AuthData {
  check(b.length >= 37 && b.length <= max, "authdata_size");
  const flags = b[32], at = !!(flags & 0x40), ed = !!(flags & 0x80);
  const out: AuthData = { rpIdHash: b.subarray(0, 32), up: !!(flags & 0x01), uv: !!(flags & 0x04), at, ed, signCount: b.readUInt32BE(33) };
  let pos = 37;
  if (at) {
    check(b.length >= pos + 18, "authdata_truncated");
    const len = b.readUInt16BE(pos + 16); pos += 18;
    check(len >= 16 && len <= 1023 && b.length >= pos + len, "authdata_credential_id");
    const id = b.subarray(pos, pos + len); pos += len;
    const { value, length } = decodeCbor(b.subarray(pos), { maxBytes: 1024, allowTrailing: true });
    pos += length;
    out.credential = { id: Buffer.from(id), cose: value };
  }
  check(!ed, "authdata_extensions_not_supported");
  check(pos === b.length, "authdata_trailing_bytes");
  return out;
}

export type Expected = { challenge: Buffer; origins: readonly string[]; rpId: string };
function clientData(raw: Buffer, type: "webauthn.create" | "webauthn.get", e: Expected) {
  check(raw.length <= 2048, "clientdata_size");
  let c: Record<string, unknown>;
  try { c = JSON.parse(raw.toString("utf8")); } catch { return fail("clientdata_json"); }
  check(c && typeof c === "object" && !Array.isArray(c), "clientdata_json");
  check(c.type === type, "clientdata_type");
  check(typeof c.challenge === "string" && fromB64u(c.challenge, 64, "clientdata_challenge").equals(e.challenge), "clientdata_challenge");
  check(typeof c.origin === "string" && e.origins.includes(c.origin), "clientdata_origin");
  check(c.crossOrigin !== true, "clientdata_cross_origin");
  check(c.tokenBinding === undefined || (c.tokenBinding as { status?: string })?.status !== "present", "clientdata_token_binding");
}
const rpOk = (a: AuthData, e: Expected) => { check(a.rpIdHash.equals(sha256(e.rpId)), "authdata_rp_id"); check(a.up, "authdata_user_presence"); check(a.uv, "authdata_user_verification"); };

/** §7.1 registration: verifies clientData (create), rpIdHash, UP+UV and returns the new credential. Attestation untrusted. */
export function verifyRegistration(r: { clientDataJSON: string; attestationObject: string }, e: Expected) {
  const cd = fromB64u(r.clientDataJSON, 2048, "clientdata_size");
  clientData(cd, "webauthn.create", e);
  const att = decodeCbor(fromB64u(r.attestationObject, 4096, "attestation_size")).value;
  check(att instanceof Map && Buffer.isBuffer((att as Map<Cbor, Cbor>).get("authData")) && typeof (att as Map<Cbor, Cbor>).get("fmt") === "string", "attestation_shape");
  const a = parseAuthData((att as Map<Cbor, Cbor>).get("authData") as Buffer, 2048);
  rpOk(a, e);
  check(a.at && a.credential, "authdata_no_credential");
  const k = coseToKey(a.credential!.cose);
  return { credentialId: b64u(a.credential!.id), alg: k.alg, jwk: k.jwk, signCount: a.signCount };
}

/** §7.2 assertion: clientData (get), rpIdHash, UP+UV, signature over authData || sha256(clientDataJSON), signCount. */
export function verifyAssertion(r: { clientDataJSON: string; authenticatorData: string; signature: string },
  e: Expected, stored: { alg: number; jwk: JsonWebKey; signCount: number }) {
  const cd = fromB64u(r.clientDataJSON, 2048, "clientdata_size");
  clientData(cd, "webauthn.get", e);
  const ad = fromB64u(r.authenticatorData, 512, "authdata_size"), a = parseAuthData(ad, 512);
  rpOk(a, e);
  check(!a.at, "authdata_unexpected_credential");
  const sig = fromB64u(r.signature, 256, "signature_size"), data = Buffer.concat([ad, sha256(cd)]);
  const key = createPublicKey({ key: stored.jwk, format: "jwk" });
  const ok = stored.alg === COSE_ALGORITHMS.ES256 ? verify("sha256", data, { key, dsaEncoding: "der" }, sig)
    : stored.alg === COSE_ALGORITHMS.EdDSA ? verify(null, data, key, sig) : fail("cose_algorithm_not_allowed");
  check(ok, "assertion_signature");
  // §7.2 step 21: a counter that is non-zero on either side must strictly increase (clone detection).
  check(!(a.signCount !== 0 || stored.signCount !== 0) || a.signCount > stored.signCount, "assertion_sign_count");
  return { signCount: a.signCount };
}
