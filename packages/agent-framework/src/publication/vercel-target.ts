import { canonical } from "../command-boundary.js";
import { assert } from "../validation.js";
import {
  canonicalTarget,
  routeSchema,
  type WebsiteTarget,
  type WebsiteRouting,
  type WebsiteRoute,
} from "./manifest.js";
import { observeRedirect, verifyRedirect } from "./routing.js";

/** Fixed-origin, bounded read adapter. This proves a current snapshot, NOT an
 * atomic compare-and-swap for a later provider mutation. Never logs raw responses.
 */
export function vercelTargetReader(
  binding: Pick<
    WebsiteTarget,
    "bindingRef" | "policyVersion" | "teamId" | "projectId" | "domains"
  > & { routing?: WebsiteRouting },
  token: () => string,
  request: typeof fetch = fetch,
) {
  const config = structuredClone(binding);
  const read = async (path: string, params: Record<string, string> = {}) => {
    const secret = token();
    assert(secret.length >= 20, "Target credential unavailable");
    const url = new URL(path, "https://api.vercel.com");
    url.search = new URLSearchParams({ teamId: config.teamId, ...params }).toString();
    let response: Response;
    try {
      response = await request(url, {
        method: "GET",
        redirect: "error",
        headers: { authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("Target provider read unavailable");
    }
    assert(response.ok && response.body, "Target provider denied or unavailable");
    const stream = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const item = await stream.read();
        if (item.done) break;
        size += item.value.byteLength;
        assert(size <= 2_000_000, "Target provider response exceeds bound");
        chunks.push(item.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("Target provider response unavailable");
    } finally {
      await stream.cancel().catch(() => undefined);
    }
  };
  const complete = (body: any, key: string) => {
    assert(
      Array.isArray(body[key]) && body[key].length <= 100 && body.pagination?.next === null,
      "Target inventory incomplete or exceeds bound",
    );
    return body[key] as any[];
  };
  const aliasShape = (a: any) => {
    assert(
      a &&
        typeof a.uid === "string" &&
        typeof a.alias === "string" &&
        typeof a.deploymentId === "string" &&
        a.projectId === config.projectId &&
        a.deletedAt == null &&
        !a.microfrontends,
      "Target alias is unbound or uses unsupported routing",
    );
    return {
      uid: a.uid,
      alias: a.alias,
      projectId: a.projectId,
      deploymentId: a.deploymentId,
      redirect: a.redirect ?? null,
      redirectStatusCode: a.redirectStatusCode ?? null,
    };
  };
  const routedSnapshot = async (project: any): Promise<WebsiteTarget> => {
    const productionId = project.targets?.production?.id;
    assert(
      typeof productionId === "string" && Array.isArray(project.targets.production.alias),
      "Target production inventory unavailable",
    );
    const deployment = await read(`/v13/deployments/${encodeURIComponent(productionId)}`);
    assert(
      deployment.id === productionId &&
        deployment.projectId === config.projectId &&
        deployment.team?.id === config.teamId &&
        deployment.readyState === "READY" &&
        deployment.readySubstate === "PROMOTED" &&
        deployment.target === "production" &&
        deployment.aliasAssigned === true &&
        Array.isArray(deployment.alias),
      "Target production deployment is not ready or belongs to another project",
    );
    const domains = complete(
      await read(`/v9/projects/${encodeURIComponent(config.projectId)}/domains`, { limit: "100" }),
      "domains",
    );
    const listed = complete(
      await read("/v4/aliases", { projectId: config.projectId, limit: "100" }),
      "aliases",
    ).map(aliasShape);
    assert(
      canonical(listed.map((a) => a.alias).sort()) === canonical([...config.domains].sort()),
      "Target project alias inventory differs from approved domains",
    );
    const assigned = await read(`/v2/deployments/${encodeURIComponent(productionId)}/aliases`);
    assert(
      Array.isArray(assigned.aliases) &&
        assigned.aliases.length <= 100 &&
        (!assigned.pagination || assigned.pagination.next === null),
      "Target deployment alias inventory incomplete",
    );
    assert(
      canonical([...deployment.alias].sort()) ===
        canonical([...project.targets.production.alias].sort()),
      "Target advertised production aliases disagree",
    );
    const aliases = [],
      routes: WebsiteRoute[] = [];
    for (const listedAlias of listed) {
      assert(
        listedAlias.deploymentId === productionId,
        "Target contains aliases outside the single production deployment",
      );
      const a = aliasShape(
        await read(`/v4/aliases/${encodeURIComponent(listedAlias.alias)}`, {
          projectId: config.projectId,
        }),
      );
      assert(
        canonical(a) === canonical(listedAlias),
        "Target alias inventory changed during verification",
      );
      aliases.push({ domain: a.alias, aliasId: a.uid, deploymentId: a.deploymentId });
      if (a.redirect === null) {
        assert(a.redirectStatusCode === null, "Target direct domain has redirect configuration");
        routes.push({ domain: a.alias, kind: "direct" });
      } else {
        assert(typeof a.redirect === "string", "Target redirect destination unavailable");
        const observed = await observeRedirect(request, a.alias, "");
        const route = routeSchema.parse({
          domain: a.alias,
          kind: "redirect" as const,
          destination: a.redirect,
          configuredStatus: a.redirectStatusCode,
          status: observed.status,
          pathPolicy: "preserve-path-and-query" as const,
        });
        assert(route.kind === "redirect", "Target redirect route unavailable");
        verifyRedirect(route, "", observed);
        routes.push(route);
      }
    }
    for (const d of domains) {
      const a = listed.find((v) => v.alias === d.name);
      assert(
        a &&
          d.projectId === config.projectId &&
          d.verified === true &&
          d.gitBranch == null &&
          d.customEnvironmentId == null &&
          (d.redirect ?? null) === a.redirect &&
          (d.redirectStatusCode ?? null) === a.redirectStatusCode,
        "Target project domain and alias routing differ or are unsupported",
      );
    }
    for (const a of assigned.aliases) {
      const listedAlias = listed.find((v) => v.alias === a.alias);
      assert(
        listedAlias && a.uid === listedAlias.uid && (a.redirect ?? null) === listedAlias.redirect,
        "Target deployment alias inventory differs",
      );
    }
    return canonicalTarget({
      bindingRef: config.bindingRef,
      policyVersion: config.policyVersion,
      teamId: config.teamId,
      projectId: config.projectId,
      domains: listed.map((a) => a.alias),
      aliases,
      routing: {
        contract: "kapelle/vercel-routing/v1",
        projectDomains: domains.map((d) => d.name),
        deploymentAliases: assigned.aliases.map((a: any) => a.alias),
        productionAliases: deployment.alias,
        routes,
      },
    });
  };
  const snapshot = async (): Promise<WebsiteTarget> => {
    const project = await read(`/v9/projects/${encodeURIComponent(config.projectId)}`);
    assert(
      project.id === config.projectId && project.accountId === config.teamId,
      "Target provider project ownership differs",
    );
    if (config.routing) return routedSnapshot(project);
    const aliases = [];
    for (const domain of config.domains) {
      const alias = await read(`/v4/aliases/${encodeURIComponent(domain)}`, {
        projectId: config.projectId,
      });
      assert(
        alias.alias === domain &&
          alias.projectId === config.projectId &&
          typeof alias.uid === "string" &&
          typeof alias.deploymentId === "string" &&
          !alias.deletedAt &&
          !alias.redirect &&
          !alias.microfrontends,
        "Target alias is unbound or uses unsupported routing",
      );
      const deployment = await read(`/v13/deployments/${encodeURIComponent(alias.deploymentId)}`);
      assert(
        deployment.id === alias.deploymentId &&
          deployment.projectId === config.projectId &&
          deployment.readyState === "READY" &&
          deployment.target === "production" &&
          deployment.aliasAssigned === true,
        "Target production deployment is not ready or belongs to another project",
      );
      aliases.push({ domain, aliasId: alias.uid, deploymentId: alias.deploymentId });
    }
    return canonicalTarget({ ...config, aliases });
  };
  return async () => {
    const first = await snapshot(),
      second = await snapshot();
    assert(canonical(first) === canonical(second), "Target changed during provider verification");
    return second;
  };
}
