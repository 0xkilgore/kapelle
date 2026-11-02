// Website pack v0, W-1 (PLAN-WEBSITE-PACK-V0 §1-§3; Fable R-6): the runtime-held GitHub connector. The model never sees it.
// Same discipline as the hosted and Resend transports: ONE pinned origin (https://api.github.com), redirects refused, no
// ambient proxy, a deadline, bounded response bytes, fixed labels (never the provider's text), the fine-grained PAT read
// from an owner-only file AT USE (never logged, never in a label). Only the calls the pack needs exist: read a ref, a file
// and the tree; create a blob, tree, commit, ref and DRAFT pull request; read pulls, commit statuses and deployments. There
// is no merge, no delete, no workflow, no settings call.
// `sent` on a refusal says whether a WRITE may have reached GitHub (transport failure, timeout, 5xx after a POST): the
// caller holds those `unsettled` and reconciles by reads (Fable R-6); a definite 4xx never landed.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export const GITHUB_API = "https://api.github.com";
export const WEBSITE_FAILURE_REASONS = ["website_transport_failed", "website_response_malformed", "website_response_too_large", "website_ambient_proxy_refused",
  "website_pat_not_regular_file", "website_pat_not_private", "website_pat_invalid", "website_http_401", "website_http_403", "website_http_404", "website_http_409",
  "website_http_422", "website_http_429", "website_http_4xx", "website_http_5xx", "website_http_unexpected", "website_arg_invalid"] as const;
export class WebsiteError extends Error {
  constructor(readonly label: string, readonly sent = false) { super(label); this.name = "WebsiteError"; }
}
const fail = (label: string, sent = false): never => { throw new WebsiteError(label, sent); };
export type GithubFetch = (url: string, init: { method: "GET" | "POST" | "PATCH"; headers: Record<string, string>; body?: string; redirect: "error"; signal: AbortSignal }) => Promise<Response>;

/** Owner-only regular file (not a link), <= 4 KiB, one fine-grained PAT (github_pat_...). Refusals name no content. */
export function readGithubPat(path: string) {
  const ls = lstatSync(path);
  if (!ls.isFile() || ls.isSymbolicLink()) fail("website_pat_not_regular_file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    if ((st.mode & 0o077) !== 0) fail("website_pat_not_private");
    if (st.size < 20 || st.size > 4096) fail("website_pat_invalid");
    const buf = Buffer.alloc(st.size); readSync(fd, buf, 0, st.size, 0);
    const pat = buf.toString("utf8").trim();
    if (!/^github_pat_[A-Za-z0-9_]{20,255}$/.test(pat)) fail("website_pat_invalid");
    return pat;
  } finally { closeSync(fd); }
}

export type Identity = { name: string; email: string };
export type PullState = { number: number; url: string; state: "open" | "closed"; merged: boolean; draft: boolean; head: string; headSha: string };
export type GithubPort = {
  /** The commit sha a branch points at, or null when the branch does not exist. */
  refSha(branch: string): Promise<string | null>;
  /** A file's bytes and blob sha at a commit, or null when absent. */
  file(path: string, commit: string): Promise<{ blobSha: string; bytes: Buffer } | null>;
  /** Every blob path in the commit's tree (for "image exists" checks). */
  treePaths(commit: string): Promise<Set<string>>;
  createBlob(bytes: Buffer): Promise<string>;
  createTree(baseCommitTree: string, files: { path: string; blobSha: string }[]): Promise<string>;
  commitTree(commit: string): Promise<string>;
  createCommit(o: { message: string; tree: string; parent: string; author: Identity }): Promise<string>;
  createRef(branch: string, sha: string): Promise<void>;
  /** Update the open draft (Fable ACCEPT 9a0f71b4 / e483c8dd): move a branch THIS runtime created to `sha`, fast-forward only
   *  (force:false). GitHub refuses a non-fast-forward (the ref moved): website_branch_moved, nothing landed. Allowlisted. */
  updateRef(branch: string, sha: string): Promise<void>;
  openDraftPull(o: { title: string; body: string; head: string; base: string }): Promise<PullState>;
  findPull(head: string): Promise<PullState | null>;
  pull(n: number): Promise<PullState>;
  /** Candidate preview URLs Vercel posted for a commit (commit statuses + deployment statuses), newest first. */
  previewUrls(commit: string): Promise<{ state: string; url: string }[]>;
};

