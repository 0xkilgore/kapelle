import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sodium from "libsodium-wrappers";
import {
  CONTENT_AAD_SCHEMA,
  ENCRYPTED_CONTENT_VERSION,
  MAX_ONE_SHOT_PLAINTEXT_BYTES,
  MAX_SECRETSTREAM_CIPHERTEXT_BYTES,
  MAX_SECRETSTREAM_CHUNK_BYTES,
  MAX_SECRETSTREAM_PLAINTEXT_BYTES,
  ONE_SHOT_ALGORITHM,
  SECRETSTREAM_ALGORITHM,
  bestEffortZero,
  computeContentReceipt,
  decryptOneShot,
  decryptSecretstream,
  encodeContentAad,
  encodeSecretstreamChunkAad,
  encryptOneShot,
  encryptSecretstream,
  generateContentId,
  generateDataEncryptionKey,
  parseSecretstreamFrames,
  rewrapDataEncryptionKey,
  verifyContentReceipt,
  type ContentAadInput,
  type OneShotEnvelope,
  type SecretstreamEnvelope,
} from "../src/encrypted-content-v1.ts";
import { TestOnlyAuthenticatedKeyWrapper } from "./support/test-key-wrapper.ts";

const CONTENT_ID = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const OTHER_CONTENT_ID = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const WRONG_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

function oneShotAad(overrides: Partial<ContentAadInput> = {}): ContentAadInput {
  return {
    reportRef: "report:private:alpha",
    contentId: CONTENT_ID,
    mimeType: "application/pdf",
    algorithm: ONE_SHOT_ALGORITHM,
    envelopeVersion: ENCRYPTED_CONTENT_VERSION,
    ...overrides,
  };
}

function streamAad(overrides: Partial<ContentAadInput> = {}): ContentAadInput {
  return {
    ...oneShotAad(),
    algorithm: SECRETSTREAM_ALGORITHM,
    ...overrides,
  };
}

function cloneStream(envelope: SecretstreamEnvelope, overrides: Partial<SecretstreamEnvelope> = {}): SecretstreamEnvelope {
  return {
    ...envelope,
    header: Uint8Array.from(envelope.header),
    framedCiphertext: Uint8Array.from(envelope.framedCiphertext),
    ...overrides,
  };
}

function cloneOneShot(envelope: OneShotEnvelope, overrides: Partial<OneShotEnvelope> = {}): OneShotEnvelope {
  return {
    ...envelope,
    nonce: Uint8Array.from(envelope.nonce),
    ciphertext: Uint8Array.from(envelope.ciphertext),
    ...overrides,
  };
}

function frameCiphertext(chunks: Uint8Array[]): Uint8Array {
  const framed: Buffer[] = [];
  for (const chunk of chunks) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(chunk.byteLength, 0);
    framed.push(length, Buffer.from(chunk));
  }
  return Buffer.concat(framed);
}

async function deterministicGoldenEnvelope(): Promise<OneShotEnvelope> {
  await sodium.ready;
  const nonce = Uint8Array.from({ length: 24 }, (_, index) => 0xa0 + index);
  return {
    algorithm: ONE_SHOT_ALGORITHM,
    envelopeVersion: ENCRYPTED_CONTENT_VERSION,
    nonce,
    ciphertext: sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      Buffer.from("golden private report", "utf8"),
      encodeContentAad(oneShotAad()),
      null,
      nonce,
      KEY,
    ),
  };
}

