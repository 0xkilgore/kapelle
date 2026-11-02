// Software WebAuthn authenticator for tests (node:crypto), shared by the lean-runtime step 2/4 suites. Fake keys only.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
export const RP = "kapelle.test", ORIGIN = "https://kapelle.test";
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
export const b64u = (b: Buffer) => b.toString("base64url");
// ---- minimal CBOR encoder for the software authenticator ----
export function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => n < 24 ? Buffer.from([(major << 5) | n]) : n < 256 ? Buffer.from([(major << 5) | 24, n])
    : n < 65536 ? Buffer.from([(major << 5) | 25, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b; })();
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v as object);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}
export class SoftAuthenticator {
  readonly credentialId = randomBytes(16); private count = 0; private key: { privateKey: KeyObject; publicKey: KeyObject };
  constructor(readonly alg: "ES256" | "EdDSA" = "ES256") { this.key = alg === "ES256" ? generateKeyPairSync("ec", { namedCurve: "P-256" }) : generateKeyPairSync("ed25519"); }
  private cose() {
    const j = this.key.publicKey.export({ format: "jwk" }) as { x: string; y?: string };
    return this.alg === "ES256" ? new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(j.x, "base64url")], [-3, Buffer.from(j.y!, "base64url")]])
      : new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(j.x, "base64url")]]);
  }
  create(options: any, o: { origin?: string; rpId?: string; flags?: number } = {}) {
    const cd = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.publicKey.challenge, origin: o.origin ?? ORIGIN, crossOrigin: false }));
    const id = this.credentialId, len = Buffer.alloc(2); len.writeUInt16BE(id.length);
    const authData = Buffer.concat([sha256(o.rpId ?? RP), Buffer.from([o.flags ?? 0x45]), Buffer.alloc(4), Buffer.alloc(16), len, id, cbor(this.cose())]);
    return { clientDataJSON: b64u(cd), attestationObject: b64u(cbor({ fmt: "none", attStmt: {}, authData })) };
  }
  /** Synthetic harnesses (G-1) persist the fake authenticator between processes; never used for a real credential. */
  toJSON() { return { alg: this.alg, credentialId: b64u(this.credentialId), count: this.count, privateKeyPem: this.key.privateKey.export({ format: "pem", type: "pkcs8" }) as string }; }
  static from(j: { alg: "ES256" | "EdDSA"; credentialId: string; count: number; privateKeyPem: string }) {
    const a = new SoftAuthenticator(j.alg);
    Object.assign(a, { credentialId: Buffer.from(j.credentialId, "base64url"), count: j.count, key: { privateKey: createPrivateKey(j.privateKeyPem), publicKey: createPublicKey(j.privateKeyPem) } });
    return a;
  }
  get(options: any, o: { origin?: string; rpId?: string; flags?: number; count?: number; crossOrigin?: boolean; challenge?: string } = {}) {
    const cd = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: o.challenge ?? options.publicKey.challenge, origin: o.origin ?? ORIGIN, ...(o.crossOrigin ? { crossOrigin: true } : {}) }));
    const c = Buffer.alloc(4); c.writeUInt32BE(o.count ?? ++this.count);
    const authData = Buffer.concat([sha256(o.rpId ?? RP), Buffer.from([o.flags ?? 0x05]), c]);
    const data = Buffer.concat([authData, sha256(cd)]);
    const signature = this.alg === "ES256" ? sign("sha256", data, this.key.privateKey) : sign(null, data, this.key.privateKey);
    return { credentialId: b64u(this.credentialId), clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature) };
  }
}