/** The only branches updateRef may move: the ones the website pack creates (apply.branchOf). */
export const RUNTIME_BRANCH = /^kapelle\/wr-[a-f0-9]{12}$/;
export function githubPort(o: { repo: string; patFile: string; fetch?: GithubFetch; timeoutMs?: number; maxBytes?: number }): GithubPort {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(o.repo)) fail("website_arg_invalid");
  const doFetch = o.fetch ?? (fetch as unknown as GithubFetch), timeout = o.timeoutMs ?? 20_000, limit = o.maxBytes ?? 8 * 1024 * 1024;
  const base = `${GITHUB_API}/repos/${o.repo}`;
  const call = async (method: "GET" | "POST" | "PATCH", path: string, body?: unknown, ok: number[] = [200, 201]) => {
    if (process.env.NODE_USE_ENV_PROXY) fail("website_ambient_proxy_refused");
    const write = method !== "GET", headers: Record<string, string> = { authorization: "Bearer " + readGithubPat(o.patFile), accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28", "user-agent": "kapelle-website-pack", ...(write ? { "content-type": "application/json" } : {}) };
    let res: Response;
    try { res = await doFetch(base + path, { method, headers, ...(write ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(timeout) }); }
    catch { return fail("website_transport_failed", write); }
    if (!ok.includes(res.status)) {
      await res.body?.cancel().catch(() => {});
      const s = res.status, label = s >= 500 && s < 600 ? "website_http_5xx" : [401, 403, 404, 409, 422, 429].includes(s) ? `website_http_${s}` : s >= 400 && s < 500 ? "website_http_4xx" : "website_http_unexpected";
      return fail(label, write && s >= 500);
    }
    const reader = res.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) { let p; try { p = await reader.read(); } catch { return fail("website_transport_failed", write); }
      if (p.done) break; size += p.value.length; if (size > limit) { await reader.cancel().catch(() => {}); return fail("website_response_too_large", write); } chunks.push(p.value); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { return fail("website_response_malformed", write); }
  };
  const sha = (v: unknown) => (typeof v === "string" && /^[a-f0-9]{40}$/.test(v) ? v : fail("website_response_malformed"));
  const branchOk = (b: string) => { if (!/^[A-Za-z0-9._/-]{1,100}$/.test(b) || b.includes("..") || b.startsWith("/") || b.endsWith("/")) fail("website_arg_invalid"); return b; };
  const pathOk = (p: string) => { if (!/^[A-Za-z0-9._/-]{1,300}$/.test(p) || p.split("/").some((s) => !s || s === "." || s === "..")) fail("website_arg_invalid"); return p; };
  const pullOf = (p: any): PullState => {
    if (!p || !Number.isInteger(p.number) || typeof p.html_url !== "string" || !/^https:\/\/github\.com\//.test(p.html_url)) return fail("website_response_malformed");
    return { number: p.number, url: p.html_url, state: p.state === "closed" ? "closed" : "open", merged: p.merged === true || !!p.merged_at, draft: p.draft === true,
      head: String(p.head?.ref ?? ""), headSha: String(p.head?.sha ?? "") };
  };
  const owner = o.repo.split("/")[0];
  return {
    async refSha(branch) {
      try { const r = await call("GET", `/git/ref/heads/${branchOk(branch)}`); return sha(r?.object?.sha); }
      catch (e) { if (e instanceof WebsiteError && e.label === "website_http_404") return null; throw e; }
    },
    async file(path, commit) {
      let r: any;
      try { r = await call("GET", `/contents/${pathOk(path)}?ref=${sha(commit)}`); }
      catch (e) { if (e instanceof WebsiteError && e.label === "website_http_404") return null; throw e; }
      // IMAGES-V1 I3: the contents API inlines files up to 1 MB only; a larger one (a sanitized flyer can be up to 1 MiB) is read by its blob.
      if (r?.type === "file" && r.encoding === "none" && Number.isInteger(r.size) && r.size <= limit / 2) r = { ...r, ...(await call("GET", `/git/blobs/${sha(r.sha)}`)), sha: r.sha };
      if (!r || r.type !== "file" || r.encoding !== "base64" || typeof r.content !== "string") return fail("website_response_malformed");
      return { blobSha: sha(r.sha), bytes: Buffer.from(r.content, "base64") };
    },
    async treePaths(commit) {
      const c = await call("GET", `/git/commits/${sha(commit)}`), t = await call("GET", `/git/trees/${sha(c?.tree?.sha)}?recursive=1`);
      if (!t || !Array.isArray(t.tree) || t.truncated === true) return fail("website_response_malformed");
      return new Set(t.tree.filter((e: any) => e?.type === "blob" && typeof e.path === "string").map((e: any) => e.path as string));
    },
    async createBlob(bytes) { return sha((await call("POST", "/git/blobs", { content: bytes.toString("base64"), encoding: "base64" }))?.sha); },
    async commitTree(commit) { return sha((await call("GET", `/git/commits/${sha(commit)}`))?.tree?.sha); },
    async createTree(baseTree, files) {
      return sha((await call("POST", "/git/trees", { base_tree: sha(baseTree), tree: files.map((f) => ({ path: pathOk(f.path), mode: "100644", type: "blob", sha: sha(f.blobSha) })) }))?.sha);
    },
    async createCommit(c) {
      const date = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      return sha((await call("POST", "/git/commits", { message: c.message, tree: sha(c.tree), parents: [sha(c.parent)], author: { ...c.author, date }, committer: { ...c.author, date } }))?.sha);
    },
    async createRef(branch, s) { await call("POST", "/git/refs", { ref: `refs/heads/${branchOk(branch)}`, sha: sha(s) }); },
    async updateRef(branch, s) {
      if (!RUNTIME_BRANCH.test(branch)) fail("website_arg_invalid"); // never main or any branch the runtime did not create
      try { await call("PATCH", `/git/refs/heads/${branchOk(branch)}`, { sha: sha(s), force: false }); }
      catch (e) { if (e instanceof WebsiteError && e.label === "website_http_422") fail("website_branch_moved"); throw e; } // not a fast-forward
    },
    async openDraftPull(p) { return pullOf(await call("POST", "/pulls", { title: p.title, body: p.body, head: branchOk(p.head), base: branchOk(p.base), draft: true })); },
    async findPull(head) {
      const l = await call("GET", `/pulls?state=all&head=${encodeURIComponent(`${owner}:${branchOk(head)}`)}&per_page=5`);
      if (!Array.isArray(l)) return fail("website_response_malformed");
      return l.length ? pullOf(l[0]) : null;
    },
    async pull(n) { if (!Number.isInteger(n) || n < 1) fail("website_arg_invalid"); return pullOf(await call("GET", `/pulls/${n}`)); },
    async previewUrls(commit) {
      const out: { state: string; url: string }[] = [];
      const st = await call("GET", `/commits/${sha(commit)}/statuses?per_page=30`);
      if (Array.isArray(st)) for (const s of st) if (typeof s?.target_url === "string" && /vercel/i.test(String(s.context ?? ""))) out.push({ state: String(s.state), url: s.target_url });
      const deps = await call("GET", `/deployments?sha=${sha(commit)}&per_page=5`);
      if (Array.isArray(deps)) for (const d of deps.slice(0, 5)) {
        if (!Number.isInteger(d?.id)) continue;
        const ds = await call("GET", `/deployments/${d.id}/statuses?per_page=5`);
        if (Array.isArray(ds)) for (const s of ds) if (typeof s?.environment_url === "string") out.push({ state: String(s.state), url: s.environment_url });
      }
      return out;
    },
  };
}
