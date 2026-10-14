import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import sodium from "libsodium-wrappers";

export const ENCRYPTED_CONTENT_VERSION = 1 as const;
export const CONTENT_AAD_SCHEMA = "REPORT_CONTENT_AAD_V1" as const;
export const ONE_SHOT_ALGORITHM = "XCHACHA20_POLY1305_V1" as const;
export const SECRETSTREAM_ALGORITHM = "SECRETSTREAM_XCHACHA20_POLY1305_V1" as const;
export const RECEIPT_ALGORITHM = "HMAC_SHA256_V1" as const;

export const DEFAULT_SECRETSTREAM_CHUNK_BYTES = 64 * 1024;
export const MAX_SECRETSTREAM_CHUNK_BYTES = 1024 * 1024;
export const MAX_SECRETSTREAM_CHUNKS = 65_536;
const SECRETSTREAM_FRAME_LENGTH_BYTES = 4;
const SECRETSTREAM_AUTH_OVERHEAD_BYTES = 17;
// This is a synchronous in-memory codec, not a streaming file API. A 64 MiB
// round trip has measured roughly 535-553 MiB peak RSS and about 146 ms of
// synchronous decrypt work. Callers must bound concurrency; larger payloads
// require a future streaming transport rather than increasing this constant.
export const MAX_SECRETSTREAM_PLAINTEXT_BYTES = 64 * 1024 * 1024;
export const MAX_ONE_SHOT_PLAINTEXT_BYTES = 8 * 1024 * 1024;
export const MAX_SECRETSTREAM_CIPHERTEXT_BYTES =
  MAX_SECRETSTREAM_PLAINTEXT_BYTES
  + (MAX_SECRETSTREAM_CHUNKS * (SECRETSTREAM_FRAME_LENGTH_BYTES + SECRETSTREAM_AUTH_OVERHEAD_BYTES));

const CONTENT_AAD_PREFIX = Buffer.from(`${CONTENT_AAD_SCHEMA}\0`, "ascii");
const RECEIPT_PREFIX = Buffer.from("REPORT_CONTENT_RECEIPT_V1", "ascii");
const CONTENT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const MAX_REPORT_REF_BYTES = 4096;
const MAX_MIME_TYPE_BYTES = 255;

export type EnvelopeAlgorithm = typeof ONE_SHOT_ALGORITHM | typeof SECRETSTREAM_ALGORITHM;

export type ContentAadInput = {
  reportRef: string;
  contentId: string;
  mimeType: string;
  algorithm: EnvelopeAlgorithm;
  envelopeVersion: typeof ENCRYPTED_CONTENT_VERSION;
};

export type OneShotEnvelope = {
  algorithm: typeof ONE_SHOT_ALGORITHM;
  envelopeVersion: typeof ENCRYPTED_CONTENT_VERSION;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
};

export type SecretstreamEnvelope = {
  algorithm: typeof SECRETSTREAM_ALGORITHM;
  envelopeVersion: typeof ENCRYPTED_CONTENT_VERSION;
  header: Uint8Array;
  framedCiphertext: Uint8Array;
  chunkCount: number;
  chunkSize: number;
  plaintextByteSize: number;
};

export type KeyWrapperContext = {
  reportRef: string;
  contentId: string;
  algorithm: EnvelopeAlgorithm;
  envelopeVersion: typeof ENCRYPTED_CONTENT_VERSION;
};

export type WrappedKeyDescriptor = {
  wrapperType: string;
  keyId: string;
  keyVersion: number;
  wrappedDek: string;
};

export interface KeyWrapper {
  readonly wrapperType: string;
  readonly keyId: string;
  readonly keyVersion: number;
  wrap(dek: Uint8Array, context: KeyWrapperContext): Promise<WrappedKeyDescriptor>;
  unwrap(descriptor: WrappedKeyDescriptor, context: KeyWrapperContext): Promise<Uint8Array>;
}

export class EncryptedContentError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "EncryptedContentError";
    this.code = code;
  }
}

function fail(code: string): never {
  throw new EncryptedContentError(code);
}

