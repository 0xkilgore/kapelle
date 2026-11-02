/** The scoped MCP proxy accepts getDocuments({parentId}) only, without paging.
 * A listing is therefore complete or unusable; never interpret a partial list as absence.
 */
export const REPORT_REGISTRY_MAX_DOCUMENTS = 10_000;
export const REPORT_REGISTRY_MAX_RESPONSE_BYTES = 2_000_000;
export const REPORT_REGISTRY_MAX_READ_BYTES = 64_000_000;
export const REPORT_REGISTRY_READ_DEADLINE_MS = 30_000;

export function reportDriveDocumentIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid report drive listing");
  const listed = value as Record<string, unknown>;
  const ids = listed.documentIds;
  if (!Array.isArray(ids) || ids.length > REPORT_REGISTRY_MAX_DOCUMENTS
    || !ids.every((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 256)
    || new Set(ids).size !== ids.length
    || (listed.hasMore !== undefined && listed.hasMore !== false)
    || (listed.nextCursor !== undefined && listed.nextCursor !== null)
    || (listed.totalCount !== undefined && listed.totalCount !== ids.length)) {
    throw new Error("Report drive listing is invalid, incomplete, or exceeds its bounded capacity");
  }
  return ids;
}

export async function boundedReportMcpBody(response: Response, spend?: (bytes: number) => void): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > REPORT_REGISTRY_MAX_RESPONSE_BYTES) throw new Error("Report response exceeded the response-size limit");
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > REPORT_REGISTRY_MAX_RESPONSE_BYTES) throw new Error("Report response exceeded the response-size limit");
      spend?.(part.value.byteLength);
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  return Buffer.concat(chunks).toString("utf8");
}
