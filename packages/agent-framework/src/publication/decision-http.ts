import { taskResultContextEnvelope } from "./task-result-context.js";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { canonical, digest, type Command } from "../command-boundary.js";
import type { FrameworkAuthority } from "../service/authority.js";
import { assert, opaque } from "../validation.js";
import { publicationArtifact, publicationProposal } from "./manifest.js";

const id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const decision = z.object({
  operationId: id, documentId: id, documentType: z.literal("kapelle/review-intent"),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  type: z.literal("RECORD_DECISION"),
  input: z.object({ proposalHash: hash, proposalVersion: z.number().int().positive(),
    approved: z.boolean(), reason: z.string().max(4000).nullable() }).strict(),
}).strict();
class Denied extends Error {}

/** Owner decision credential, one installed native review. No new persistence:
 * receipt proof is read from the existing native prepared-command journal.
 * Mount on a private listener with a distinct owner-session bridge token.
 * Never give this credential to a worker or publication executor.
 */
export function publicationDecisionHandler(authority: FrameworkAuthority, config: {
  token: () => string; manifest: unknown; reviewDocumentId: string; instanceId: string;
  taskResultContext?: import("./task-result-context.js").TaskResultContextReader;
  readPublicationStatus?: () => Promise<unknown>;
  decisionRecorded?: () => void;
}) {
  const artifact = publicationArtifact(config.manifest), manifest = artifact.manifest;
  const proposal = publicationProposal(manifest);
  const reviewId = config.reviewDocumentId, instanceId = config.instanceId;
  opaque(reviewId); opaque(instanceId);
  assert(authority.options.ownerId === manifest.ownerId && authority.options.scopeRef === manifest.scopeRef,
    "Publication decision authority identity differs");
  const contextBinding = config.taskResultContext?.binding;
  if (contextBinding) assert(contextBinding.ownerId === manifest.ownerId && contextBinding.scopeRef === manifest.scopeRef &&
    contextBinding.reviewId === reviewId && contextBinding.proposalHash === proposal.contentHash &&
    contextBinding.report.id === manifest.report.id && contextBinding.report.contentHash === manifest.report.contentHash &&
    contextBinding.task.id === manifest.task.authorityTaskRef && contextBinding.task.authorityRef === manifest.task.authorityRef &&
    contextBinding.task.commitmentHash === manifest.task.commitmentHash, "Task result context host binding differs");
  const bound = (command: Command) => {
    if (command.documentId !== reviewId || command.documentType !== "kapelle/review-intent"
      || command.type !== "RECORD_DECISION" || command.input.proposalHash !== proposal.contentHash
      || command.input.proposalVersion !== proposal.version) throw new Denied();
  };
  const entry = (operationId: string) => {
    const saved = authority.journal.get(operationId);
    if (saved) {
      bound(saved.command);
      assert(saved.requestHash === digest({ownerId:manifest.ownerId,scopeRef:manifest.scopeRef,command:saved.command}),
        "Publication decision receipt identity differs");
    }
    return saved;
  };
  const read = async () => {
    const document = await authority.read(reviewId, "kapelle/review-intent"), state = document.state.global;
    if (document.state.document.version !== 2 || !("proposal" in state)
      || state.ownerId !== manifest.ownerId || state.scopeRef !== manifest.scopeRef
      || state.instanceId !== instanceId || canonical(state.proposal) !== canonical(proposal)) throw new Denied();
    return document;
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, {"content-type":"application/json","cache-control":"private, no-store"});
      res.end(JSON.stringify(value));
    };
    const token = config.token(), actual = Buffer.from(req.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
    if (token.length < 32 || actual.length !== expected.length || !timingSafeEqual(actual, expected)
      || req.headers["x-id-owner"] || req.headers["x-id-team"] || req.headers["x-id-admin"])
      return reply(403, {ok:false,error:"forbidden"});
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/task-result-context") {
        if (req.method !== "GET" || url.search || req.headers.origin) throw new Denied();
        if (!config.taskResultContext) return reply(503, {ok:false,error:"task_result_context_unbound"});
        const context = await config.taskResultContext.read();
        return reply(200, taskResultContextEnvelope(context));
      }
      if (req.method === "GET" && url.pathname === "/health") return reply(200,
        {ok:true,contract:"kapelle-publication-decisions/v1",ownerId:manifest.ownerId,scopeRef:manifest.scopeRef,reviewDocumentId:reviewId});
      if (req.method === "GET" && url.pathname === "/publication-status" && !url.search && config.readPublicationStatus)
        return reply(200, {ok:true,status:await config.readPublicationStatus()});
      if (req.method === "GET" && url.pathname.startsWith("/documents/")) {
        if (decodeURIComponent(url.pathname.slice(11)) !== reviewId || url.searchParams.get("type") !== "kapelle/review-intent") throw new Denied();
        return reply(200, {ok:true,document:await read()});
      }
      if (req.method === "GET" && url.pathname.startsWith("/operations/")) {
        const operationId = id.parse(decodeURIComponent(url.pathname.slice(12))), saved = entry(operationId);
        if (!saved) return reply(409, {ok:false,error:"Operation not found"});
        const receipt = await authority.receipt(operationId);
        return reply(200, {ok:true,...receipt,requestHash:saved.requestHash});
      }
      if (req.method !== "POST" || url.pathname !== "/commands") return reply(403, {ok:false,error:"forbidden"});
      if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return reply(415, {ok:false,error:"json_required"});
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 24576) return reply(413, {ok:false,error:"request_too_large"}); chunks.push(Buffer.from(chunk)); }
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (raw?.type !== "RECORD_DECISION") throw new Denied();
      const command = decision.parse(raw); bound(command);
      if (!command.input.approved && !command.input.reason?.trim()) return reply(400, {ok:false,error:"changes_reason_required"});
      // Accepted recovery must work without today's document projection/facts.
      // The journal hash binds original owner/scope/command; command() checks
      // the exact payload again and returns the original native receipt.
      if (!entry(command.operationId)) await read();
      const receipt = await authority.command(command), saved = entry(command.operationId);
      assert(saved, "Publication decision receipt unavailable");
      if (receipt.result.disposition === "ACCEPTED") config.decisionRecorded?.();
      return reply(200, {ok:true,...receipt,requestHash:saved.requestHash});
    } catch (error) {
      if (error instanceof Denied) return reply(403, {ok:false,error:"forbidden"});
      if (error instanceof z.ZodError || error instanceof SyntaxError || error instanceof URIError)
        return reply(400, {ok:false,error:"invalid_request"});
      const message = error instanceof Error ? error.message : "";
      const known = /^(Wrong |Invalid |Stale |Instance |Source |Definition |Runtime |Operation ID conflicts|A saved native operation|Document unavailable|Operation not found|Authenticated owner|Actor, timestamp|Target |Proposal |Grant |Capability )/.test(message);
      return reply(known ? 409 : 503, {ok:false,error:known ? message : "decision_authority_unavailable"});
    }
  };
}
