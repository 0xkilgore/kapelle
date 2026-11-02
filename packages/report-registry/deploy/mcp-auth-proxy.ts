#!/usr/bin/env -S node --experimental-strip-types
import { validateReportSnapshot } from "./report-snapshot.mjs";
import {aggregateSummary} from './report-summary-read/aggregate.mjs';
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_BIND_HOST = "127.0.0.1";
const DEFAULT_BIND_PORT = 4251;
const DEFAULT_UPSTREAM = "http://127.0.0.1:4250/mcp";
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const UPSTREAM_TIMEOUT_MS = 15_000;
const shuttingDownServers = new WeakSet<Server>();

// getReportDocumentV1: scoped selected-Report read (membership + that document's heads only); no listing prerequisite.
const READER_TOOLS = new Set(["getDocuments", "getDocument", "getReportLibraryMetadata", "getReportDocumentV1"]);
const REVIEWER_TOOLS = new Set(["getDocuments", "getDocument", "getReportLibraryMetadata", "addActions"]);
const PRODUCER_TOOLS = new Set([...READER_TOOLS, "getReportIdentities", "createDocument", "addActions", "lookupReportPublicationV1", "getRegistryDeploymentV1"]);
const REVIEW_ACTIONS = new Set([
  "MARK_OPENED",
  "MARK_READ",
  "MARK_UNREAD",
  "ADD_FEEDBACK",
  "DISMISS_ATTENTION",
  "RESOLVE_ATTENTION",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_FEEDBACK_CODE_UNITS = 4_000;

export type ProxyConfig = {
  readerToken: string;
  reviewerToken?: string;
  producerToken: string;
  reviewerActorId?: string;
  driveId: string;
  upstream?: string;
  timeoutMs?: number;
  /** First suspension after a listing timeout (doubles per consecutive timeout, max 10 min). Default 30 s. */
  listingSuspendMs?: number;
  /** Reader listings reuse a completed snapshot for max(this, 2 x its duration), capped at 30 s. Default 5 s; 0 disables. */
  readerListingReuseMs?: number;
  /** Refuse producer createDocument/addActions that do not carry expectedRegistryGeneration (enable once every producer
   * sends it). When a mutation carries it, it is ALWAYS enforced. Default false. */
  requireWriteGeneration?: boolean;
  audit?: (event: AuditEvent) => void;
};

type Role = "reader" | "reviewer" | "producer";
type AuditEvent = { timestamp: string; role: Role | null; tool: string | null; status: number };

export function createMcpAuthProxy(config: ProxyConfig) {
  const readerToken = requireToken("reader", config.readerToken);
  const producerToken = requireToken("producer", config.producerToken);
  const reviewer = requireOptionalReviewer(config.reviewerToken, config.reviewerActorId);
  requireDistinctTokens([readerToken, producerToken, ...(reviewer ? [reviewer.token] : [])]);
  const upstream = requireLoopbackUpstream(config.upstream ?? DEFAULT_UPSTREAM);
  const driveId = requireDriveId(config.driveId);
  const timeoutMs = config.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new Error("AUTH_CONFIG_INVALID: timeout must be between 100 and 60000 milliseconds");
  }

  let activeSummaryReads = 0;
  const listing = listingGate(upstream, driveId, timeoutMs, config.listingSuspendMs ?? 30_000, config.readerListingReuseMs ?? 5_000);
  const audit = config.audit ?? writeAuditEvent;

  const server = createServer(async (request, response) => {
    let role: Role | null = null;
    let tool: string | null = null;
    const respond = (status: number, body: Record<string, unknown>) => {
      safeAudit(audit, { timestamp: new Date().toISOString(), role, tool, status });
      return json(response, status, body);
    };
    try {
      if (shuttingDownServers.has(server)) {
        response.setHeader("connection", "close");
        return respond(503, { error: "shutting_down" });
      }
      if (request.method === "GET" && request.url === "/health") {
        return respond(200, { ok: true });
      }
      const detailMatch = request.url?.match(/^\/v2\/reports\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
      if (request.method === "GET" && (request.url === "/v2/report-summaries" || detailMatch)) {
        role = authorize(request, readerToken, reviewer?.token ?? null, producerToken);
        if (!role) return respond(401, {error:"unauthorized"});
        if (role !== "reader") return respond(403, {error:"forbidden_role"});
        if (request.headers["transfer-encoding"] || (request.headers["content-length"] && request.headers["content-length"] !== "0")) return respond(400, {error:"invalid_request"});
        if (activeSummaryReads >= 2) return respond(503, {error:"reader_busy"});
        activeSummaryReads++;
        try {
          if (detailMatch) {
            tool = "getReportDetailV2";
            const upstreamResult = await callUpstream(upstream, mcpBody(tool, {id:detailMatch[1]}), 5000);
            if (upstreamResult.status !== 200) throw Error("SUMMARY_UNAVAILABLE");
            const detail = (extractStructuredContent(upstreamResult.body, upstreamResult.contentType) as any)?.detail;
            if (!detail || detail.schemaVersion !== "kapelle.report-detail.v2" || detail.source !== "vetra-report-registry" || detail.driveId !== driveId || !["available","withdrawn","superseded"].includes(detail.availability)) throw Error("SUMMARY_UNAVAILABLE");
            if (detail.availability === "available" && (detail.document?.header?.id !== detailMatch[1] || detail.document?.header?.documentType !== "kilgore/report" || detail.document?.state?.global?.lifecycle !== "FINAL")) throw Error("SUMMARY_UNAVAILABLE");
            if (detail.availability !== "available" && detail.document !== null) throw Error("SUMMARY_UNAVAILABLE");
            return respond(200, detail);
          }
          tool = "getReportSummaryPage";
          const result = await aggregateSummary(async (args:Record<string,unknown>, budget:number) => {
            const upstreamResult = await callUpstream(upstream, mcpBody("getReportSummaryPage", args), budget);
            if (upstreamResult.status !== 200) throw Error("SUMMARY_UNAVAILABLE");
            return (extractStructuredContent(upstreamResult.body, upstreamResult.contentType) as any)?.page;
          }, driveId);
          return respond(200, result);
        } catch { return respond(503, {error:"report_projection_unavailable"}); }
        finally { activeSummaryReads--; }
      }
      if (request.method !== "POST" || request.url !== "/mcp") {
        return respond(404, { error: "not_found" });
      }
      role = authorize(request, readerToken, reviewer?.token ?? null, producerToken);
      if (!role) return respond(401, { error: "unauthorized" });
      const body = await readBoundedBody(request, MAX_REQUEST_BYTES);
      const allowed = requireAllowedRequest(
        body,
        role,
        driveId,
        reviewer?.actorId ?? null,
      );
      tool = allowed.tool;
      if (!tool || !allowed.arguments) return respond(403, { error: "forbidden_tool" });

      if (tool === "getReportDocumentV1" || (role === "reader" && tool === "getDocument")) {
        // Step 3: one native scoped proof of fixed-Drive membership and this document's heads; no full-Drive listing and no
        // listing-derived eligibility. A reader getDocument keeps its {document} shape; a foreign/removed id is refused.
        const read = await scopedDocumentRead(upstream, driveId, String(allowed.arguments.id), timeoutMs);
        if (!read) return respond(403, { error: "forbidden_document" });
        const structuredContent = tool === "getDocument" ? { document: read.document } : { read };
        const envelope = { jsonrpc: "2.0", id: JSON.parse(allowed.body.toString()).id, result: { structuredContent, content: [] } };
        if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_RESPONSE_BYTES) throw Error("RESPONSE_TOO_LARGE");
        return respond(200, envelope);
      }

      let verifiedReviewerRead: Awaited<ReturnType<typeof requireCurrentReportDocument>> | undefined;
      if (role === "reviewer" && (tool === "getDocument" || tool === "addActions")) {
        verifiedReviewerRead = await requireCurrentReportDocument(
          upstream,
          driveId,
          allowed.arguments.documentId ?? allowed.arguments.id,
          timeoutMs,
          tool === "addActions" ? (allowed.arguments.actions as any[])[0].input.expectedRevision : undefined,
        );
      }
      if (tool === "getDocuments" || tool === "getReportIdentities" || tool === "getReportLibraryMetadata") {
        const snapshot = await listing(role === "reader");
        const payload = tool === "getReportLibraryMetadata" ? snapshot : projectScopedList(snapshot,tool === "getReportIdentities");
        const envelope={jsonrpc:"2.0",id:JSON.parse(allowed.body.toString()).id,result:{structuredContent:payload,content:[]}};
        if(Buffer.byteLength(JSON.stringify(envelope))>MAX_RESPONSE_BYTES)throw Error("RESPONSE_TOO_LARGE");
        return respond(200,envelope);
      }
      // Model-admission fence AT THE WRITE: a producer mutation carrying the Registry
      // deployment generation it was admitted for is forwarded only if the RUNNING deployment matches it right now (no write
      // otherwise), and its result is released only if the deployment is still the same after the write (a change during the
      // write -> 502 registry_generation_changed: the outcome is never claimed). The key is stripped before forwarding.
      let forwardBody = allowed.body, expectedGeneration: string | null = null;
      if (role === "producer" && (tool === "createDocument" || tool === "addActions")) {
        const supplied = allowed.arguments.expectedRegistryGeneration;
        if (supplied !== undefined || config.requireWriteGeneration) {
          if (typeof supplied !== "string" || !/^v1:[A-Za-z0-9._:@-]{1,200}:[a-f0-9]{64}:[0-9a-f-]{36}$/.test(supplied)) return respond(403, { error: "registry_generation_required" });
          if (await registryGeneration(upstream, driveId, timeoutMs) !== supplied) return respond(409, { error: "registry_generation_mismatch" });
          const value = JSON.parse(allowed.body.toString());delete value.params.arguments.expectedRegistryGeneration;
          forwardBody = Buffer.from(JSON.stringify(value));expectedGeneration = supplied;
        }
      }
      let upstreamResult;
      if (tool === "getDocument" && verifiedReviewerRead) {
        const document = object(extractStructuredContent(verifiedReviewerRead.fetched.body, verifiedReviewerRead.fetched.contentType))?.document;
        const structuredContent = {document, membership:verifiedReviewerRead.membership};
        const result = {structuredContent, content:[]};
        const reply = Buffer.from(JSON.stringify({jsonrpc:"2.0",id:JSON.parse(allowed.body.toString()).id,result}));
        if (reply.length > MAX_RESPONSE_BYTES) throw Error("RESPONSE_TOO_LARGE");
        upstreamResult = {status:200,contentType:"application/json",body:reply};
      } else upstreamResult = await callUpstream(upstream, forwardBody, timeoutMs);
      if (expectedGeneration !== null && await registryGeneration(upstream, driveId, timeoutMs).catch(() => null) !== expectedGeneration) {
        return respond(502, { error: "registry_generation_changed" });
      }
      response.statusCode = upstreamResult.status;
      response.setHeader("content-type", upstreamResult.contentType ?? "application/json");
      response.setHeader("cache-control", "no-store");
      response.end(upstreamResult.body);
      safeAudit(audit, { timestamp: new Date().toISOString(), role, tool, status: upstreamResult.status });
    } catch (error) {
      const code = (error as Error).message;
      if (code === "REQUEST_TOO_LARGE") return respond(413, { error: "request_too_large" });
      if (code === "REQUEST_INVALID") return respond(400, { error: "invalid_request" });
      if (code === "REVIEWER_REVISION_CONFLICT") return respond(409, { error: "revision_conflict" });
      if (code === "REVIEWER_SCOPE_FORBIDDEN") return respond(403, { error: "forbidden_document" });
      if (code === "RESPONSE_TOO_LARGE") return respond(502, { error: "upstream_response_too_large" });
      if (code === "LISTING_SUSPENDED") return respond(503, { error: "listing_suspended" });
      return respond(502, { error: "upstream_unavailable" });
    }
  });
  return server;
}

export function requireAllowedTool(body: Buffer, role: Role): string | null {
  return parseAllowedRequest(body, role).tool;
}

function requireAllowedRequest(
  body: Buffer,
  role: Role,
  driveId: string,
  reviewerActorId: string | null,
) {
  const parsed = parseAllowedRequest(body, role);
  if (!parsed.tool) return { tool: null, body: Buffer.from(JSON.stringify(parsed.value)) };
  if ((parsed.tool === "getDocuments" || parsed.tool === "getReportIdentities" || parsed.tool === "getReportLibraryMetadata") && (!hasExactKeys(parsed.arguments,["parentId"]) || parsed.arguments.parentId !== driveId)) return {tool:null,body:Buffer.alloc(0)};
  if(parsed.tool==='getRegistryDeploymentV1' && (role!=='producer'||Object.keys(parsed.arguments).length!==0))return {tool:null,body:Buffer.alloc(0)};
  if(parsed.tool==='getReportDocumentV1' && (!hasExactKeys(parsed.arguments,['id'])||typeof parsed.arguments.id!=='string'||!UUID_PATTERN.test(parsed.arguments.id)))return {tool:null,body:Buffer.alloc(0)};
  if(parsed.tool==='lookupReportPublicationV1' && (role!=='producer'||!hasExactKeys(parsed.arguments,['reportRef'])||typeof parsed.arguments.reportRef!=='string'||!parsed.arguments.reportRef.trim()||parsed.arguments.reportRef.length>1000))return {tool:null,body:Buffer.alloc(0)};
  if (role === "reader" || role === "reviewer") {
    const args = parsed.arguments;
    if (parsed.tool === "getDocuments" && (!hasExactKeys(args, ["parentId"]) || args.parentId !== driveId)) {
      return { tool: null, body: Buffer.alloc(0) };
    }
    if (parsed.tool === "getDocument" && (!hasExactKeys(args, ["id"]) || typeof args.id !== "string" || (role === "reader" && !UUID_PATTERN.test(args.id)))) {
      return { tool: null, body: Buffer.alloc(0) };
    }
    if (parsed.tool === "addActions" && (
      role !== "reviewer"
      || !reviewerActorId
      || !validReviewerAddActions(args, reviewerActorId)
    )) return { tool: null, body: Buffer.alloc(0) };
  }
  return { tool: parsed.tool, body: Buffer.from(JSON.stringify(parsed.value)), arguments: parsed.arguments };
}

function validReviewerAddActions(
  args: Record<string, unknown>,
  reviewerActorId: string,
): boolean {
  if (!hasExactKeys(args, ["documentId", "actions"])) return false;
  if (typeof args.documentId !== "string" || !args.documentId) return false;
  if (!Array.isArray(args.actions) || args.actions.length !== 1) return false;
  const action = object(args.actions[0]);
  if (!action || !hasExactKeys(action, ["type", "scope", "input"])) return false;
  if (typeof action.type !== "string" || !REVIEW_ACTIONS.has(action.type) || action.scope !== "global") return false;
  const input = object(action.input);
  if (!input) return false;
  const commonKeys = ["expectedRevision", "occurredAt", "actorId"];
  const expectedKeys = action.type === "ADD_FEEDBACK" ? [...commonKeys, "feedbackId", "bodyMarkdown"] : commonKeys;
  if (!hasExactKeys(input, expectedKeys)) return false;
  if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) return false;
  if (!canonicalInstant(input.occurredAt) || input.actorId !== reviewerActorId) return false;
  if (action.type === "ADD_FEEDBACK") {
    if (typeof input.feedbackId !== "string" || !UUID_PATTERN.test(input.feedbackId)) return false;
    if (typeof input.bodyMarkdown !== "string") return false;
    const normalized = input.bodyMarkdown.normalize("NFKC").trim();
    if (!normalized || normalized !== input.bodyMarkdown || normalized.length > MAX_FEEDBACK_CODE_UNITS) return false;
    if (/[^\P{Cc}\n\t]/u.test(normalized)) return false;
  }
  return true;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseAllowedRequest(body: Buffer, role: Role) {
  let value: unknown;
  try { value = JSON.parse(body.toString("utf8")); }
  catch { throw new Error("REQUEST_INVALID"); }
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("REQUEST_INVALID");
  const envelope = value as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (envelope.method !== "tools/call" || typeof envelope.params?.name !== "string") throw new Error("REQUEST_INVALID");
  const args = envelope.params.arguments;
  if (!args || Array.isArray(args) || typeof args !== "object") throw new Error("REQUEST_INVALID");
  const allowed = role === "producer" ? PRODUCER_TOOLS : role === "reviewer" ? REVIEWER_TOOLS : READER_TOOLS;
  return {
    value,
    tool: allowed.has(envelope.params.name) ? envelope.params.name : null,
    arguments: args as Record<string, unknown>,
  };
}

function authorize(request: IncomingMessage, readerToken: string, reviewerToken: string | null, producerToken: string): Role | null {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !/^Bearer /i.test(header)) return null;
  const supplied = header.slice(header.indexOf(" ") + 1);
  if (tokensEqual(supplied, producerToken)) return "producer";
  if (reviewerToken && tokensEqual(supplied, reviewerToken)) return "reviewer";
  if (tokensEqual(supplied, readerToken)) return "reader";
  return null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function requireDriveId(value: string): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 200 || /\s/.test(value)) {
    throw new Error("AUTH_CONFIG_INVALID: report drive id is required");
  }
  return value;
}