function assertByteArray(value: Uint8Array, code: string): void {
  if (!(value instanceof Uint8Array)) fail(code);
}

function assertExactLength(value: Uint8Array, length: number, code: string): void {
  assertByteArray(value, code);
  if (value.byteLength !== length) fail(code);
}

function encodeU32(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) fail("INTEGER_OUT_OF_RANGE");
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32BE(value, 0);
  return bytes;
}

function encodeLengthPrefixed(bytes: Uint8Array): Buffer {
  return Buffer.concat([encodeU32(bytes.byteLength), Buffer.from(bytes)]);
}

function exactUtf8(value: string, code: string, maximumBytes: number): Buffer {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(code);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes || bytes.toString("utf8") !== value) fail(code);
  return bytes;
}

function assertContentId(contentId: string): Buffer {
  if (typeof contentId !== "string" || !CONTENT_ID_PATTERN.test(contentId)) fail("CONTENT_ID_INVALID");
  const decoded = Buffer.from(contentId, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== contentId) fail("CONTENT_ID_INVALID");
  return Buffer.from(contentId, "ascii");
}

function assertMimeType(mimeType: string): Buffer {
  if (typeof mimeType !== "string" || !MIME_TYPE_PATTERN.test(mimeType)) fail("MIME_TYPE_INVALID");
  const bytes = Buffer.from(mimeType, "ascii");
  if (bytes.byteLength > MAX_MIME_TYPE_BYTES) fail("MIME_TYPE_INVALID");
  return bytes;
}

function assertAlgorithm(algorithm: string): asserts algorithm is EnvelopeAlgorithm {
  if (algorithm !== ONE_SHOT_ALGORITHM && algorithm !== SECRETSTREAM_ALGORITHM) fail("ENVELOPE_ALGORITHM_UNSUPPORTED");
}

function assertVersion(version: number): asserts version is typeof ENCRYPTED_CONTENT_VERSION {
  if (version !== ENCRYPTED_CONTENT_VERSION) fail("ENVELOPE_VERSION_UNSUPPORTED");
}

function snapshotAadInput(input: ContentAadInput): ContentAadInput {
  if (!input || typeof input !== "object") fail("AAD_INPUT_INVALID");
  const reportRef = input.reportRef;
  const contentId = input.contentId;
  const mimeType = input.mimeType;
  const algorithm = input.algorithm;
  const envelopeVersion = input.envelopeVersion;
  assertAlgorithm(algorithm);
  assertVersion(envelopeVersion);
  return { reportRef, contentId, mimeType, algorithm, envelopeVersion };
}

function snapshotWrapperContext(context: KeyWrapperContext): KeyWrapperContext {
  if (!context || typeof context !== "object") fail("KEY_WRAPPER_CONTEXT_INVALID");
  const reportRef = context.reportRef;
  const contentId = context.contentId;
  const algorithm = context.algorithm;
  const envelopeVersion = context.envelopeVersion;
  exactUtf8(reportRef, "REPORT_REF_INVALID", MAX_REPORT_REF_BYTES);
  assertContentId(contentId);
  assertAlgorithm(algorithm);
  assertVersion(envelopeVersion);
  return { reportRef, contentId, algorithm, envelopeVersion };
}

function snapshotWrappedKeyDescriptor(descriptor: WrappedKeyDescriptor): WrappedKeyDescriptor {
  if (!descriptor || typeof descriptor !== "object") fail("WRAPPED_DEK_DESCRIPTOR_INVALID");
  const wrapperType = descriptor.wrapperType;
  const keyId = descriptor.keyId;
  const keyVersion = descriptor.keyVersion;
  const wrappedDek = descriptor.wrappedDek;
  if (
    typeof wrapperType !== "string" || wrapperType.length === 0
    || typeof keyId !== "string" || keyId.length === 0
    || !Number.isSafeInteger(keyVersion) || keyVersion < 1
    || typeof wrappedDek !== "string" || wrappedDek.length === 0
  ) {
    fail("WRAPPED_DEK_DESCRIPTOR_INVALID");
  }
  return { wrapperType, keyId, keyVersion, wrappedDek };
}

