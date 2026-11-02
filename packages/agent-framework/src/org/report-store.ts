// Lean runtime: the org's local Report store. Same create-only, idempotent, owner-only-file store as the owner-private
// store, but it admits exactly this org's PROJECT-classified Reports (org agents are never owner-private) and lists
// drafts for the reviewers' web view. Reports never leave the org runtime.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { OwnerPrivateReportStore, privateDocumentId } from "../agent-kit/private-store.js";
import type { TaskReportRequest } from "../task-delegation/worker-contract.js";

export class OrgReportStore extends OwnerPrivateReportStore {
  override readonly bindingRef = "org-report-store:v1";
  constructor(dir: string, private readonly org: { ownerId: string; scopeRef: string }) { super(dir, org); }
  override async admitted(raw: TaskReportRequest) {
    // Project Reports carry no classification tag (only owner-private ones do); anything tagged is refused here.
    return raw?.classification === undefined && raw.ownerId === this.org.ownerId && raw.scopeRef === this.org.scopeRef;
  }
  /** Draft summaries (newest first) for reviewers: ids, Task, size and time; never content. */
  list() {
    return readdirSync(this.dir).filter((n) => /^[a-f0-9]{64}\.json$/.test(n)).map((n) => {
      const s = JSON.parse(readFileSync(join(this.dir, n), "utf8")) as { request: TaskReportRequest; publishedAt: string };
      return { documentId: privateDocumentId(s.request.publicationId), taskId: s.request.taskId, dispatchId: s.request.dispatchId, bytes: Buffer.byteLength(s.request.markdown), publishedAt: s.publishedAt };
    }).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }
}
