import { canonical } from "../content.js";
import { assert } from "../validation.js";
import {
  bytesHash,
  type PublicationManifest,
  type WebsiteRoute,
  type WebsiteTarget,
} from "./manifest.js";

export type RedirectObservation = { status: number; location: string | null };
export function routingPaths(files: PublicationManifest["build"]["siteFiles"]) {
  return ["", ...files.flatMap((f) => [f.path, f.path + "?kapelle-routing-probe=1"])];
}
export function verifyRedirect(
  route: Extract<WebsiteRoute, { kind: "redirect" }>,
  path: string,
  result: RedirectObservation,
) {
  assert(
    result.status === route.status && result.location === `https://${route.destination}/${path}`,
    "Redirect status, destination or path policy differs",
  );
}
/** Public HEAD only, with manual redirect handling and no credentials. */
export async function observeRedirect(
  request: typeof fetch,
  domain: string,
  path: string,
): Promise<RedirectObservation> {
  const url = new URL(`https://${domain}/${path}`);
  assert(
    url.hostname === domain && url.pathname + url.search === "/" + path && !url.hash,
    "Ambiguous redirect proof path",
  );
  const response = await request(url, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  try {
    return { status: response.status, location: response.headers.get("location") };
  } finally {
    await response.body?.cancel();
  }
}
export function verifyPromotedTarget(
  expected: WebsiteTarget,
  actual: WebsiteTarget,
  deploymentId: string,
) {
  const promoted = structuredClone(expected);
  promoted.aliases.forEach((a) => {
    a.deploymentId = deploymentId;
  });
  assert(
    canonical(actual) === canonical(promoted),
    "Delivery production aliases or routing do not match receipt",
  );
}
export async function verifyPublishedSite(
  target: WebsiteTarget,
  files: PublicationManifest["build"]["siteFiles"],
  provider: {
    site(domain: string, path: string): Promise<Uint8Array>;
    redirect?(domain: string, path: string): Promise<RedirectObservation>;
  },
) {
  const proofs: unknown[] = [];
  const routes: WebsiteRoute[] =
    "routing" in target
      ? target.routing.routes
      : target.domains.map((domain) => ({ domain, kind: "direct" }));
  for (const route of routes) {
    if (route.kind === "redirect") {
      assert(provider.redirect, "Independent redirect evidence unavailable");
      for (const path of routingPaths(files)) {
        const result = await provider.redirect(route.domain, path);
        verifyRedirect(route, path, result);
        proofs.push({ domain: route.domain, path, ...result });
      }
    } else
      for (const file of files) {
        const bytes = await provider.site(route.domain, file.path);
        assert(
          bytes.byteLength === file.bytes && bytesHash(bytes) === file.hash,
          "Delivery live-site bytes differ",
        );
        proofs.push({ domain: route.domain, path: file.path, contentHash: file.hash });
      }
  }
  return proofs;
}