export function generateContentId(): string {
  return randomBytes(32).toString("base64url");
}

export async function generateDataEncryptionKey(): Promise<Uint8Array> {
  await sodium.ready;
  return sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
}

export function encodeContentAad(input: ContentAadInput): Uint8Array {
  const snapshot = snapshotAadInput(input);
  const reportRef = exactUtf8(snapshot.reportRef, "REPORT_REF_INVALID", MAX_REPORT_REF_BYTES);
  const contentId = assertContentId(snapshot.contentId);
  const mimeType = assertMimeType(snapshot.mimeType);
  const algorithm = Buffer.from(snapshot.algorithm, "ascii");
  return Buffer.concat([
    CONTENT_AAD_PREFIX,
    encodeLengthPrefixed(reportRef),
    encodeLengthPrefixed(contentId),
    encodeLengthPrefixed(mimeType),
    encodeLengthPrefixed(algorithm),
    encodeU32(snapshot.envelopeVersion),
  ]);
}

export function encodeSecretstreamChunkAad(baseAad: Uint8Array, chunkIndex: number, expectedTag: number): Uint8Array {
  assertByteArray(baseAad, "AAD_INVALID");
  if (expectedTag < 0 || expectedTag > 0xff || !Number.isInteger(expectedTag)) fail("SECRETSTREAM_TAG_EXPECTATION_INVALID");
  const chunkAad = Buffer.allocUnsafe(baseAad.byteLength + 9);
  chunkAad.set(baseAad, 0);
  writeSecretstreamChunkAadSuffix(chunkAad, baseAad.byteLength, chunkIndex, expectedTag);
  return chunkAad;
}

function writeSecretstreamChunkAadSuffix(
  chunkAad: Buffer,
  baseAadLength: number,
  chunkIndex: number,
  expectedTag: number,
): void {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) fail("INTEGER_OUT_OF_RANGE");
  if (expectedTag < 0 || expectedTag > 0xff || !Number.isInteger(expectedTag)) {
    fail("SECRETSTREAM_TAG_EXPECTATION_INVALID");
  }
  chunkAad.writeBigUInt64BE(BigInt(chunkIndex), baseAadLength);
  chunkAad[baseAadLength + 8] = expectedTag;
}

function createSecretstreamChunkAadTemplate(baseAad: Uint8Array): Buffer {
  assertByteArray(baseAad, "AAD_INVALID");
  const chunkAad = Buffer.allocUnsafe(baseAad.byteLength + 9);
  chunkAad.set(baseAad, 0);
  return chunkAad;
}

function assertDataKey(key: Uint8Array): void {
  assertExactLength(key, 32, "DEK_INVALID");
}

function assertOneShotAad(aad: ContentAadInput): Uint8Array {
  const snapshot = snapshotAadInput(aad);
  if (snapshot.algorithm !== ONE_SHOT_ALGORITHM) fail("ENVELOPE_MODE_MISMATCH");
  return encodeContentAad(snapshot);
}

function assertSecretstreamAad(aad: ContentAadInput): Uint8Array {
  const snapshot = snapshotAadInput(aad);
  if (snapshot.algorithm !== SECRETSTREAM_ALGORITHM) fail("ENVELOPE_MODE_MISMATCH");
  return encodeContentAad(snapshot);
}

async function encryptOneShotWithNonce(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: ContentAadInput,
  nonce: Uint8Array,
): Promise<OneShotEnvelope> {
  await sodium.ready;
  assertByteArray(plaintext, "PLAINTEXT_INVALID");
  if (plaintext.byteLength === 0) fail("PLAINTEXT_EMPTY");
  if (plaintext.byteLength > MAX_ONE_SHOT_PLAINTEXT_BYTES) fail("ONE_SHOT_PLAINTEXT_TOO_LARGE");
  assertDataKey(key);
  assertExactLength(nonce, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES, "NONCE_INVALID");
  const encodedAad = assertOneShotAad(aad);
  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    encodedAad,
    null,
    nonce,
    key,
  );
  return {
    algorithm: ONE_SHOT_ALGORITHM,
    envelopeVersion: ENCRYPTED_CONTENT_VERSION,
    nonce: Uint8Array.from(nonce),
    ciphertext: Uint8Array.from(ciphertext),
  };
}

