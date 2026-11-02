// AGENT-MODEL-V2 slice 1b: the host-side, READ-ONLY source assembler. A Task's chosen scope (project OR folder) becomes an
// immutable snapshot BEFORE approval: the exact relative file list, sizes and sha256 are bound into the plan, and the bytes are
// kept in the private content-addressed packet store. Execution consumes those bytes and never reopens the folder.
// Rules (GENERIC-AGENT-DELTA / AGENT-MODEL-V2): owner-admitted roots under ~/Workspace only (never Dropbox), no symlink at any
// path component, no traversal, regular files only, a text-type allowlist, dependency/cache/hidden trees skipped, credential
// names and secret-bearing content excluded with a content-free reason, file identity checked before and after reading, and
// caps that REFUSE on overflow (never silently sample). Nothing here executes, follows URLs or treats file text as authority.
import {lstatSync, readdirSync, realpathSync, openSync, readSync, fstatSync, closeSync, constants, type Stats} from 'node:fs';
import {join, isAbsolute, resolve, sep} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonical, digest} from '../content.js';
import {packetSchema, type TaskSourcePacket} from '../task-delegation/worker-contract.js';
import {sourceScopeSchema, PACKET_LIMITS, type SourceScope} from './launch-policy.js';

export const ASSEMBLER_LIMITS = {maxFiles: PACKET_LIMITS.maxSources - 1 /* + the Task */, maxFileBytes: 32768, maxPacketBytes: PACKET_LIMITS.maxBytes,
  maxEntries: 1000, maxDepth: 8} as const;
const TEXT_EXT = new Set(['md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'py', 'ts', 'tsx', 'js', 'mjs', 'cjs', 'sh', 'sql', 'html', 'css', 'xml', 'ini', 'cfg', 'rst', 'log']);
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'venv', '__pycache__', 'dist', 'build', 'out', 'target', 'coverage', 'tmp', 'cache', 'logs']);
/** Credential-bearing names (case-insensitive). */
const SECRET_NAME = [/^\.env(\..*)?$/i, /\.env$/i, /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|kdbx|gpg|asc|ovpn)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pypirc|pgpass|git-credentials)$/i, /credential/i, /secret/i, /token/i, /passw(or)?d/i, /service[-_]?account.*\.json$/i, /^auth\.json$/i, /\.htpasswd$/i];
/** Deterministic secret-content screening (content-free reasons only). */
const SECRET_CONTENT = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}\b/, /(api[_-]?key|secret|token|passw(or)?d)["']?\s*[:=]\s*['"]?[A-Za-z0-9_\-./+=]{12,}/i, /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/];
/** The reader policy every manifest names (its hash changes when these rules change). */
/** The assembler's secret-content refusal, reused for agent OUTPUT (lean runtime step 4 member replies). */
export const secretContentFound = (text: string) => SECRET_CONTENT.some(r => r.test(text));
export const READER_POLICY = {contract: 'kapelle.folder-reader/v1', limits: ASSEMBLER_LIMITS,
  // A text file over maxFileBytes is split at line boundaries into path#Lx-Ly documents (never excluded, never summarised).
  chunking: 'line-range/v1', text: [...TEXT_EXT].sort(), skipDirs: [...SKIP_DIRS].sort(),
  secretNames: SECRET_NAME.map(r => r.source), secretContent: SECRET_CONTENT.map(r => r.source)};
export const READER_POLICY_HASH = digest(READER_POLICY);

