import {parsePublicationMetadata, type PublicationMetadata} from './publication-metadata.ts';
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import type { ReportRegistryMcp } from "./mcp-client.ts";

const CONFIRMATION = "promote-to-live-report-registry";
const MAX_DOCUMENTS = 100;
const MAX_INLINE_MARKDOWN_BYTES = 256 * 1024;

export type LiveAttention = "NONE" | "READ" | "ANSWER" | "DECIDE" | "APPROVE" | "REQUEST_CHANGE";
export type LiveProducerKind = "HUMAN" | "AGENT" | "SERVICE" | "IMPORT";

export type PromoteReportInput = {
  publicationPlanDigest?: string;
  publication?: PublicationMetadata;
  confirmation: string;
  driveId: string;
  file: string;
  title: string;
  reportRef: string;
  sourceRef: string;
  projectRef?: string | null;
  familyRef?: string | null;
  producer: { kind: LiveProducerKind; id: string; label?: string | null };
  attention?: LiveAttention;
  reasonCode?: string | null;
  reason?: string | null;
  reviewBy?: string | null;
  expiresAt?: string | null;
  actorId: string;
  occurredAt?: string;
  receiptDir: string;
  /** Shared owner-only directory for every publisher targeting this Drive. */
  lockDir: string;
  expectedContentHash?: string;
  expectedByteSize?: number;
};

export type PromotionReceipt = {
  publication?: PublicationMetadata;
  schemaVersion: "report-promotion-receipt.v1";
  status: "CREATED" | "RECOVERED" | "ALREADY_REGISTERED";
  reportRef: string;
  documentId: string;
  driveId: string;
  sourceRef: string;
  contentHash: string;
  byteSize: number;
  attention: LiveAttention;
  promotedAt: string;
  receiptPath: string;
};

type LiveDocument = {
  header: { id: string; name: string; documentType: string };
  state: { global: Record<string, unknown> };
};

export async function promoteReport(input: PromoteReportInput, mcp: ReportRegistryMcp): Promise<PromotionReceipt> {
  if (input.confirmation !== CONFIRMATION) {
    throw new Error(`PROMOTION_CONFIRMATION_REQUIRED: --confirm ${CONFIRMATION}`);
  }
  const normalized = normalizeInput(input);
  if(normalized.publication){
    if(!normalized.publicationPlanDigest||! /^[a-f0-9]{64}$/.test(normalized.publicationPlanDigest))throw Error("PRIVATE_PUBLICATION_PLAN_REQUIRED");
    const p=parsePublicationMetadata(normalized.publication);
    if(p.sourceRef!==normalized.sourceRef||p.author.id!==normalized.producer.id||p.publishedAt!==normalized.occurredAt||p.contentHash!==normalized.expectedContentHash)throw Error("PUBLICATION_REQUEST_BINDING_MISMATCH");
  }
  mkdirSync(normalized.receiptDir, { recursive: true, mode: 0o700 });
  chmodSync(normalized.receiptDir, 0o700);
  const lockDirectory = securePublisherLockDirectory(normalized.lockDir);
  // All protocol writers acquire publication identity first, then reportRef.
  // Fail-fast acquisition avoids waiting deadlocks and never removes others' locks.
  const lockPaths = [
    ...(normalized.publication ? [join(lockDirectory, `.publication-lock-${promotionLockKey(normalized.driveId, normalized.publication.publicationId)}`)] : []),
    join(lockDirectory, `.lock-${promotionLockKey(normalized.driveId, normalized.reportRef)}`),
  ];
  const acquired: string[] = [];
  try {
    for (const lockPath of lockPaths) {
      try { mkdirSync(lockPath, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`PROMOTION_LOCKED: inspect stale lock only after confirming no writer is active (${lockPath})`);
        }
        throw error;
      }
      acquired.push(lockPath);
    }
    return await promoteUnlocked(normalized, mcp);
  } finally {
    for (const lockPath of acquired.reverse()) rmdirSync(lockPath);
  }
}