describe("ENCRYPTED_CONTENT_V1 canonical encodings", () => {
  it("commits the canonical AAD schema and golden byte vector", () => {
    assert.equal(CONTENT_AAD_SCHEMA, "REPORT_CONTENT_AAD_V1");
    assert.equal(
      Buffer.from(encodeContentAad(oneShotAad())).toString("hex"),
      "5245504f52545f434f4e54454e545f4141445f563100000000147265706f72743a707269766174653a616c7068610000002b41414543417751464267634943516f4c4441304f4478415245684d554652595847426b61477877644868380000000f6170706c69636174696f6e2f706466000000155843484143484132305f504f4c59313330355f563100000001",
    );
  });

  it("rejects malformed identifiers, MIME types, algorithms, and versions", () => {
    assert.throws(() => encodeContentAad(oneShotAad({ contentId: "short" })), /CONTENT_ID_INVALID/);
    assert.throws(() => encodeContentAad(oneShotAad({ mimeType: "text/plain; charset=utf-8" })), /MIME_TYPE_INVALID/);
    assert.throws(
      () => encodeContentAad(oneShotAad({ algorithm: "AES_GCM" as ContentAadInput["algorithm"] })),
      /ENVELOPE_ALGORITHM_UNSUPPORTED/,
    );
    assert.throws(
      () => encodeContentAad(oneShotAad({ envelopeVersion: 2 as typeof ENCRYPTED_CONTENT_VERSION })),
      /ENVELOPE_VERSION_UNSUPPORTED/,
    );
  });

  it("reads each AAD field once and rejects non-canonical MIME values", () => {
    let algorithmReads = 0;
    const getterBacked = {
      ...oneShotAad(),
      get algorithm() {
        algorithmReads += 1;
        return algorithmReads === 1 ? ONE_SHOT_ALGORITHM : "TOTALLY_FORGED_ALG";
      },
    } as ContentAadInput;
    encodeContentAad(getterBacked);
    assert.equal(algorithmReads, 1);
    assert.throws(() => encodeContentAad(oneShotAad({ mimeType: "Application/PDF" })), /MIME_TYPE_INVALID/);
    assert.throws(
      () => encodeContentAad(oneShotAad({ mimeType: `text/${"a".repeat(251)}` })),
      /MIME_TYPE_INVALID/,
    );
  });

  it("pins the chunk AAD encoding", async () => {
    await sodium.ready;
    const baseAad = encodeContentAad(streamAad());
    const messageChunkAad = encodeSecretstreamChunkAad(
      baseAad,
      0,
      sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
    const finalChunkAad = encodeSecretstreamChunkAad(
      baseAad,
      0x0102_0304,
      sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
    );
    assert.equal(
      Buffer.from(messageChunkAad).toString("hex"),
      "5245504f52545f434f4e54454e545f4141445f563100000000147265706f72743a707269766174653a616c7068610000002b41414543417751464267634943516f4c4441304f4478415245684d554652595847426b61477877644868380000000f6170706c69636174696f6e2f7064660000002253454352455453545245414d5f5843484143484132305f504f4c59313330355f563100000001000000000000000000",
    );
    assert.equal(
      Buffer.from(finalChunkAad).toString("hex"),
      "5245504f52545f434f4e54454e545f4141445f563100000000147265706f72743a707269766174653a616c7068610000002b41414543417751464267634943516f4c4441304f4478415245684d554652595847426b61477877644868380000000f6170706c69636174696f6e2f7064660000002253454352455453545245414d5f5843484143484132305f504f4c59313330355f563100000001000000000102030403",
    );
  });

  it("generates strict random 32-byte base64url content identifiers", () => {
    const first = generateContentId();
    const second = generateContentId();
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(first, "base64url").byteLength, 32);
    assert.notEqual(first, second);
  });

  it("generates independent 32-byte data-encryption keys", async () => {
    const first = await generateDataEncryptionKey();
    const second = await generateDataEncryptionKey();
    assert.equal(first.byteLength, 32);
    assert.equal(second.byteLength, 32);
    assert.notDeepEqual(first, second);
  });
});