function extractDocumentIds(body: Buffer, contentType: string | null): string[] {
  const candidates = contentType?.toLowerCase().includes("text/event-stream")
    ? body.toString("utf8").split(/\r?\n\r?\n/).flatMap((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()))
    : [body.toString("utf8")];
  for (const candidate of candidates) {
    try {
      const envelope = JSON.parse(candidate) as { result?: { isError?: boolean; structuredContent?: unknown; content?: Array<{ type?: unknown; text?: unknown }> } };
      let content = envelope.result?.structuredContent;
      if (content === undefined) {
        const text = envelope.result?.content?.find((entry) => entry.type === "text")?.text;
        if (typeof text === "string") content = JSON.parse(text);
      }
      const ids = (content as { documentIds?: unknown } | undefined)?.documentIds;
      if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) return ids;
    } catch { /* try the next SSE payload */ }
  }
  throw new Error("UPSTREAM_SCOPE_RESPONSE_INVALID");
}

function projectScopedList(snapshot:any,identities:boolean) {
 const {schemaVersion,driveId,branch,complete,documentIds,totalCount,hasMore,nextCursor,snapshotDigest}=snapshot;
 return {schemaVersion,driveId,branch,complete,documentIds,totalCount,hasMore,nextCursor,snapshotDigest,...(identities?{identities:snapshot.reports.map((row:any)=>({header:{id:row.documentId,name:row.name,documentType:"kilgore/report"},state:{global:{reportRef:row.reportRef,publication:row.publication}}}))}:{})};
}
/** Scale bridge C: full-Drive listing admission. The Reactor runs one PGlite query at a time and a client timeout does NOT stop
 * the query, so a listing past its deadline keeps the engine busy and every later request (point reads, V1, writes) queues
 * behind it. At most ONE listing is in flight (concurrent callers share its result); after a listing times out, new listings
 * are refused (listing_suspended, no automatic retry) for a doubling window (suspendMs .. 10 min) so orphaned queries cannot
 * pile up. Point reads, V1 and writes are never gated here. This cannot preempt the one orphan query already running.
 * Reader refreshes additionally reuse a recent completed snapshot (see below). */
