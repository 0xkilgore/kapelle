import { createHmac } from "node:crypto";
import {
  EncryptedContentError,
  type KeyWrapper,
  type KeyWrapperContext,
  type WrappedKeyDescriptor,
} from "../../src/encrypted-content-v1.ts";

function contextBytes(context: KeyWrapperContext): Buffer {
  return Buffer.from(JSON.stringify([
    context.reportRef,
    context.contentId,
    context.algorithm,
    context.envelopeVersion,
  ]), "utf8");
}

export class TestOnlyAuthenticatedKeyWrapper implements KeyWrapper {
  readonly wrapperType = "TEST_ONLY_HMAC_XOR_V1";
  readonly keyId: string;
  readonly keyVersion: number;
  private readonly wrappingKey: Uint8Array;

  constructor(
    keyId: string,
    keyVersion: number,
    wrappingKey: Uint8Array,
  ) {
    if (wrappingKey.byteLength !== 32) throw new Error("test wrapping key must be 32 bytes");
    this.keyId = keyId;
    this.keyVersion = keyVersion;
    this.wrappingKey = Uint8Array.from(wrappingKey);
  }

  async wrap(dek: Uint8Array, context: KeyWrapperContext): Promise<WrappedKeyDescriptor> {
    if (dek.byteLength !== 32) throw new EncryptedContentError("DEK_INVALID");
    const mask = createHmac("sha256", this.wrappingKey).update("mask").update(contextBytes(context)).digest();
    const encrypted = Buffer.from(dek.map((byte, index) => byte ^ mask[index]));
    const mac = createHmac("sha256", this.wrappingKey)
      .update("mac")
      .update(contextBytes(context))
      .update(encrypted)
      .digest();
    return {
      wrapperType: this.wrapperType,
      keyId: this.keyId,
      keyVersion: this.keyVersion,
      wrappedDek: Buffer.concat([encrypted, mac]).toString("base64url"),
    };
  }

  async unwrap(descriptor: WrappedKeyDescriptor, context: KeyWrapperContext): Promise<Uint8Array> {
    if (
      descriptor.wrapperType !== this.wrapperType ||
      descriptor.keyId !== this.keyId ||
      descriptor.keyVersion !== this.keyVersion
    ) {
      throw new EncryptedContentError("KEY_WRAPPER_MISMATCH");
    }
    const payload = Buffer.from(descriptor.wrappedDek, "base64url");
    if (payload.byteLength !== 64 || payload.toString("base64url") !== descriptor.wrappedDek) {
      throw new EncryptedContentError("WRAPPED_DEK_INVALID");
    }
    const encrypted = payload.subarray(0, 32);
    const actualMac = payload.subarray(32);
    const expectedMac = createHmac("sha256", this.wrappingKey)
      .update("mac")
      .update(contextBytes(context))
      .update(encrypted)
      .digest();
    if (!actualMac.equals(expectedMac)) throw new EncryptedContentError("WRAPPED_DEK_AUTHENTICATION_FAILED");
    const mask = createHmac("sha256", this.wrappingKey).update("mask").update(contextBytes(context)).digest();
    return Uint8Array.from(encrypted.map((byte, index) => byte ^ mask[index]));
  }
}