export async function encryptOneShot(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: ContentAadInput,
): Promise<OneShotEnvelope> {
  await sodium.ready;
  return encryptOneShotWithNonce(
    plaintext,
    key,
    aad,
    sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES),
  );
}

export async function decryptOneShot(
  envelope: OneShotEnvelope | SecretstreamEnvelope,
  key: Uint8Array,
  aad: ContentAadInput,
): Promise<Uint8Array> {
  await sodium.ready;
  if (!envelope || typeof envelope !== "object") fail("ENVELOPE_INVALID");
  const envelopeAlgorithm = envelope.algorithm;
  const aadSnapshot = snapshotAadInput(aad);
  if (envelopeAlgorithm !== ONE_SHOT_ALGORITHM || aadSnapshot.algorithm !== ONE_SHOT_ALGORITHM) {
    fail("ENVELOPE_MODE_MISMATCH");
  }
  const oneShotEnvelope = envelope as OneShotEnvelope;
  const envelopeVersion = oneShotEnvelope.envelopeVersion;
  const nonce = oneShotEnvelope.nonce;
  const ciphertext = oneShotEnvelope.ciphertext;
  assertVersion(envelopeVersion);
  assertDataKey(key);
  assertExactLength(nonce, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES, "NONCE_INVALID");
  assertByteArray(ciphertext, "CIPHERTEXT_INVALID");
  if (
    ciphertext.byteLength < sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES ||
    ciphertext.byteLength > MAX_ONE_SHOT_PLAINTEXT_BYTES + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES
  ) {
    fail("CIPHERTEXT_INVALID");
  }
  try {
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      ciphertext,
      assertOneShotAad(aadSnapshot),
      nonce,
      key,
    );
    return Uint8Array.from(plaintext);
  } catch {
    fail("ENVELOPE_AUTHENTICATION_FAILED");
  }
}

function validateChunkSize(chunkSize: number): void {
  if (!Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > MAX_SECRETSTREAM_CHUNK_BYTES) {
    fail("SECRETSTREAM_CHUNK_SIZE_INVALID");
  }
}

function frameCiphertext(chunks: Uint8Array[]): Uint8Array {
  const frames: Buffer[] = [];
  for (const chunk of chunks) {
    frames.push(encodeU32(chunk.byteLength), Buffer.from(chunk));
  }
  return Buffer.concat(frames);
}

/** Returns read-only zero-copy views that alias the caller's ciphertext buffer. */
export function parseSecretstreamFrames(framedCiphertext: Uint8Array): Uint8Array[] {
  assertByteArray(framedCiphertext, "SECRETSTREAM_FRAMING_INVALID");
  if (framedCiphertext.byteLength > MAX_SECRETSTREAM_CIPHERTEXT_BYTES) {
    fail("SECRETSTREAM_CIPHERTEXT_TOO_LARGE");
  }
  const bytes = Buffer.from(
    framedCiphertext.buffer,
    framedCiphertext.byteOffset,
    framedCiphertext.byteLength,
  );
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < SECRETSTREAM_FRAME_LENGTH_BYTES) fail("SECRETSTREAM_FRAMING_INVALID");
    const length = bytes.readUInt32BE(offset);
    offset += SECRETSTREAM_FRAME_LENGTH_BYTES;
    if (
      length <= SECRETSTREAM_AUTH_OVERHEAD_BYTES
      || length > MAX_SECRETSTREAM_CHUNK_BYTES + SECRETSTREAM_AUTH_OVERHEAD_BYTES
    ) {
      fail("SECRETSTREAM_FRAMING_INVALID");
    }
    if (length > bytes.byteLength - offset) fail("SECRETSTREAM_FRAMING_INVALID");
    if (frames.length + 1 > MAX_SECRETSTREAM_CHUNKS) fail("SECRETSTREAM_TOO_MANY_CHUNKS");
    frames.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (frames.length === 0) fail("SECRETSTREAM_EMPTY");
  return frames;
}

