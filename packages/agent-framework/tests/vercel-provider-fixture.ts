import { publicationFixture } from "./publication-fixtures.js";
import { assert } from "../src/validation.js";
export function vercelProviderFixture(routed = false) {
  const f = publicationFixture("dpl_new", routed),
    m = f.m;
  assert(m.contract === "kapelle/website-publication/v2", "Routing fixture requires v2");
  const state = {
    posts: 0,
    published: false,
    fault: "",
    page: f.page,
    routing: structuredClone(m.target.routing),
    projectReads: 0,
    requests: [] as { method: string; path: string; origin: string; stagingCredential: boolean }[],
  };
  const currentId = () =>
    state.fault === "target" ? "dpl_drift" : state.published ? "dpl_new" : "dpl_old";
  const alias = (domain: string) => {
    const bound = m.target.aliases.find((a) => a.domain === domain)!;
    const route = state.routing.routes.find((r) => r.domain === domain)!;
    return {
      uid: bound.aliasId,
      alias: domain,
      projectId: m.target.projectId,
      deploymentId:
        state.fault === "mixed-deployment" && domain === "synthetic-team.vercel.app"
          ? "dpl_preview"
          : currentId(),
      redirect: route.kind === "redirect" ? route.destination : null,
      redirectStatusCode: route.kind === "redirect" ? route.configuredStatus : null,
    };
  };
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? "GET",
      headers = new Headers(init?.headers);
    state.requests.push({
      method,
      path: url.pathname + url.search,
      origin: url.origin,
      stagingCredential: headers.has("x-vercel-protection-bypass"),
    });
    if (url.hostname !== "api.vercel.com") {
      if (headers.has("authorization")) throw Error("Credential sent to site");
      if (url.hostname === "synthetic-staged.vercel.app") {
        if (
          state.fault === "protected-staging" &&
          headers.get("x-vercel-protection-bypass") !== "synthetic-deployment-protection-token"
        )
          return new Response(null, { status: 401 });
        if (state.fault === "unbound-staged-bytes") return new Response("Wrong staged content");
      } else if (headers.has("x-vercel-protection-bypass"))
        throw Error("Staging credential sent to public site");
      const route = state.routing.routes.find((r) => r.domain === url.hostname);
      if (route?.kind === "redirect") {
        if (method !== "HEAD" || init?.redirect !== "manual")
          throw Error("Redirect must be observed, never followed");
        const destination =
          state.fault === "redirect-destination" ? "unapproved.test" : route.destination;
        const path = state.fault === "redirect-path" && url.pathname !== "/" ? "/" : url.pathname;
        const query = state.fault === "redirect-query" ? "" : url.search;
        return new Response(null, {
          status: state.fault === "redirect-status" ? 308 : route.status,
          headers: { location: `https://${destination}${path}${query}` },
        });
      }
      if (state.fault === "direct-redirect" && url.hostname === "synthetic-team.vercel.app")
        return new Response(null, {
          status: 307,
          headers: { location: "https://www.synthetic.test/" },
        });
      return new Response(state.page);
    }
    if (url.searchParams.get("teamId") !== m.target.teamId || init?.redirect !== "error")
      throw Error("Unscoped API call");
    if (method === "POST") {
      if (url.pathname !== `/v10/projects/${m.target.projectId}/promote/dpl_new`)
        throw Error("Unexpected mutation");
      state.posts++;
      if (state.fault === "unknown")
        throw Error("Synthetic provider token in error must not escape");
      state.published = true;
      if (state.fault === "accepted-lost") throw Error("Synthetic lost success");
      return new Response(null, { status: 202 });
    }
    const json = (body: unknown) => Response.json(body);
    if (url.pathname.endsWith("/domains"))
      return json({
        domains: [
          ...state.routing.projectDomains.map((name) => {
            const a = alias(name);
            return {
              name,
              projectId: m.target.projectId,
              verified: true,
              redirect: a.redirect,
              redirectStatusCode:
                state.fault === "domain-alias-status" && a.redirect ? 308 : a.redirectStatusCode,
              gitBranch: state.fault === "branch-domain" ? "other" : null,
            };
          }),
          ...(state.fault === "extra-domain" ? [{ name: "extra.synthetic.test" }] : []),
        ],
        pagination: { next: state.fault === "domain-pagination" ? 123 : null },
      });
    if (url.pathname === "/v4/aliases") {
      if (
        url.searchParams.get("projectId") !== m.target.projectId ||
        url.searchParams.get("limit") !== "100"
      )
        throw Error("Incomplete project inventory query");
      let aliases = m.target.domains.map(alias);
      if (state.fault === "missing-alias")
        aliases = aliases.filter((a) => a.alias !== "synthetic-team.vercel.app");
      if (state.fault === "extra-alias")
        aliases.push({
          ...alias(m.target.domains[0]),
          alias: "unapproved.vercel.app",
          uid: "extra",
        });
      return json({
        aliases,
        pagination: { next: state.fault === "alias-pagination" ? 123 : null },
      });
    }
    if (url.pathname.startsWith("/v2/deployments/") && url.pathname.endsWith("/aliases")) {
      let names = state.routing.deploymentAliases;
      if (state.fault === "missing-deployment-alias")
        names = names.filter((n) => n !== "synthetic-team.vercel.app");
      const aliases = names.map((name) => {
        const a = alias(name);
        return { alias: name, uid: a.uid, redirect: a.redirect };
      });
      if (state.fault === "extra-deployment-alias")
        aliases.push({ alias: "extra.vercel.app", uid: "extra", redirect: null });
      return json({ aliases });
    }
    if (url.pathname.includes("/projects/")) {
      state.projectReads++;
      if (state.fault === "routing-drift" && state.projectReads > 2) {
        const route = state.routing.routes.find((r) => r.kind === "redirect");
        if (route?.kind === "redirect") route.status = 308;
      }
      return json({
        id: m.target.projectId,
        accountId: m.target.teamId,
        autoAssignCustomDomains: state.fault !== "policy",
        targets: { production: { id: currentId(), alias: state.routing.productionAliases } },
        ...(state.fault === "rolling-release"
          ? {
              rollingRelease: {
                target: "production",
                stages: [
                  { targetPercentage: 10, requireApproval: true },
                  { targetPercentage: 100 },
                ],
              },
            }
          : {}),
      });
    }
    if (url.pathname.startsWith("/v4/aliases/"))
      return json(alias(decodeURIComponent(url.pathname.split("/").at(-1)!)));
    if (url.pathname.endsWith("/dpl_new"))
      return json({
        id: "dpl_new",
        url:
          state.fault === "unbound-staged-host"
            ? "unbound.vercel.app"
            : "synthetic-staged.vercel.app",
        projectId: m.target.projectId,
        team: { id: state.fault === "team" ? "wrong" : m.target.teamId },
        target: "production",
        readyState: "READY",
        readySubstate: state.published
          ? state.fault === "rolling-state"
            ? "ROLLING"
            : "PROMOTED"
          : "STAGED",
        aliasAssigned: state.published,
        alias: state.published ? state.routing.productionAliases : [],
        meta: {
          kapelleCommit: m.source.commit,
          kapelleTree: m.source.tree,
          kapelleBuildHash: state.fault === "build" ? "wrong" : m.build.outputHash,
          kapelleBuildReceiptHash: m.build.receiptHash,
        },
      });
    return json({
      id: url.pathname.split("/").at(-1),
      projectId: m.target.projectId,
      team: { id: m.target.teamId },
      readyState: "READY",
      readySubstate: "PROMOTED",
      target: "production",
      aliasAssigned: true,
      alias: state.routing.productionAliases,
    });
  };
  return { ...f, m, state, request, stagingReceipt: f.state.staging! };
}
