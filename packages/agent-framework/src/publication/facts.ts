import { canonical, digest } from "../command-boundary.js";
import type { Facts } from "../service/authority.js";
import { verifiedStagingReceipt, type StagingReceiptReader } from "./staging.js";
import { assert, timestamp } from "../validation.js";
import {
  bytesHash,
  canonicalTarget,
  publicationArtifact,
  type PublicationManifest,
  type WebsiteTarget,
} from "./manifest.js";

export interface BuildReceipt {
  receiptRef: string;
  repoRef: string;
  commit: string;
  tree: string;
  lockfileHash: string;
  recipeRef: string;
  environment: "production";
  outputHash: string;
  exitCode: number;
}
export interface PublicationReaders {
  /** Authority-authenticated Report Registry read, with raw content bytes. */
  report(id: string): Promise<{
    id: string;
    ownerId: string;
    scopeRef: string;
    reportRef: string;
    sourceRef: string;
    bytes: Uint8Array;
    revision: number;
  }>;
  /** Fixed server repoRef mapping; compares both checked-out and committed bytes. */
  source(expected: PublicationManifest["source"]): Promise<void>;
  /** Receipt loaded from a trusted build runner's retained evidence, not request JSON. */
  build(receiptRef: string): Promise<BuildReceipt>;
  /** Trusted staging runner evidence, required for a staged deployment proposal. */
  staging?: StagingReceiptReader;
  target(): Promise<WebsiteTarget>;
  /** Reads the existing Task Authority mapping; no task mutation. */
  task(): Promise<PublicationManifest["task"] & { ownerId: string; scopeRef: string }>;
}
export class PublicationFactsAdapter {
  readonly artifact;
  constructor(
    manifest: unknown,
    private readonly readers: PublicationReaders,
    private readonly now: () => string,
  ) {
    this.artifact = publicationArtifact(manifest);
  }
  get manifest() {
    return this.artifact.manifest;
  }
  async verify() {
    const m = this.manifest,
      now = this.now();
    timestamp(now);
    assert(now < m.expiresAt, "Proposal expired");
    const [report, , build, target, task] = await Promise.all([
      this.readers.report(m.report.id),
      this.readers.source(m.source),
      this.readers.build(m.build.receiptRef),
      this.readers.target(),
      this.readers.task(),
    ]);
    assert(
      report.id === m.report.id &&
        report.ownerId === m.ownerId &&
        report.scopeRef === m.scopeRef &&
        report.reportRef === m.report.reportRef &&
        report.sourceRef === m.report.sourceRef &&
        report.bytes.byteLength === m.report.bytes &&
        bytesHash(report.bytes) === m.report.contentHash,
      "Proposal Report content or ownership changed",
    );
    // Report revision is deliberately excluded: read/feedback operations do not edit approved bytes.
    assert(
      build.receiptRef === m.build.receiptRef &&
        digest(build) === m.build.receiptHash &&
        build.repoRef === m.source.repoRef &&
        build.commit === m.source.commit &&
        build.tree === m.source.tree &&
        build.lockfileHash === m.source.lockfile.hash &&
        build.recipeRef === m.build.recipeRef &&
        build.environment === "production" &&
        build.exitCode === 0 &&
        build.outputHash === m.build.outputHash,
      "Proposal production build evidence unavailable or changed",
    );
    assert(
      canonical(canonicalTarget(target)) === canonical(m.target),
      "Target website binding changed",
    );
    if (m.build.stagedDeploymentId) {
      assert(this.readers.staging, "Trusted staging reader unavailable");
      await verifiedStagingReceipt(m, this.readers.staging);
    }
    assert(
      task.ownerId === m.ownerId &&
        task.scopeRef === m.scopeRef &&
        task.managerTaskRef === m.task.managerTaskRef &&
        task.authorityRef === m.task.authorityRef &&
        task.authorityTaskRef === m.task.authorityTaskRef &&
        task.commitmentHash === m.task.commitmentHash,
      "Proposal existing task mapping or commitment changed",
    );
    const finished = this.now();
    timestamp(finished);
    assert(finished >= now && finished < m.expiresAt, "Proposal expired during verification");
    return { checkedAt: finished, artifact: this.artifact, target: canonicalTarget(target) };
  }
  async facts(base: Facts, allowPublish = false): Promise<Facts> {
    const { artifact, target } = await this.verify();
    assert(
      !base.artifacts.some((a) => a.id === artifact.id) &&
        !base.resources.some((r) => r.id === target.bindingRef),
      "Duplicate publication authority fact",
    );
    return {
      ...base,
      artifacts: [
        ...base.artifacts,
        { id: artifact.id, version: artifact.version, contentHash: artifact.contentHash },
      ],
      resources: [
        ...base.resources,
        {
          id: target.bindingRef,
          resourceType: "website",
          revision: target.policyVersion,
          contentHash: digest(target),
          allowedActions: allowPublish ? ["read", "publish"] : ["read"],
        },
      ],
    };
  }
}