async function promoteUnlocked(normalized: ReturnType<typeof normalizeInput>, mcp: ReportRegistryMcp): Promise<PromotionReceipt> {
  const content = readMarkdownContent(normalized.file);
  assertExpectedContentIdentity(normalized, content);
  if(normalized.publication && existsSync(privateIntentPath(normalized)))readPrivateIntent(privateIntentPath(normalized),normalized);
  const intentName = promotionIntentName(normalized.reportRef);
  const documents = await readDriveDocuments(mcp, normalized.driveId, normalized.publication ? 10_000 : MAX_DOCUMENTS);
  if(normalized.publication){
    const collisions=documents.filter(d=>(d.state.global.publication as PublicationMetadata | undefined)?.publicationId===normalized.publication!.publicationId);
    if(collisions.length>1||collisions.some(d=>d.state.global.reportRef!==normalized.reportRef))throw Error("PUBLICATION_ID_CONFLICT");
  }
  const matching = documents.filter((document) => document.state.global.reportRef === normalized.reportRef);
  if (matching.length > 1) throw new Error("REPORT_REF_DUPLICATED: multiple live documents share this reportRef");
  if (matching.length === 1) {
    const existing = normalized.publication ? asLiveDocument(await mcp.call("getDocument", {id:matching[0].header.id})) : matching[0];
    if(existing.header.id!==matching[0].header.id)throw Error("DOCUMENT_RESPONSE_IDENTITY_MISMATCH");
    assertRegisteredContentMatch(existing, normalized, content);
    if (normalized.attention !== "NONE" && hasBlankAttention(existing)) {
      await mcp.call("addActions", {
        documentId: existing.header.id,
        actions: [requestReviewAction(normalized, registeredRevision(existing))],
      });
      const recovered = asLiveDocument(await mcp.call("getDocument", { id: existing.header.id }));
      assertRegisteredMatch(recovered, normalized, content);
      return writeReceipt(normalized, existing.header.id, content, "RECOVERED");
    }
    assertAttentionMatch(existing, normalized);
    return writeReceipt(normalized, existing.header.id, content, "ALREADY_REGISTERED");
  }

  const pending = documents.filter((document) => document.header.name === intentName && !document.state.global.reportRef);
  if (pending.length > 1) throw new Error("PROMOTION_INTENT_DUPLICATED: multiple blank documents share this intent");
  const recovering = pending.length === 1;
  const privateIntent = normalized.publication ? privateIntentPath(normalized) : null;
  let markCreate: (() => void) | undefined;
  if (privateIntent && !recovering) {
    // Persist possible create before the network write. If the response is lost
    // and the remote intent is not yet visible, never interpret that as absence.
    if (existsSync(privateIntent)) {
      readPrivateIntent(privateIntent,normalized);
      throw new Error("PRIVATE_PUBLICATION_CREATE_UNCERTAIN: retained request intent requires native reconciliation");
    }
    markCreate=()=>{
    const fd=openSync(privateIntent,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
    try {writeFileSync(fd,JSON.stringify({schemaVersion:"private-report-create-intent.v1",driveId:normalized.driveId,reportRef:normalized.reportRef,sourceRef:normalized.sourceRef,publication:normalized.publication,planDigest:normalized.publicationPlanDigest,contentHash:content.hash,phase:"CREATE_ATTEMPTED"})+"\n");fsyncSync(fd);}finally{closeSync(fd);}fsyncDirectory(normalized.receiptDir);
    };
    // Legacy transports retain their conservative early marker. Capable transports
    // run the marker only after membership and local transport preflight.
    if(!mcp.callWithStart){markCreate();markCreate=undefined;}
  }
  if(privateIntent && existsSync(privateIntent))readPrivateIntent(privateIntent,normalized);
  const documentId = recovering ? pending[0].header.id : await createIntentDocument(mcp, normalized.driveId, intentName, markCreate);

  const actions: Array<{ type: string; input: Record<string, unknown>; scope: "global" }> = [{
    type: "REGISTER_REPORT",
    scope: "global",
    input: {
      ...(normalized.publication ? {publication: normalized.publication} : {}),
      id: reportPhid(normalized.reportRef),
      reportRef: normalized.reportRef,
      title: normalized.title,
      projectRef: normalized.projectRef,
      familyRef: normalized.familyRef,
      sourceRef: normalized.sourceRef,
      producer: normalized.producer,
      content: {
        storage: "INLINE_MARKDOWN",
        mimeType: "text/markdown",
        filename: content.filename,
        contentHash: content.hash,
        byteSize: content.byteSize,
        markdown: content.markdown,
        blobRef: null,
      },
      lifecycle: "FINAL",
      occurredAt: normalized.occurredAt,
      actorId: normalized.actorId,
    },
  }];
  if (normalized.attention !== "NONE") {
    actions.push(requestReviewAction(normalized, 1));
  }
  await mcp.call("addActions", { documentId, actions });
  const verified = asLiveDocument(await mcp.call("getDocument", { id: documentId }));
  assertRegisteredMatch(verified, normalized, content);
  return writeReceipt(normalized, documentId, content, recovering ? "RECOVERED" : "CREATED");
}

function normalizeInput(input: PromoteReportInput) {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  requireIso(occurredAt, "occurredAt");
  if (input.reviewBy) requireIso(input.reviewBy, "reviewBy");
  if (input.expiresAt) requireIso(input.expiresAt, "expiresAt");
  if (!["HUMAN", "AGENT", "SERVICE", "IMPORT"].includes(input.producer.kind)) {
    throw new Error("PRODUCER_KIND_INVALID");
  }
  const attention = input.attention ?? "NONE";
  if (!["NONE", "READ", "ANSWER", "DECIDE", "APPROVE", "REQUEST_CHANGE"].includes(attention)) {
    throw new Error("ATTENTION_INVALID");
  }
  if (attention === "NONE" && (input.reasonCode || input.reason || input.reviewBy || input.expiresAt)) {
    throw new Error("ATTENTION_METADATA_WITHOUT_REQUEST");
  }
  return {
    ...input,
    file: resolve(input.file),
    driveId: text(input.driveId, "driveId", 256),
    title: text(input.title, "title", 500),
    reportRef: text(input.reportRef, "reportRef", 1_000),
    sourceRef: text(input.sourceRef, "sourceRef", 4_000),
    projectRef: optionalText(input.projectRef, "projectRef", 1_000),
    familyRef: optionalText(input.familyRef, "familyRef", 1_000),
    producer: {
      kind: input.producer.kind,
      id: text(input.producer.id, "producer.id", 500),
      label: optionalText(input.producer.label, "producer.label", 500),
    },
    attention,
    reasonCode: optionalText(input.reasonCode, "reasonCode", 500),
    reason: optionalText(input.reason, "reason", 2_000),
    reviewBy: input.reviewBy ?? null,
    expiresAt: input.expiresAt ?? null,
    actorId: text(input.actorId, "actorId", 500),
    occurredAt,
    receiptDir: resolve(input.receiptDir),
    lockDir: typeof input.lockDir === "string" && input.lockDir.trim() === input.lockDir && input.lockDir
      ? resolve(input.lockDir)
      : "",
    expectedContentHash: optionalContentHash(input.expectedContentHash),
    expectedByteSize: optionalByteSize(input.expectedByteSize),
  };
}

function optionalContentHash(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("EXPECTED_CONTENT_IDENTITY_INVALID");
  return value;
}

function optionalByteSize(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_INLINE_MARKDOWN_BYTES) {
    throw new Error("EXPECTED_CONTENT_IDENTITY_INVALID");
  }
  return value;
}

