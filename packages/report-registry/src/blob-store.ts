import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type BlobReceipt = {
  blob_ref: string;
  content_hash: string;
  byte_size: number;
  path: string;
};

export type BlobStore = {
  put(bytes: Uint8Array): BlobReceipt;
  get(blobRef: string): Uint8Array;
  has(blobRef: string): boolean;
};

const ENCRYPTED_BLOB_MAGIC = Buffer.from("RRBLOB01", "ascii");
const AES_GCM_NONCE_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;

export class ContentAddressedBlobStore {
  readonly root: string;

  constructor(root: string) { this.root = root; }

  put(bytes: Uint8Array): BlobReceipt {
    const hash = createHash("sha256").update(bytes).digest("hex");
    const path = join(this.root, "sha256", hash.slice(0, 2), hash);
    mkdirSync(dirname(path), { recursive: true });
    try {
      const existing = readFileSync(path);
      const existingHash = createHash("sha256").update(existing).digest("hex");
      if (existingHash !== hash) throw new Error(`blob hash collision at ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
      renameSync(tmp, path);
    }
    return { blob_ref: `blob:sha256:${hash}`, content_hash: hash, byte_size: bytes.byteLength, path };
  }

  get(blobRef: string): Uint8Array {
    const hash = this.hashFromRef(blobRef);
    const bytes = readFileSync(join(this.root, "sha256", hash.slice(0, 2), hash));
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== hash) throw new Error(`blob integrity failure for ${blobRef}`);
    return bytes;
  }

  has(blobRef: string): boolean {
    const hash = this.hashFromRef(blobRef);
    try { return statSync(join(this.root, "sha256", hash.slice(0, 2), hash)).isFile(); }
    catch { return false; }
  }

  private hashFromRef(blobRef: string): string {
    const match = /^blob:sha256:([0-9a-f]{64})$/.exec(blobRef);
    if (!match) throw new Error(`invalid blob ref: ${blobRef}`);
    return match[1];
  }
}

export class EncryptedContentAddressedBlobStore implements BlobStore {
  readonly root: string;
  readonly #key: Buffer;

  constructor(root: string, key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("BLOB_KEY_INVALID: AES-256-GCM requires exactly 32 bytes");
    this.root = root;
    this.#key = Buffer.from(key);
  }

  put(bytes: Uint8Array): BlobReceipt {
    const plaintext = Buffer.from(bytes);
    const hash = createHash("sha256").update(plaintext).digest("hex");
    const path = join(this.root, "sha256", hash.slice(0, 2), hash);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const existing = this.decrypt(readFileSync(path), hash);
      const existingHash = createHash("sha256").update(existing).digest("hex");
      if (existingHash !== hash) throw new Error(`blob hash collision at ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const nonce = randomBytes(AES_GCM_NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
      cipher.setAAD(Buffer.from(hash, "ascii"));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope = Buffer.concat([ENCRYPTED_BLOB_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, envelope, { flag: "wx", mode: 0o600 });
      renameSync(tmp, path);
    }
    return { blob_ref: `blob:sha256:${hash}`, content_hash: hash, byte_size: plaintext.byteLength, path };
  }

  get(blobRef: string): Uint8Array {
    const hash = hashFromBlobRef(blobRef);
    const plaintext = this.decrypt(readFileSync(join(this.root, "sha256", hash.slice(0, 2), hash)), hash);
    const actual = createHash("sha256").update(plaintext).digest("hex");
    if (actual !== hash) throw new Error(`blob integrity failure for ${blobRef}`);
    return plaintext;
  }

  has(blobRef: string): boolean {
    try {
      this.get(blobRef);
      return true;
    }
    catch { return false; }
  }

  private decrypt(envelope: Buffer, hash: string): Buffer {
    const minimum = ENCRYPTED_BLOB_MAGIC.byteLength + AES_GCM_NONCE_BYTES + AES_GCM_TAG_BYTES;
    if (envelope.byteLength < minimum || !envelope.subarray(0, ENCRYPTED_BLOB_MAGIC.byteLength).equals(ENCRYPTED_BLOB_MAGIC)) {
      throw new Error("BLOB_ENVELOPE_INVALID");
    }
    const nonceStart = ENCRYPTED_BLOB_MAGIC.byteLength;
    const tagStart = nonceStart + AES_GCM_NONCE_BYTES;
    const ciphertextStart = tagStart + AES_GCM_TAG_BYTES;
    const decipher = createDecipheriv("aes-256-gcm", this.#key, envelope.subarray(nonceStart, tagStart));
    decipher.setAAD(Buffer.from(hash, "ascii"));
    decipher.setAuthTag(envelope.subarray(tagStart, ciphertextStart));
    try {
      return Buffer.concat([decipher.update(envelope.subarray(ciphertextStart)), decipher.final()]);
    } catch {
      throw new Error("BLOB_AUTHENTICATION_FAILED");
    }
  }
}

export function blobKeyFromBase64(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) throw new Error("BLOB_KEY_INVALID: expected base64");
  const key = Buffer.from(normalized, "base64");
  if (key.byteLength !== 32) throw new Error("BLOB_KEY_INVALID: expected 32 decoded bytes");
  return key;
}

function hashFromBlobRef(blobRef: string): string {
  const match = /^blob:sha256:([0-9a-f]{64})$/.exec(blobRef);
  if (!match) throw new Error(`invalid blob ref: ${blobRef}`);
  return match[1];
}
