import type { KitHost } from "../agent-kit/kit-host.js";
import {TaskGenerations} from '../task-delegation/generations.js';
import { TaskProposals } from "../task-delegation/proposals.js";
import { TaskDelegations } from "../task-delegation/adapter.js";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { FrameworkAuthority } from "./authority.js";
import { assert } from "../validation.js";
const dispatchPhase = z.enum(["OFFERED", "ACCEPTED", "CANCEL_REQUESTED", "RESULT_RECORDED"]);
const dispatchListQuery = z.object({
  // Increment 2 §2.3: recipient OR an exact Task (taskRef) or both; a Task query also finds historical recipients.
  recipient: z.string().min(1).max(200).optional(),
  taskRef: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).optional(),
  phase: z.string().max(80).optional().transform((v) => (v ? v.split(",").map((p) => dispatchPhase.parse(p.trim())) : undefined)),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().min(1).max(512).optional(),
}).strict().refine((q) => q.recipient !== undefined || q.taskRef !== undefined, "recipient or taskRef required");
const type = z.enum([
  "kapelle/agent-definition",
  "kapelle/agent-instance",
  "kapelle/review-intent",
  "kapelle/dispatch",
]);
const allocate = z
  .object({
    operationId: z.string().min(1).max(200),
    documentType: type,
    name: z.string().min(1).max(150),
    modelVersion: z.number().int().min(1).max(3).optional(),
  })
  .strict();
