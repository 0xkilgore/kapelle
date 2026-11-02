import {assertPrivateBinding,type PrivatePublicationBinding} from './private-publication.ts';
import {parsePublicationMetadata, type PublicationMetadata} from './publication-metadata.ts';
import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { BigIntStats } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import type { ReportRegistryMcp } from "./mcp-client.ts";
import {
  LIVE_PROMOTION_CONFIRMATION,
  promoteReport,
  type LiveAttention,
  type LiveProducerKind,
  type PromoteReportInput,
  type PromotionReceipt,
} from "./promote.ts";

export const PROMOTION_REQUEST_SCHEMA_VERSION = "report-promotion-request.v2" as const;

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_MARKDOWN_BYTES = 256 * 1024;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const URI_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//;

type PromotionAttention = {
  request: LiveAttention;
  reasonCode?: string | null;
  reason?: string | null;
  reviewBy?: string | null;
  expiresAt?: string | null;
};

export type PromotionRequest = {
  publication?: PublicationMetadata;
  schemaVersion: typeof PROMOTION_REQUEST_SCHEMA_VERSION;
  contentPath: string;
  title: string;
  reportRef: string;
  sourceRef: string;
  expectedContentHash: string;
  expectedByteSize: number;
  projectRef?: string | null;
  familyRef?: string | null;
  producer: {
    kind: LiveProducerKind;
    id: string;
    label?: string | null;
  };
  attention: PromotionAttention;
  occurredAt?: string;
};

export type PromotionRequestPlan = {
  publication?: PublicationMetadata;
  schemaVersion: "report-promotion-plan.v2";
  planDigest: string;
  title: string;
  reportRef: string;
  sourceRef: string;
  projectRef: string | null;
  familyRef: string | null;
  producer: { kind: LiveProducerKind; id: string; label: string | null };
  attention: {
    request: LiveAttention;
    reasonCode: string | null;
    reason: string | null;
    reviewBy: string | null;
    expiresAt: string | null;
  };
  occurredAt: string | null;
  content: {
    filename: string;
    contentHash: string;
    byteSize: number;
  };
};

export type AdmittedPromotionRequest = {
  request: PromotionRequest;
  content: {
    filename: string;
    bytes: Buffer;
    contentHash: string;
    byteSize: number;
  };
};

export type PromotionRequestRuntime = {
  publicationBinding?: PrivatePublicationBinding;
  confirmation: string;
  planDigest: string;
  driveId: string;
  receiptDir: string;
  lockDir: string;
  actorId: string;
};

type UnknownRecord = Record<string, unknown>;

export function loadPromotionRequest(requestPath: string, allowedRoot: string): AdmittedPromotionRequest {
  const requestBytes = readBoundedUtf8File(requestPath, MAX_REQUEST_BYTES, "REQUEST");
  let decoded: unknown;
  try {
    decoded = JSON.parse(requestBytes.text);
  } catch {
    throw new Error("PROMOTION_REQUEST_JSON_INVALID");
  }
  const request = parsePromotionRequest(decoded);
  const content = admitMarkdownFile(request.contentPath, allowedRoot);
  if (content.contentHash !== request.expectedContentHash || content.byteSize !== request.expectedByteSize) {
    throw new Error("PROMOTION_REQUEST_CONTENT_RECEIPT_MISMATCH");
  }
  return { request, content };
}

export function buildPromotionRequestPlan(admitted: AdmittedPromotionRequest): PromotionRequestPlan {
  const { request, content } = validateAdmittedPromotionRequest(admitted);
  const planWithoutDigest = {
    ...(request.publication ? {publication: request.publication} : {}),
    schemaVersion: "report-promotion-plan.v2" as const,
    title: request.title,
    reportRef: request.reportRef,
    sourceRef: request.sourceRef,
    projectRef: request.projectRef ?? null,
    familyRef: request.familyRef ?? null,
    producer: {
      kind: request.producer.kind,
      id: request.producer.id,
      label: request.producer.label ?? null,
    },
    attention: {
      request: request.attention.request,
      reasonCode: request.attention.reasonCode ?? null,
      reason: request.attention.reason ?? null,
      reviewBy: request.attention.reviewBy ?? null,
      expiresAt: request.attention.expiresAt ?? null,
    },
    occurredAt: request.occurredAt ?? null,
    content: {
      filename: content.filename,
      contentHash: content.contentHash,
      byteSize: content.byteSize,
    },
  };
  return {
    ...planWithoutDigest,
    planDigest: createHash("sha256").update(JSON.stringify(planWithoutDigest)).digest("hex"),
  };
}