export type ScopeRoot = {id: string; path: string; label: string; projects: string[]; classification?: 'project' | 'owner-private'};
export type ExclusionReason = 'hidden' | 'dependency_or_cache' | 'unsupported_type' | 'secret_name' | 'secret_content' | 'file_too_large' | 'not_regular_file' | 'not_utf8_text';
export const manifestSchema = z.object({
  contract: z.literal('kapelle.source-manifest/v1'),
  scope: sourceScopeSchema, rootId: z.string(), readerPolicyHash: z.string(), classification: z.enum(['project', 'owner-private']),
  entries: z.array(z.object({relativePath: z.string(), byteSize: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(ASSEMBLER_LIMITS.maxFiles),
  excluded: z.record(z.string(), z.number().int().nonnegative()),
  /** Line-range chunks of files over maxFileBytes (whole-file size/sha stay in entries). Absent when nothing was chunked. */
  chunks: z.array(z.object({relativePath: z.string(), startLine: z.number().int().positive(), endLine: z.number().int().positive(),
    byteSize: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(ASSEMBLER_LIMITS.maxFiles).optional(),
  packetHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type SourceManifest = z.infer<typeof manifestSchema>;

export class ScopeRefused extends Error { constructor(readonly reason: string, readonly detail: Record<string, unknown> = {}) { super(reason); this.name = 'ScopeRefused'; } }
const refuse = (reason: string, detail: Record<string, unknown> = {}): never => { throw new ScopeRefused(reason, detail); };

/** The root a scope resolves to, and the directory inside it. Containment is checked by path components. */
export function resolveScope(scope: SourceScope, roots: readonly ScopeRoot[], workspace = join(homedir(), 'Workspace')) {
  const s = sourceScopeSchema.parse(scope);
  const root = s.kind === 'folder' ? roots.find(r => r.id === s.rootId) : roots.find(r => r.projects.includes(s.projectId));
  if (!root) refuse('scope_root_not_admitted');
  const r = root!;
  if (!isAbsolute(r.path) || r.path.includes('/Dropbox/') || resolve(r.path) !== r.path || !(r.path + sep).startsWith(resolve(workspace) + sep)) refuse('scope_root_outside_workspace');
  let real: string;
  try { real = realpathSync(r.path); } catch { return refuse('scope_root_unavailable'); }
  if (real !== r.path) refuse('scope_root_is_alias'); // a symlinked root (e.g. into Dropbox) is refused
  const rel = s.kind === 'folder' ? s.relativeDirectory : '';
  const segments = rel === '' ? [] : rel.split('/');
  let cur = r.path;
  for (const seg of segments) {
    cur = join(cur, seg);
    let st: Stats; try { st = lstatSync(cur); } catch { return refuse('scope_directory_missing'); }
    if (st.isSymbolicLink()) refuse('scope_path_symlink');
    if (!st.isDirectory()) refuse('scope_path_not_directory');
  }
  return {root: r, directory: cur, relativeDirectory: rel};
}

function readStable(path: string, before: Stats): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (st.ino !== before.ino || st.dev !== before.dev || st.size !== before.size || st.mtimeMs !== before.mtimeMs || st.nlink !== 1) refuse('source_changed_during_read');
    const buf = Buffer.alloc(st.size); let off = 0;
    while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n === 0) break; off += n; }
    const after = fstatSync(fd);
    if (off !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs) refuse('source_changed_during_read');
    return buf;
  } finally { closeSync(fd); }
}
const deterministicId = (rootId: string, rel: string, sha: string) => {
  const h = createHash('sha256').update(['kapelle.folder-source/v1', rootId, rel, sha].join('\0')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** Assemble the snapshot for one scope. `select` optionally narrows to owner-chosen relative paths (still screened). */
export function assembleScope(o: {scope: SourceScope; roots: readonly ScopeRoot[]; capturedAt: string; select?: readonly string[]; workspace?: string}) {
  const {root, directory} = resolveScope(o.scope, o.roots, o.workspace);
  const excluded: Record<string, number> = {};
  const exclude = (r: ExclusionReason) => { excluded[r] = (excluded[r] ?? 0) + 1; };
  const candidates: {rel: string; path: string; st: Stats}[] = [];
  let entries = 0;
  const walk = (dir: string, relDir: string, depth: number) => {
    if (depth > ASSEMBLER_LIMITS.maxDepth) refuse('scope_too_deep', {maxDepth: ASSEMBLER_LIMITS.maxDepth});
    for (const name of readdirSync(dir).sort()) {
      if (++entries > ASSEMBLER_LIMITS.maxEntries) refuse('scope_too_many_entries', {maxEntries: ASSEMBLER_LIMITS.maxEntries});
      const path = join(dir, name), rel = relDir ? relDir + '/' + name : name, st = lstatSync(path);
      if (name.startsWith('.')) { exclude(SECRET_NAME.some(r => r.test(name)) ? 'secret_name' : 'hidden'); continue; }
      // A hard-linked file (nlink > 1) may be the same inode as a file outside the root: never read it.
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink !== 1)) { exclude('not_regular_file'); continue; }
      if (st.isDirectory()) { if (SKIP_DIRS.has(name.toLowerCase())) { exclude('dependency_or_cache'); continue; } walk(path, rel, depth + 1); continue; }
      if (SECRET_NAME.some(r => r.test(name))) { exclude('secret_name'); continue; }
      const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
      if (!TEXT_EXT.has(ext)) { exclude('unsupported_type'); continue; }
      if (o.select && !o.select.includes(rel)) continue; // not chosen: neither included nor reported
      // Too large even to chunk into one packet: the snapshot is NOT approvable (never a silent exclusion).
      if (st.size > ASSEMBLER_LIMITS.maxPacketBytes) refuse('scope_file_too_large', {relativePath: rel, byteSize: st.size, maxBytes: ASSEMBLER_LIMITS.maxPacketBytes});
      candidates.push({rel, path, st});
    }
  };
  walk(directory, '', 0);
  if (o.select) for (const rel of o.select) if (!candidates.some(c => c.rel === rel)) refuse('selected_file_not_admitted', {relativePath: rel});
  const files: {rel: string; text: string; sha: string; bytes: number}[] = [];
  for (const c of candidates) {
    const buf = readStable(c.path, c.st);
    let text: string;
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(buf); } catch { exclude('not_utf8_text'); continue; }
    if (text.includes('\u0000')) { exclude('not_utf8_text'); continue; }
    if (SECRET_CONTENT.some(r => r.test(text))) { exclude('secret_content'); continue; }
    files.push({rel: c.rel, text, sha: createHash('sha256').update(buf).digest('hex'), bytes: buf.length});
  }
  if (files.length === 0) refuse('scope_has_no_admissible_files', {excluded});
  // One document per file, or line-range chunks for a file over maxFileBytes. EVERY document counts against the caps.
  const docs: {title: string; text: string; sha: string; chunk: {rel: string; startLine: number; endLine: number; bytes: number} | null}[] = [];
  for (const f of files) {
    if (f.bytes <= ASSEMBLER_LIMITS.maxFileBytes) { docs.push({title: f.rel, text: f.text, sha: f.sha, chunk: null}); continue; }
    for (const c of lineChunks(f.rel, f.text)) docs.push({title: `${f.rel}#L${c.startLine}-L${c.endLine}`, text: c.text, sha: createHash('sha256').update(c.text).digest('hex'),
      chunk: {rel: f.rel, startLine: c.startLine, endLine: c.endLine, bytes: Buffer.byteLength(c.text)}});
  }
  if (docs.length > ASSEMBLER_LIMITS.maxFiles) refuse('scope_overflow', {files: docs.length, maxFiles: ASSEMBLER_LIMITS.maxFiles, excluded});
  const project = o.scope.kind === 'project' ? o.scope.projectId : null;
  const rawPacket = {contract: 'kapelle.task-source-packet/v1', sources: docs.map(d => ({
    document: {id: deterministicId(root.id, d.title, d.sha), version: 1, hash: d.sha, title: d.title, project,
      mimeType: /\.(csv|tsv)$/i.test(d.chunk?.rel ?? d.title) ? 'text/csv' : 'text/markdown', content: d.text},
    reference: `kapelle-folder:${root.id}/${d.title}`, capturedAt: o.capturedAt}))};
  // Measured before parsing, so an over-budget packet refuses with its own reason (the schema enforces the same bound).
  if (Buffer.byteLength(JSON.stringify(rawPacket)) > ASSEMBLER_LIMITS.maxPacketBytes) refuse('packet_too_large', {maxBytes: ASSEMBLER_LIMITS.maxPacketBytes});
  const packet: TaskSourcePacket = packetSchema.parse(rawPacket);
  const manifest = manifestSchema.parse({contract: 'kapelle.source-manifest/v1', scope: o.scope, rootId: root.id, readerPolicyHash: READER_POLICY_HASH,
    classification: root.classification ?? 'project', entries: files.map(f => ({relativePath: f.rel, byteSize: f.bytes, sha256: f.sha})), excluded,
    ...(docs.some(d => d.chunk) ? {chunks: docs.filter(d => d.chunk).map(d => ({relativePath: d.chunk!.rel, startLine: d.chunk!.startLine, endLine: d.chunk!.endLine, byteSize: d.chunk!.bytes, sha256: d.sha}))} : {}),
    packetHash: digest(packet)});
  return {packet, manifest, manifestHash: digest(manifest)};
}
/** Split a text at line boundaries into chunks of at most maxFileBytes (UTF-8), keeping 1-based whole-file line numbers so
 *  citations stay [path#Lx-Ly]. A single line longer than the bound refuses (never cut mid-line). Deterministic. */
export function lineChunks(rel: string, text: string): {startLine: number; endLine: number; text: string}[] {
  const lines = text.split(/(?<=\n)/), out: {startLine: number; endLine: number; text: string}[] = [];
  let cur = '', curBytes = 0, start = 1;
  lines.forEach((line, i) => {
    const b = Buffer.byteLength(line);
    if (b > ASSEMBLER_LIMITS.maxFileBytes) refuse('scope_line_too_long', {relativePath: rel, line: i + 1, maxBytes: ASSEMBLER_LIMITS.maxFileBytes});
    if (curBytes + b > ASSEMBLER_LIMITS.maxFileBytes) { out.push({startLine: start, endLine: i, text: cur}); cur = ''; curBytes = 0; start = i + 1; }
    cur += line; curBytes += b;
  });
  if (cur) out.push({startLine: start, endLine: lines.length, text: cur});
  return out;
}
/** Recompute a manifest's hash (the value bound into the plan and grantPlan v2). */
export const manifestHashOf = (m: SourceManifest) => digest(manifestSchema.parse(m));
export const canonicalManifest = (m: SourceManifest) => canonical(manifestSchema.parse(m));
