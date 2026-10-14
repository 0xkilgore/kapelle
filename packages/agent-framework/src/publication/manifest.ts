import { writerPolicyArtifactSchema, verifyWriterPolicy } from "./writer-policy.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { digest, proposalHash } from "../command-boundary.js";
import { assert, timestamp } from "../validation.js";
import type { Proposal } from "../../document-models/review-intent/v2/index.js";

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const git = z.string().regex(/^[a-f0-9]{40}$/);
const utc = z.string().refine((v) => {
  try {
    timestamp(v);
    return true;
  } catch {
    return false;
  }
});
const relativePath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      p.split("/").every((x) => x && x !== "." && x !== ".."),
  );
const domain = z
  .string()
  .max(253)
  .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/);
export const fileSchema = z
  .object({ path: relativePath, hash, bytes: z.number().int().nonnegative().max(20_000_000) })
  .strict();
const legacyTargetSchema = z
  .object({
    bindingRef: id,
    policyVersion: z.number().int().positive(),
    teamId: id,
    projectId: id,
    domains: z.array(domain).min(1).max(10),
    aliases: z
      .array(z.object({ domain, aliasId: id, deploymentId: id }).strict())
      .min(1)
      .max(10),
  })
  .strict();
const redirectStatus = z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]);
export const routeSchema = z.discriminatedUnion("kind", [
  z.object({ domain, kind: z.literal("direct") }).strict(),
  z
    .object({
      domain,
      kind: z.literal("redirect"),
      destination: domain,
      configuredStatus: redirectStatus.nullable(),
      status: redirectStatus,
      pathPolicy: z.literal("preserve-path-and-query"),
    })
    .strict(),
]);
export const routingSchema = z
  .object({
    contract: z.literal("kapelle/vercel-routing/v1"),
    projectDomains: z.array(domain).min(1).max(10),
    deploymentAliases: z.array(domain).min(1).max(10),
    productionAliases: z.array(domain).min(1).max(10),
    routes: z.array(routeSchema).min(1).max(10),
  })
  .strict();
export type WebsiteRoute = z.infer<typeof routeSchema>;
export type WebsiteRouting = z.infer<typeof routingSchema>;
const routedTargetSchema = legacyTargetSchema.extend({ routing: routingSchema }).strict();
export const targetSchema = z.union([legacyTargetSchema, routedTargetSchema]);
export type WebsiteTarget = z.infer<typeof targetSchema>;
export function canonicalTarget(raw: unknown): WebsiteTarget {
  const t = targetSchema.parse(raw);
  t.domains.sort();
  t.aliases.sort((a, b) => a.domain.localeCompare(b.domain, "en"));
  assert(
    new Set(t.domains).size === t.domains.length &&
      new Set(t.aliases.map((a) => a.domain)).size === t.aliases.length,
    "Duplicate publication domain",
  );
  assert(
    JSON.stringify(t.domains) === JSON.stringify(t.aliases.map((a) => a.domain)),
    "Alias set differs from bound domains",
  );
  if ("routing" in t) {
    const r = t.routing;
    for (const names of [r.projectDomains, r.deploymentAliases, r.productionAliases]) {
      names.sort();
      assert(
        new Set(names).size === names.length && names.every((n) => t.domains.includes(n)),
        "Invalid routing inventory",
      );
    }
    r.routes.sort((a, b) => a.domain.localeCompare(b.domain, "en"));
    assert(
      JSON.stringify(r.routes.map((v) => v.domain)) === JSON.stringify(t.domains),
      "Route set differs from bound aliases",
    );
    assert(
      JSON.stringify([...new Set([...r.projectDomains, ...r.deploymentAliases])].sort()) ===
        JSON.stringify(t.domains),
      "Unclassified project alias",
    );
    assert(
      new Set(t.aliases.map((a) => a.aliasId)).size === t.aliases.length &&
        new Set(t.aliases.map((a) => a.deploymentId)).size === 1,
      "Routing requires one production deployment and distinct alias IDs",
    );
    for (const route of r.routes) {
      if (route.kind === "redirect") {
        assert(
          r.projectDomains.includes(route.domain) &&
            r.routes.some((v) => v.domain === route.destination && v.kind === "direct"),
          "Redirect destination must be a bound direct domain; chains and loops are unsupported",
        );
        assert(
          route.configuredStatus === null || route.configuredStatus === route.status,
          "Redirect effective status differs from configured status",
        );
      } else if (!r.projectDomains.includes(route.domain)) {
        assert(
          route.domain.endsWith(".vercel.app"),
          "Non-project alias must be a generated Vercel alias",
        );
      }
    }
  }
  return t;
}
const legacyManifestSchema = z
  .object({
    contract: z.literal("kapelle/website-publication/v1"),
    ownerId: id,
    scopeRef: id,
    generation: z.number().int().positive(),
    originDispatch: z.object({ documentId: id, contentHash: hash }).strict().optional(),
    expiresAt: utc,
    report: z
      .object({
        id,
        reportRef: id,
        sourceRef: z.string().min(1).max(500),
        contentHash: hash,
        bytes: z.number().int().positive().max(1_000_000),
      })
      .strict(),
    source: z
      .object({
        repoRef: id,
        commit: git,
        tree: git,
        files: z.array(fileSchema).min(1).max(100),
        lockfile: fileSchema,
      })
      .strict(),
    build: z
      .object({
        receiptRef: id,
        receiptHash: hash,
        outputHash: hash,
        recipeRef: id,
        environment: z.literal("production"),
        stagedDeploymentId: id.optional(),
        staging: z.object({ receiptRef: id, receiptHash: hash }).strict().optional(),
        siteFiles: z.array(fileSchema).min(1).max(20),
      })
      .strict(),
    target: legacyTargetSchema,
    task: z
      .object({ managerTaskRef: id, authorityRef: id, authorityTaskRef: id, commitmentHash: hash })
      .strict(),
  })
  .strict();
