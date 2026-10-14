import { DatabaseSync } from "node:sqlite";
import { digest, canonical, releaseHash } from "../src/command-boundary.js";
import { PublicationFactsAdapter, type BuildReceipt } from "../src/publication/facts.js";
import { bytesHash, publicationManifest, type WebsiteTarget } from "../src/publication/manifest.js";
import {
  type DispatchBinding,
  type DispatchIntent,
  type PublicationDispatch,
  type PublicationProvider,
  type ProviderReceipt,
} from "../src/publication/effects.js";
import { assert } from "../src/validation.js";
import { context, at } from "./fixtures.js";
import type { StagingReceipt } from "../src/publication/staging.js";

export function publicationFixture(stagedDeploymentId?: string, routed = false) {
  const reportBytes = Buffer.from("Synthetic approval content"),
    page = Buffer.from("Synthetic built page");
  const uploadedFiles = [
    { path: "static/events/cleanup", hash: bytesHash(page), bytes: page.length },
  ];
  const build: BuildReceipt = {
    receiptRef: "build:synthetic",
    repoRef: "repo:synthetic",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    lockfileHash: bytesHash("lock"),
    recipeRef: "build:next-production-v1",
    environment: "production",
    outputHash: stagedDeploymentId ? digest(uploadedFiles) : digest("synthetic-build-output"),
    exitCode: 0,
  };
  const staging: StagingReceipt | undefined = stagedDeploymentId
    ? {
        contract: "kapelle/vercel-staging/v1",
        receiptRef: "staging:synthetic",
        buildReceiptRef: build.receiptRef,
        buildReceiptHash: digest(build),
        outputHash: build.outputHash,
        recipeRef: build.recipeRef,
        environment: "production",
        commit: build.commit,
        tree: build.tree,
        lockfileHash: build.lockfileHash,
        teamId: "team_synthetic",
        projectId: "prj_synthetic",
        deploymentId: stagedDeploymentId,
        deploymentHost: "synthetic-staged.vercel.app",
        uploadedFiles,
        completedAt: "2026-09-11T09:00:00.000Z",
      }
    : undefined;
  const m = publicationManifest({
    contract: stagedDeploymentId
      ? "kapelle/website-publication/v2"
      : "kapelle/website-publication/v1",
    ownerId: "owner",
    scopeRef: "synthetic-league",
    generation: 1,
    expiresAt: "2026-09-11T12:00:00.000Z",
    report: {
      id: "report-1",
      reportRef: "report:synthetic",
      sourceRef: "source:synthetic",
      contentHash: bytesHash(reportBytes),
      bytes: reportBytes.length,
    },
    source: {
      repoRef: build.repoRef,
      commit: build.commit,
      tree: build.tree,
      files: [{ path: "src/page.tsx", hash: bytesHash("source"), bytes: 6 }],
      lockfile: { path: "package-lock.json", hash: build.lockfileHash, bytes: 4 },
    },
    build: {
      ...(staging
        ? {
            stagedDeploymentId,
            staging: { receiptRef: staging.receiptRef, receiptHash: digest(staging) },
          }
        : {}),
      receiptRef: build.receiptRef,
      receiptHash: digest(build),
      outputHash: build.outputHash,
      recipeRef: build.recipeRef,
      environment: "production",
      siteFiles: [{ path: "events/cleanup", hash: bytesHash(page), bytes: page.length }],
    },
    target: {
      bindingRef: "website:synthetic",
      policyVersion: 1,
      teamId: "team_synthetic",
      projectId: "prj_synthetic",
      domains: ["www.synthetic.test"],
      aliases: [
        { domain: "www.synthetic.test", aliasId: "alias_synthetic", deploymentId: "dpl_old" },
      ],
      ...(stagedDeploymentId
        ? {
            ...(routed
              ? {
                  domains: [
                    "synthetic.test",
                    "www.synthetic.test",
                    "synthetic.vercel.app",
                    "synthetic-team.vercel.app",
                  ],
                  aliases: [
                    {
                      domain: "www.synthetic.test",
                      aliasId: "alias_synthetic",
                      deploymentId: "dpl_old",
                    },
                    { domain: "synthetic.test", aliasId: "alias_apex", deploymentId: "dpl_old" },
                    {
                      domain: "synthetic.vercel.app",
                      aliasId: "alias_generated",
                      deploymentId: "dpl_old",
                    },
                    {
                      domain: "synthetic-team.vercel.app",
                      aliasId: "alias_generated_team",
                      deploymentId: "dpl_old",
                    },
                  ],
                }
              : {}),
            routing: {
              contract: "kapelle/vercel-routing/v1",
              projectDomains: routed
                ? ["synthetic.test", "www.synthetic.test", "synthetic.vercel.app"]
                : ["www.synthetic.test"],
              deploymentAliases: routed
                ? [
                    "synthetic.test",
                    "www.synthetic.test",
                    "synthetic.vercel.app",
                    "synthetic-team.vercel.app",
                  ]
                : ["www.synthetic.test"],
              productionAliases: routed ? ["synthetic-team.vercel.app"] : ["www.synthetic.test"],
              routes: routed
                ? [
                    {
                      domain: "synthetic.test",
                      kind: "redirect",
                      destination: "www.synthetic.test",
                      configuredStatus: null,
                      status: 307,
                      pathPolicy: "preserve-path-and-query",
                    },
                    { domain: "www.synthetic.test", kind: "direct" },
                    { domain: "synthetic.vercel.app", kind: "direct" },
                    { domain: "synthetic-team.vercel.app", kind: "direct" },
                  ]
                : [{ domain: "www.synthetic.test", kind: "direct" }],
            },
          }
        : {}),
    },
    task: {
      managerTaskRef: "task-existing",
      authorityRef: "authority:synthetic",
      authorityTaskRef: "native-task-existing",
      commitmentHash: digest("synthetic-task-commitment"),
    },
  });
  const ctx = context();
  ctx.definitions[0].release.capabilities.push({
    id: "website",
    resourceType: "website",
    actions: ["read", "publish"],
    outputTypes: ["report"],
    requirement: "OPTIONAL",
  });
  ctx.definitions[0].release.documentModels = [
    { documentType: "kapelle/review-intent", version: 2 },
  ];
  ctx.definitions[0].release.contentHash = releaseHash(ctx.definitions[0].release);
  const state = {
    now: at,
    reportRevision: 2,
    reportBytes,
    reportOwner: "owner",
    sourceError: false,
    build,
    staging,
    target: structuredClone(m.target),
    task: { ...m.task, ownerId: m.ownerId, scopeRef: m.scopeRef },
  };
  const adapter = new PublicationFactsAdapter(
    m,
    {
      report: async () => ({
        id: m.report.id,
        ownerId: state.reportOwner,
        scopeRef: m.scopeRef,
        reportRef: m.report.reportRef,
        sourceRef: m.report.sourceRef,
        bytes: state.reportBytes,
        revision: state.reportRevision,
      }),
      source: async () => {
        assert(!state.sourceError, "Source changed");
      },
      build: async () => state.build,
      staging: async () => state.staging,
      target: async () => state.target,
      task: async () => state.task,
    },
    () => state.now,
  );
  return { m, ctx, state, adapter, page };
}