function listingGate(upstream:string,driveId:string,timeoutMs:number,suspendMs:number,readerReuseMs:number){
 let inFlight:Promise<ReturnType<typeof validateReportSnapshot>>|null=null,suspendedUntil=0,backoff=0;
 let last:{snapshot:ReturnType<typeof validateReportSnapshot>;at:number;ms:number}|null=null;
 return async(reader=false)=>{
  // Coalesce repeated READER refreshes (display/legacy polling): a completed snapshot is reused for max(readerReuseMs, 2 x its
  // own duration), capped at 30 s, so polling cannot keep the single-connection engine busy. Producer listings (membership
  // checks of the listing publication path) are always fresh.
  if(reader&&readerReuseMs>0&&last&&Date.now()-last.at<Math.min(Math.max(readerReuseMs,2*last.ms),30_000))return last.snapshot;
  if(Date.now()<suspendedUntil)throw Error("LISTING_SUSPENDED");
  if(inFlight)return inFlight;
  const started=Date.now();
  inFlight=completeScopedSnapshot(upstream,driveId,timeoutMs).then(snapshot=>{backoff=0;last={snapshot,at:Date.now(),ms:Date.now()-started};return snapshot;},error=>{
   if((error as Error)?.name==="TimeoutError"||(error as Error)?.name==="AbortError"){backoff=Math.min(Math.max(backoff*2,suspendMs),600_000);suspendedUntil=Date.now()+backoff;}
   throw error;
  }).finally(()=>{inFlight=null;});
  return inFlight;
 };
}
async function completeScopedSnapshot(upstream:string,driveId:string,timeoutMs:number) {
 const result=await callUpstream(upstream,mcpBody("getReportLibraryMetadata",{parentId:driveId}),Math.min(timeoutMs,6000));
 if(result.status!==200)throw Error("UPSTREAM_SCOPE_RESPONSE_INVALID");
 return validateReportSnapshot(extractStructuredContent(result.body,result.contentType),driveId);
}