const manifestSchema = z.discriminatedUnion("contract", [
  legacyManifestSchema,
  legacyManifestSchema
    .extend({ contract: z.literal("kapelle/website-publication/v2"), target: routedTargetSchema })
    .strict(),
  legacyManifestSchema.extend({
    contract: z.literal("kapelle/website-publication/v3"),
    target: routedTargetSchema,
    writerPolicy: writerPolicyArtifactSchema,
  }).strict(),
]);
export type PublicationManifest = z.infer<typeof manifestSchema>;
export const bytesHash = (bytes: Uint8Array | string) =>
  "sha256:" + createHash("sha256").update(bytes).digest("hex");
export function publicationManifest(raw: unknown): PublicationManifest {
  const m = manifestSchema.parse(raw);
  if (m.contract === "kapelle/website-publication/v3") {
    m.writerPolicy = verifyWriterPolicy(m.writerPolicy);
    assert(m.writerPolicy.policy.teamId === m.target.teamId &&
      m.writerPolicy.policy.projectId === m.target.projectId,
    "Writer policy target differs from publication");
  }
  assert(
    Boolean(m.build.stagedDeploymentId) === Boolean(m.build.staging),
    "Staged deployment requires an exact trusted staging receipt binding",
  );
  m.target = canonicalTarget(m.target);
  m.source.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert(
    new Set(m.source.files.map((f) => f.path)).size === m.source.files.length,
    "Duplicate publication file",
  );
  assert(!m.source.files.some((f) => f.path === m.source.lockfile.path), "Lockfile listed twice");
  m.build.siteFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert(
    new Set(m.build.siteFiles.map((f) => f.path)).size === m.build.siteFiles.length,
    "Duplicate site proof file",
  );
  return m;
}
export function publicationArtifact(raw: unknown) {
  const manifest = publicationManifest(raw),
    contentHash = digest(manifest);
  function freeze(value: unknown) {
    if (value && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
  }
  const artifact = { manifest, id: "publication:" + contentHash.slice(7), version: 1, contentHash };
  freeze(artifact);
  return artifact;
}
export function publicationProposal(raw: unknown): Proposal {
  const a = publicationArtifact(raw),
    m = a.manifest;
  const p: Proposal = {
    version: m.generation,
    contentHash: "",
    contentRef: a.id,
    contentVersion: a.version,
    artifactHash: a.contentHash,
    expiresAt: m.expiresAt,
    effectKind: "WEBSITE_PUBLICATION",
    action: "publish",
    targets: [
      {
        documentRef: m.target.bindingRef,
        revision: m.target.policyVersion,
        contentHash: digest(m.target),
      },
    ],
    senderConnectionRef: null,
    recipients: [],
  };
  p.contentHash = proposalHash(p);
  return p;
}
