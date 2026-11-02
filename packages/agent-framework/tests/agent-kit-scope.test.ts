// AGENT-MODEL-V2 slice 1b: the read-only scope assembler on a synthetic workspace shaped like the owner's fantasy-basketball
// folder (structure only; synthetic contents). Every refusal path is exercised; nothing is executed.
import {describe, it, expect, beforeEach} from 'vitest';
import {mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, realpathSync, chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {assembleScope, resolveScope, ScopeRefused, READER_POLICY_HASH, manifestHashOf, ASSEMBLER_LIMITS, lineChunks} from '../src/agent-kit/scope-assembler.js';
import {resolveCitations, chatFilesOf} from '../src/agent-kit/chat.js';
import {digest} from '../src/content.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
let ws: string, personal: string;
const roots = () => [{id: 'personal', path: personal, label: 'Personal', projects: ['personal']}];
const at = '2026-10-15T15:00:00.000Z';
const refusal = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof ScopeRefused ? e.reason : 'other:' + (e as Error).message; } return 'none'; };
function write(rel: string, content: string | Buffer) { const p = join(personal, rel); mkdirSync(join(p, '..'), {recursive: true}); writeFileSync(p, content); return p; }

beforeEach(() => {
  ws = join(realpathSync(mkdtempSync(join(tmpdir(), 'scope-ws-'))), 'Workspace'); personal = join(ws, 'personal'); mkdirSync(personal, {recursive: true});
  write('fantasy-basketball/available-players.csv', 'player,team,proj\nSynthetic A,BOS,31.2\nSynthetic B,NYK,28.4\n');
  write('fantasy-basketball/trade-analysis.md', '# Trade analysis (synthetic)\n\nKeep A; sell B.\n');
  write('fantasy-basketball/bot.py', 'print("synthetic")\n');
  write('fantasy-basketball/keeper-model/model.py', 'def score(x):\n    return x\n');
  write('fantasy-basketball/.env', 'YAHOO_TOKEN=synthetic-not-a-secret\n');
  write('fantasy-basketball/.git/config', '[core]\n');
  write('fantasy-basketball/.venv/lib/x.py', 'x=1\n');
  write('fantasy-basketball/logs/run.log', 'ok\n');
  write('fantasy-basketball/weekly-report.txt', 'Week 1 (synthetic)\n');
  write('fantasy-basketball/notes-with-key.md', 'aws AKIA' + 'ABCDEFGHIJKLMNOP' + ' leaked\n');
  write('fantasy-basketball/big.csv', 'a,b\n' + '1,2\n'.repeat(9000));
  write('fantasy-basketball/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

describe('scope assembler (read-only snapshot)', () => {
  it('includes exactly the admissible text files, excludes the rest with content-free reasons, and binds names + hashes', () => {
    const r = assembleScope({scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'}, roots: roots(), capturedAt: at, workspace: ws});
    // big.csv (36 KB) is over the per-file bound: it is CHUNKED and included (never excluded), whole-file entry kept.
    expect(r.manifest.entries.map(e => e.relativePath)).toEqual(['available-players.csv', 'big.csv', 'bot.py', 'keeper-model/model.py', 'trade-analysis.md', 'weekly-report.txt']);
    expect(r.manifest.excluded).toEqual({secret_name: 1, hidden: 2, dependency_or_cache: 1, unsupported_type: 1, secret_content: 1});
    expect(r.manifest.chunks!.map(c => [c.relativePath, c.startLine])).toEqual([['big.csv', 1], ['big.csv', r.manifest.chunks![1].startLine]]);
    const csv = r.manifest.entries.find(e => e.relativePath === 'available-players.csv')!;
    expect(csv.sha256).toBe(sha('player,team,proj\nSynthetic A,BOS,31.2\nSynthetic B,NYK,28.4\n'));
    const doc = r.packet.sources.find(s => s.document.title === 'available-players.csv')!;
    expect(doc.document).toMatchObject({mimeType: 'text/csv', hash: csv.sha256, project: null});
    expect(doc.reference).toBe('kapelle-folder:personal/available-players.csv'); // relative, never a host path
    expect(JSON.stringify(r)).not.toContain(ws);
    expect(r.manifest.packetHash).toBe(digest(r.packet));
    expect(r.manifest.readerPolicyHash).toBe(READER_POLICY_HASH);
    expect(r.manifestHash).toBe(manifestHashOf(r.manifest));
    // Deterministic: the same folder state gives the same manifest; any byte change gives a different one.
    expect(assembleScope({scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'}, roots: roots(), capturedAt: at, workspace: ws}).manifestHash).toBe(r.manifestHash);
    write('fantasy-basketball/trade-analysis.md', '# Trade analysis (synthetic)\n\nKeep A; keep B.\n');
    expect(assembleScope({scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'fantasy-basketball'}, roots: roots(), capturedAt: at, workspace: ws}).manifestHash).not.toBe(r.manifestHash);
  });
  it('a project scope resolves to its admitted root; owner selection narrows the files (still screened)', () => {
    const r = assembleScope({scope: {kind: 'project', projectId: 'personal'}, roots: roots(), capturedAt: at, workspace: ws, select: ['fantasy-basketball/trade-analysis.md']});
    expect(r.manifest).toMatchObject({rootId: 'personal', entries: [{relativePath: 'fantasy-basketball/trade-analysis.md'}]});
    expect(r.packet.sources[0].document.project).toBe('personal');
    expect(refusal(() => assembleScope({scope: {kind: 'project', projectId: 'personal'}, roots: roots(), capturedAt: at, workspace: ws, select: ['fantasy-basketball/.env']}))).toBe('selected_file_not_admitted');
  });
  it('refuses: unadmitted root/project, root outside Workspace or in Dropbox, symlinked root or path, missing directory, no admissible files', () => {
    expect(refusal(() => resolveScope({kind: 'folder', rootId: 'other', relativeDirectory: ''}, roots(), ws))).toBe('scope_root_not_admitted');
    expect(refusal(() => resolveScope({kind: 'project', projectId: 'finances'}, roots(), ws))).toBe('scope_root_not_admitted');
    expect(refusal(() => resolveScope({kind: 'folder', rootId: 'xx', relativeDirectory: ''}, [{id: 'xx', path: '/etc', label: 'x', projects: []}], ws))).toBe('scope_root_outside_workspace');
    expect(refusal(() => resolveScope({kind: 'folder', rootId: 'xx', relativeDirectory: ''}, [{id: 'xx', path: join(ws, 'Dropbox', 'y'), label: 'x', projects: []}], ws))).toBe('scope_root_outside_workspace');
    const alias = join(ws, 'alias'); symlinkSync(personal, alias);
    expect(refusal(() => resolveScope({kind: 'folder', rootId: 'aa', relativeDirectory: ''}, [{id: 'aa', path: alias, label: 'a', projects: []}], ws))).toBe('scope_root_is_alias');
    symlinkSync(join(personal, 'fantasy-basketball'), join(personal, 'linked'));
    expect(refusal(() => resolveScope({kind: 'folder', rootId: 'personal', relativeDirectory: 'linked'}, roots(), ws))).toBe('scope_path_symlink');
    expect(refusal(() => resolveScope({kind: 'folder', rootId: 'personal', relativeDirectory: 'nope'}, roots(), ws))).toBe('scope_directory_missing');
    expect(refusal(() => resolveScope({kind: 'folder', rootId: 'personal', relativeDirectory: '../..'} as never, roots(), ws))).toMatch(/^other:.*relative_directory_invalid/s); // schema refuses traversal
  });
  it('Fable F-1: credential keys are caught in JSON-quoted form as in env/yaml/toml/ini; the reader policy hash covers the rule', () => {
    const forms = {'a.json': '{"api_key": "abcdefghijklmnop1234"}\n', 'b.json': "{'password': 'correcthorsebattery'}\n", 'c.json': '{"client_secret":"abcdefghijklmnop1234"}\n',
      'd.txt': 'API_KEY=abcdefghijklmnop1234\n', 'e.yaml': 'token: abcdefghijklmnop1234\n', 'f.toml': 'password = "abcdefghijklmnop1234"\n', 'g.ini': 'secret=abcdefghijklmnop1234\n'};
    for (const [name, body] of Object.entries(forms)) write('keys/' + name, body);
    write('keys/ok.json', '{"apiVersion": "v1", "tokens_used": 12}\n');
    const r = assembleScope({scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'keys'}, roots: roots(), capturedAt: at, workspace: ws});
    expect(r.manifest.entries.map(e => e.relativePath)).toEqual(['ok.json']);
    expect(r.manifest.excluded).toEqual({secret_content: 7});
  });
  it('Fable F-2: a hard-linked file (nlink > 1) is never read, even though it is a regular file inside the root', () => {
    const outside = join(ws, 'outside.md'); writeFileSync(outside, '# outside the root\n');
    mkdirSync(join(personal, 'linked-dir')); linkSync(outside, join(personal, 'linked-dir', 'inside.md'));
    write('linked-dir/plain.md', '# plain\n');
    const r = assembleScope({scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'linked-dir'}, roots: roots(), capturedAt: at, workspace: ws});
    expect(r.manifest.entries.map(e => e.relativePath)).toEqual(['plain.md']);
    expect(r.manifest.excluded).toEqual({not_regular_file: 1});
  });
  it('a symlinked FILE is never followed; empty and overflowing scopes refuse instead of sampling', () => {
    mkdirSync(join(personal, 'only-links'));
    symlinkSync(join(personal, 'fantasy-basketball', 'trade-analysis.md'), join(personal, 'only-links', 'trade.md'));
    expect(refusal(() => assembleScope({scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'only-links'}, roots: roots(), capturedAt: at, workspace: ws}))).toBe('scope_has_no_admissible_files');
    for (let i = 0; i <= ASSEMBLER_LIMITS.maxFiles; i++) write(`many/n${i}.md`, `note ${i}\n`);
    expect(refusal(() => assembleScope({scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'many'}, roots: roots(), capturedAt: at, workspace: ws}))).toBe('scope_overflow');
  });

  // CP agent launch prerequisite (Fable review): a meeting transcript over the per-file bound is split into line-range chunks
  // with whole-file line numbers, deterministic ids and the whole-file sha; never excluded; overflow refuses.
  it('chunks an oversize transcript into path#Lx-Ly documents that reassemble exactly; manifest keeps the whole-file sha', () => {
    const lines = Array.from({length: 1300}, (_, i) => `[00:${String(i % 60).padStart(2, '0')}] Speaker ${i % 4}: synthetic line ${i + 1} about the Block Partyival plan.`);
    const transcript = lines.join('\n') + '\n';
    expect(Buffer.byteLength(transcript)).toBeGreaterThan(58000);
    write('meetings/2026-10-08/transcript.txt', transcript);
    write('meetings/2026-10-08/summary.md', '# Summary (synthetic)\nDecisions: date set.\n');
    const go = () => assembleScope({scope: {kind: 'folder', rootId: 'personal', relativeDirectory: 'meetings'}, roots: roots(), capturedAt: at, workspace: ws});
    const r = go();
    expect(r.manifest.excluded).toEqual({});
    const entry = r.manifest.entries.find(e => e.relativePath === '2026-10-08/transcript.txt')!;
    expect(entry).toEqual({relativePath: '2026-10-08/transcript.txt', byteSize: Buffer.byteLength(transcript), sha256: sha(transcript)});
    const chunks = r.manifest.chunks!;
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].startLine).toBe(1);expect(chunks.at(-1)!.endLine).toBe(1300);
    for (let i = 1; i < chunks.length; i++) expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
    const docs = r.packet.sources.filter(src => src.document.title.startsWith('2026-10-08/transcript.txt#L'));
    expect(docs.map(d => d.document.title)).toEqual(chunks.map(c => `2026-10-08/transcript.txt#L${c.startLine}-L${c.endLine}`));
    expect(docs.map(d => d.document.content).join('')).toBe(transcript);
    docs.forEach((d, i) => { expect(d.document.hash).toBe(chunks[i].sha256); expect(sha(d.document.content)).toBe(chunks[i].sha256);
      expect(Buffer.byteLength(d.document.content)).toBeLessThanOrEqual(ASSEMBLER_LIMITS.maxFileBytes); });
    expect(docs[0].reference).toBe('kapelle-folder:personal/2026-10-08/transcript.txt#L' + chunks[0].startLine + '-L' + chunks[0].endLine);
    // Deterministic: same bytes -> same ids, manifest and hash.
    expect(go().manifestHash).toBe(r.manifestHash);
    expect(go().packet.sources.map(s => s.document.id)).toEqual(r.packet.sources.map(s => s.document.id));
    // Chat sees whole-file line numbers; a citation inside chunk 2 (and one spanning the boundary) resolves; past the end does not.
    const files = chatFilesOf(r.packet.sources, r.manifest.entries);
    const second = chunks[1].startLine;
    const c = resolveCitations(`[2026-10-08/transcript.txt#L${second + 2}] [2026-10-08/transcript.txt#L${second - 1}-L${second + 1}] [2026-10-08/transcript.txt#L1301]`, files);
    expect(c.map(x => x.valid)).toEqual([true, true, false]);
    expect(c[0].sha256).toBe(sha(transcript));
  });
  it('refuses instead of excluding: a file larger than the packet, a line longer than a chunk, too many chunks, an over-budget packet', () => {
    const refusalOf = (rel: string) => refusal(() => assembleScope({scope: {kind: 'folder', rootId: 'personal', relativeDirectory: rel}, roots: roots(), capturedAt: at, workspace: ws}));
    write('huge/minutes.txt', 'x\n'.repeat(70000)); // 140 KB > the 128 KiB packet
    expect(refusalOf('huge')).toBe('scope_file_too_large');
    write('longline/one.txt', 'y'.repeat(40000) + '\n');
    expect(refusalOf('longline')).toBe('scope_line_too_long');
    for (let i = 0; i < 4; i++) write(`many-chunks/t${i}.txt`, 'z'.repeat(80) + '\n'.repeat(1) + ('w'.repeat(99) + '\n').repeat(400)); // ~40 KB each -> 2 chunks
    expect(refusalOf('many-chunks')).toBe('scope_overflow');
    for (let i = 0; i < 2; i++) write(`big-packet/t${i}.txt`, ('v'.repeat(199) + '\n').repeat(330)); // ~66 KB each -> 4 chunks, packet > 128 KiB
    expect(refusalOf('big-packet')).toBe('packet_too_large');
  });
  it('lineChunks never cuts a line and keeps 1-based whole-file numbering', () => {
    const t = Array.from({length: 5000}, (_, i) => `line ${i + 1}`).join('\n');
    const cs = lineChunks('a.txt', t);
    expect(cs.map(c => c.text).join('')).toBe(t);
    expect(cs[0].startLine).toBe(1);expect(cs.at(-1)!.endLine).toBe(5000);
    expect(cs.every(c => c.text.split('\n').length - (c.text.endsWith('\n') ? 1 : 0) === c.endLine - c.startLine + 1)).toBe(true);
  });
});