describe("XChaCha20-Poly1305 one-shot envelope", () => {
  it("round-trips and produces different ciphertext for identical plaintext", async () => {
    const plaintext = Buffer.from("same private report bytes");
    const first = await encryptOneShot(plaintext, KEY, oneShotAad());
    const second = await encryptOneShot(plaintext, KEY, oneShotAad());
    assert.notDeepEqual(first.nonce, second.nonce);
    assert.notDeepEqual(first.ciphertext, second.ciphertext);
    assert.deepEqual(Buffer.from(await decryptOneShot(first, KEY, oneShotAad())), plaintext);
    assert.deepEqual(Buffer.from(await decryptOneShot(second, KEY, oneShotAad())), plaintext);
  });

  it("matches a committed deterministic ciphertext golden vector", async () => {
    const envelope = await deterministicGoldenEnvelope();
    assert.equal(Buffer.from(envelope.nonce).toString("hex"), "a0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7");
    assert.equal(
      Buffer.from(envelope.ciphertext).toString("hex"),
      "22836679d23384dc13065be8055583b25edaf05ede461e66b99cd74a79597374b4e7e2b095",
    );
    assert.equal(Buffer.from(await decryptOneShot(envelope, KEY, oneShotAad())).toString("utf8"), "golden private report");
  });

  it("fails closed for ciphertext, key, nonce, AAD, report, content, MIME, and version tampering", async () => {
    const envelope = await encryptOneShot(Buffer.from("classified"), KEY, oneShotAad());
    const mutated = cloneOneShot(envelope);
    mutated.ciphertext[0] ^= 0x80;
    await assert.rejects(() => decryptOneShot(mutated, KEY, oneShotAad()), /ENVELOPE_AUTHENTICATION_FAILED/);
    await assert.rejects(() => decryptOneShot(envelope, WRONG_KEY, oneShotAad()), /ENVELOPE_AUTHENTICATION_FAILED/);
    await assert.rejects(() => decryptOneShot(envelope, KEY, oneShotAad({ reportRef: "report:private:other" })), /ENVELOPE_AUTHENTICATION_FAILED/);
    await assert.rejects(() => decryptOneShot(envelope, KEY, oneShotAad({ contentId: OTHER_CONTENT_ID })), /ENVELOPE_AUTHENTICATION_FAILED/);
    await assert.rejects(() => decryptOneShot(envelope, KEY, oneShotAad({ mimeType: "text/plain" })), /ENVELOPE_AUTHENTICATION_FAILED/);
    await assert.rejects(
      () => decryptOneShot(cloneOneShot(envelope, { envelopeVersion: 2 as 1 }), KEY, oneShotAad()),
      /ENVELOPE_VERSION_UNSUPPORTED/,
    );
    await assert.rejects(
      () => decryptOneShot(cloneOneShot(envelope, { nonce: envelope.nonce.subarray(1) }), KEY, oneShotAad()),
      /NONCE_INVALID/,
    );
  });

  it("refuses cross-mode presentation before decrypting", async () => {
    const oneShot = await encryptOneShot(Buffer.from("one shot"), KEY, oneShotAad());
    const stream = await encryptSecretstream(Buffer.from("streamed"), KEY, streamAad(), { chunkSize: 3 });
    await assert.rejects(() => decryptSecretstream(oneShot, KEY, streamAad()), /ENVELOPE_MODE_MISMATCH/);
    await assert.rejects(() => decryptOneShot(stream, KEY, oneShotAad()), /ENVELOPE_MODE_MISMATCH/);
    await assert.rejects(() => decryptOneShot(oneShot, KEY, streamAad()), /ENVELOPE_MODE_MISMATCH/);
  });

  it("enforces its bounded one-shot size before encryption", async () => {
    await assert.rejects(
      () => encryptOneShot(Buffer.alloc(MAX_ONE_SHOT_PLAINTEXT_BYTES + 1), KEY, oneShotAad()),
      /ONE_SHOT_PLAINTEXT_TOO_LARGE/,
    );
    const envelope = await encryptOneShot(Buffer.from("bounded"), KEY, oneShotAad());
    await assert.rejects(
      () => decryptOneShot(
        cloneOneShot(envelope, { ciphertext: Buffer.alloc(MAX_ONE_SHOT_PLAINTEXT_BYTES + 17) }),
        KEY,
        oneShotAad(),
      ),
      /CIPHERTEXT_INVALID/,
    );
  });

  it("rejects empty one-shot plaintext as a producer error", async () => {
    await assert.rejects(() => encryptOneShot(Buffer.alloc(0), KEY, oneShotAad()), /PLAINTEXT_EMPTY/);
  });
});

