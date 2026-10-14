export const DEFAULT_REACTOR_URL = "http://127.0.0.1:4250/graphql";

export type ReactorProbe = {
  up: boolean;
  url: string;
  detail: string;
};

export async function probeReactor(
  url = process.env.REACTOR_URL ?? DEFAULT_REACTOR_URL,
  timeoutMs = 2_000,
): Promise<ReactorProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
      signal: controller.signal,
    });
    if (!response.ok) return { up: false, url, detail: `HTTP ${response.status}` };
    const body = await response.json() as { data?: { __typename?: string }; errors?: { message?: string }[] };
    if (body.errors?.length) return { up: false, url, detail: body.errors.map((e) => e.message ?? "unknown GraphQL error").join("; ") };
    if (!body.data?.__typename) return { up: false, url, detail: "unexpected GraphQL response" };
    return { up: true, url, detail: `GraphQL ${body.data.__typename}` };
  } catch (error) {
    return { up: false, url, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}
