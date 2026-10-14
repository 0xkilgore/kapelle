import { readFile } from "node:fs/promises";
import { z } from "zod";
import { digest } from "../content.js";
import { assert } from "../validation.js";
import { fileSchema, type PublicationManifest } from "./manifest.js";

const staging = z
  .object({
    contract: z.literal("kapelle/vercel-staging/v1"),
    receiptRef: z.string().min(1),
    buildReceiptRef: z.string().min(1),
    buildReceiptHash: z.string(),
    outputHash: z.string(),
    recipeRef: z.string(),
    environment: z.literal("production"),
    commit: z.string(),
    tree: z.string(),
    lockfileHash: z.string(),
    teamId: z.string(),
    projectId: z.string(),
    deploymentId: z.string(),
    deploymentHost: z
      .string()
      .max(253)
      .regex(/^[a-z0-9][a-z0-9-]*\.vercel\.app$/),
    uploadedFiles: z.array(fileSchema).min(1).max(100000),
    completedAt: z.iso.datetime(),
  })
  .strict();
export type StagingReceipt = z.infer<typeof staging>;
export type StagingReceiptReader = (receiptRef: string) => Promise<unknown>;

/** A receipt from the trusted staging runner's retained upload evidence. Provider
 * deployment metadata and caller request JSON are not staging evidence. */
export async function verifiedStagingReceipt(m: PublicationManifest, read: StagingReceiptReader) {
  assert(m.build.staging && m.build.stagedDeploymentId, "Trusted staging binding required");
  const r = staging.parse(await read(m.build.staging.receiptRef));
  assert(
    r.receiptRef === m.build.staging.receiptRef &&
      digest(r) === m.build.staging.receiptHash &&
      r.buildReceiptRef === m.build.receiptRef &&
      r.buildReceiptHash === m.build.receiptHash &&
      r.outputHash === m.build.outputHash &&
      r.recipeRef === m.build.recipeRef &&
      r.commit === m.source.commit &&
      r.tree === m.source.tree &&
      r.lockfileHash === m.source.lockfile.hash &&
      r.teamId === m.target.teamId &&
      r.projectId === m.target.projectId &&
      r.deploymentId === m.build.stagedDeploymentId,
    "Trusted staging receipt differs from approved build or deployment",
  );
  const ordered = [...r.uploadedFiles].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  assert(
    new Set(ordered.map((f) => f.path)).size === ordered.length && digest(ordered) === r.outputHash,
    "Uploaded build inventory differs",
  );
  return r;
}

/** Fixed server-side receipt map only. Does not create a receipt, stage an upload,
 * or infer provider evidence from metadata. Keep the producer's retained files. */
export function stagingReceiptReader(
  files: Readonly<Record<string, string>>,
): StagingReceiptReader {
  const paths = new Map(Object.entries(files));
  return async (ref) => {
    const path = paths.get(ref);
    assert(path, "Trusted staging receipt unavailable");
    const bytes = await readFile(path);
    assert(bytes.length <= 32_000_000, "Staging receipt exceeds bound");
    return JSON.parse(bytes.toString("utf8"));
  };
}