describe("XChaCha20-Poly1305 secretstream envelope", () => {
  it("uses fixed bounded chunks and exact final semantics", async () => {
    const plaintext = Buffer.from("abcdefghijklmnopqrstuvwxyz");
    const envelope = await encryptSecretstream(plaintext, KEY, streamAad(), { chunkSize: 5 });
    assert.equal(envelope.chunkCount, 6);
    assert.equal(parseSecretstreamFrames(envelope.framedCiphertext).length, 6);
    assert.deepEqual(await decryptSecretstream(envelope, KEY, streamAad()), plaintext);
  });

  it("decrypts a committed secretstream compatibility vector", async () => {
    const envelope: SecretstreamEnvelope = {
      algorithm: SECRETSTREAM_ALGORITHM,
      envelopeVersion: ENCRYPTED_CONTENT_VERSION,
      header: Buffer.from("10b4026e04506454721159727a4bd913342d1f39d566b658", "hex"),
      framedCiphertext: Buffer.from(
        "0000001891df9048d98b6d882b6bbaf5c87838023dcb1df3ae0cf68d"
        + "00000018280db0101a556fb84908b466e51d3b757d567e33ba1e4a5f"
        + "00000018a010a930cd205bb68096d4b00c12a7146939ebe051d2d7bc"
        + "0000001643453c9509eddd62d3f6deba5f72ec3b289c9ec554c6",
        "hex",
      ),
      chunkCount: 4,
      chunkSize: 7,
      plaintextByteSize: 26,
    };
    assert.equal(
      Buffer.from(await decryptSecretstream(envelope, KEY, streamAad())).toString("utf8"),
      "golden secretstream report",
    );
  });

  it("rejects empty streams and invalid declared bounds", async () => {
    await assert.rejects(() => encryptSecretstream(Buffer.alloc(0), KEY, streamAad()), /SECRETSTREAM_EMPTY/);
    await assert.rejects(() => encryptSecretstream(Buffer.from("x"), KEY, streamAad(), { chunkSize: 0 }), /SECRETSTREAM_CHUNK_SIZE_INVALID/);
    await assert.rejects(
      () => encryptSecretstream(Buffer.from("x"), KEY, streamAad(), { chunkSize: MAX_SECRETSTREAM_CHUNK_BYTES + 1 }),
      /SECRETSTREAM_CHUNK_SIZE_INVALID/,
    );
    const valid = await encryptSecretstream(Buffer.from("abcdef"), KEY, streamAad(), { chunkSize: 2 });
    await assert.rejects(
      () => decryptSecretstream(cloneStream(valid, { framedCiphertext: new Uint8Array(), chunkCount: 1 }), KEY, streamAad()),
      /SECRETSTREAM_EMPTY/,
    );
    await assert.rejects(
      () => decryptSecretstream(cloneStream(valid, { plaintextByteSize: 0 }), KEY, streamAad()),
      /SECRETSTREAM_PLAINTEXT_SIZE_INVALID/,
    );
    assert.throws(
      () => parseSecretstreamFrames(Buffer.alloc(MAX_SECRETSTREAM_CIPHERTEXT_BYTES + 1)),
      /SECRETSTREAM_CIPHERTEXT_TOO_LARGE/,
    );
    const tiny = await encryptSecretstream(Buffer.from("x"), KEY, streamAad(), { chunkSize: 1 });
    await assert.rejects(
      () => decryptSecretstream(
        cloneStream(tiny, {
          chunkSize: MAX_SECRETSTREAM_CHUNK_BYTES,
          plaintextByteSize: MAX_SECRETSTREAM_PLAINTEXT_BYTES,
        }),
        KEY,
        streamAad(),
      ),
      /SECRETSTREAM_PLAINTEXT_SIZE_INVALID/,
    );
  });

  it("rejects mutation, wrong keys, wrong descriptors, and header tampering", async () => {
    const envelope = await encryptSecretstream(Buffer.from("multiple secret chunks"), KEY, streamAad(), { chunkSize: 4 });
    const mutated = cloneStream(envelope);
    mutated.framedCiphertext[8] ^= 1;
    await assert.rejects(() => decryptSecretstream(mutated, KEY, streamAad()), /ENVELOPE_AUTHENTICATION_FAILED/);
    await assert.rejects(() => decryptSecretstream(envelope, WRONG_KEY, streamAad()), /ENVELOPE_AUTHENTICATION_FAILED/);
    await assert.rejects(() => decryptSecretstream(envelope, KEY, streamAad({ reportRef: "report:private:other" })), /ENVELOPE_AUTHENTICATION_FAILED/);
    await assert.rejects(() => decryptSecretstream(envelope, KEY, streamAad({ contentId: OTHER_CONTENT_ID })), /ENVELOPE_AUTHENTICATION_FAILED/);
    const badHeader = cloneStream(envelope);
    badHeader.header[0] ^= 1;
    await assert.rejects(() => decryptSecretstream(badHeader, KEY, streamAad()), /ENVELOPE_AUTHENTICATION_FAILED/);
  });

  it("rejects reordered, duplicated, deleted, inserted, truncated, and post-final chunks", async () => {
    const envelope = await encryptSecretstream(Buffer.from("0123456789abcdef"), KEY, streamAad(), { chunkSize: 4 });
    const frames = parseSecretstreamFrames(envelope.framedCiphertext);

    const reordered = cloneStream(envelope, {
      framedCiphertext: frameCiphertext([frames[1], frames[0], ...frames.slice(2)]),
    });
    await assert.rejects(() => decryptSecretstream(reordered, KEY, streamAad()), /ENVELOPE_AUTHENTICATION_FAILED/);

    const duplicatedFrames = [frames[0], frames[0], ...frames.slice(1)];
    const duplicated = cloneStream(envelope, {
      framedCiphertext: frameCiphertext(duplicatedFrames),
      chunkCount: duplicatedFrames.length,
      plaintextByteSize: envelope.plaintextByteSize + 4,
    });
    await assert.rejects(() => decryptSecretstream(duplicated, KEY, streamAad()), /ENVELOPE_AUTHENTICATION_FAILED/);

    const deletedFrames = [frames[0], ...frames.slice(2)];
    const deleted = cloneStream(envelope, {
      framedCiphertext: frameCiphertext(deletedFrames),
      chunkCount: deletedFrames.length,
      plaintextByteSize: envelope.plaintextByteSize - 4,
    });
    await assert.rejects(() => decryptSecretstream(deleted, KEY, streamAad()), /ENVELOPE_AUTHENTICATION_FAILED/);

    const insertedFrames = [frames[0], Uint8Array.from(frames[1]), ...frames.slice(1)];
    insertedFrames[1][5] ^= 2;
    const inserted = cloneStream(envelope, {
      framedCiphertext: frameCiphertext(insertedFrames),
      chunkCount: insertedFrames.length,
      plaintextByteSize: envelope.plaintextByteSize + 4,
    });
    await assert.rejects(() => decryptSecretstream(inserted, KEY, streamAad()), /ENVELOPE_AUTHENTICATION_FAILED/);

    const truncated = cloneStream(envelope, { framedCiphertext: envelope.framedCiphertext.subarray(0, envelope.framedCiphertext.byteLength - 1) });
    await assert.rejects(() => decryptSecretstream(truncated, KEY, streamAad()), /SECRETSTREAM_FRAMING_INVALID/);

    const withoutFinalFrames = frames.slice(0, -1);
    const withoutFinal = cloneStream(envelope, {
      framedCiphertext: frameCiphertext(withoutFinalFrames),
      chunkCount: withoutFinalFrames.length,
      plaintextByteSize: envelope.plaintextByteSize - 4,
    });
    await assert.rejects(() => decryptSecretstream(withoutFinal, KEY, streamAad()), /ENVELOPE_AUTHENTICATION_FAILED/);

    const afterFinalFrames = [...frames, frames[0]];
    const afterFinal = cloneStream(envelope, {
      framedCiphertext: frameCiphertext(afterFinalFrames),
      chunkCount: afterFinalFrames.length,
      plaintextByteSize: envelope.plaintextByteSize + 4,
    });
    await assert.rejects(() => decryptSecretstream(afterFinal, KEY, streamAad()), /ENVELOPE_AUTHENTICATION_FAILED/);
  });

  it("binds chunk count, chunk size, plaintext size, algorithm, and version", async () => {
    const envelope = await encryptSecretstream(Buffer.from("abcdefghijk"), KEY, streamAad(), { chunkSize: 3 });
    await assert.rejects(() => decryptSecretstream(cloneStream(envelope, { chunkCount: 3 }), KEY, streamAad()), /SECRETSTREAM_CHUNK_COUNT_MISMATCH/);
    await assert.rejects(() => decryptSecretstream(cloneStream(envelope, { chunkSize: 4 }), KEY, streamAad()), /SECRETSTREAM_CHUNK_INVALID/);
    await assert.rejects(() => decryptSecretstream(cloneStream(envelope, { plaintextByteSize: 10 }), KEY, streamAad()), /SECRETSTREAM_PLAINTEXT_SIZE_INVALID/);
    await assert.rejects(
      () => decryptSecretstream(cloneStream(envelope, { envelopeVersion: 2 as 1 }), KEY, streamAad()),
      /ENVELOPE_VERSION_UNSUPPORTED/,
    );
  });

  it("rejects genuine cross-construction presentation", async () => {
    const stream = await encryptSecretstream(Buffer.from("stream attack"), KEY, streamAad(), { chunkSize: 6 });
    const streamFrames = parseSecretstreamFrames(stream.framedCiphertext);
    const forgedOneShot: OneShotEnvelope = {
      algorithm: ONE_SHOT_ALGORITHM,
      envelopeVersion: ENCRYPTED_CONTENT_VERSION,
      nonce: stream.header,
      ciphertext: streamFrames[0],
    };
    await assert.rejects(
      () => decryptOneShot(forgedOneShot, KEY, oneShotAad()),
      /ENVELOPE_AUTHENTICATION_FAILED/,
    );

    const oneShot = await encryptOneShot(Buffer.from("one-shot attack"), KEY, oneShotAad());
    const forgedStream: SecretstreamEnvelope = {
      algorithm: SECRETSTREAM_ALGORITHM,
      envelopeVersion: ENCRYPTED_CONTENT_VERSION,
      header: oneShot.nonce,
      framedCiphertext: frameCiphertext([oneShot.ciphertext]),
      chunkCount: 1,
      chunkSize: oneShot.ciphertext.byteLength - 17,
      plaintextByteSize: oneShot.ciphertext.byteLength - 17,
    };
    await assert.rejects(
      () => decryptSecretstream(forgedStream, KEY, streamAad()),
      /ENVELOPE_AUTHENTICATION_FAILED/,
    );
  });
});