/** The running Registry deployment generation 'v1:<releaseId>:<modelDigest>:<bootId>' (native getRegistryDeploymentV1), or
 * 'unstable' when boot and current release/model differ (files changed under the running process). */
async function registryGeneration(upstream:string,driveId:string,timeoutMs:number):Promise<string>{
 const result=await callUpstream(upstream,mcpBody("getRegistryDeploymentV1",{}),Math.min(timeoutMs,5000));
 if(result.status!==200)throw Error("UPSTREAM_SCOPE_RESPONSE_INVALID");
 const d=object(object(extractStructuredContent(result.body,result.contentType))?.deployment);
 if(!d||d.schemaVersion!=="kapelle.registry-deployment.v1"||d.driveId!==driveId||typeof d.bootId!=="string"||typeof d.bootModelDigest!=="string")throw Error("UPSTREAM_SCOPE_RESPONSE_INVALID");
 if(d.releaseId!==d.bootReleaseId||d.currentModelDigest!==d.bootModelDigest||typeof d.bootReleaseId!=="string")return "unstable";
 return `v1:${d.bootReleaseId}:${d.bootModelDigest}:${d.bootId}`;
}

/** Native scoped selected-Report read, validated: null = not a current member of the configured Drive (or not provable). */
async function scopedDocumentRead(upstream:string,driveId:string,id:string,timeoutMs:number){
 const result=await callUpstream(upstream,mcpBody("getReportDocumentV1",{id}),Math.min(timeoutMs,6000));
 if(result.status!==200)throw Error("UPSTREAM_SCOPE_RESPONSE_INVALID");
 let read:any;try{read=object(object(extractStructuredContent(result.body,result.contentType))?.read);}catch{return null;}
 const header=object(object(read?.document)?.header),global=object(object(object(read?.document)?.state)?.global);
 if(!read||read.schemaVersion!=="kapelle.report-document-read.v1"||read.driveId!==driveId||read.documentId!==id||!header||header.id!==id||header.documentType!=="kilgore/report"||typeof header.name!=="string"
  ||!global||read.lifecycle!==global.lifecycle||read.revision!==global.revision||typeof read.blank!=="boolean"||typeof read.stamp!=="string"||!/^[a-f0-9]{64}$/.test(read.stamp))throw Error("UPSTREAM_SCOPE_RESPONSE_INVALID");
 return read as {schemaVersion:string;driveId:string;documentId:string;stamp:string;lifecycle:string;revision:number;blank:boolean;observedAt:string;document:{header:Record<string,unknown>;state:{global:Record<string,unknown>}}};
}