export async function encryptSecretstream(
  plaintext: Uint8Array,
  key: Uint8Array,
  aad: ContentAadInput,
  options: { chunkSize?: number } = {},
): Promise<SecretstreamEnvelope> {
  await sodium.ready;
  assertByteArray(plaintext, "PLAINTEXT_INVALID");
  if (plaintext.byteLength === 0) fail("SECRETSTREAM_EMPTY");
  if (plaintext.byteLength > MAX_SECRETSTREAM_PLAINTEXT_BYTES) fail("SECRETSTREAM_PLAINTEXT_TOO_LARGE");
  assertDataKey(key);
  const chunkSize = options.chunkSize ?? DEFAULT_SECRETSTREAM_CHUNK_BYTES;
  validateChunkSize(chunkSize);
  const chunkCount = Math.ceil(plaintext.byteLength / chunkSize);
  if (chunkCount > MAX_SECRETSTREAM_CHUNKS) fail("SECRETSTREAM_TOO_MANY_CHUNKS");
  const baseAad = assertSecretstreamAad(aad);
  const chunkAad = createSecretstreamChunkAadTemplate(baseAad);
  const initialized = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  const encryptedChunks: Uint8Array[] = [];
  for (let index = 0; index < chunkCount; index += 1) {
    const final = index === chunkCount - 1;
    const tag = final
      ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
    const start = index * chunkSize;
    const message = plaintext.subarray(start, Math.min(start + chunkSize, plaintext.byteLength));
    writeSecretstreamChunkAadSuffix(chunkAad, baseAad.byteLength, index, tag);
    encryptedChunks.push(Uint8Array.from(
      sodium.crypto_secretstream_xchacha20poly1305_push(initialized.state, message, chunkAad, tag),
    ));
  }
  return {
    algorithm: SECRETSTREAM_ALGORITHM,
    envelopeVersion: ENCRYPTED_CONTENT_VERSION,
    header: Uint8Array.from(initialized.header),
    framedCiphertext: frameCiphertext(encryptedChunks),
    chunkCount,
    chunkSize,
    plaintextByteSize: plaintext.byteLength,
  };
}