export async function promotePromotionRequest(
  admitted: AdmittedPromotionRequest,
  runtime: PromotionRequestRuntime,
  mcp: ReportRegistryMcp,
): Promise<PromotionReceipt> {
  if (runtime.confirmation !== LIVE_PROMOTION_CONFIRMATION) {
    throw new Error(`PROMOTION_CONFIRMATION_REQUIRED: --confirm ${LIVE_PROMOTION_CONFIRMATION}`);
  }
  const normalized = validateAdmittedPromotionRequest(admitted);
  if(normalized.request.publication){
    if(!runtime.publicationBinding)throw Error("PRIVATE_PUBLICATION_BINDING_REQUIRED");
    assertPrivateBinding(normalized,runtime,runtime.publicationBinding);
  }
  const expectedPlanDigest = buildPromotionRequestPlan(normalized).planDigest;
  if (!/^[a-f0-9]{64}$/.test(runtime.planDigest) || runtime.planDigest !== expectedPlanDigest) {
    throw new Error("PROMOTION_PLAN_DIGEST_MISMATCH");
  }
  const stagingRoot = mkdtempSync(join(tmpdir(), "report-promotion-request-"));
  chmodSync(stagingRoot, 0o700);
  const stagedFile = join(stagingRoot, normalized.content.filename);
  try {
    writeFileSync(stagedFile, normalized.content.bytes, { flag: "wx", mode: 0o600 });
    const input = toPromoteReportInput(normalized, runtime, stagedFile);
    return await promoteReport(input, mcp);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function validateAdmittedPromotionRequest(admitted: AdmittedPromotionRequest): AdmittedPromotionRequest {
  const request = parsePromotionRequest(admitted.request);
  const content = admitted.content;
  if (!content || !Buffer.isBuffer(content.bytes)) throw new Error("PROMOTION_ADMITTED_CONTENT_INVALID");
  if (content.filename !== basename(request.contentPath) || ![".md", ".markdown"].includes(extname(content.filename).toLowerCase())) {
    throw new Error("PROMOTION_ADMITTED_CONTENT_INVALID");
  }
  if (content.bytes.byteLength !== content.byteSize || content.byteSize < 1 || content.byteSize > MAX_MARKDOWN_BYTES) {
    throw new Error("PROMOTION_ADMITTED_CONTENT_INVALID");
  }
  const hash = createHash("sha256").update(content.bytes).digest("hex");
  if (hash !== content.contentHash) throw new Error("PROMOTION_ADMITTED_CONTENT_INVALID");
  if (hash !== request.expectedContentHash || content.byteSize !== request.expectedByteSize) {
    throw new Error("PROMOTION_REQUEST_CONTENT_RECEIPT_MISMATCH");
  }
  const text = decodeUtf8(content.bytes, "PROMOTION_ADMITTED_CONTENT_INVALID");
  if (text.trim().length === 0) throw new Error("PROMOTION_ADMITTED_CONTENT_INVALID");
  return {
    request,
    content: {
      filename: content.filename,
      bytes: Buffer.from(content.bytes),
      contentHash: content.contentHash,
      byteSize: content.byteSize,
    },
  };
}

export function parsePromotionRequest(value: unknown): PromotionRequest {
  const root = record(value, "PROMOTION_REQUEST_INVALID");
  exactKeys(root, [
    "schemaVersion",
    "contentPath",
    "title",
    "reportRef",
    "sourceRef",
    "expectedContentHash",
    "expectedByteSize",
    "projectRef",
    "familyRef",
    "producer",
    "attention",
    "occurredAt",
    "publication",
  ], "PROMOTION_REQUEST_UNKNOWN_FIELD");
  if (root.schemaVersion !== PROMOTION_REQUEST_SCHEMA_VERSION) {
    throw new Error("PROMOTION_REQUEST_SCHEMA_UNSUPPORTED");
  }

  const producerRecord = record(root.producer, "PROMOTION_REQUEST_PRODUCER_INVALID");
  exactKeys(producerRecord, ["kind", "id", "label"], "PROMOTION_REQUEST_PRODUCER_UNKNOWN_FIELD");
  const kind = boundedText(producerRecord.kind, "producer.kind", 32) as LiveProducerKind;
  if (!["HUMAN", "AGENT", "SERVICE", "IMPORT"].includes(kind)) {
    throw new Error("PROMOTION_REQUEST_PRODUCER_KIND_INVALID");
  }

  const attentionRecord = record(root.attention, "PROMOTION_REQUEST_ATTENTION_INVALID");
  exactKeys(attentionRecord, ["request", "reasonCode", "reason", "reviewBy", "expiresAt"], "PROMOTION_REQUEST_ATTENTION_UNKNOWN_FIELD");
  const attentionRequest = boundedText(attentionRecord.request, "attention.request", 32) as LiveAttention;
  if (!["NONE", "READ", "ANSWER", "DECIDE", "APPROVE", "REQUEST_CHANGE"].includes(attentionRequest)) {
    throw new Error("PROMOTION_REQUEST_ATTENTION_KIND_INVALID");
  }
  const reasonCode = optionalText(attentionRecord.reasonCode, "attention.reasonCode", 500);
  const reason = optionalText(attentionRecord.reason, "attention.reason", 2_000);
  const reviewBy = optionalIso(attentionRecord.reviewBy, "attention.reviewBy");
  const expiresAt = optionalIso(attentionRecord.expiresAt, "attention.expiresAt");
  if (attentionRequest === "NONE" && [reasonCode, reason, reviewBy, expiresAt].some((entry) => entry !== null)) {
    throw new Error("PROMOTION_REQUEST_ATTENTION_METADATA_WITHOUT_REQUEST");
  }

  const contentPath = boundedText(root.contentPath, "contentPath", 4_000);
  if (!isAbsolute(contentPath)) throw new Error("PROMOTION_REQUEST_CONTENT_PATH_NOT_ABSOLUTE");
  const sourceRef = boundedText(root.sourceRef, "sourceRef", 4_000);
  const dispatchSource = /^dispatch:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sourceRef);
  if ((!URI_SCHEME_PATTERN.test(sourceRef) && !dispatchSource) || sourceRef.startsWith("file://")) {
    throw new Error("PROMOTION_REQUEST_SOURCE_REF_INVALID");
  }
  const occurredAt = root.occurredAt === undefined ? undefined : strictIso(root.occurredAt, "occurredAt");
  const expectedContentHash = boundedText(root.expectedContentHash, "expectedContentHash", 64);
  if (!/^[a-f0-9]{64}$/.test(expectedContentHash)) {
    throw new Error("PROMOTION_REQUEST_CONTENT_HASH_INVALID");
  }
  if (!Number.isSafeInteger(root.expectedByteSize) || Number(root.expectedByteSize) < 1 || Number(root.expectedByteSize) > MAX_MARKDOWN_BYTES) {
    throw new Error("PROMOTION_REQUEST_CONTENT_SIZE_INVALID");
  }

  const publication = root.publication === undefined ? undefined : parsePublicationMetadata(root.publication);
  if (publication && (kind!=="AGENT" || publication.contentHash !== expectedContentHash || publication.sourceRef !== sourceRef || publication.publishedAt !== occurredAt || publication.author.id !== producerRecord.id)) throw new Error("PUBLICATION_REQUEST_BINDING_MISMATCH");
  return {
    ...(publication ? {publication} : {}),
    schemaVersion: PROMOTION_REQUEST_SCHEMA_VERSION,
    contentPath,
    title: boundedText(root.title, "title", 500),
    reportRef: stableRef(root.reportRef, "reportRef", 1_000),
    sourceRef,
    expectedContentHash,
    expectedByteSize: Number(root.expectedByteSize),
    projectRef: optionalText(root.projectRef, "projectRef", 1_000),
    familyRef: optionalText(root.familyRef, "familyRef", 1_000),
    producer: {
      kind,
      id: boundedText(producerRecord.id, "producer.id", 500),
      label: optionalText(producerRecord.label, "producer.label", 500),
    },
    attention: {
      request: attentionRequest,
      reasonCode,
      reason,
      reviewBy,
      expiresAt,
    },
    occurredAt,
  };
}

export function toPromoteReportInput(
  admitted: AdmittedPromotionRequest,
  runtime: PromotionRequestRuntime,
  stagedFile: string,
): PromoteReportInput {
  const request = admitted.request;
  return {
    ...(request.publication ? {publication: request.publication,publicationPlanDigest:buildPromotionRequestPlan(admitted).planDigest} : {}),
    confirmation: runtime.confirmation,
    driveId: runtime.driveId,
    file: stagedFile,
    title: request.title,
    reportRef: request.reportRef,
    sourceRef: request.sourceRef,
    projectRef: request.projectRef ?? null,
    familyRef: request.familyRef ?? null,
    producer: request.producer,
    attention: request.attention.request,
    reasonCode: request.attention.reasonCode ?? null,
    reason: request.attention.reason ?? null,
    reviewBy: request.attention.reviewBy ?? null,
    expiresAt: request.attention.expiresAt ?? null,
    actorId: runtime.actorId,
    occurredAt: request.occurredAt,
    receiptDir: runtime.receiptDir,
    lockDir: runtime.lockDir,
    expectedContentHash: admitted.content.contentHash,
    expectedByteSize: admitted.content.byteSize,
  };
}

function admitMarkdownFile(contentPath: string, allowedRoot: string): AdmittedPromotionRequest["content"] {
  if (!isAbsolute(allowedRoot)) throw new Error("PROMOTION_ALLOWED_ROOT_NOT_ABSOLUTE");
  const resolvedRoot = resolve(allowedRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(resolvedRoot);
  } catch {
    throw new Error("PROMOTION_ALLOWED_ROOT_INVALID");
  }
  if (canonicalRoot !== allowedRoot) throw new Error("PROMOTION_ALLOWED_ROOT_NOT_CANONICAL");
  const rootStat = lstatSync(canonicalRoot, { bigint: true });
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("PROMOTION_ALLOWED_ROOT_INVALID");

  let rootDescriptor: number | undefined;
  try {
    rootDescriptor = openSync(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const openedRoot = fstatSync(rootDescriptor, { bigint: true });
    if (!openedRoot.isDirectory() || openedRoot.dev !== rootStat.dev || openedRoot.ino !== rootStat.ino) {
      throw new Error("PROMOTION_ALLOWED_ROOT_IDENTITY_CHANGED");
    }
    return admitMarkdownFileWithinOpenedRoot(contentPath, canonicalRoot, openedRoot);
  } finally {
    if (rootDescriptor !== undefined) closeSync(rootDescriptor);
  }
}

function admitMarkdownFileWithinOpenedRoot(
  contentPath: string,
  canonicalRoot: string,
  openedRoot: BigIntStats,
): AdmittedPromotionRequest["content"] {

  let canonicalContent: string;
  try {
    canonicalContent = realpathSync.native(contentPath);
  } catch {
    throw new Error("PROMOTION_CONTENT_FILE_INVALID");
  }
  if (canonicalContent !== contentPath) throw new Error("PROMOTION_CONTENT_PATH_NOT_CANONICAL");
  const fromRoot = relative(canonicalRoot, canonicalContent);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("PROMOTION_CONTENT_OUTSIDE_ALLOWED_ROOT");
  }
  const extension = extname(canonicalContent).toLowerCase();
  if (![".md", ".markdown"].includes(extension)) throw new Error("PROMOTION_CONTENT_TYPE_UNSUPPORTED");

  const pathStat = lstatSync(canonicalContent, { bigint: true });
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1n) {
    throw new Error("PROMOTION_CONTENT_NOT_SAFE_REGULAR_FILE");
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(canonicalContent, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (!openedBefore.isFile() || openedBefore.nlink !== 1n || openedBefore.dev !== pathStat.dev || openedBefore.ino !== pathStat.ino) {
      throw new Error("PROMOTION_CONTENT_IDENTITY_CHANGED");
    }
    if (openedBefore.size < 1n) throw new Error("PROMOTION_CONTENT_EMPTY");
    if (openedBefore.size > BigInt(MAX_MARKDOWN_BYTES)) throw new Error("PROMOTION_CONTENT_TOO_LARGE");
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    if (
      openedAfter.dev !== openedBefore.dev
      || openedAfter.ino !== openedBefore.ino
      || openedAfter.size !== openedBefore.size
      || openedAfter.mtimeNs !== openedBefore.mtimeNs
      || openedAfter.ctimeNs !== openedBefore.ctimeNs
      || bytes.byteLength !== Number(openedBefore.size)
    ) {
      throw new Error("PROMOTION_CONTENT_CHANGED_DURING_READ");
    }
    const rootAfter = lstatSync(canonicalRoot, { bigint: true });
    if (!rootAfter.isDirectory() || rootAfter.dev !== openedRoot.dev || rootAfter.ino !== openedRoot.ino) {
      throw new Error("PROMOTION_ALLOWED_ROOT_IDENTITY_CHANGED");
    }
    const pathAfter = lstatSync(canonicalContent, { bigint: true });
    if (!pathAfter.isFile() || pathAfter.dev !== openedBefore.dev || pathAfter.ino !== openedBefore.ino) {
      throw new Error("PROMOTION_CONTENT_IDENTITY_CHANGED");
    }
    const text = decodeUtf8(bytes, "PROMOTION_CONTENT_ENCODING_INVALID");
    if (text.trim().length === 0) throw new Error("PROMOTION_CONTENT_EMPTY");
    return {
      filename: basename(canonicalContent),
      bytes,
      contentHash: createHash("sha256").update(bytes).digest("hex"),
      byteSize: bytes.byteLength,
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readBoundedUtf8File(path: string, maxBytes: number, prefix: string): { text: string; bytes: Buffer } {
  let pathStat: BigIntStats;
  try {
    pathStat = lstatSync(path, { bigint: true });
  } catch {
    throw new Error(`${prefix}_FILE_INVALID`);
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink !== 1n) throw new Error(`${prefix}_FILE_INVALID`);
  if (pathStat.size === 0n) throw new Error(`${prefix}_FILE_EMPTY`);
  if (pathStat.size > BigInt(maxBytes)) throw new Error(`${prefix}_FILE_TOO_LARGE`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (openedBefore.dev !== pathStat.dev || openedBefore.ino !== pathStat.ino || !openedBefore.isFile()) {
      throw new Error(`${prefix}_FILE_IDENTITY_CHANGED`);
    }
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    if (
      openedAfter.dev !== openedBefore.dev
      || openedAfter.ino !== openedBefore.ino
      || openedAfter.size !== openedBefore.size
      || openedAfter.mtimeNs !== openedBefore.mtimeNs
      || openedAfter.ctimeNs !== openedBefore.ctimeNs
      || bytes.byteLength !== Number(openedBefore.size)
    ) {
      throw new Error(`${prefix}_FILE_CHANGED_DURING_READ`);
    }
    return { text: decodeUtf8(bytes, `${prefix}_ENCODING_INVALID`), bytes };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function decodeUtf8(bytes: Buffer, errorCode: string): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(errorCode);
  }
  if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error(errorCode);
  return text;
}

function record(value: unknown, errorCode: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(errorCode);
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, allowed: readonly string[], errorCode: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(errorCode);
}

function boundedText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`PROMOTION_REQUEST_FIELD_INVALID: ${field}`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`PROMOTION_REQUEST_FIELD_INVALID: ${field}`);
  }
  return value;
}

function stableRef(value: unknown, field: string, maxBytes: number): string {
  const ref = boundedText(value, field, maxBytes);
  if (!ref.includes(":")) throw new Error(`PROMOTION_REQUEST_FIELD_INVALID: ${field}`);
  return ref;
}

function optionalText(value: unknown, field: string, maxBytes: number): string | null {
  if (value === undefined || value === null) return null;
  return boundedText(value, field, maxBytes);
}

function optionalIso(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return strictIso(value, field);
}

function strictIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_UTC_PATTERN.test(value)) {
    throw new Error(`PROMOTION_REQUEST_FIELD_INVALID: ${field}`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`PROMOTION_REQUEST_FIELD_INVALID: ${field}`);
  }
  return value;
}
