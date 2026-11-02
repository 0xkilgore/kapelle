import { z } from "zod";
import { digest } from "../content.js";
import { assert, opaque } from "../validation.js";
import type { PublicationManifest } from "./manifest.js";
import { jsonRequest, privateEndpoint } from "./transport-http.js";

const task = z
  .object({
    id: z.string(),
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    ownerId: z.string(),
    projectId: z.string(),
    title: z.string().min(1),
    bodyMarkdown: z.string(),
    sourceRef: z.string(),
    status: z.enum(["OPEN", "BLOCKED", "SNOOZED", "DONE", "ARCHIVED"]),
  })
  .passthrough();
/** Existing Task Authority read endpoint. Native owner and framework owner are
 * explicitly configured identities; no name normalization or implicit aliasing. */
export class PublicationTaskReader {
  private readonly origin: string;
  constructor(
    private readonly config: {
      origin: string;
      token: () => string;
      authorityRef: string;
      taskId: string;
      nativeOwnerId: string;
      frameworkOwnerId: string;
      scopeRef: string;
      projectId: string;
      reportId: string;
    },
    private readonly request: typeof fetch = fetch,
  ) {
    this.origin = privateEndpoint(config.origin);
    [
      config.authorityRef,
      config.taskId,
      config.nativeOwnerId,
      config.frameworkOwnerId,
      config.scopeRef,
      config.projectId,
      config.reportId,
    ].forEach(opaque);
  }
  async read() {
    const s = task.parse(
      await jsonRequest(
        this.origin,
        `/v1/tasks/${encodeURIComponent(this.config.taskId)}`,
        this.config.token,
        this.request,
      ),
    );
    assert(
      s.id === this.config.taskId &&
        s.ownerId === this.config.nativeOwnerId &&
        s.projectId === this.config.projectId &&
        s.sourceRef === "kapelle:report:" + this.config.reportId,
      "Task identity, ownership, project or report link differs",
    );
    const commitmentHash = digest({
      title: s.title,
      bodyMarkdown: s.bodyMarkdown,
      ownerId: s.ownerId,
    });
    return {
      authorityRef: this.config.authorityRef,
      taskRef: s.id,
      ownerId: this.config.frameworkOwnerId,
      scopeRef: this.config.scopeRef,
      nativeOwnerId: s.ownerId,
      revision: s.revision,
      projectId: s.projectId,
      status: s.status,
      sourceRef: s.sourceRef,
      commitmentHash,
    };
  }
  /** Bind a separately resolved Manager-to-native mapping, never infer it from a slug. */
  publicationTask(managerTaskRef: string) {
    opaque(managerTaskRef);
    return async (expected: PublicationManifest["task"]) => {
      const current = await this.read();
      assert(
        expected.authorityRef === current.authorityRef &&
          expected.authorityTaskRef === current.taskRef &&
          expected.managerTaskRef === managerTaskRef &&
          expected.commitmentHash === current.commitmentHash &&
          !["DONE", "ARCHIVED"].includes(current.status),
        "Publication Task commitment changed or is inactive",
      );
      return { ...expected, ownerId: current.ownerId, scopeRef: current.scopeRef };
    };
  }
}
