// Website pack v0, W-1 (Fable R-6/R-8): a FAKE GitHub that speaks the REST shapes the connector uses, so tests drive the real
// githubPort through its real request/response code. In-memory refs, blobs (real git blob shas), trees, commits, draft pulls,
// commit statuses and deployments, plus failure injection: an HTTP status, a transport failure BEFORE the request applies,
// or AFTER it applied (the write landed but the answer was lost: the reconcile-by-reads case). Never touches the network.
import { createHash } from "node:crypto";

type Commit = { tree: string; parents: string[]; message: string; author: { name: string; email: string } };
type Pull = { number: number; title: string; body: string; head: string; base: string; draft: boolean; state: "open" | "closed"; merged: boolean; headSha: string };
type Fault = { method: string; path: RegExp; kind: number | "throw-before" | "throw-after"; times: number };
const sha1 = (s: string | Buffer) => createHash("sha1").update(s).digest("hex");
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

export class FakeGithub {
  readonly blobs = new Map<string, Buffer>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly commits = new Map<string, Commit>();
  readonly refs = new Map<string, string>();
  readonly pulls: Pull[] = [];
  readonly statuses = new Map<string, { context: string; state: string; target_url: string }[]>();
  readonly calls: { method: string; path: string; auth: string; body: any }[] = [];
  private faults: Fault[] = [];
  private befores: { method: string; path: RegExp; fn: () => void }[] = [];
  constructor(readonly repo = "0xkilgore/example-org-website", files: Record<string, string | Buffer> = {}) { this.refs.set("main", this.commitFiles(files, [], "initial")); }