const admission = z
  .object({
    instanceId: z.string().min(1).max(200),
    documentId: z.string().min(1).max(200),
    revision: z.number().int().min(0),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
/** Agent kit (slice 3b): optional host for the owner's New agent -> review -> Create agent flow. */
export function frameworkHandler(authority: FrameworkAuthority, token: () => string, kit: () => KitHost | null = () => null, hostedSpend?: () => unknown) {
  const tasks = new TaskDelegations(authority);
  const proposals = new TaskProposals(authority,tasks);
  const generations = new TaskGenerations(authority);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      });
      res.end(JSON.stringify(data));
    };
    const secret = token(),
      actual = Buffer.from(req.headers.authorization ?? ""),
      expected = Buffer.from(`Bearer ${secret}`);
    if (
      secret.length < 32 ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    )
      return reply(403, { ok: false, error: "forbidden" });
    if (req.headers["x-id-team"] || req.headers["x-id-owner"] || req.headers["x-id-admin"])
      return reply(403, { ok: false, error: "caller_identity_not_supported" });
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (authority.journal.readOnly && !(req.method === 'GET' &&
        (url.pathname === '/health' || url.pathname === '/pilot-native-observation')))
        return reply(403, { ok: false, error: 'observation_only' });
      if (url.pathname === '/pilot-native-observation') {
        if (req.method !== 'GET' || url.search || req.headers['transfer-encoding'] ||
          (req.headers['content-length'] && req.headers['content-length'] !== '0'))
          return reply(400, { ok: false, error: 'invalid_request' });
        return reply(200, { ok: true, ...(await authority.observePilotNative()) });
      }
      if(req.method==="GET" && url.pathname.startsWith("/task-proposals/operations/")){
        const item=await proposals.lookup(decodeURIComponent(url.pathname.slice("/task-proposals/operations/".length)));
        return item?reply(200,{ok:true,item}):reply(404,{ok:false,error:"not_found"});
      }
      if(req.method==="GET" && url.pathname.startsWith("/task-proposals/"))return reply(200,{ok:true,item:await proposals.read(decodeURIComponent(url.pathname.slice("/task-proposals/".length)))});
      if (url.pathname.startsWith("/agents/")) {
        const k = kit();
        if (!k) return reply(404, { ok: false, error: "agent_kit_not_installed" });
        if (req.method === "GET" && url.pathname === "/agents/templates")
          return reply(200, { ok: true, items: [{ id: "example-org", label: "Example Park", summary: "Website event/page drafts, newsletter and notes drafts. Never sends, deploys or changes source records." }] });
        if (req.method === "GET" && url.pathname === "/agents/options") return reply(200, { ok: true, ...k.options() });
        // CP agent launch: Ops-readable hosted spend (caps, settled, open, unsettled incl. carried months). Read-only.
        if (req.method === "GET" && url.pathname === "/agents/spend")
          return hostedSpend ? reply(200, { ok: true, spend: hostedSpend() }) : reply(404, { ok: false, error: "hosted_runtime_not_installed" });
        const snap = /^\/agents\/snapshots\/(sha256:[a-f0-9]{64})$/.exec(url.pathname);
        if (req.method === "GET" && snap) return reply(200, { ok: true, ...k.readSnapshot(snap[1]) });
        const files = /^\/agents\/([^/]+)\/files$/.exec(url.pathname);
        if (req.method === "GET" && files) return reply(200, { ok: true, files: k.latestFiles(decodeURIComponent(files[1])) });
        const profile = /^\/agents\/([^/]+)\/profile$/.exec(url.pathname);
        if (req.method === "GET" && profile) return reply(200, { ok: true, ...(await k.profile(decodeURIComponent(profile[1]))) });
        const availability = /^\/agents\/([^/]+)\/availability$/.exec(url.pathname);
        if (req.method === "GET" && availability) return reply(200, { ok: true, ...(await k.describe(decodeURIComponent(availability[1]))) });
      }
      if (req.method === "GET" && url.pathname === "/task-delegations/agents")
        return reply(200, {ok:true, ...(await authority.taskDelegationAgents(url.searchParams.get("taskId")??"",
          // Agent kit: the draft's operation id + the plan's expiry (both bound by the plan hash) yield the planned pin + grantPlan.
          url.searchParams.has("operationId") ? {...z.object({ operationId: z.string().uuid(), expiresAt: z.iso.datetime() }).strict().parse({
            operationId: url.searchParams.get("operationId"), expiresAt: url.searchParams.get("expiresAt") }),
            // AGENT-MODEL-V2: the frozen source for ONE agent's plan, resolved from the host's own manifest store (never the browser's).
            ...(url.searchParams.has("manifestHash") ? (() => { const k = kit(); assert(k, "kit_not_installed");
              return { instanceId: z.string().min(1).max(200).parse(url.searchParams.get("instanceId")), source: k!.sourceOf(z.string().parse(url.searchParams.get("manifestHash"))) }; })() : {}) } : undefined))});
      if (req.method === "GET" && url.pathname.startsWith("/task-delegations/")) {
        const item = await tasks.lookup(decodeURIComponent(url.pathname.slice("/task-delegations/".length)));
        return item ? reply(200, {ok:true,item}) : reply(404, {ok:false,error:"not_found"});
      }
      if (req.method === "GET" && url.pathname === "/health")
        return reply(200, {
          ok: true,
          contract: "kapelle-framework/v1",
          scopeRef: authority.options.scopeRef,
        });
      if (req.method === "GET" && url.pathname === "/instances") {
        const items = await authority.listInstances(), k = kit();
        // With the kit installed, each item carries its stable kit identity (definition + launch-policy classification).
        if (!k) return reply(200, { ok: true, items });
        const ids = await k.identities(items as never);
        return reply(200, { ok: true, items: items.map((item, i) => ({ ...(item as object), kit: ids[i] })) });
      }
      if (req.method === "GET" && url.pathname === "/dispatches") {
        // G1: read-only Dispatch records by recipient. Bounded page, explicit completeness,
        // owner/scope enforced inside the authority. No execution state is implied.
        const q = dispatchListQuery.parse({
          recipient: url.searchParams.get("recipient") ?? undefined,
          taskRef: url.searchParams.get("taskRef") ?? undefined,
          phase: url.searchParams.get("phase") ?? undefined,
          limit: url.searchParams.get("limit") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
        });
        return reply(200, { ok: true, ...(await authority.listDispatches({ recipient: q.recipient, taskRef: q.taskRef, phases: q.phase, limit: q.limit, cursor: q.cursor ?? null })) });
      }
      if (req.method === "GET" && url.pathname.startsWith("/operations/"))
        return reply(200, {
          ok: true,
          ...(await authority.receipt(decodeURIComponent(url.pathname.slice(12)))),
        });
      if (req.method === "GET" && url.pathname.startsWith("/documents/"))
        return reply(200, {
          ok: true,
          document: await authority.read(
            decodeURIComponent(url.pathname.slice(11)),
            type.parse(url.searchParams.get("type")),
          ),
        });
      if (req.method !== "POST") return reply(404, { ok: false, error: "not_found" });
      if (!(req.headers["content-type"] ?? "").startsWith("application/json"))
        return reply(415, { ok: false, error: "json_required" });
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 262144) return reply(413, { ok: false, error: "request_too_large" });
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const lifecycle = /^\/agents\/([^/]+)\/(pause|resume|retire)$/.exec(url.pathname);
      if (lifecycle) {
        const k = kit();
        if (!k) return reply(404, { ok: false, error: "agent_kit_not_installed" });
        return reply(200, { ok: true, item: await k.lifecycle(decodeURIComponent(lifecycle[1]), lifecycle[2] as "pause" | "resume" | "retire", body) });
      }
      if (url.pathname === "/agents/snapshot") {
        const k = kit();
        if (!k) return reply(404, { ok: false, error: "agent_kit_not_installed" });
        return reply(200, { ok: true, ...(await k.snapshot(body)) });
      }
      if (url.pathname === "/agents/preview" || url.pathname === "/agents/create") {
        const k = kit();
        if (!k) return reply(404, { ok: false, error: "agent_kit_not_installed" });
        return url.pathname === "/agents/preview" ? reply(200, { ok: true, ...k.preview(body) }) : reply(200, { ok: true, item: await k.create(body) });
      }
      if(url.pathname==="/task-proposals")return reply(200,{ok:true,item:await proposals.create(body)});
      const generationRoute=/^\/task-proposals\/([^/]+)\/generation-requests(?:\/([^/]+)\/run)?$/.exec(url.pathname);
      if(generationRoute){
        if(generationRoute[2]){z.object({}).strict().parse(body);return reply(200,{ok:true,item:await generations.run(generationRoute[1],generationRoute[2])});}
        return reply(200,{ok:true,item:await generations.request(generationRoute[1],body)});
      }
      const planRoute=/^\/task-proposals\/([^/]+)\/(revisions|approve-and-send)$/.exec(url.pathname);
      if(planRoute)return planRoute[2]==="revisions"?reply(200,{ok:true,item:await proposals.revise(planRoute[1],body)}):reply(200,{ok:true,...await proposals.approveAndSend(planRoute[1],body)});
      if (url.pathname === "/task-delegations") return reply(200, {ok:true,item:await tasks.submit(body)});
      if (url.pathname === "/allocate") {
        const i = allocate.parse(body);
        return reply(200, {
          ok: true,
          ...(await authority.allocate(i.operationId, i.documentType, i.name, i.modelVersion)),
        });
      }
      if (url.pathname === "/commands") {
        if (["RESERVE_EFFECT", "CLAIM_EXECUTION", "RECORD_DELIVERY", "REQUEST_TASK_GENERATION", "CLAIM_TASK_GENERATION", "RECORD_TASK_GENERATION"].includes(body?.type))
          return reply(403, { ok: false, error: "execution_credential_required" });
        return reply(200, { ok: true, ...(await authority.command(body)) });
      }
      if (url.pathname === "/inbox-review/grant")
        return reply(200, {
          ok: true,
          admission: await authority.grantInboxReview(admission.parse(body)),
        });
      if (url.pathname === "/admission")
        return reply(200, {
          ok: true,
          admission: await authority.admission(admission.parse(body)),
        });
      return reply(404, { ok: false, error: "not_found" });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return reply(400, { ok: false, error: "invalid_request" });
      const message = error instanceof Error ? error.message : "";
      // Only bounded domain rejections are returned. Do not expose filesystem/DB errors or credentials.
      if (/^Task (acceptance uncertain|authority unavailable|delegation is not configured|authority not configured)/.test(message)) return reply(503, {ok:false,error:message});
      const known =
        /^(creation_|kit_|template_|Task |Wrong |Invalid |Unknown |Stale |Instance |Source |Definition |Runtime |Paid |External effect |Operation ID conflicts|Allocation conflict|A saved native operation|Document unavailable|Operation not found|Authenticated owner|Actor, timestamp|Unknown or unsupported|Release identity|Model profile|Capability |Grant |Budget |Fallback |Qualified migration|Target |Proposal |Scope exceeds)/.test(
          message,
        );
      reply(known ? 409 : 503, { ok: false, error: known ? message : "authority_unavailable" });
    }
  };
}