async function requireCurrentReportDocument(
  upstream: string,
  driveId: string,
  documentId: unknown,
  timeoutMs: number,
  expectedRevision?: number,
) {
  if (typeof documentId !== "string" || !UUID_PATTERN.test(documentId)) throw new Error("REVIEWER_SCOPE_FORBIDDEN");
  const checked = await callUpstream(upstream, mcpBody("getReportReviewScope", { id: documentId }), Math.min(timeoutMs, 5000));
  if (checked.status !== 200) throw new Error("UPSTREAM_REVALIDATION_FAILED");
  const scope = object(object(extractStructuredContent(checked.body, checked.contentType))?.scope);
  if (!scope || scope.schemaVersion !== "kapelle.report-review-scope.v1" || scope.driveId !== driveId || scope.documentId !== documentId || scope.lifecycle !== "FINAL" || !Number.isSafeInteger(scope.revision) || Number(scope.revision) < 1 || typeof scope.checkedAt !== "string" || !canonicalInstant(scope.checkedAt)) throw new Error("UPSTREAM_REVALIDATION_FAILED");
  if (expectedRevision !== undefined && expectedRevision !== scope.revision) throw new Error("REVIEWER_REVISION_CONFLICT");
  const fetched = await callUpstream(upstream, mcpBody("getDocument", { id: documentId }), timeoutMs);
  if (fetched.status !== 200) throw new Error("UPSTREAM_REVALIDATION_FAILED");
  const metadata = extractDocumentMetadata(fetched.body, fetched.contentType);
  if (metadata.id !== documentId || metadata.documentType !== "kilgore/report" || metadata.lifecycle !== "FINAL" || metadata.revision !== scope.revision) throw new Error("UPSTREAM_REVALIDATION_FAILED");
  // Recheck after fetching the selected body. Each addActions call performs its
  // own check; no read result/cursor is accepted as mutation authority.
  const rechecked = await callUpstream(upstream, mcpBody("getReportReviewScope", { id: documentId }), Math.min(timeoutMs, 5000));
  if (rechecked.status !== 200) throw new Error("UPSTREAM_REVALIDATION_FAILED");
  const after = object(object(extractStructuredContent(rechecked.body, rechecked.contentType))?.scope);
  if (!after || after.schemaVersion !== scope.schemaVersion || after.driveId !== driveId || after.documentId !== documentId || after.lifecycle !== "FINAL" || after.revision !== scope.revision || typeof after.checkedAt !== "string" || !canonicalInstant(after.checkedAt)) throw new Error("UPSTREAM_REVALIDATION_FAILED");
  return {fetched,membership:{schemaVersion:"kapelle.report-review-membership.v1",driveId,documentId,observedAt:after.checkedAt}};
}

