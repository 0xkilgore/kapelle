import { PublicationProjectHold, type PublicationSettlement } from "./project-hold.js";
import type { DatabaseSync } from "node:sqlite";
import { canonical, digest } from "../content.js";
import { assert } from "../validation.js";
import {
  dispatchIntent,
  verifyDispatch,
  type DispatchBinding,
  type ProviderReceipt,
  type PublicationProvider,
} from "./effects.js";
import { publicationArtifact, bytesHash, type PublicationManifest } from "./manifest.js";
import { vercelTargetReader } from "./vercel-target.js";
import { boundedBytes } from "./transport-http.js";
import { verifiedStagingReceipt, type StagingReceiptReader } from "./staging.js";
import {
  observeRedirect,
  routingPaths,
  verifyRedirect,
  verifyPromotedTarget,
  verifyPublishedSite,
} from "./routing.js";

type Attempt = {
  operation_id: string;
  binding_json: string;
  deployment_id: string;
  settled: number;
};
/** Retained HTTP contact metadata in the existing native authority command journal.
 * It grants no approval or invocation right; ReviewIntent remains that authority. */
export class VercelPublicationProvider implements PublicationProvider {
  readonly manifest: Extract<PublicationManifest, { contract: "kapelle/website-publication/v2" }>;
  private readonly request: typeof fetch;
  private readonly readTarget: ReturnType<typeof vercelTargetReader>;
  private readonly deploymentId: string;
  private readonly hold: PublicationProjectHold;
  constructor(
    private readonly config: {
      manifest: PublicationManifest;
      reviewId: string;
      instanceId: string;
      journal: DatabaseSync;
      /** Stable unique identity of the single trusted executor installation. */
      brokerHostId: string;
      token: () => string;
      request?: typeof fetch;
      stagingReceipt: StagingReceiptReader;
      /** Separate deployment-protection credential; never the Vercel REST token. */
      stagedProtectionBypass?: () => string;
      /** Recheck actual native effect admission inside the provider's write sequence. */
      admit: (binding: DispatchBinding) => Promise<void>;
      confirmNativeDelivery: (binding: DispatchBinding, evidenceId: string) => Promise<void>;
      /** Explicitly qualified immutable per-request terminal proof. Vercel's
       * documented promotion/status APIs do not implement this port. Omit there. */
      readRequestSettlement?: (binding: DispatchBinding) => Promise<PublicationSettlement | null>;
      /** Verify the retained native invocation before closing a no-contact claim. */
      confirmNativeInvocation?: (binding: DispatchBinding) => Promise<void>;
      /** Installation must fence all other project writers, including Git auto promotion.
       * This check is required because Vercel promote provides no documented CAS token. */
      assertExclusiveProjectWriter: () => Promise<void>;
    },
  ) {
    const manifest = publicationArtifact(config.manifest).manifest;
    assert(
      manifest.contract === "kapelle/website-publication/v2",
      "Vercel execution requires a new v2 routing-bound proposal",
    );
    this.manifest = manifest;
    assert(this.manifest.build.stagedDeploymentId, "Approved staged deployment ID required");
    this.deploymentId = this.manifest.build.stagedDeploymentId;
    this.request = config.request ?? fetch;
    this.readTarget = vercelTargetReader(this.manifest.target, config.token, this.request);
    this.hold = new PublicationProjectHold(config.journal, config.brokerHostId, {
      teamId: this.manifest.target.teamId, projectId: this.manifest.target.projectId,
      deploymentId: this.deploymentId,
    });
    config.journal.exec(`CREATE TABLE IF NOT EXISTS publication_provider_contacts(
      operation_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, project_id TEXT NOT NULL,
      deployment_id TEXT NOT NULL, binding_json TEXT NOT NULL, settled INTEGER NOT NULL DEFAULT 0,
      UNIQUE(team_id,project_id,deployment_id));
      CREATE UNIQUE INDEX IF NOT EXISTS publication_provider_project_lane
      ON publication_provider_contacts(team_id,project_id) WHERE settled=0;
      CREATE TABLE IF NOT EXISTS publication_no_contact_seals(
        operation_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL, proof_json TEXT NOT NULL);`);
  }
  async withOperation<T>(binding: DispatchBinding, fn: () => Promise<T>): Promise<T> {
    this.expected(binding);
    return this.hold.withOperation(binding, fn);
  }
  holdStatus(binding: DispatchBinding) {
    this.expected(binding);
    return this.hold.status(binding);
  }
  private noContact(binding: DispatchBinding): PublicationSettlement | null {
    const row = this.config.journal.prepare("SELECT * FROM publication_no_contact_seals WHERE operation_id=?").get(binding.operationId);
    if (!row) return null;
    assert(row.binding_json === canonical(binding), "No-contact binding differs");
    return JSON.parse(String(row.proof_json));
  }
  /** Trusted host maintenance only. The active-run guard proves no publisher is
   * still executing; absence of the mandatory pre-send contact record proves no
   * request was sent. The durable seal forbids every future send for this operation.
   * A crash after sealing is recovered through ordinary native reconciliation. */
  async sealNoContact(binding: DispatchBinding) {
    return this.withOperation(binding, async () => {
      this.hold.assertOwned(binding);
      assert(!this.expected(binding), "Provider contact exists; cannot prove no contact");
      assert(this.config.confirmNativeInvocation, "Native invocation reader unavailable");
      await this.config.confirmNativeInvocation(binding);
      this.hold.assertOwned(binding);
      assert(!this.expected(binding), "Provider contact exists; cannot prove no contact");
      const proof: PublicationSettlement = { contract: "kapelle/publication-settlement/v1",
        operationId: binding.operationId, bindingHash: digest(binding), teamId: this.manifest.target.teamId,
        projectId: this.manifest.target.projectId, deploymentId: this.deploymentId, outcome: "NO_CONTACT",
        proofRef: "no-contact:" + digest(binding).slice(7),
        proofHash: digest({ binding, host: this.config.brokerHostId, contact: null, permanentlySealed: true }) };
      this.config.journal.prepare("INSERT OR IGNORE INTO publication_no_contact_seals VALUES (?,?,?)")
        .run(binding.operationId, canonical(binding), canonical(proof));
      return proof;
    });
  }
  private expected(binding: DispatchBinding) {
    verifyDispatch(
      binding,
      dispatchIntent(this.config.reviewId, this.config.instanceId, this.manifest),
    );
    const row = this.config.journal
      .prepare("SELECT * FROM publication_provider_contacts WHERE operation_id=?")
      .get(binding.operationId) as Attempt | undefined;
    if (row)
      assert(
        row.binding_json === canonical(binding) && row.deployment_id === this.deploymentId,
        "Provider saved operation differs",
      );
    return row;
  }
  private async get(path: string) {
    const secret = this.config.token();
    assert(secret.length >= 20, "Provider credential unavailable");
    const url = new URL(path, "https://api.vercel.com");
    url.searchParams.set("teamId", this.manifest.target.teamId);
    try {
      const r = await this.request(url, {
        method: "GET",
        redirect: "error",
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(10_000),
      });
      assert(r.ok, "Provider read unavailable");
      return JSON.parse((await boundedBytes(r, 2_000_000)).toString("utf8"));
    } catch {
      throw new Error("Provider read unavailable");
    }
  }
  private async candidate() {
    const staged = await verifiedStagingReceipt(this.manifest, this.config.stagingReceipt);
    const d = await this.get(`/v13/deployments/${encodeURIComponent(this.deploymentId)}`),
      m = this.manifest;
    assert(
      d.id === this.deploymentId &&
        d.url === staged.deploymentHost &&
        d.projectId === m.target.projectId &&
        d.team?.id === m.target.teamId &&
        d.target === "production" &&
        d.readyState === "READY" &&
        d.meta?.kapelleCommit === m.source.commit &&
        d.meta.kapelleTree === m.source.tree &&
        d.meta.kapelleBuildHash === m.build.outputHash &&
        d.meta.kapelleBuildReceiptHash === m.build.receiptHash,
      "Staged provider build identity differs",
    );
    return d;
  }
  async preflight(binding: DispatchBinding, manifest: PublicationManifest) {
    assert(canonical(manifest) === canonical(this.manifest), "Provider manifest differs");
    if (this.expected(binding)) return; // A retained attempt can only reconcile.
    await this.config.assertExclusiveProjectWriter();
    const d = await this.candidate();
    assert(
      d.readySubstate === "STAGED" && d.aliasAssigned === false,
      "Candidate is not an unused staged production deployment",
    );
    const project = await this.get(
      `/v9/projects/${encodeURIComponent(this.manifest.target.projectId)}`,
    );
    assert(
      project.id === this.manifest.target.projectId &&
        project.accountId === this.manifest.target.teamId &&
        project.autoAssignCustomDomains === true &&
        project.rollingRelease == null,
      "Project promotion policy unavailable or unsupported",
    );
    // Uploaded inventory is bound by the trusted staging receipt; these reads
    // separately prove the intended routes/assets before any promotion contact.
    const bypass = this.config.stagedProtectionBypass?.();
    assert(
      bypass === undefined || (bypass.length >= 20 && bypass !== this.config.token()),
      "Invalid staged protection credential",
    );
    for (const file of this.manifest.build.siteFiles) {
      const bytes = await this.siteBytes(d.url, file, bypass);
      assert(
        bytes.length === file.bytes && bytesHash(bytes) === file.hash,
        "Staged site differs from approved bytes",
      );
    }
    for (const route of this.manifest.target.routing.routes) {
      if (route.kind === "redirect")
        for (const path of routingPaths(this.manifest.build.siteFiles))
          verifyRedirect(route, path, await this.redirect(route.domain, path));
    }
    assert(
      canonical(await this.target()) === canonical(this.manifest.target),
      "Production target drifted",
    );
  }
  async publish(binding: DispatchBinding, manifest: PublicationManifest) {
    this.hold.assertOwned(binding);
    assert(!this.noContact(binding), "Publication operation permanently sealed without contact");
    assert(canonical(manifest) === canonical(this.manifest), "Provider manifest differs");
    if (this.expected(binding)) return; // Never repeat a possibly transmitted POST.
    await this.preflight(binding, manifest);
    await this.config.assertExclusiveProjectWriter();
    await this.config.admit(binding);
    const secret = this.config.token();
    assert(secret.length >= 20, "Provider credential unavailable");
    // Awaited preflight/admission must not let a detached or retired run send
    // after another recovery has sealed it. No await separates this check from
    // the mandatory durable contact record and the actual request invocation.
    this.hold.assertOwned(binding);
    assert(!this.noContact(binding), "Publication operation permanently sealed without contact");
    // Persist BEFORE any contact. A crash on either side of fetch never authorizes a retry.
    // The project hold and active run already cover reservation, claim and reconciliation.
    this.config.journal
      .prepare(`INSERT INTO publication_provider_contacts(operation_id,team_id,project_id,deployment_id,binding_json)
      VALUES (?,?,?,?,?)`)
      .run(
        binding.operationId,
        this.manifest.target.teamId,
        this.manifest.target.projectId,
        this.deploymentId,
        canonical(binding),
      );
    const url = new URL(
      `/v10/projects/${encodeURIComponent(this.manifest.target.projectId)}/promote/${encodeURIComponent(this.deploymentId)}`,
      "https://api.vercel.com",
    );
    url.searchParams.set("teamId", this.manifest.target.teamId);
    try {
      const response = await this.request(url, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15_000),
      });
      // Even a 4xx is not used to clear native consumption or release the lane.
      await response.body?.cancel();
    } catch {
      /* Contact ambiguity is deliberately retained for receipt-only lookup. */
    }
  }
  target() {
    return this.readTarget();
  }
  async site(domain: string, path: string) {
    const file = this.manifest.build.siteFiles.find((f) => f.path === path);
    assert(
      this.manifest.target.routing.routes.some((r) => r.domain === domain && r.kind === "direct") &&
        file,
      "Unbound site evidence path",
    );
    return this.siteBytes(domain, file);
  }
  async redirect(domain: string, path: string) {
    assert(
      this.manifest.target.routing.routes.some(
        (r) => r.domain === domain && r.kind === "redirect",
      ) && routingPaths(this.manifest.build.siteFiles).includes(path),
      "Unbound redirect evidence path",
    );
    return observeRedirect(this.request, domain, path);
  }
  private async siteBytes(
    domain: string,
    file: PublicationManifest["build"]["siteFiles"][number],
    bypass?: string,
  ) {
    const url = new URL("/" + file.path, "https://" + domain);
    assert(
      !url.search && !url.hash && url.pathname === "/" + file.path,
      "Ambiguous site evidence path",
    );
    try {
      const r = await this.request(url, {
        method: "GET",
        redirect: "error",
        headers: bypass ? { "x-vercel-protection-bypass": bypass } : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      assert(r.ok, "Site evidence unavailable");
      return await boundedBytes(r, file.bytes + 1);
    } catch {
      throw new Error("Site evidence unavailable");
    }
  }
  async receipt(binding: DispatchBinding): Promise<ProviderReceipt> {
    const attempt = this.expected(binding),
      m = this.manifest;
    const base: ProviderReceipt = {
      operationId: binding.operationId,
      intentHash: digest(binding.intent),
      providerRef: "vercel:" + m.target.projectId,
      receiptRef:
        "vercel-promotion:" +
        digest({ operationId: binding.operationId, deploymentId: this.deploymentId }).slice(7),
      status: "UNKNOWN",
      teamId: m.target.teamId,
      projectId: m.target.projectId,
      deploymentId: null,
      commit: m.source.commit,
      tree: m.source.tree,
      buildHash: m.build.outputHash,
      environment: "production",
    };
    if (!attempt) return this.noContact(binding) ? { ...base, status: "FAILED",
      receiptRef: this.noContact(binding)!.proofRef } : base;
    try {
      const d = await this.candidate();
      if (d.aliasAssigned !== true || d.readySubstate !== "PROMOTED") return base;
      const first = await this.target();
      verifyPromotedTarget(m.target, first, this.deploymentId);
      await verifyPublishedSite(first, m.build.siteFiles, this);
      assert(canonical(await this.target()) === canonical(first), "Published target drifted");
      return { ...base, status: "PUBLISHED", deploymentId: this.deploymentId };
    } catch {
      return base;
    }
  }
  async confirmDelivery(binding: DispatchBinding, evidenceId: string) {
    this.hold.assertOwned(binding);
    const contact = this.expected(binding), noContact = this.noContact(binding);
    assert(contact || noContact, "Provider contact unavailable");
    await this.config.confirmNativeDelivery(binding, evidenceId);
    // Public state can match while our request is still delayed (including an owner
    // promoting the same deployment). Native delivery is observational, not settlement.
    this.hold.observe(binding, evidenceId);
    const proof = noContact ?? await this.config.readRequestSettlement?.(binding);
    if (proof) {
      assert(noContact || proof.outcome === "COMPLETED", "Contact requires terminal request proof");
      this.hold.settle(binding, proof, evidenceId, () => {
        if (contact) this.config.journal.prepare("UPDATE publication_provider_contacts SET settled=1 WHERE operation_id=?")
          .run(binding.operationId);
      });
    }
  }
}