function assertExpectedContentIdentity(
  input: ReturnType<typeof normalizeInput>,
  content: ReturnType<typeof readMarkdownContent>,
): void {
  const hasHash = input.expectedContentHash !== null;
  const hasSize = input.expectedByteSize !== null;
  if (hasHash !== hasSize) throw new Error("EXPECTED_CONTENT_IDENTITY_INVALID");
  if (!hasHash) return;
  if (content.hash !== input.expectedContentHash || content.byteSize !== input.expectedByteSize) {
    throw new Error("EXPECTED_CONTENT_IDENTITY_MISMATCH");
  }
}

function readMarkdownContent(file: string) {
  if (![".md", ".markdown"].includes(extname(file).toLowerCase())) {
    throw new Error("CONTENT_TYPE_UNSUPPORTED: live promotion currently accepts Markdown only");
  }
  const bytes = readFileSync(file);
  if (bytes.byteLength === 0) throw new Error("CONTENT_EMPTY: Markdown must contain text");
  if (bytes.byteLength > MAX_INLINE_MARKDOWN_BYTES) {
    throw new Error(`CONTENT_TOO_LARGE: Markdown exceeds ${MAX_INLINE_MARKDOWN_BYTES} bytes`);
  }
  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("CONTENT_ENCODING_INVALID: Markdown must be valid UTF-8");
  }
  if (markdown.trim().length === 0) throw new Error("CONTENT_EMPTY: Markdown must contain text");
  if (!Buffer.from(markdown, "utf8").equals(bytes)) {
    throw new Error("CONTENT_ENCODING_INVALID: Markdown must round-trip as UTF-8");
  }
  return {
    filename: basename(file),
    markdown,
    hash: createHash("sha256").update(bytes).digest("hex"),
    byteSize: bytes.byteLength,
  };
}