function extractDocumentMetadata(
  body: Buffer,
  contentType: string | null,
): { id: string; documentType: string; lifecycle: string; revision: number } {
  const content = extractStructuredContent(body, contentType);
  const document = object(object(content)?.document);
  const header = object(document?.header);
  const state = object(object(document?.state)?.global);
  if (
    typeof header?.id !== "string"
    || typeof header.documentType !== "string"
    || typeof state?.lifecycle !== "string"
    || !Number.isSafeInteger(state?.revision) || Number(state?.revision) < 1
  ) {
    throw new Error("UPSTREAM_SCOPE_RESPONSE_INVALID");
  }
  return {
    id: header.id,
    documentType: header.documentType,
    lifecycle: state.lifecycle,
    revision: Number(state.revision),
  };
}

function extractStructuredContent(body: Buffer, contentType: string | null): unknown {
  const candidates = contentType?.toLowerCase().includes("text/event-stream")
    ? body.toString("utf8").split(/\r?\n\r?\n/).flatMap((event) => event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()))
    : [body.toString("utf8")];
  for (const candidate of candidates) {
    try {
      const envelope = JSON.parse(candidate) as { result?: { isError?: boolean; structuredContent?: unknown; content?: Array<{ type?: unknown; text?: unknown }> } };
      if (envelope.result?.isError) throw Error("UPSTREAM_SCOPE_RESPONSE_INVALID");
      if (envelope.result?.structuredContent !== undefined) return envelope.result.structuredContent;
      const text = envelope.result?.content?.find((entry) => entry.type === "text")?.text;
      if (typeof text === "string") return JSON.parse(text);
    } catch { /* try the next SSE payload */ }
  }
  throw new Error("UPSTREAM_SCOPE_RESPONSE_INVALID");
}