export async function decryptSecretstream(
  envelope: OneShotEnvelope | SecretstreamEnvelope,
  key: Uint8Array,
  aad: ContentAadInput,
): Promise<Uint8Array> {
  await sodium.ready;
  if (!envelope || typeof envelope !== "object") fail("ENVELOPE_INVALID");
  const envelopeAlgorithm = envelope.algorithm;
  const aadSnapshot = snapshotAadInput(aad);
  if (envelopeAlgorithm !== SECRETSTREAM_ALGORITHM || aadSnapshot.algorithm !== SECRETSTREAM_ALGORITHM) {
    fail("ENVELOPE_MODE_MISMATCH");
  }
  const streamEnvelope = envelope as SecretstreamEnvelope;
  const envelopeVersion = streamEnvelope.envelopeVersion;
  const header = streamEnvelope.header;
  const framedCiphertext = streamEnvelope.framedCiphertext;
  const chunkSize = streamEnvelope.chunkSize;
  const chunkCount = streamEnvelope.chunkCount;
  const plaintextByteSize = streamEnvelope.plaintextByteSize;
  assertVersion(envelopeVersion);
  assertDataKey(key);
  assertExactLength(header, sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES, "SECRETSTREAM_HEADER_INVALID");
  validateChunkSize(chunkSize);
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_SECRETSTREAM_CHUNKS) {
    fail("SECRETSTREAM_CHUNK_COUNT_INVALID");
  }
  if (!Number.isInteger(plaintextByteSize) || plaintextByteSize < 1 || plaintextByteSize > MAX_SECRETSTREAM_PLAINTEXT_BYTES) {
    fail("SECRETSTREAM_PLAINTEXT_SIZE_INVALID");
  }
  if (((chunkCount - 1) * chunkSize) >= MAX_SECRETSTREAM_PLAINTEXT_BYTES) {
    fail("SECRETSTREAM_PLAINTEXT_SIZE_INVALID");
  }
  assertByteArray(framedCiphertext, "SECRETSTREAM_FRAMING_INVALID");
  if (framedCiphertext.byteLength === 0) fail("SECRETSTREAM_EMPTY");
  if (framedCiphertext.byteLength > MAX_SECRETSTREAM_CIPHERTEXT_BYTES) {
    fail("SECRETSTREAM_CIPHERTEXT_TOO_LARGE");
  }
  const frames = parseSecretstreamFrames(framedCiphertext);
  if (frames.length !== chunkCount) fail("SECRETSTREAM_CHUNK_COUNT_MISMATCH");
  let evidencedPlaintextByteSize = 0;
  for (const frame of frames) {
    evidencedPlaintextByteSize += frame.byteLength - SECRETSTREAM_AUTH_OVERHEAD_BYTES;
  }
  if (plaintextByteSize !== evidencedPlaintextByteSize) {
    fail("SECRETSTREAM_PLAINTEXT_SIZE_INVALID");
  }
  const baseAad = assertSecretstreamAad(aadSnapshot);
  const chunkAad = createSecretstreamChunkAadTemplate(baseAad);
  let state: unknown;
  try {
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(header, key);
  } catch {
    fail("SECRETSTREAM_HEADER_INVALID");
  }
  const plaintext = Buffer.allocUnsafe(plaintextByteSize);
  let plaintextBytes = 0;
  let complete = false;
  try {
    for (let index = 0; index < frames.length; index += 1) {
      const final = index === frames.length - 1;
      const expectedTag = final
        ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE;
      writeSecretstreamChunkAadSuffix(chunkAad, baseAad.byteLength, index, expectedTag);
      let message: Uint8Array | undefined;
      try {
        const pulled = sodium.crypto_secretstream_xchacha20poly1305_pull(state, frames[index], chunkAad);
        if (!pulled) fail("ENVELOPE_AUTHENTICATION_FAILED");
        if (pulled.tag !== expectedTag) fail("SECRETSTREAM_TAG_INVALID");
        message = pulled.message;
        if (
          message.byteLength < 1 ||
          message.byteLength > chunkSize ||
          (!final && message.byteLength !== chunkSize)
        ) {
          fail("SECRETSTREAM_CHUNK_INVALID");
        }
        if (plaintextBytes + message.byteLength > plaintext.byteLength) {
          fail("SECRETSTREAM_PLAINTEXT_SIZE_MISMATCH");
        }
        plaintext.set(message, plaintextBytes);
        plaintextBytes += message.byteLength;
      } catch (error) {
        if (error instanceof EncryptedContentError) throw error;
        fail("ENVELOPE_AUTHENTICATION_FAILED");
      } finally {
        if (message) bestEffortZero(message);
      }
    }
    if (plaintextBytes !== plaintextByteSize) fail("SECRETSTREAM_PLAINTEXT_SIZE_MISMATCH");
    complete = true;
    return plaintext;
  } finally {
    if (!complete) bestEffortZero(plaintext);
  }
}