export async function readDriveDocuments(mcp: ReportRegistryMcp, driveId: string, maximum=MAX_DOCUMENTS): Promise<LiveDocument[]> {
  if(maximum>MAX_DOCUMENTS){
    const payload=record(await mcp.call("getReportIdentities",{parentId:driveId}));
    const documentIds=payload.documentIds;
    if(!Array.isArray(documentIds)||documentIds.some(id=>typeof id!=="string")||new Set(documentIds).size!==documentIds.length||!Array.isArray(payload.identities)||payload.identities.length!==documentIds.length||payload.identities.length>maximum)throw Error("PRIVATE_PUBLICATION_IDENTITIES_INCOMPLETE");
    const docs=payload.identities.map(asLiveDocumentIdentity);
    const seen=new Set(docs.map(d=>d.header.id));
    if(seen.size!==documentIds.length||documentIds.some(id=>!seen.has(id)))throw Error("PRIVATE_PUBLICATION_IDENTITIES_INCOMPLETE");
    return docs;
  }
  const listed = record(await mcp.call("getDocuments", { parentId: driveId }));
  const documentIds = listed.documentIds;
  if (!Array.isArray(documentIds) || documentIds.some((id) => typeof id !== "string")) {
    throw new Error("DRIVE_RESPONSE_INVALID: getDocuments omitted documentIds");
  }
  if (documentIds.length > maximum) throw new Error(`DRIVE_SCAN_BOUND_EXCEEDED: more than ${maximum} documents`);
  const documents: LiveDocument[] = [];
  for (let offset=0;offset<documentIds.length;offset+=8) {
    const group=await Promise.all(documentIds.slice(offset,offset+8).map(async id=>{
      const doc=asLiveDocument(await mcp.call("getDocument",{id}));if(doc.header.id!==id)throw Error("DOCUMENT_RESPONSE_IDENTITY_MISMATCH");return doc;
    }));documents.push(...group);
  }
  return documents.filter((document) => document.header.documentType === "kilgore/report");
}

function asLiveDocumentIdentity(value:unknown):LiveDocument {
 const doc=record(value),header=record(doc.header),global=record(record(doc.state).global);
 if(typeof header.id!=="string"||typeof header.name!=="string"||header.documentType!=="kilgore/report"||typeof global.reportRef!=="string"||!Object.hasOwn(global,"publication")||(global.publication!==null&&typeof record(global.publication).publicationId!=="string"))throw Error("PRIVATE_PUBLICATION_IDENTITY_INVALID");
 return doc as LiveDocument;
}

function privateIntentPath(input:ReturnType<typeof normalizeInput>):string {
 return join(input.receiptDir,'.private-create-'+createHash('sha256').update(input.driveId+'\0'+input.reportRef).digest('hex')+'.json');
}
function readPrivateIntent(path:string,input:ReturnType<typeof normalizeInput>) {
 const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||(s.mode&0o077)||s.size>65536)throw Error('PRIVATE_PUBLICATION_INTENT_INVALID');
 const saved=JSON.parse(readFileSync(path,'utf8'));
 if(saved.schemaVersion!=='private-report-create-intent.v1'||saved.driveId!==input.driveId||saved.reportRef!==input.reportRef||saved.sourceRef!==input.sourceRef||saved.planDigest!==input.publicationPlanDigest||JSON.stringify(saved.publication)!==JSON.stringify(input.publication))throw Error('PRIVATE_PUBLICATION_INTENT_CONFLICT');return saved;
}

