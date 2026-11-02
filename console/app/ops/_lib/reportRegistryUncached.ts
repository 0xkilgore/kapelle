import "server-only";

import {
  normalizeReportDocument,
  pendingPublicationDocument,
  visibleReportById,
  type ReportRegistryItem,
  type ReportRegistrySnapshot,
} from "./reportRegistryContract";
import {
  mapWithConcurrency,
  parseMcpEnvelope,
  reportRegistryAuthorizationHeader,
  validatedMcpEndpoint,
} from "./reportRegistryTransport";

import { boundedReportMcpBody, reportDriveDocumentIds, REPORT_REGISTRY_MAX_READ_BYTES, REPORT_REGISTRY_READ_DEADLINE_MS } from "./reportRegistryBounds";

import { reportReadTrace, type ReportReadCaller } from "./reportReadTrace";

type ReadBudget = { signal: AbortSignal; spend: (bytes: number) => void; trace: ReturnType<typeof reportReadTrace> };
function readBudget(signal?: AbortSignal, caller: ReportReadCaller = "selected-reports"): ReadBudget & { close: (success: boolean) => void } {
  const trace = reportReadTrace(caller);
  const controller = new AbortController();
  let bytes = 0;
  return {
    trace,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(REPORT_REGISTRY_READ_DEADLINE_MS), ...(signal ? [signal] : [])]),
    spend(count) { trace.bytes(count); bytes += count; if (bytes > REPORT_REGISTRY_MAX_READ_BYTES) { controller.abort(); throw new Error("Report read exceeded the total response-size limit"); } },
    close(success) { controller.abort(); trace.close(success); },
  };
}
function sameMembers(before: string[], after: string[]) {
  const members = new Set(after);
  return before.length === after.length && before.every(id => members.has(id));
}
const DOCUMENT_READ_CONCURRENCY = 8;
// One Registry tool call may take several seconds under normal provider
// latency. The refresh coordinator keeps the complete read bounded below its
// source lease; this per-call budget only prevents one stalled call from
// consuming that entire window.
export const REPORTS_MCP_CALL_DEADLINE_MS = 6_000;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Vetra returned a non-object payload");
  return value as Record<string, unknown>;
}

async function mcpCall(endpoint: string, name: "getDocument" | "getDocuments", args: Record<string, unknown>, budget: ReadBudget): Promise<unknown> {
  return budget.trace.measure(name, () => mcpCallRaw(endpoint, name, args, budget));
}

async function mcpCallRaw(endpoint: string, name: string, args: Record<string, unknown>, budget: ReadBudget): Promise<unknown> {
  budget.signal.throwIfAborted();
  const authorization = reportRegistryAuthorizationHeader(process.env.KAPELLE_REPORT_REGISTRY_MCP_TOKEN);
  if (!authorization) throw new Error("Report Registry reader credential is not configured");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", authorization, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `${name}-${crypto.randomUUID()}`, method: "tools/call", params: { name, arguments: args } }),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([AbortSignal.timeout(REPORTS_MCP_CALL_DEADLINE_MS), budget.signal]),
  });
  if (!response.ok) throw new Error(`Vetra ${name} returned HTTP ${response.status}`);
  const body = await boundedReportMcpBody(response, budget.spend);
  const envelope = parseMcpEnvelope(body, response.headers.get("content-type"));
  if (envelope.error) throw new Error(`Vetra ${name} failed`);
  if (envelope.result?.isError) throw new Error(`Vetra ${name} rejected the request`);
  if (envelope.result?.structuredContent !== undefined) return envelope.result.structuredContent;
  const text = envelope.result?.content?.find((entry) => entry.type === "text")?.text;
  if (!text) throw new Error(`Vetra ${name} omitted its payload`);
  return JSON.parse(text) as unknown;
}

export async function readVetraReportRegistry(endpoint: string, driveId: string, signal?: AbortSignal, caller: ReportReadCaller = "unspecified"): Promise<ReportRegistrySnapshot> {
  const budget = readBudget(signal, caller);
  let success = false;
  try {
    const documentIds = reportDriveDocumentIds(await mcpCall(endpoint, "getDocuments", { parentId: driveId }, budget));
    const documents = await mapWithConcurrency(documentIds, DOCUMENT_READ_CONCURRENCY, async (id) => {
      const payload = asRecord(await mcpCall(endpoint, "getDocument", { id }, budget));
      if (pendingPublicationDocument(payload.document)) {
        if ((payload.document as {header?: {id?: unknown}})?.header?.id !== id) throw new Error("Report identity mismatch");
        return undefined;
      }
      const report = normalizeReportDocument(payload.document);
      if (!report || report.documentId !== id) throw new Error("Vetra report drive contained an invalid report document");
      return report;
    });
    const after = reportDriveDocumentIds(await mcpCall(endpoint, "getDocuments", { parentId: driveId }, budget));
    if (!sameMembers(documentIds, after)) throw new Error("Report drive membership changed during the read");
    success = true;
    return {
      schemaVersion: "kapelle.report-library.v1", generatedAt: new Date().toISOString(),
      source: "vetra-report-registry", driveId, reports: documents.filter((document) => document != null),
    };
  } finally { budget.close(success); }
}

