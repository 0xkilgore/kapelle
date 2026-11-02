export const OPS_PRIVATE_RESPONSE_HEADERS = Object.freeze({
  "cache-control": "no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow",
  "x-kapelle-private-mode": "localhost-ops",
});

export type OpsRequestSecurity = {
  host: string | null;
  forwardedFor: string | null;
  realIp: string | null;
  token: string | null;
};

export type TrustedTailnetOpsContract = {
  enabled: boolean;
  host: string | null;
  login: string | null;
};

export function opsTokenFromHeaders(headers: Headers): string | null {
  return (
    bearerToken(headers.get("authorization")) ??
    headers.get("x-kapelle-ops-token") ??
    cookieToken(headers.get("cookie"), "KAPELLE_OPS_TOKEN") ??
    cookieToken(headers.get("cookie"), "kapelle_ops_token")
  );
}

export function isLoopbackOpsRequest(request: Pick<OpsRequestSecurity, "host" | "forwardedFor" | "realIp">) {
  const host = normalizeHost(request.host);
  const forwardedFor = request.forwardedFor?.split(",")[0]?.trim();
  const realIp = request.realIp?.trim();

  return (
    (host === "localhost" || host === "127.0.0.1" || host === "::1") &&
    (!forwardedFor || isLoopbackIp(forwardedFor)) &&
    (!realIp || isLoopbackIp(realIp))
  );
}

export function isTrustedTailnetOpsRequest(
  request: { host: string | null; tailscaleUserLogin: string | null },
  contract: TrustedTailnetOpsContract,
) {
  if (!contract.enabled) return false;

  const requestHost = normalizeHost(request.host);
  const trustedHost = normalizeHost(contract.host);
  const requestLogin = normalizeLogin(request.tailscaleUserLogin);
  const trustedLogin = normalizeLogin(contract.login);

  return Boolean(
    requestHost &&
      trustedHost &&
      requestHost === trustedHost &&
      requestLogin &&
      trustedLogin &&
      requestLogin === trustedLogin,
  );
}

function bearerToken(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function cookieToken(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeHost(value: string | null) {
  if (!value) return null;
  const host = value.trim().toLowerCase();
  if (host.startsWith("[::1]") || host === "::1") return "::1";
  return host.split(":")[0] ?? null;
}

function normalizeLogin(value: string | null) {
  const login = value?.trim().toLowerCase();
  return login || null;
}

function isLoopbackIp(value: string) {
  return (
    value === "127.0.0.1" ||
    value === "::1" ||
    value === "::ffff:127.0.0.1" ||
    value.startsWith("127.")
  );
}