async function createIntentDocument(mcp: ReportRegistryMcp, driveId: string, name: string, beforeSend?: () => void): Promise<string> {
  const args = { documentType: "kilgore/report", name, driveId };
  const created = record(await (beforeSend ? mcp.callWithStart!("createDocument", args, beforeSend) : mcp.call("createDocument", args)));
  const directId = typeof created.documentId === "string" ? created.documentId : null;
  const document = created.document && typeof created.document === "object" ? created.document as Record<string, unknown> : null;
  const header = document?.header && typeof document.header === "object" ? document.header as Record<string, unknown> : null;
  const nestedId = typeof header?.id === "string" ? header.id : null;
  const id = directId ?? nestedId;
  if (!id) throw new Error("CREATE_RESPONSE_INVALID: createDocument omitted the document id");
  return id;
}

function asLiveDocument(value: unknown): LiveDocument {
  const outer = record(value);
  const raw = outer.document && typeof outer.document === "object" ? record(outer.document) : outer;
  const header = record(raw.header);
  const state = record(raw.state);
  const global = record(state.global);
  if (typeof header.id !== "string" || typeof header.name !== "string" || typeof header.documentType !== "string") {
    throw new Error("DOCUMENT_RESPONSE_INVALID: malformed header");
  }
  return { header: { id: header.id, name: header.name, documentType: header.documentType }, state: { global } };
}

function assertRegisteredMatch(document: LiveDocument, input: ReturnType<typeof normalizeInput>, content: ReturnType<typeof readMarkdownContent>): void {
  assertRegisteredContentMatch(document, input, content);
  assertAttentionMatch(document, input);
}

/** Pure immutable-content verification shared by publication and read-only recovery.
 * Attention is mutable after publication and is deliberately not a completion fact. */
export function verifyRegisteredReport(value: unknown, input: PromoteReportInput, content: {filename:string;markdown:string;hash:string;byteSize:number}) {
  const document=asLiveDocument(value);
  if(document.header.documentType!=='kilgore/report')throw Error('PRIVATE_PUBLICATION_DOCUMENT_TYPE');
  assertRegisteredContentMatch(document,normalizeInput(input),content);
  registeredRevision(document);
  return document;
}

/** True only for a Report from the pre-publication (47-file) Registry model: no publication value. getDocument state omits
 * the key; the proxy's identities projection emits it as null. Both mean "none"; any object (even a wrong one) is NOT legacy. */
export function legacyUnpublished(global: Record<string, unknown>): boolean {
  return global.publication === undefined || global.publication === null;
}

function assertRegisteredContentMatch(document: LiveDocument, input: ReturnType<typeof normalizeInput>, content: ReturnType<typeof readMarkdownContent>): void {
  const state = document.state.global;
  const producer = record(state.producer);
  const descriptor = record(state.content);
  const mismatches: string[] = [];
  compare(mismatches, "reportRef", state.reportRef, input.reportRef);
  compare(mismatches, "title", state.title, input.title);
  compare(mismatches, "projectRef", state.projectRef ?? null, input.projectRef);
  compare(mismatches, "familyRef", state.familyRef ?? null, input.familyRef);
  compare(mismatches, "sourceRef", state.sourceRef, input.sourceRef);
  compare(mismatches, "producer.kind", producer.kind, input.producer.kind);
  compare(mismatches, "producer.id", producer.id, input.producer.id);
  compare(mismatches, "producer.label", producer.label ?? null, input.producer.label);
  compare(mismatches, "content.storage", descriptor.storage, "INLINE_MARKDOWN");
  compare(mismatches, "content.mimeType", descriptor.mimeType, "text/markdown");
  compare(mismatches, "content.filename", descriptor.filename, content.filename);
  compare(mismatches, "content.contentHash", descriptor.contentHash, content.hash);
  compare(mismatches, "content.byteSize", descriptor.byteSize, content.byteSize);
  compare(mismatches, "lifecycle", state.lifecycle, "FINAL");
  compare(mismatches, "content.markdown", descriptor.markdown, content.markdown);
  if(input.publication){
    // Old (47-file) Registry model: it has no publication field and silently drops the input, so the stored Report has no
    // publication value. Only that absence (undefined/null) is tolerated; any present publication object must still match.
    if(!legacyUnpublished(state))compare(mismatches,"publication",JSON.stringify(parsePublicationMetadata(state.publication)),JSON.stringify(parsePublicationMetadata(input.publication)));
    compare(mismatches,"createdBy",state.createdBy,input.actorId);
  }
  if (mismatches.length) throw new Error(`REPORT_REF_CONFLICT: ${mismatches.join(", ")}`);
}