function mcpBody(name: string, args: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({
    jsonrpc: "2.0",
    id: `scope-${name}`,
    method: "tools/call",
    params: { name, arguments: args },
  }));
}

async function callUpstream(upstream: string, body: Buffer, timeoutMs: number) {
  const response = await fetch(upstream, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: body.toString("utf8"),
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error("RESPONSE_TOO_LARGE");
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await readBoundedResponse(response, MAX_RESPONSE_BYTES),
  };
}

function safeAudit(audit: (event: AuditEvent) => void, event: AuditEvent) {
  try { audit(event); } catch { /* audit transport cannot break authorization */ }
}

function writeAuditEvent(event: AuditEvent) {
  process.stdout.write(`${JSON.stringify({ event: "report_registry_mcp", ...event })}\n`);
}

function tokensEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function requireToken(role: Role, value: string): string {
  if (typeof value !== "string" || value.length < 32 || /\s/.test(value)) {
    throw new Error(`AUTH_CONFIG_INVALID: ${role} token must have at least 32 non-whitespace characters`);
  }
  return value;
}

function requireDistinctTokens(values: string[]) {
  for (let left = 0; left < values.length; left += 1) {
    for (let right = left + 1; right < values.length; right += 1) {
      if (tokensEqual(values[left], values[right])) {
        throw new Error("AUTH_CONFIG_INVALID: reader, reviewer, and producer tokens must be distinct");
      }
    }
  }
}

