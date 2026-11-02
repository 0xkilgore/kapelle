// Owner-private Report store (LOCAL-MLX-ADAPTER-SPEC "Qualification and finance privacy"): owner-private agents' Reports are
// WITHHELD from the shared Report Registry. They are published here instead: an owner-only directory on the Framework host
// (outside Dropbox), one create-only file per publication, in the exact evidence shape of the Task publication port, so the
// existing independent verifier (PrivateTaskReportAdapter / independentlyVerifiedReports) and native result facts work
// unchanged. Nothing here is reachable from the Registry, summaries, Today, digests, search or Build-team metadata (they
// read the Registry); the only reader is the owner-token gateway (GET /private-reports/:id).
import {mkdirSync, lstatSync, openSync, writeSync, closeSync, linkSync, unlinkSync, readFileSync, existsSync, fsyncSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonical} from '../content.js';
import {assert} from '../validation.js';
import {publicationRequestSchema, type TaskReportRequest} from '../task-delegation/worker-contract.js';
import type {PrivateTaskPublicationPort} from '../task-delegation/private-report-adapter.js';

export const PRIVATE_DRIVE_ID = 'owner-private';
const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const bare = (s: string) => s.replace(/^sha256:/, '');
/** Stable document id per publication (UUID-shaped, derived; the store holds one document per publication). */
export function privateDocumentId(publicationId: string) {
  const h = hex('kapelle-owner-private:' + publicationId);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const storedSchema = z.object({contract: z.literal('kapelle.owner-private-report/v1'), request: publicationRequestSchema, evidence: z.unknown(), publishedAt: z.iso.datetime()}).strict();

export class OwnerPrivateReportStore implements PrivateTaskPublicationPort {
  readonly bindingRef: string = 'owner-private-store:v1';
  constructor(readonly dir: string, private readonly scope: {ownerId: string; scopeRef: string}, private readonly now: () => Date = () => new Date()) {
    assert(!dir.includes('/Dropbox/'), 'private_store_in_dropbox');
    mkdirSync(dir, {recursive: true, mode: 0o700});
    const s = lstatSync(dir);
    assert(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o077) === 0, 'private_store_not_private');
  }
  private file(publicationId: string) { return join(this.dir, hex(publicationId) + '.json'); }
  /** Only owner-private requests in this owner/scope are admitted here (a project Report never lands in this store). */
  async admitted(raw: TaskReportRequest) {
    const r = publicationRequestSchema.parse(raw);
    return r.classification === 'owner-private' && r.ownerId === this.scope.ownerId && r.scopeRef === this.scope.scopeRef;
  }
  private evidence(r: TaskReportRequest, publishedAt: string) {
    const documentId = privateDocumentId(r.publicationId), planDigest = hex(canonical(r));
    const author = {id: r.instanceId, label: 'Owner-private agent', instanceId: r.instanceId, definitionId: null, definitionVersion: null, definitionHash: null};
    return {documentId, driveId: PRIVATE_DRIVE_ID, reportRef: 'report:task:' + r.publicationId.slice(12), sourceRef: r.sourceRef, producerId: r.instanceId, revision: 1,
      publication: {publicationId: r.publicationId, author, publisher: {id: 'owner-private-store', label: 'Owner-private store', instanceId: null, definitionId: null, definitionVersion: null, definitionHash: null},
        runRef: `kapelle-task://dispatch/${r.dispatchId}?input=${bare(r.inputHash)}`, sourceRef: r.sourceRef,
        provenanceRef: `kapelle-task://execution/${bare(r.executionHash)}?packet=${bare(r.packetHash)}`, contentHash: bare(r.contentHash), contentVersion: 1,
        authorizationRef: 'owner-private:' + r.ownerId, publishedAt},
      markdown: r.markdown, planDigest, verificationRef: 'private-report:' + hex(JSON.stringify({driveId: PRIVATE_DRIVE_ID, documentId, planDigest})),
      scope: {ownerId: r.ownerId, scopeRef: r.scopeRef, driveId: PRIVATE_DRIVE_ID, admissionRef: this.bindingRef}};
  }
  /** Create-only and idempotent: the same publication returns its stored evidence; a different request for it is refused. */
  async publish(raw: TaskReportRequest) {
    const r = publicationRequestSchema.parse(raw);
    assert(await this.admitted(r), 'private_store_not_admitted');
    assert(hex(r.markdown) === bare(r.contentHash), 'private_store_content_hash');
    const existing = await this.lookup(r);
    if (existing) return existing;
    const publishedAt = this.now().toISOString(), file = this.file(r.publicationId), tmp = file + '.' + process.pid + '.tmp';
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({contract: 'kapelle.owner-private-report/v1', request: r, evidence: this.evidence(r, publishedAt), publishedAt})); fsyncSync(fd); } finally { closeSync(fd); }
    try { linkSync(tmp, file); } catch { /* raced: the stored one decides below */ } finally { unlinkSync(tmp); }
    const stored = await this.lookup(r);
    assert(stored, 'private_store_publication_conflict');
    return stored;
  }
  private load(publicationId: string) {
    const file = this.file(publicationId);
    if (!existsSync(file)) return null;
    const s = lstatSync(file);
    assert(s.isFile() && !s.isSymbolicLink() && (s.mode & 0o077) === 0, 'private_store_file_not_private');
    return storedSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  }
  async lookup(raw: TaskReportRequest) {
    const r = publicationRequestSchema.parse(raw), stored = this.load(r.publicationId);
    if (!stored) return null;
    assert(canonical(stored.request) === canonical(r), 'private_store_publication_conflict');
    return structuredClone(stored.evidence);
  }
  /** Independent re-read from disk (the adapter re-derives and checks every binding, hash and verification ref). */
  async read(publicationId: string) {
    const stored = this.load(publicationId);
    assert(stored, 'private_store_not_found');
    return structuredClone(stored!.evidence);
  }
  /** Gateway read by document id (owner token only, at the HTTP layer). Returns the stored request's verified view. */
  readDocument(documentId: string) {
    const id = z.string().uuid().parse(documentId);
    // The id is derived from the publication id; scan is bounded by this owner's private Reports.
    for (const name of readdirSync(this.dir).sort()) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const stored = storedSchema.parse(JSON.parse(readFileSync(join(this.dir, name), 'utf8')));
      if (privateDocumentId(stored.request.publicationId) !== id) continue;
      const r = stored.request;
      assert(r.ownerId === this.scope.ownerId && r.scopeRef === this.scope.scopeRef && hex(r.markdown) === bare(r.contentHash), 'private_store_document_changed');
      return {documentId: id, reportRef: 'report:task:' + r.publicationId.slice(12), sourceRef: r.sourceRef, producerId: r.instanceId, dispatchId: r.dispatchId, taskId: r.taskId,
        lifecycle: 'FINAL' as const, contentVersion: 1, contentHash: r.contentHash, byteSize: Buffer.byteLength(r.markdown), markdown: r.markdown, publishedAt: stored.publishedAt, classification: 'owner-private' as const};
    }
    return null;
  }
}