function assertAttentionMatch(document: LiveDocument, input: ReturnType<typeof normalizeInput>): void {
  const attention = record(document.state.global.attention);
  const mismatches: string[] = [];
  compare(mismatches, "attention.request", attention.request, input.attention);
  compare(mismatches, "attention.reasonCode", attention.reasonCode ?? null, input.reasonCode);
  compare(mismatches, "attention.reason", attention.reason ?? null, input.reason);
  compare(mismatches, "attention.reviewBy", attention.reviewBy ?? null, input.reviewBy);
  compare(mismatches, "attention.expiresAt", attention.expiresAt ?? null, input.expiresAt);
  if (mismatches.length) throw new Error(`REPORT_REF_CONFLICT: ${mismatches.join(", ")}`);
}

function hasBlankAttention(document: LiveDocument): boolean {
  const attention = record(document.state.global.attention);
  return attention.request === "NONE"
    && (attention.reasonCode ?? null) === null
    && (attention.reason ?? null) === null
    && (attention.reviewBy ?? null) === null
    && (attention.expiresAt ?? null) === null
    && (attention.requestedAt ?? null) === null
    && (attention.resolvedAt ?? null) === null;
}

function registeredRevision(document: LiveDocument): number {
  const revision = document.state.global.revision;
  if (!Number.isSafeInteger(revision) || Number(revision) < 1) {
    throw new Error("DOCUMENT_RESPONSE_INVALID: registered report omitted a valid revision");
  }
  return Number(revision);
}

function requestReviewAction(input: ReturnType<typeof normalizeInput>, expectedRevision: number) {
  return {
    type: "REQUEST_REVIEW",
    scope: "global" as const,
    input: {
      request: input.attention,
      reasonCode: input.reasonCode,
      reason: input.reason,
      reviewBy: input.reviewBy,
      expiresAt: input.expiresAt,
      expectedRevision,
      occurredAt: input.occurredAt,
      actorId: input.actorId,
    },
  };
}

