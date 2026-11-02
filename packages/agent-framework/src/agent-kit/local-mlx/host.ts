// Production wiring of the local-mlx adapter (Qwen qualified 2026-10-15 with the 2 GB prompt cache). The kit loads it lazily per
// run/chat turn. Every load re-verifies, fresh: the service plist is byte-identical to the QUALIFIED pin (a changed cache size,
// model path or flags is a different deployment and refuses), the service is running, and the profile is the catalog entry
// whose hash the qualification recorded. The service generation is the same identity the qualification used:
// <plist sha256 prefix 12>:<pid>. Read-only on the host (reads the plist, `launchctl print`); never starts or stops the service.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {z} from 'zod';
import {assert} from '../../validation.js';
import type {LocalAdapter} from '../../worker/execution.js';
import {profileHash, type RuntimeCatalog} from '../runtime-catalog.js';
import {openLocalMlxAdapter} from './adapter.js';

const abs = z.string().min(1).refine(p => isAbsolute(p) && !p.includes('/Dropbox/'), 'absolute path outside Dropbox');
export const localMlxHostSchema = z.object({
  /** The catalog profile this host serves (e.g. local-qwen) and its QUALIFIED hash. */
  profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), profileHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  /** The launchd service and its plist, pinned to the qualified bytes. */
  service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,120}$/), plist: z.object({path: abs, sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  reservationDir: abs,
}).strict();
export type LocalMlxHost = z.infer<typeof localMlxHostSchema>;

/** `launchctl print gui/<uid>/<service>` -> pid, or null when not running. */
export function launchdPid(service: string, run: (args: string[]) => string = args => execFileSync('launchctl', args, {encoding: 'utf8', timeout: 5000})): number | null {
  let out: string;
  try { out = run(['print', `gui/${process.getuid?.() ?? 501}/${service}`]); } catch { return null; }
  const m = /^\s*pid = (\d+)\s*$/m.exec(out);
  return m ? Number(m[1]) : null;
}

export function localMlxProvider(o: {config: unknown; catalog: () => RuntimeCatalog; pid?: (service: string) => number | null; read?: (path: string) => Buffer}) {
  const c = localMlxHostSchema.parse(o.config), read = o.read ?? (p => readFileSync(p)), pid = o.pid ?? (s => launchdPid(s));
  let cached: {generation: string; adapter: LocalAdapter} | null = null;
  return async function loadLocalProvider(): Promise<LocalAdapter> {
    const plistSha = createHash('sha256').update(read(c.plist.path)).digest('hex');
    assert(plistSha === c.plist.sha256, 'kit_local_service_changed');
    const p = pid(c.service);
    assert(p, 'kit_local_service_not_running');
    const profile = o.catalog().profiles.find(x => x.id === c.profileId);
    assert(profile && profile.runtime.kind === 'local-mlx' && profileHash(profile) === c.profileHash, 'kit_local_profile_not_qualified');
    assert(profile!.runtime.kind === 'local-mlx' && profile!.runtime.server.service === c.service, 'kit_local_service_differs');
    const generation = `${plistSha.slice(0, 12)}:${p}`;
    if (!cached || cached.generation !== generation) cached = {generation, adapter: openLocalMlxAdapter({profile, serviceGeneration: generation, reservationDir: c.reservationDir})};
    return cached.adapter;
  };
}