/** Synthetic qualification double ONLY, not a second production Dispatch store. */
export class SyntheticDispatch implements PublicationDispatch {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS synthetic_dispatch (key TEXT PRIMARY KEY, body TEXT NOT NULL)",
    );
  }
  async ensure(intent: DispatchIntent) {
    const binding: DispatchBinding = {
      intent,
      dispatchRef: "dispatch:" + intent.key.slice(8),
      outboxRef: "outbox:" + intent.key.slice(8),
      operationId: "effect:" + intent.key.slice(8),
    };
    this.db
      .prepare("INSERT OR IGNORE INTO synthetic_dispatch(key, body) VALUES (?, ?)")
      .run(intent.key, JSON.stringify(binding));
    const current = (await this.read(intent.key))!;
    assert(canonical(current.intent) === canonical(intent), "Dispatch key conflict");
    return current;
  }
  async read(key: string) {
    const r = this.db.prepare("SELECT body FROM synthetic_dispatch WHERE key=?").get(key) as
      | { body: string }
      | undefined;
    return r ? (JSON.parse(r.body) as DispatchBinding) : null;
  }
  all(): DispatchBinding[] {
    return (this.db.prepare("SELECT body FROM synthetic_dispatch").all() as { body: string }[]).map(
      (r) => JSON.parse(r.body),
    );
  }
  close() {
    this.db.close();
  }
}
export class SyntheticProvider implements PublicationProvider {
  calls = 0;
  mode: "success" | "unknown" | "accepted-then-lost" | "failed" = "success";
  status: ProviderReceipt["status"] = "UNKNOWN";
  targetState: WebsiteTarget;
  tamper: Partial<ProviderReceipt> = {};
  siteBytes: Uint8Array;
  constructor(readonly f: ReturnType<typeof publicationFixture>) {
    this.targetState = structuredClone(f.m.target);
    this.siteBytes = f.page;
  }
  async publish(_b: DispatchBinding) {
    this.calls++;
    if (this.mode === "unknown") throw new Error("synthetic response lost");
    this.status = this.mode === "failed" ? "FAILED" : "PUBLISHED";
    if (this.status === "PUBLISHED")
      this.targetState.aliases.forEach((a) => (a.deploymentId = "dpl_new"));
    if (this.status === "PUBLISHED") this.f.state.target = structuredClone(this.targetState);
    if (this.mode === "accepted-then-lost") throw new Error("synthetic acknowledgement lost");
  }
  async receipt(b: DispatchBinding): Promise<ProviderReceipt> {
    const m = this.f.m;
    return {
      operationId: b.operationId,
      intentHash: digest(b.intent),
      providerRef: "provider:synthetic",
      receiptRef: "receipt:synthetic:" + this.status,
      status: this.status,
      teamId: m.target.teamId,
      projectId: m.target.projectId,
      deploymentId: this.status === "PUBLISHED" ? "dpl_new" : null,
      commit: m.source.commit,
      tree: m.source.tree,
      buildHash: m.build.outputHash,
      environment: "production",
      ...this.tamper,
    };
  }
  async target() {
    return structuredClone(this.targetState);
  }
  async site() {
    return this.siteBytes;
  }
}