describe("key wrapping abstraction and content receipts", () => {
  it("wraps, unwraps, and rewraps without coupling the envelope to a custody backend", async () => {
    const context = {
      reportRef: "report:private:alpha",
      contentId: CONTENT_ID,
      algorithm: ONE_SHOT_ALGORITHM,
      envelopeVersion: ENCRYPTED_CONTENT_VERSION,
    };
    const current = new TestOnlyAuthenticatedKeyWrapper("test:old", 1, Buffer.alloc(32, 7));
    const next = new TestOnlyAuthenticatedKeyWrapper("test:new", 2, Buffer.alloc(32, 9));
    const wrapped = await current.wrap(KEY, context);
    assert.deepEqual(await current.unwrap(wrapped, context), KEY);
    const rewrapped = await rewrapDataEncryptionKey(wrapped, current, next, context);
    assert.deepEqual(await next.unwrap(rewrapped, context), KEY);
    await assert.rejects(() => current.unwrap(wrapped, { ...context, reportRef: "report:private:other" }), /WRAPPED_DEK_AUTHENTICATION_FAILED/);
    await assert.rejects(
      () => rewrapDataEncryptionKey({ ...wrapped, keyId: "test:wrong" }, current, next, context),
      /KEY_WRAPPER_MISMATCH/,
    );
    await assert.rejects(
      () => current.unwrap({ ...wrapped, wrapperType: "TEST_ONLY_OTHER" }, context),
      /KEY_WRAPPER_MISMATCH/,
    );
    await assert.rejects(
      () => current.unwrap({ ...wrapped, keyVersion: 2 }, context),
      /KEY_WRAPPER_MISMATCH/,
    );
    const tamperedWrappedDek = `${wrapped.wrappedDek.slice(0, -1)}${wrapped.wrappedDek.endsWith("A") ? "B" : "A"}`;
    await assert.rejects(
      () => current.unwrap({ ...wrapped, wrappedDek: tamperedWrappedDek }, context),
      /WRAPPED_DEK_(INVALID|AUTHENTICATION_FAILED)/,
    );
  });

  it("refuses an unrecoverable rewrap result and malformed wrapper context", async () => {
    const context = {
      reportRef: "report:private:alpha",
      contentId: CONTENT_ID,
      algorithm: ONE_SHOT_ALGORITHM,
      envelopeVersion: ENCRYPTED_CONTENT_VERSION,
    };
    const current = new TestOnlyAuthenticatedKeyWrapper("test:old", 1, Buffer.alloc(32, 7));
    const wrapped = await current.wrap(KEY, context);
    const broken = {
      wrapperType: "TEST_ONLY_BROKEN",
      keyId: "test:broken",
      keyVersion: 2,
      async wrap() {
        return {
          wrapperType: this.wrapperType,
          keyId: this.keyId,
          keyVersion: this.keyVersion,
          wrappedDek: "not-recoverable",
        };
      },
      async unwrap() {
        throw new Error("cannot recover");
      },
    };
    await assert.rejects(
      () => rewrapDataEncryptionKey(wrapped, current, broken, context),
      /cannot recover|WRAPPED_DEK_RECOVERY_FAILED/,
    );
    await assert.rejects(
      () => rewrapDataEncryptionKey(wrapped, current, broken, { ...context, contentId: "not-canonical" }),
      /CONTENT_ID_INVALID/,
    );
  });

  it("zeroes an invalid unwrapped DEK before failing rewrap", async () => {
    const context = {
      reportRef: "report:private:alpha",
      contentId: CONTENT_ID,
      algorithm: ONE_SHOT_ALGORITHM,
      envelopeVersion: ENCRYPTED_CONTENT_VERSION,
    };
    const invalidDek = Uint8Array.from([1, 2, 3, 4]);
    const current = {
      wrapperType: "TEST_ONLY_SHORT",
      keyId: "test:short",
      keyVersion: 1,
      async wrap() { throw new Error("unused"); },
      async unwrap() { return invalidDek; },
    };
    const next = new TestOnlyAuthenticatedKeyWrapper("test:next", 2, Buffer.alloc(32, 9));
    await assert.rejects(
      () => rewrapDataEncryptionKey(
        { wrapperType: current.wrapperType, keyId: current.keyId, keyVersion: current.keyVersion, wrappedDek: "x" },
        current,
        next,
        context,
      ),
      /DEK_INVALID/,
    );
    assert.deepEqual(invalidDek, Uint8Array.from([0, 0, 0, 0]));
  });

  it("uses stable descriptor snapshots during rewrap", async () => {
    const context = {
      reportRef: "report:private:alpha",
      contentId: CONTENT_ID,
      algorithm: ONE_SHOT_ALGORITHM,
      envelopeVersion: ENCRYPTED_CONTENT_VERSION,
    };
    const current = new TestOnlyAuthenticatedKeyWrapper("test:old", 1, Buffer.alloc(32, 7));
    const next = new TestOnlyAuthenticatedKeyWrapper("test:new", 2, Buffer.alloc(32, 9));
    const wrapped = await current.wrap(KEY, context);
    let wrapperTypeReads = 0;
    const getterBacked = {
      ...wrapped,
      get wrapperType() {
        wrapperTypeReads += 1;
        return wrapperTypeReads === 1 ? wrapped.wrapperType : "FORGED_AFTER_VALIDATION";
      },
    };
    const rewrapped = await rewrapDataEncryptionKey(getterBacked, current, next, context);
    assert.equal(wrapperTypeReads, 1);
    assert.equal(rewrapped.wrapperType, next.wrapperType);
    assert.deepEqual(await next.unwrap(rewrapped, context), KEY);

    let returnedTypeReads = 0;
    const flippingNext = {
      ...next,
      wrapperType: next.wrapperType,
      keyId: next.keyId,
      keyVersion: next.keyVersion,
      async wrap(dek: Uint8Array, wrapperContext: typeof context) {
        const stable = await next.wrap(dek, wrapperContext);
        return {
          ...stable,
          get wrapperType() {
            returnedTypeReads += 1;
            return returnedTypeReads === 1 ? stable.wrapperType : "FORGED_AFTER_VALIDATION";
          },
        };
      },
      async unwrap(descriptor: typeof wrapped, wrapperContext: typeof context) {
        return next.unwrap(descriptor, wrapperContext);
      },
    };
    const stableResult = await rewrapDataEncryptionKey(wrapped, current, flippingNext, context);
    assert.equal(returnedTypeReads, 1);
    assert.equal(stableResult.wrapperType, next.wrapperType);
  });

  it("binds versioned receipts to report identity without publishing a plaintext hash", () => {
    const receiptKey = Buffer.alloc(32, 4);
    const plaintext = Buffer.from("same bytes");
    const first = computeContentReceipt(plaintext, "report:one", receiptKey, 3);
    const second = computeContentReceipt(plaintext, "report:two", receiptKey, 3);
    const receiptKeys = new Map([[3, receiptKey]]);
    assert.match(first, /^HMAC_SHA256_V1:3:[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, second);
    assert.equal(verifyContentReceipt(first, plaintext, "report:one", receiptKeys), true);
    assert.equal(verifyContentReceipt(first, Buffer.from("different"), "report:one", receiptKeys), false);
    assert.throws(() => verifyContentReceipt("SHA256:3:bad", plaintext, "report:one", receiptKeys), /CONTENT_RECEIPT_INVALID/);
  });

  it("authenticates the receipt-key version rather than trusting its label", () => {
    const receiptKey = Buffer.alloc(32, 4);
    const plaintext = Buffer.from("same bytes");
    const receipt = computeContentReceipt(plaintext, "report:one", receiptKey, 1);
    const relabelled = receipt.replace(":1:", ":2:");
    assert.equal(verifyContentReceipt(relabelled, plaintext, "report:one", new Map([[1, receiptKey], [2, receiptKey]])), false);
    assert.notEqual(
      computeContentReceipt(plaintext, "report:one", receiptKey, 1).split(":")[2],
      computeContentReceipt(plaintext, "report:one", receiptKey, 2).split(":")[2],
    );
    const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const lastCharacterIndex = base64urlAlphabet.indexOf(receipt.at(-1)!);
    assert.equal(lastCharacterIndex % 4, 0);
    const nonCanonicalMac = `${receipt.slice(0, -1)}${base64urlAlphabet[lastCharacterIndex + 1]}`;
    assert.deepEqual(
      Buffer.from(nonCanonicalMac.split(":")[2], "base64url"),
      Buffer.from(receipt.split(":")[2], "base64url"),
    );
    assert.throws(
      () => verifyContentReceipt(nonCanonicalMac, plaintext, "report:one", new Map([[1, receiptKey]])),
      /CONTENT_RECEIPT_INVALID/,
    );
  });

  it("pins the versioned content-receipt encoding", () => {
    assert.equal(
      computeContentReceipt(Buffer.from("golden private report"), "report:private:alpha", Buffer.alloc(32, 4), 7),
      "HMAC_SHA256_V1:7:WT3PIfPHqlHLATYV7xgBxNMvZtC2C8PI2ZxQ_jQkveY",
    );
  });

  it("makes only a best-effort zeroing claim for controlled byte arrays", () => {
    const controlled = Uint8Array.from([1, 2, 3, 4]);
    bestEffortZero(controlled);
    assert.deepEqual(controlled, Uint8Array.from([0, 0, 0, 0]));
  });
});
