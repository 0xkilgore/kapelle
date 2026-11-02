// Owner-private Report store: withheld from the shared Registry; verified by the SAME independent verifier as Registry Reports.
import {describe, it, expect, beforeEach} from 'vitest';
import {mkdtempSync, realpathSync, chmodSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {digest} from '../src/content.js';
import {OwnerPrivateReportStore, privateDocumentId} from '../src/agent-kit/private-store.js';
import {independentlyVerifiedReports} from '../src/task-delegation/runtime.js';
import {publicationRequestSchema, type TaskReportRequest} from '../src/task-delegation/worker-contract.js';

const hex = (s: string) => createHash('sha256').update(s).digest('hex');
const OWNER = 'owner', SCOPE = 'kapelle', INSTANCE = 'finances-1';
function request(over: Partial<TaskReportRequest> = {}): TaskReportRequest {
  const dispatchId = randomUUID(), inputHash = 'sha256:' + 'c'.repeat(64), markdown = '# September summary (synthetic)\n\nNo money moved.';
  return publicationRequestSchema.parse({publicationId: 'task-report:' + digest({dispatchId, inputHash}).slice(7), ownerId: OWNER, scopeRef: SCOPE, instanceId: INSTANCE, dispatchId, inputHash,
    taskId: 'task-1', sourceRef: 'dispatch:' + dispatchId, packetHash: 'sha256:' + 'd'.repeat(64), executionHash: 'sha256:' + 'e'.repeat(64), markdown, contentHash: 'sha256:' + hex(markdown),
    classification: 'owner-private', ...over});
}

describe('owner-private Report store', () => {
  let dir: string;
  beforeEach(() => { const root = realpathSync(mkdtempSync(join(tmpdir(), 'private-store-'))); chmodSync(root, 0o700); dir = join(root, 'private'); });
  const store = () => new OwnerPrivateReportStore(dir, {ownerId: OWNER, scopeRef: SCOPE}, () => new Date('2026-10-15T01:00:00.000Z'));

  it('publishes through the real independent verifier (same evidence checks as the Registry bridge); idempotent; owner-only file', async () => {
    const s = store(), v = independentlyVerifiedReports(s, OWNER, SCOPE, INSTANCE), r = request();
    expect(await v.reports.admitted(r)).toBe(true);
    const receipt = await v.reports.publish(r);
    expect(receipt).toMatchObject({publicationId: r.publicationId, dispatchId: r.dispatchId, reportId: privateDocumentId(r.publicationId), contentVersion: 1, contentHash: r.contentHash});
    const read = await v.reports.read(receipt);
    expect(Buffer.from(read.bytes).toString()).toBe(r.markdown);
    expect(read).toMatchObject({ownerId: OWNER, scopeRef: SCOPE, producerId: INSTANCE, sourceRef: r.sourceRef, contentVersion: 1});
    expect(await v.reports.publish(r)).toEqual(receipt); // same publication, same receipt
    expect(await v.reports.lookup(r)).toEqual(receipt);
    expect(await v.facts()).toEqual([expect.objectContaining({reportId: receipt.reportId, dispatchId: r.dispatchId})]);
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(statSync(join(dir, files[0])).mode & 0o777).toBe(0o600);
  });
  it('admits only owner-private requests in its own owner/scope (a project Report never lands here)', async () => {
    const s = store(), {classification: _c, ...project} = request();
    expect(await s.admitted(project as TaskReportRequest)).toBe(false);
    await expect(s.publish(project as TaskReportRequest)).rejects.toThrow(/private_store_not_admitted/);
    expect(await s.admitted(request({ownerId: 'someone-else'}))).toBe(false);
    expect(await s.admitted(request({scopeRef: 'other'}))).toBe(false);
  });
  it('a different request for the same publication is refused; a tampered file fails independent verification', async () => {
    const s = store(), v = independentlyVerifiedReports(s, OWNER, SCOPE, INSTANCE), r = request();
    const receipt = await v.reports.publish(r);
    const md2 = '# changed';
    await expect(s.publish({...r, markdown: md2, contentHash: 'sha256:' + hex(md2)})).rejects.toThrow(/private_store_publication_conflict/);
    const file = join(dir, readdirSync(dir)[0]), stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.evidence.markdown = '# tampered';
    writeFileSync(file, JSON.stringify(stored), {mode: 0o600});
    await expect(v.reports.read(receipt)).rejects.toThrow();
    chmodSync(file, 0o644);
    await expect(s.read(r.publicationId)).rejects.toThrow(/private_store_file_not_private/);
  });
  it('the gateway read returns the verified document by id; unknown ids are null; the store refuses Dropbox and open directories', async () => {
    const s = store(), r = request();
    await s.publish(r);
    const doc = s.readDocument(privateDocumentId(r.publicationId));
    expect(doc).toMatchObject({documentId: privateDocumentId(r.publicationId), producerId: INSTANCE, dispatchId: r.dispatchId, lifecycle: 'FINAL', contentVersion: 1,
      contentHash: r.contentHash, markdown: r.markdown, classification: 'owner-private', reportRef: 'report:task:' + r.publicationId.slice(12)});
    expect(s.readDocument(randomUUID())).toBeNull();
    expect(() => s.readDocument('../etc')).toThrow();
    expect(() => new OwnerPrivateReportStore('/tmp/x/Dropbox/private', {ownerId: OWNER, scopeRef: SCOPE})).toThrow(/private_store_in_dropbox/);
    const open = join(dir, '..', 'open'); mkdirSync(open, {mode: 0o755}); chmodSync(open, 0o755);
    expect(() => new OwnerPrivateReportStore(open, {ownerId: OWNER, scopeRef: SCOPE})).toThrow(/private_store_not_private/);
  });
});
