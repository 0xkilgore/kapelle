import { createHash } from "node:crypto";
import { z } from "zod";
export const sha = (text: string) => createHash("sha256").update(text).digest("hex");
export const sourceSchema = z
  .object({
    id: z.string().uuid(),
    version: z.number().int().nonnegative(),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    title: z.string().min(1).max(1024),
    project: z.string().max(200).nullable(),
    mimeType: z.enum(["text/markdown", "text/csv"]),
    content: z.string().max(262144),
  })
  .strict()
  .refine(
    (s) => Buffer.byteLength(s.content) <= 262144 && sha(s.content) === s.hash,
    "source_integrity",
  );
export type Source = z.infer<typeof sourceSchema>;
export const requestSchema = z
  .object({
    operationId: z.string().uuid(),
    agent: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
    comment: z.string().min(1).max(4000),
    document: sourceSchema,
  })
  .strict();
export const pinSchema = z
  .object({
    instanceId: z.string().min(1).max(200),
    runtimeBindingRef: z.string().min(1).max(200),
    targetUrl: z.string(),
    definitionHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    instanceRevision: z.number().int().nonnegative(),
    scopeRef: z.string().min(1).max(200),
  })
  .strict();
export const workSchema = z
  .object({
    dispatchId: z.string().regex(/^phid:disp-[a-zA-Z0-9_-]+$/),
    queryId: z.string().min(1).max(200),
    request: requestSchema,
    pin: pinSchema,
  })
  .strict();
export type Work = z.infer<typeof workSchema>;
export function localOrigin(value: string) {
  const u = new URL(value);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/"
  )
    throw Error("local_endpoint_required");
  return u.origin;
}
export async function boundedJson(response: Response, limit = 600000): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader)
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > limit) {
        await reader.cancel();
        throw Error("response_too_large");
      }
      chunks.push(part.value);
    }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
