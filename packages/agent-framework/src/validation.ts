/** Pure validation shared by the authored reducers. No IO, clock or generated IDs. */
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function text(value: string, label = "value", max = 4000) {
  assert(value.trim().length > 0 && value.length <= max, `Invalid ${label}`);
  return value;
}
export function timestamp(value: string) {
  assert(
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "Invalid timestamp",
  );
}
export function hash(value: string) {
  assert(/^sha256:[a-f0-9]{64}$/.test(value), "Invalid content hash");
}
export function version(value: string) {
  assert(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value),
    "Release version must be major.minor.patch",
  );
}
export function newer(next: string, previous: string) {
  version(next);
  version(previous);
  const a = next.split(".").map(Number),
    b = previous.split(".").map(Number);
  const difference = a.map((v, i) => v - b[i]).find((v) => v !== 0);
  assert(difference !== undefined && difference > 0, "Definition version must advance");
}
export function ref(value: { id: string; version: string; contentHash: string }) {
  opaque(value.id);
  text(value.version, "version", 200);
  hash(value.contentHash);
}
export function opaque(value: string) {
  text(value, "reference", 500);
  assert(
    /^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$/.test(value),
    "Reference must be an opaque ID, not a path, URL or secret",
  );
}
export function unique(values: string[], label: string) {
  assert(new Set(values).size === values.length, `Duplicate ${label}`);
  values.forEach((v) => text(v, label, 500));
  assert(values.length <= 200, `Too many ${label}`);
}
export interface Metadata {
  revision: number;
  ownerId: string | null | undefined;
  createdAt: string | null | undefined;
  updatedAt: string | null | undefined;
}
export interface Mutation {
  actorId: string;
  occurredAt: string;
  expectedRevision: number;
}
export function before(state: Metadata, input: Mutation, create = false) {
  opaque(input.actorId);
  timestamp(input.occurredAt);
  assert(
    Number.isInteger(input.expectedRevision) && input.expectedRevision === state.revision,
    "Stale document revision",
  );
  if (create)
    assert(state.revision === 0 && state.ownerId === null, "Document already initialized");
  else assert(state.ownerId === input.actorId && state.revision > 0, "Owner required");
  if (state.updatedAt)
    assert(input.occurredAt >= state.updatedAt, "Timestamp precedes last mutation");
}
export function touch(state: Metadata, input: Mutation) {
  state.revision++;
  state.ownerId ??= input.actorId;
  state.createdAt ??= input.occurredAt;
  state.updatedAt = input.occurredAt;
}
export function modelPolicy(p: {
  preferredProfile: string;
  concurrencyLimit: number;
  budgetPolicyRef: string;
  paidFallback: boolean;
  fallbackProvider?: string | null;
  fallbackScopeRef?: string | null;
  fallbackBudgetRef?: string | null;
}) {
  text(p.preferredProfile);
  opaque(p.budgetPolicyRef);
  assert(
    Number.isInteger(p.concurrencyLimit) && p.concurrencyLimit >= 1 && p.concurrencyLimit <= 32,
    "Invalid concurrency limit",
  );
  if (p.paidFallback) {
    assert(
      p.fallbackProvider && p.fallbackScopeRef && p.fallbackBudgetRef,
      "Paid fallback requires provider, scope and budget",
    );
    opaque(p.fallbackProvider);
    opaque(p.fallbackScopeRef);
    opaque(p.fallbackBudgetRef);
  } else
    assert(
      !p.fallbackProvider && !p.fallbackScopeRef && !p.fallbackBudgetRef,
      "Disabled fallback must not retain a paid route",
    );
}
