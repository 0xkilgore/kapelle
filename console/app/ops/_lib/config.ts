import "server-only";

import {
  isLoopbackOpsRequest,
  isTrustedTailnetOpsRequest,
  OPS_PRIVATE_RESPONSE_HEADERS,
  opsTokenFromHeaders,
} from "./securityTopology";

export type OpsConfig = {
  enabled: boolean;
  token: string | null;
  managerUrl: string;
  teamId: string;
  allowRemote: boolean;
  trustTailnet: boolean;
  trustedTailnetHost: string | null;
  trustedTailnetLogin: string | null;
  caneDraftArtifacts: boolean;
  workPersonalView: boolean;
};

export type OpsAccess =
  | { ok: true; config: OpsConfig }
  | { ok: false; status: 403 | 404; reason: string; config: OpsConfig };

export const OPS_NO_STORE_HEADERS = OPS_PRIVATE_RESPONSE_HEADERS;

export function getOpsConfig(): OpsConfig {
  return {
    enabled: process.env.KAPELLE_OPS_ENABLED === "1",
    token: process.env.KAPELLE_OPS_TOKEN ?? null,
    managerUrl:
      process.env.KAPELLE_MANAGER_URL ??
      process.env.MANAGER_URL ??
      "http://127.0.0.1:4100",
    teamId: normalizeTeamId(process.env.KAPELLE_TEAM_ID ?? process.env.ID_AGENTS_TEAM_ID) ?? "default",
    allowRemote: process.env.KAPELLE_OPS_ALLOW_REMOTE === "1",
    trustTailnet: process.env.KAPELLE_OPS_TRUST_TAILNET === "1",
    trustedTailnetHost: process.env.KAPELLE_OPS_TAILNET_HOST?.trim() || null,
    trustedTailnetLogin: process.env.KAPELLE_OPS_TAILNET_LOGIN?.trim() || null,
    caneDraftArtifacts: process.env.CANE_DRAFT_ARTIFACTS === "1",
    workPersonalView: process.env.WORK_PERSONAL_VIEW === "1",
  };
}

function normalizeTeamId(teamId: string | null | undefined): string | null {
  const trimmed = teamId?.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase() === "default" ? "default" : trimmed;
}

export function requireOpsApiAccess(request: Request, options: { requireCredential?: boolean } = {}): OpsAccess {
  const config = getOpsConfig();
  const requestHeaders = request.headers;

  return evaluateOpsAccess(config, {
    host: requestHeaders.get("host"),
    forwardedFor: requestHeaders.get("x-forwarded-for"),
    realIp: requestHeaders.get("x-real-ip"),
    token: opsTokenFromHeaders(request.headers),
    tailscaleUserLogin: requestHeaders.get("tailscale-user-login"),
    requireCredential: options.requireCredential,
  });
}

export async function requireOpsPageAccess(options: { requireCredential?: boolean } = {}): Promise<OpsAccess> {
  const config = getOpsConfig();
  const { cookies, headers } = await import("next/headers");
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  const securityHeaders = new Headers();
  const authorization = requestHeaders.get("authorization");
  const headerToken = requestHeaders.get("x-kapelle-ops-token");
  if (authorization) securityHeaders.set("authorization", authorization);
  if (headerToken) securityHeaders.set("x-kapelle-ops-token", headerToken);
  securityHeaders.set("cookie", requestCookies.toString());

  return evaluateOpsAccess(config, {
    host: requestHeaders.get("host"),
    forwardedFor: requestHeaders.get("x-forwarded-for"),
    realIp: requestHeaders.get("x-real-ip"),
    token:
      opsTokenFromHeaders(securityHeaders),
    tailscaleUserLogin: requestHeaders.get("tailscale-user-login"),
    requireCredential: options.requireCredential,
  });
}

function evaluateOpsAccess(
  config: OpsConfig,
  request: {
    host: string | null;
    forwardedFor: string | null;
    realIp: string | null;
    token: string | null;
    tailscaleUserLogin: string | null;
    requireCredential?: boolean;
  },
): OpsAccess {
  if (!config.enabled) {
    return { ok: false, status: 404, reason: "Kapelle ops is disabled.", config };
  }

  const trustedTailnetRequest = !request.requireCredential && isTrustedTailnetOpsRequest(
    { host: request.host, tailscaleUserLogin: request.tailscaleUserLogin },
    {
      enabled: config.trustTailnet,
      host: config.trustedTailnetHost,
      login: config.trustedTailnetLogin,
    },
  );

  if (!config.token && !trustedTailnetRequest) {
    return {
      ok: false,
      status: 403,
      reason: "KAPELLE_OPS_TOKEN is not configured.",
      config,
    };
  }

  if (!config.allowRemote && !isLoopbackOpsRequest(request)) {
    return { ok: false, status: 403, reason: "Remote ops access is disabled.", config };
  }

  if (request.token !== config.token && !trustedTailnetRequest) {
    return { ok: false, status: 403, reason: "Missing or invalid ops token.", config };
  }

  return { ok: true, config };
}
