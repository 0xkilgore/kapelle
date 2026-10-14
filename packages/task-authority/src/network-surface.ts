/** Slice 2 provides the only network surface, declared in gateway/openapi.ts. */
export const NETWORK_ROUTES: readonly string[] = [];

export const PROHIBITED_ROUTE_TERMS = [
  "import",
  "migrate",
  "bulk",
  "batch",
  "directory",
  "scan",
  "delete-all",
  "purge",
  "restore",
] as const;

export function assertSafeRouteSurface(routes = NETWORK_ROUTES): void {
  for (const route of routes) {
    const normalized = route.toLowerCase();
    const prohibited = PROHIBITED_ROUTE_TERMS.find((term) => normalized.includes(term));
    if (prohibited) throw new Error(`prohibited route term '${prohibited}' in ${route}`);
  }
}