function writeReceipt(input: ReturnType<typeof normalizeInput>, documentId: string, content: ReturnType<typeof readMarkdownContent>, status: PromotionReceipt["status"]): PromotionReceipt {
  const receiptId = createHash("sha256")
    .update(`${input.driveId}\0${input.reportRef}\0${content.hash}`)
    .digest("hex")
    .slice(0, 24);
  const receiptPath = join(input.receiptDir, `${receiptId}.json`);
  if (existsSync(receiptPath)) {
    return readMatchingReceipt(receiptPath, input, documentId, content);
  }
  const receipt: PromotionReceipt = {
    ...(input.publication ? {publication: input.publication} : {}),
    schemaVersion: "report-promotion-receipt.v1",
    status,
    reportRef: input.reportRef,
    documentId,
    driveId: input.driveId,
    sourceRef: input.sourceRef,
    contentHash: content.hash,
    byteSize: content.byteSize,
    attention: input.attention,
    promotedAt: new Date().toISOString(),
    receiptPath,
  };
  const temporary = `${receiptPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  let published = false;
  try {
    const descriptor = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporary, receiptPath);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return readMatchingReceipt(receiptPath, input, documentId, content);
    }
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (!published) throw new Error("PROMOTION_RECEIPT_WRITE_FAILED");
  chmodSync(receiptPath, 0o600);
  fsyncDirectory(input.receiptDir);
  return receipt;
}

function readMatchingReceipt(
  receiptPath: string,
  input: ReturnType<typeof normalizeInput>,
  documentId: string,
  content: ReturnType<typeof readMarkdownContent>,
): PromotionReceipt {
  const stat = lstatSync(receiptPath, { bigint: true });
  const receiptName = basename(receiptPath);
  const receiptDirectory = dirname(receiptPath);
  const transientPublicationLink = stat.nlink === 2n && readdirSync(receiptDirectory).some((name) => {
    if (!name.startsWith(`${receiptName}.`) || !name.endsWith(".tmp")) return false;
    try {
      const sibling = lstatSync(join(receiptDirectory, name), { bigint: true });
      return sibling.isFile() && !sibling.isSymbolicLink() && sibling.dev === stat.dev && sibling.ino === stat.ino;
    } catch {
      return false;
    }
  });
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.nlink !== 1n && !transientPublicationLink) || (stat.mode & 0o077n) !== 0n || stat.size < 1n || stat.size > 64n * 1024n) {
    throw new Error("PROMOTION_RECEIPT_INVALID");
  }
  let existing: PromotionReceipt;
  const descriptor = openSync(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile()
      || before.dev !== stat.dev
      || before.ino !== stat.ino
      || (before.nlink !== 1n && !transientPublicationLink)
    ) {
      throw new Error("PROMOTION_RECEIPT_INVALID");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(receiptPath, { bigint: true });
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs
      || bytes.byteLength !== Number(before.size)
      || pathAfter.dev !== before.dev
      || pathAfter.ino !== before.ino
    ) {
      throw new Error("PROMOTION_RECEIPT_INVALID");
    }
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!Buffer.from(decoded, "utf8").equals(bytes)) throw new Error("PROMOTION_RECEIPT_INVALID");
    existing = JSON.parse(decoded) as PromotionReceipt;
  } catch {
    throw new Error("PROMOTION_RECEIPT_INVALID");
  } finally {
    closeSync(descriptor);
  }
  if (
    existing.schemaVersion !== "report-promotion-receipt.v1"
    || !["CREATED", "RECOVERED", "ALREADY_REGISTERED"].includes(existing.status)
    || JSON.stringify(existing.publication ?? null) !== JSON.stringify(input.publication ?? null)
    || existing.reportRef !== input.reportRef
    || existing.documentId !== documentId
    || existing.driveId !== input.driveId
    || existing.sourceRef !== input.sourceRef
    || existing.contentHash !== content.hash
    || existing.byteSize !== content.byteSize
    || existing.attention !== input.attention
    || existing.receiptPath !== receiptPath
    || !Number.isFinite(Date.parse(existing.promotedAt))
  ) {
    throw new Error("PROMOTION_RECEIPT_CONFLICT");
  }
  return existing;
}

function fsyncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function securePublisherLockDirectory(configured: string): string {
  if (!configured) throw new Error("PROMOTION_LOCK_DIR_REQUIRED");
  const normalized = resolve(configured);
  if (!existsSync(normalized)) mkdirSync(normalized, { recursive: true, mode: 0o700 });
  const canonical = realpathSync.native(normalized);
  if (canonical !== normalized) throw new Error("PROMOTION_LOCK_DIR_NOT_CANONICAL");
  const stat = lstatSync(canonical);
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new Error("PROMOTION_LOCK_DIR_NOT_OWNER_ONLY");
  }
  return canonical;
}

export function promotionIntentName(reportRef: string): string {
  return `report-promotion-intent:${promotionKey(reportRef)}`;
}

function promotionKey(reportRef: string): string {
  return createHash("sha256").update(reportRef).digest("hex").slice(0, 20);
}

function promotionLockKey(driveId: string, reportRef: string): string {
  return createHash("sha256").update(`${driveId}\0${reportRef}`).digest("hex").slice(0, 24);
}

function reportPhid(reportRef: string): string {
  return `report:0x${createHash("sha256").update(reportRef).digest("hex").slice(0, 32)}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP_PAYLOAD_INVALID");
  return value as Record<string, unknown>;
}

function text(value: string, field: string, max: number): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field.toUpperCase()}_REQUIRED`);
  if (normalized.length > max) throw new Error(`${field.toUpperCase()}_TOO_LONG`);
  return normalized;
}

function optionalText(value: string | null | undefined, field: string, max: number): string | null {
  return value == null || value.trim() === "" ? null : text(value, field, max);
}

function requireIso(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field.toUpperCase()}_INVALID`);
}

function compare(mismatches: string[], field: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) mismatches.push(field);
}

export const LIVE_PROMOTION_CONFIRMATION = CONFIRMATION;