function requireOptionalReviewer(token: string | undefined, actorId: string | undefined): { token: string; actorId: string } | null {
  const hasToken = typeof token === "string" && token.length > 0;
  const hasActor = typeof actorId === "string" && actorId.length > 0;
  if (!hasToken && !hasActor) return null;
  if (!hasToken || !hasActor) throw new Error("AUTH_CONFIG_INVALID: reviewer token and actor id must be configured together");
  return { token: requireToken("reviewer", token!), actorId: requireActorId(actorId!) };
}

function requireActorId(value: string): string {
  if (typeof value !== "string" || value.length < 3 || value.length > 256 || value.trim() !== value || /\s/.test(value)) {
    throw new Error("AUTH_CONFIG_INVALID: reviewer actor id is required");
  }
  return value;
}

function requireLoopbackUpstream(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.username || url.password || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("AUTH_CONFIG_INVALID: upstream must be loopback HTTP");
  }
  if (url.pathname !== "/mcp" || url.search || url.hash) throw new Error("AUTH_CONFIG_INVALID: upstream path must be /mcp");
  return url.toString();
}

function readBoundedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => tooLarge ? reject(new Error("REQUEST_TOO_LARGE")) : resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("RESPONSE_TOO_LARGE");
    }
    chunks.push(Buffer.from(value));
  }
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>) {
  if (response.headersSent || response.destroyed) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export function startMcpAuthProxy() {
  const host = process.env.REPORT_REGISTRY_AUTH_BIND_HOST ?? DEFAULT_BIND_HOST;
  if (!["127.0.0.1", "::1"].includes(host)) throw new Error("AUTH_CONFIG_INVALID: proxy must bind to loopback");
  const port = Number(process.env.REPORT_REGISTRY_AUTH_BIND_PORT ?? DEFAULT_BIND_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AUTH_CONFIG_INVALID: invalid bind port");
  const server = createMcpAuthProxy({
    readerToken: process.env.REPORT_REGISTRY_READER_TOKEN ?? "",
    reviewerToken: process.env.REPORT_REGISTRY_REVIEWER_TOKEN,
    producerToken: process.env.REPORT_REGISTRY_PRODUCER_TOKEN ?? "",
    reviewerActorId: process.env.REPORT_REGISTRY_REVIEWER_ACTOR_ID,
    driveId: process.env.REPORT_REGISTRY_DRIVE_ID ?? "",
    requireWriteGeneration: process.env.REPORT_REGISTRY_REQUIRE_WRITE_GENERATION === "1",
    upstream: process.env.REPORT_REGISTRY_AUTH_UPSTREAM,
  });
  server.listen(port, host, () => process.stdout.write(`report-registry auth proxy listening on ${host}:${port}\n`));
  return server;
}

/** CLI-only lifecycle: authenticated requests already admitted retain normal upstream semantics. */
export function installProxyShutdown(server: Server) {
  let stopping = false;
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    shuttingDownServers.add(server);
    // Existing upstream timeout is15s; permit it to settle within Docker's30s stop bound.
    const deadline = setTimeout(() => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      process.stderr.write("proxy shutdown drain deadline exceeded\n");
      process.exit(1);
    }, 20_000);
    server.close((error) => {
      clearTimeout(deadline);
      process.exit(error ? 1 : 0);
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installProxyShutdown(startMcpAuthProxy());
}