export async function rewrapDataEncryptionKey(
  descriptor: WrappedKeyDescriptor,
  currentWrapper: KeyWrapper,
  newWrapper: KeyWrapper,
  context: KeyWrapperContext,
): Promise<WrappedKeyDescriptor> {
  const descriptorSnapshot = snapshotWrappedKeyDescriptor(descriptor);
  const currentWrapperType = currentWrapper.wrapperType;
  const currentKeyId = currentWrapper.keyId;
  const currentKeyVersion = currentWrapper.keyVersion;
  if (
    descriptorSnapshot.wrapperType !== currentWrapperType ||
    descriptorSnapshot.keyId !== currentKeyId ||
    descriptorSnapshot.keyVersion !== currentKeyVersion
  ) {
    fail("KEY_WRAPPER_MISMATCH");
  }
  const contextSnapshot = snapshotWrapperContext(context);
  const dek = await currentWrapper.unwrap({ ...descriptorSnapshot }, contextSnapshot);
  try {
    assertDataKey(dek);
    const newWrapperType = newWrapper.wrapperType;
    const newKeyId = newWrapper.keyId;
    const newKeyVersion = newWrapper.keyVersion;
    const rewrapped = snapshotWrappedKeyDescriptor(await newWrapper.wrap(dek, contextSnapshot));
    if (
      rewrapped.wrapperType !== newWrapperType ||
      rewrapped.keyId !== newKeyId ||
      rewrapped.keyVersion !== newKeyVersion
    ) {
      fail("KEY_WRAPPER_MISMATCH");
    }
    let recovered: Uint8Array;
    try {
      recovered = await newWrapper.unwrap({ ...rewrapped }, contextSnapshot);
    } catch {
      fail("WRAPPED_DEK_RECOVERY_FAILED");
    }
    try {
      assertDataKey(recovered);
      const originalView = Buffer.from(dek.buffer, dek.byteOffset, dek.byteLength);
      const recoveredView = Buffer.from(recovered.buffer, recovered.byteOffset, recovered.byteLength);
      if (!timingSafeEqual(originalView, recoveredView)) fail("WRAPPED_DEK_RECOVERY_FAILED");
    } finally {
      bestEffortZero(recovered);
    }
    return { ...rewrapped };
  } finally {
    bestEffortZero(dek);
  }
}

export function computeContentReceipt(
  plaintext: Uint8Array,
  reportRef: string,
  receiptKey: Uint8Array,
  receiptKeyVersion: number,
): string {
  assertByteArray(plaintext, "PLAINTEXT_INVALID");
  assertExactLength(receiptKey, 32, "RECEIPT_KEY_INVALID");
  if (!Number.isSafeInteger(receiptKeyVersion) || receiptKeyVersion < 1) fail("RECEIPT_KEY_VERSION_INVALID");
  const reportRefBytes = exactUtf8(reportRef, "REPORT_REF_INVALID", MAX_REPORT_REF_BYTES);
  const plaintextHash = createHash("sha256").update(plaintext).digest();
  const payload = Buffer.concat([
    RECEIPT_PREFIX,
    encodeU32(receiptKeyVersion),
    encodeLengthPrefixed(reportRefBytes),
    plaintextHash,
  ]);
  const mac = createHmac("sha256", receiptKey).update(payload).digest("base64url");
  return `${RECEIPT_ALGORITHM}:${receiptKeyVersion}:${mac}`;
}

export type ReceiptKeyRing = ReadonlyMap<number, Uint8Array>;

export function verifyContentReceipt(
  receipt: string,
  plaintext: Uint8Array,
  reportRef: string,
  receiptKeys: ReceiptKeyRing,
): boolean {
  const match = new RegExp(`^${RECEIPT_ALGORITHM}:([1-9][0-9]*):([A-Za-z0-9_-]{43})$`).exec(receipt);
  if (!match) fail("CONTENT_RECEIPT_INVALID");
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version)) fail("CONTENT_RECEIPT_INVALID");
  if (!receiptKeys || typeof receiptKeys.get !== "function") fail("RECEIPT_KEY_RING_INVALID");
  const receiptKey = receiptKeys.get(version);
  if (!receiptKey) fail("RECEIPT_KEY_VERSION_UNKNOWN");
  const suppliedMac = Buffer.from(match[2], "base64url");
  if (suppliedMac.byteLength !== 32 || suppliedMac.toString("base64url") !== match[2]) {
    fail("CONTENT_RECEIPT_INVALID");
  }
  const expected = computeContentReceipt(plaintext, reportRef, receiptKey, version);
  const expectedMac = expected.split(":")[2];
  return timingSafeEqual(suppliedMac, Buffer.from(expectedMac, "base64url"));
}

export function bestEffortZero(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) return;
  try {
    sodium.memzero(bytes);
  } catch {
    bytes.fill(0);
  }
}