  blob(bytes: Buffer) { const s = sha1(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])); this.blobs.set(s, bytes); return s; }
  private tree(entries: Map<string, string>) { const s = sha1("tree " + JSON.stringify([...entries].sort())); this.trees.set(s, entries); return s; }
  private commit(c: Commit) { const s = sha1("commit " + JSON.stringify(c)); this.commits.set(s, c); return s; }
  /** A commit on top of `parents` whose tree is the parent's tree with these files replaced. */
  commitFiles(files: Record<string, string | Buffer>, parents: string[], message: string) {
    const base = parents[0] ? new Map(this.trees.get(this.commits.get(parents[0])!.tree)!) : new Map<string, string>();
    for (const [p, c] of Object.entries(files)) base.set(p, this.blob(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    return this.commit({ tree: this.tree(base), parents, message, author: { name: "Fixture", email: "fixture@example.org" } });
  }
  /** Someone else pushes to main. */
  advanceMain(files: Record<string, string>) { this.refs.set("main", this.commitFiles(files, [this.refs.get("main")!], "upstream change")); return this.refs.get("main")!; }
  fileAt(commit: string, path: string) { const b = this.trees.get(this.commits.get(commit)!.tree)!.get(path); return b ? this.blobs.get(b)!.toString("utf8") : null; }
  bytesAt(commit: string, path: string) { const b = this.trees.get(this.commits.get(commit)!.tree)!.get(path); return b ? this.blobs.get(b)! : null; }
  setStatus(commit: string, s: { context: string; state: string; target_url: string }) { this.statuses.set(commit, [s, ...(this.statuses.get(commit) ?? [])]); }
  merge(n: number) { const p = this.pulls.find((x) => x.number === n)!; p.state = "closed"; p.merged = true; }
  close(n: number) { const p = this.pulls.find((x) => x.number === n)!; p.state = "closed"; }
  fault(method: string, path: RegExp, kind: Fault["kind"], times = 1) { this.faults.push({ method, path, kind, times }); }
  /** Run `fn` once right before the next matching request is routed (e.g. someone moves a branch between our read and our write). */
  before(method: string, path: RegExp, fn: () => void) { this.befores.push({ method, path, fn }); }
  /** Is `ancestor` reachable from `sha` through first and other parents? (the fast-forward check) */
  private reaches(sha: string, ancestor: string): boolean { const seen = new Set<string>(), todo = [sha];
    while (todo.length) { const c = todo.pop()!; if (c === ancestor) return true; if (seen.has(c)) continue; seen.add(c); todo.push(...(this.commits.get(c)?.parents ?? [])); } return false; }

  fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect?: string }): Promise<Response> => {
    const u = new URL(url), prefix = `/repos/${this.repo}`;
    if (u.origin !== "https://api.github.com" || init.redirect !== "error" || !u.pathname.startsWith(prefix)) return json({ message: "Not Found" }, 404);
    const path = u.pathname.slice(prefix.length) + u.search, body = init.body ? JSON.parse(init.body) : null;
    this.calls.push({ method: init.method, path, auth: init.headers.authorization, body });
    if (!/^Bearer github_pat_/.test(init.headers.authorization ?? "")) return json({ message: "Bad credentials" }, 401);
    const bi = this.befores.findIndex((x) => x.method === init.method && x.path.test(path));
    if (bi >= 0) this.befores.splice(bi, 1)[0].fn();
    const f = this.faults.find((x) => x.method === init.method && x.path.test(path) && x.times > 0);
    if (f) { f.times--; if (f.kind === "throw-before") throw new TypeError("fetch failed"); if (typeof f.kind === "number") return json({ message: "fault" }, f.kind); }
    const res = this.route(init.method, u.pathname.slice(prefix.length), u.searchParams, body);
    if (f?.kind === "throw-after") throw new TypeError("socket hang up"); // applied, answer lost
    return res;
  };
  private route(method: string, p: string, q: URLSearchParams, b: any): Response {
    let m: RegExpExecArray | null;
    if (method === "GET" && (m = /^\/git\/ref\/heads\/(.+)$/.exec(p))) { const s = this.refs.get(m[1]); return s ? json({ ref: `refs/heads/${m[1]}`, object: { sha: s, type: "commit" } }) : json({ message: "Not Found" }, 404); }
    if (method === "GET" && (m = /^\/contents\/(.+)$/.exec(p))) {
      const c = this.commits.get(q.get("ref") ?? ""), blob = c ? this.trees.get(c.tree)!.get(m[1]) : undefined;
      if (!blob) return json({ message: "Not Found" }, 404);
      const bytes = this.blobs.get(blob)!; // GitHub inlines contents up to 1 MB only; larger files come back with encoding "none"
      return json(bytes.length > 1_000_000 ? { type: "file", path: m[1], sha: blob, encoding: "none", content: "", size: bytes.length }
        : { type: "file", path: m[1], sha: blob, encoding: "base64", content: bytes.toString("base64"), size: bytes.length });
    }
    if (method === "GET" && (m = /^\/git\/blobs\/([a-f0-9]{40})$/.exec(p))) { const b = this.blobs.get(m[1]); return b ? json({ sha: m[1], encoding: "base64", content: b.toString("base64"), size: b.length }) : json({}, 404); }
    if (method === "GET" && (m = /^\/git\/commits\/([a-f0-9]{40})$/.exec(p))) { const c = this.commits.get(m[1]); return c ? json({ sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), message: c.message }) : json({}, 404); }
    if (method === "GET" && (m = /^\/git\/trees\/([a-f0-9]{40})$/.exec(p))) { const t = this.trees.get(m[1]); return t ? json({ sha: m[1], truncated: false, tree: [...t].map(([path, sha]) => ({ path, type: "blob", mode: "100644", sha })) }) : json({}, 404); }
    if (method === "POST" && p === "/git/blobs") return json({ sha: this.blob(Buffer.from(b.content, b.encoding === "base64" ? "base64" : "utf8")) }, 201);
    if (method === "POST" && p === "/git/trees") {
      const base = this.trees.get(b.base_tree); if (!base) return json({}, 422);
      const t = new Map(base); for (const e of b.tree) { if (!this.blobs.has(e.sha)) return json({}, 422); t.set(e.path, e.sha); }
      return json({ sha: this.tree(t) }, 201);
    }
    if (method === "POST" && p === "/git/commits") {
      if (!this.trees.has(b.tree) || !b.parents.every((x: string) => this.commits.has(x))) return json({}, 422);
      return json({ sha: this.commit({ tree: b.tree, parents: b.parents, message: b.message, author: { name: b.author.name, email: b.author.email } }) }, 201);
    }
    if (method === "POST" && p === "/git/refs") {
      const name = String(b.ref).replace(/^refs\/heads\//, "");
      if (this.refs.has(name)) return json({ message: "Reference already exists" }, 422);
      if (!this.commits.has(b.sha)) return json({}, 422);
      this.refs.set(name, b.sha); return json({ ref: b.ref, object: { sha: b.sha } }, 201);
    }
    if (method === "PATCH" && (m = /^\/git\/refs\/heads\/(.+)$/.exec(p))) {
      const name = m[1], cur = this.refs.get(name);
      if (!cur || !this.commits.has(b.sha)) return json({ message: "Reference does not exist" }, 422);
      if (b.force !== false || !this.reaches(b.sha, cur)) return json({ message: "Update is not a fast forward" }, 422);
      this.refs.set(name, b.sha); for (const pr of this.pulls) if (pr.head === name && pr.state === "open") pr.headSha = b.sha;
      return json({ ref: `refs/heads/${name}`, object: { sha: b.sha } });
    }
    if (method === "POST" && p === "/pulls") {
      if (!this.refs.has(b.head) || this.pulls.some((x) => x.head === b.head && x.state === "open")) return json({ message: "Validation Failed" }, 422);
      const pr: Pull = { number: this.pulls.length + 1, title: b.title, body: b.body, head: b.head, base: b.base, draft: b.draft === true, state: "open", merged: false, headSha: this.refs.get(b.head)! };
      this.pulls.push(pr); return json(this.pullJson(pr), 201);
    }
    if (method === "GET" && p === "/pulls") {
      const head = (q.get("head") ?? "").split(":")[1]; return json(this.pulls.filter((x) => x.head === head).reverse().map((x) => this.pullJson(x)));
    }
    if (method === "GET" && (m = /^\/pulls\/(\d+)$/.exec(p))) { const pr = this.pulls.find((x) => x.number === Number(m![1])); return pr ? json(this.pullJson(pr)) : json({}, 404); }
    if (method === "GET" && (m = /^\/commits\/([a-f0-9]{40})\/statuses$/.exec(p))) return json(this.statuses.get(m[1]) ?? []);
    if (method === "GET" && p === "/deployments") return json([]);
    return json({ message: "Not Found" }, 404);
  }
  private pullJson(x: Pull) {
    return { number: x.number, html_url: `https://github.com/${this.repo}/pull/${x.number}`, state: x.state, draft: x.draft, merged: x.merged, merged_at: x.merged ? "2026-10-16T00:00:00Z" : null,
      title: x.title, body: x.body, head: { ref: x.head, sha: x.headSha }, base: { ref: x.base } };
  }
}
