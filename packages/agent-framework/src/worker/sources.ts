import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import { isAbsolute } from "node:path";
import { DefinitionReleaseSchema } from "../../document-models/agent-definition/v1/index.js";
import { releaseHash } from "../command-boundary.js";
import type { Facts } from "../service/authority.js";
import { boundedJson, localOrigin, sha, sourceSchema, type Source } from "./contracts.js";

export class ReportSourceClient {
  readonly origin: string;
  constructor(
    url: string,
    readonly token: () => string,
    readonly ownerId: string,
    readonly scopeRef: string,
    readonly fetcher: typeof fetch = fetch,
  ) {
    this.origin = localOrigin(url);
  }
  async inbox(agentId:string):Promise<Source[]> {
    const token=this.token();if(token.length<32)throw Error('source_not_configured');
    const r=await this.fetcher(`${this.origin}/api/internal/framework/source?agentId=${encodeURIComponent(agentId)}`,{headers:{authorization:`Bearer ${token}`},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error('source_unavailable');
    const envelope=z.object({ok:z.literal(true),ownerId:z.literal(this.ownerId),scopeRef:z.literal(this.scopeRef),agentId:z.literal(agentId),documents:z.array(sourceSchema).max(32)}).strict().parse(await boundedJson(r,9000000));
    if(new Set(envelope.documents.map(d=>d.id)).size!==envelope.documents.length)throw Error('duplicate_sources');
    return envelope.documents;
  }
  async read(id: string): Promise<Source> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error("invalid_source");
    const token = this.token();
    if (token.length < 32) throw Error("source_not_configured");
    const r = await this.fetcher(
      `${this.origin}/api/internal/framework/source?documentId=${encodeURIComponent(id)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!r.ok) throw Error("source_unavailable");
    const envelope = z
      .object({
        ok: z.literal(true),
        ownerId: z.literal(this.ownerId),
        scopeRef: z.literal(this.scopeRef),
        document: sourceSchema,
      })
      .strict()
      .parse(await boundedJson(r));
    if (envelope.document.id !== id) throw Error("source_identity_mismatch");
    return envelope.document;
  }
}
const ref = z
  .object({
    id: z.string(),
    version: z.string(),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const asset = z.object({ ref, path: z.string().min(1) }).strict();
const commonBinding = {
  ref:z.string(), agent:z.string(), instanceId:z.string(),
  contract:z.literal('kapelle.document-review/v1'), modelProfile:z.string(), model:z.string().min(1),
  maxInputBytes:z.number().int().min(100).max(64000),
  maxOutputTokens:z.number().int().min(1).max(4096), budgetRef:z.string(),
};
const bindingSchema = z.union([
  z.object({...commonBinding,modelUrl:z.string(),runtime:z.literal('local-qwen').optional()}).strict(),
  z.object({...commonBinding,runtime:z.literal('claude-agent-sdk'),credentialTeamId:z.string().uuid(),
    maxOutputTokens:z.number().int().min(1).max(16384),
    credentialKind:z.literal('claude-code-oauth'),maxBudgetUsd:z.number().positive().max(10),
    timeoutMs:z.number().int().min(1000).max(300000)}).strict(),
]);
const profileSchema = z
  .object({
    ownerId: z.string().min(1),
    scopeRef: z.string().min(1),
    expiresAt: z.iso.datetime(),
    documentIds: z.array(z.string().uuid()).max(32),
    inboxDocumentIds: z.array(z.string().uuid()).max(32).default([]),
    inboxAgents: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/)).max(10).default([]),
    releases: z
      .array(
        z.object({ release: DefinitionReleaseSchema(), assets: z.array(asset).max(32) }).strict(),
      )
      .max(10),
    bindings: z
      .array(
        bindingSchema,
      )
      .max(10),
  })
  .strict();
export type WorkerProfile = z.infer<typeof profileSchema>;
/** Owner-authored admission file. No request may supply releases, bindings or permissions. */
export async function privateText(path: string, limit = 262144, privateRequired = true) {
  if (!isAbsolute(path)) throw Error("absolute_file_required");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    if (
      !s.isFile() ||
      s.size > limit ||
      (s.mode & (privateRequired ? 0o077 : 0o022)) !== 0 ||
      s.uid !== process.getuid?.()
    )
      throw Error("private_file_required");
    const bytes = await file.readFile();
    if (bytes.length > limit) throw Error("private_file_too_large");
    return bytes.toString("utf8");
  } finally {
    await file.close();
  }
}
export class ProductionSources {
  constructor(
    readonly profilePath: string,
    readonly ownerId: string,
    readonly scopeRef: string,
    readonly reports: ReportSourceClient,
    readonly now = () => new Date().toISOString(),
  ) {}
  async profile() {
    const p = profileSchema.parse(JSON.parse(await privateText(this.profilePath)));
    if (p.ownerId !== this.ownerId || p.scopeRef !== this.scopeRef || p.expiresAt <= this.now())
      throw Error("profile_scope_or_expiry");
    if (
      new Set([...p.documentIds,...p.inboxDocumentIds]).size !== p.documentIds.length+p.inboxDocumentIds.length ||
      p.documentIds.length+p.inboxDocumentIds.length > 32 ||
      new Set(p.bindings.map((b) => b.ref)).size !== p.bindings.length ||
      new Set(p.bindings.map((b) => b.instanceId)).size !== p.bindings.length
    )
      throw Error("profile_duplicates");
    for (const b of p.bindings) if (b.runtime !== 'claude-agent-sdk') localOrigin(b.modelUrl);
    if(new Set(p.inboxAgents).size!==p.inboxAgents.length || p.inboxAgents.some(a=>p.bindings.filter(b=>b.agent===a).length!==1))throw Error("inbox_binding_invalid");
    for (const entry of p.releases) {
      if (releaseHash(entry.release) !== entry.release.contentHash)
        throw Error("release_integrity");
      for (const r of [
        entry.release.instructions,
        ...entry.release.skills,
        ...entry.release.qualificationFixtures,
      ])
        await this.asset(entry, r);
    }
    return p;
  }
  async asset(entry: WorkerProfile["releases"][number], reference: z.infer<typeof ref>) {
    const matches = entry.assets.filter(
      (a) =>
        a.ref.id === reference.id &&
        a.ref.version === reference.version &&
        a.ref.contentHash === reference.contentHash,
    );
    if (matches.length !== 1) throw Error("package_asset_missing");
    const bytes = await privateText(matches[0].path, 262144, false);
    if ("sha256:" + sha(bytes) !== reference.contentHash) throw Error("package_asset_integrity");
    return bytes;
  }
  async accepted(p:WorkerProfile){
    const items=[];
    for(const agent of p.inboxAgents){
      const binding=p.bindings.find(b=>b.agent===agent)!;
      for(const source of await this.reports.inbox(agent))items.push({source,instanceId:binding.instanceId,expiresAt:p.expiresAt});
    }
    const ids=[...p.documentIds,...p.inboxDocumentIds,...items.map(i=>i.source.id)];
    if(new Set(ids).size!==ids.length)throw Error('duplicate_sources');
    return items;
  }
  async read(id: string) {
    const p = await this.profile();
    if ([...p.documentIds,...p.inboxDocumentIds].includes(id))return this.reports.read(id);
    const found=(await this.accepted(p)).find(i=>i.source.id===id);
    if(!found)throw Error('source_not_admitted');
    return found.source;
  }
  async facts(): Promise<Facts> {
    const p = await this.profile();
    const accepted=await this.accepted(p);
    const sources = accepted.map(i=>i.source);
    // Bounded explicit admission; never crawl the library or send unrelated documents to a model.
    for (const id of [...p.documentIds,...p.inboxDocumentIds]) sources.push(await this.reports.read(id));
    return {
      inboxReviews:accepted.map(i=>({documentId:i.source.id,instanceId:i.instanceId,revision:i.source.version,contentHash:'sha256:'+i.source.hash,expiresAt:i.expiresAt})),
      definitions: p.releases.map((e) => ({ release: e.release, qualified: true })),
      resources: sources.map((s) => ({
        id: s.id,
        resourceType: (p.inboxDocumentIds.includes(s.id)||accepted.some(i=>i.source.id===s.id)) ? "inbox-review" : "report",
        revision: s.version,
        contentHash: "sha256:" + s.hash,
        allowedActions: ["read"],
      })),
      artifacts: sources.map((s) => ({
        id: s.id,
        version: s.version,
        contentHash: "sha256:" + s.hash,
      })),
      runtimeBindingRefs: p.bindings.map((b) => b.ref),
      runtimeBindingContracts: Object.fromEntries(p.bindings.map((b) => [b.ref, b.contract])),
      budgetPolicyRefs: p.bindings.map((b) => b.budgetRef),
      connectionRefs: [],
      scheduleRefs: [],
      effects: [],
      deliveryReceipts: [],
    };
  }
}