export async function readReportRegistrySnapshotUncached(signal?: AbortSignal, caller: ReportReadCaller = "unspecified"): Promise<ReportRegistrySnapshot> {
  const configuredEndpoint = process.env.KAPELLE_REPORT_REGISTRY_MCP_URL?.trim();
  const driveId = process.env.KAPELLE_REPORT_REGISTRY_DRIVE_ID?.trim();
  if (!configuredEndpoint || !driveId) throw new Error("Report Registry is not configured");
  const authorization = reportRegistryAuthorizationHeader(process.env.KAPELLE_REPORT_REGISTRY_MCP_TOKEN);
  if (!authorization) throw new Error("Report Registry reader credential is not configured");

  const allowedRemoteHosts = (process.env.KAPELLE_REPORT_REGISTRY_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  const endpoint = validatedMcpEndpoint(configuredEndpoint, allowedRemoteHosts);
  if (!endpoint) throw new Error("Report Registry endpoint is not permitted");
  return readVetraReportRegistry(endpoint, driveId, signal, caller);
}

export type ReportBindingRead =
  | { availability: "authoritative"; report: ReportRegistryItem; error: null }
  | { availability: "not-found"; report: null; error: string }
  | { availability: "unavailable"; report: null; error: string };

export type ReportBindingBatchRead =
  | { availability: "authoritative"; reports: ReportRegistryItem[]; missingDocumentIds: string[]; error: null }
  | { availability: "unavailable"; reports: null; missingDocumentIds: null; error: string };

/** Selected reports share one drive-scope read and one overall budget. No cross-request cache. */
export async function readReportDocumentsForBinding(requestedIds: readonly string[], signal?: AbortSignal): Promise<ReportBindingBatchRead> {
  const budget = readBudget(signal);
  let success = false;
  try {
    if (!Array.isArray(requestedIds) || requestedIds.length > 1_000 || !requestedIds.every(id => typeof id === "string" && id.length > 0 && id.length <= 256)) throw new Error("Invalid report identities");
    const documentIds = [...new Set(requestedIds)];
    const configuredEndpoint = process.env.KAPELLE_REPORT_REGISTRY_MCP_URL?.trim();
    const driveId = process.env.KAPELLE_REPORT_REGISTRY_DRIVE_ID?.trim();
    const authorization = reportRegistryAuthorizationHeader(process.env.KAPELLE_REPORT_REGISTRY_MCP_TOKEN);
    if (!configuredEndpoint || !driveId || !authorization) throw new Error("Report Registry is not configured");
    const allowedRemoteHosts = (process.env.KAPELLE_REPORT_REGISTRY_ALLOWED_HOSTS ?? "").split(",").map(host => host.trim()).filter(Boolean);
    const endpoint = validatedMcpEndpoint(configuredEndpoint, allowedRemoteHosts);
    if (!endpoint) throw new Error("Report Registry endpoint is not permitted");
    const ids = new Set(reportDriveDocumentIds(await mcpCall(endpoint, "getDocuments", { parentId: driveId }, budget)));
    const reports = await mapWithConcurrency(documentIds.filter(id => ids.has(id)), DOCUMENT_READ_CONCURRENCY, async documentId => {
      const payload = asRecord(await mcpCall(endpoint, "getDocument", { id: documentId }, budget));
      const report = normalizeReportDocument(payload.document);
      if (!report || report.documentId !== documentId) throw new Error("Report document could not be verified");
      return report;
    });
    const after = new Set(reportDriveDocumentIds(await mcpCall(endpoint, "getDocuments", { parentId: driveId }, budget)));
    if (documentIds.some(id => ids.has(id) !== after.has(id))) throw new Error("Report membership changed during the read");
    success = true;
    return { availability: "authoritative", reports, missingDocumentIds: documentIds.filter(id => !ids.has(id)), error: null };
  } catch {
    return { availability: "unavailable", reports: null, missingDocumentIds: null, error: "Report Registry could not be read" };
  } finally { budget.close(success); }
}

/** Fresh, scoped binding read. Lifecycle is evidence, not a visibility filter. */
export async function readReportDocumentForBinding(documentId: string, signal?: AbortSignal): Promise<ReportBindingRead> {
  if (process.env.KAPELLE_REPORT_DETAIL_URL?.trim()) {
    const {readSelectedReport}=await import('./reportSelectedSource');
    return readSelectedReport(documentId,signal);
  }
  const result = await readReportDocumentsForBinding([documentId], signal);
  if (result.availability !== "authoritative") return { availability: "unavailable", report: null, error: result.error };
  const report = result.reports[0];
  return report ? { availability: "authoritative", report, error: null }
    : { availability: "not-found", report: null, error: "Report not found in the configured Vetra drive" };
}

export async function readReportDocumentUncached(documentId: string) {
  const result = await readReportDocumentForBinding(documentId);
  if (result.availability !== "authoritative") return result;
  return visibleReportById([result.report], documentId) ? result
    : { availability: "not-found" as const, report: null, error: "Report not found in the configured Vetra drive" };
}
