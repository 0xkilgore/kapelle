// Production wiring of the qualified local model (2 GB prompt cache): every load re-verifies the qualified plist bytes, the
// running service and the catalog profile hash; the generation identity matches the qualification's (<plist sha12>:<pid>).
import {describe, it, expect} from 'vitest';
import {mkdtempSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {localProfileSchema, profileHash, runtimeCatalogSchema, runtimeLabel} from '../src/agent-kit/runtime-catalog.js';
import {vendoredPiDigest} from '../src/agent-kit/local-mlx/adapter.js';
import {localMlxProvider, launchdPid} from '../src/agent-kit/local-mlx/host.js';

const h = (c: string) => 'sha256:' + c.repeat(64);
const profile = localProfileSchema.parse({id: 'local-qwen', contract: 'kapelle.restricted-execution/v2', qualificationRef: 'synthetic:local-mlx',
  runtime: {kind: 'local-mlx', locality: 'local-only', model: '/models/qwen', server: {implementation: 'mlx-lm', version: '0.31.3', service: 'com.kapelle.local-llm', endpoint: 'http://127.0.0.1:8080/v1'},
    modelManifestHash: h('a'), runnerManifestHash: h('b'), modelStorageRef: '/models', contextTokens: 8192, sampling: {temperature: 0}, enableThinking: false, tools: [], concurrencyLimit: 1},
  harness: {kind: 'pi-agent-core', source: 'https://github.com/earendil-works/pi', commit: 'b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6', vendoredDigest: vendoredPiDigest(), adapterContract: 'kapelle.local-mlx-adapter/v1'},
  limits: {maxOutputTokens: 4096, maxBudgetUsd: 1, timeoutMs: 120000}});
const plistBytes = Buffer.from('<plist>--prompt-cache-bytes 2147483648</plist>'), plistSha = createHash('sha256').update(plistBytes).digest('hex');

describe('local-mlx host wiring', () => {
  const make = (o: {bytes?: Buffer; pid?: number | null; prof?: typeof profile; hash?: string} = {}) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'local-host-')));
    const catalog = runtimeCatalogSchema.parse({contract: 'kapelle.runtime-catalog/v1', profiles: [o.prof ?? profile]});
    return localMlxProvider({config: {profileId: 'local-qwen', profileHash: o.hash ?? profileHash(profile), service: 'com.kapelle.local-llm',
      plist: {path: '/Library/LaunchAgents/com.kapelle.local-llm.plist', sha256: plistSha}, reservationDir: join(dir, 'reservation')},
      catalog: () => catalog, read: () => o.bytes ?? plistBytes, pid: () => o.pid === undefined ? 4242 : o.pid});
  };
  it('loads the adapter for the qualified profile; same generation reuses it; a restarted service is a new generation', async () => {
    let pid = 4242;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'local-host-')));
    const catalog = runtimeCatalogSchema.parse({contract: 'kapelle.runtime-catalog/v1', profiles: [profile]});
    const load = localMlxProvider({config: {profileId: 'local-qwen', profileHash: profileHash(profile), service: 'com.kapelle.local-llm', plist: {path: '/p.plist', sha256: plistSha}, reservationDir: join(dir, 'r')},
      catalog: () => catalog, read: () => plistBytes, pid: () => pid});
    const a = await load();
    expect(a).toMatchObject({runtime: 'pi-agent-core', runtimeProfileHash: profileHash(profile), harnessDigest: profile.harness.vendoredDigest});
    expect(await load()).toBe(a);
    pid = 4343; expect(await load()).not.toBe(a);
  });
  it('refuses: changed plist (different cache/flags), service not running, profile edited or missing from the catalog', async () => {
    await expect(make({bytes: Buffer.from('<plist>--prompt-cache-bytes 4294967296</plist>')})()).rejects.toThrow('kit_local_service_changed');
    await expect(make({pid: null})()).rejects.toThrow('kit_local_service_not_running');
    await expect(make({hash: h('c')})()).rejects.toThrow('kit_local_profile_not_qualified');
    await expect(make({prof: {...profile, limits: {...profile.limits, timeoutMs: 60000}}})()).rejects.toThrow('kit_local_profile_not_qualified');
  });
  it('config refuses Dropbox paths and unknown fields; launchctl output parses the pid or null', () => {
    expect(() => localMlxProvider({config: {profileId: 'local-qwen', profileHash: h('a'), service: 's.x', plist: {path: '/Users/x/Dropbox/p.plist', sha256: 'a'.repeat(64)}, reservationDir: '/tmp/r'}, catalog: () => ({}) as never})).toThrow();
    expect(() => localMlxProvider({config: {profileId: 'local-qwen', profileHash: h('a'), service: 's.x', plist: {path: '/p', sha256: 'a'.repeat(64)}, reservationDir: '/tmp/r', endpoint: 'x'}, catalog: () => ({}) as never})).toThrow();
    expect(launchdPid('svc', () => 'gui/501/svc = {\n\tstate = running\n\tpid = 85610\n}')).toBe(85610);
    expect(launchdPid('svc', () => 'gui/501/svc = {\n\tstate = not running\n}')).toBeNull();
    expect(launchdPid('svc', () => { throw Error('Could not find service'); })).toBeNull();
  });
  it('owner-facing model label never carries a host path', () => {
    const path = '/Users/owner/Models/huggingface/hub/models--mlx-community--Qwen3.6-27B-4bit/snapshots/c000ac2c2057d94be3fa931000c31723aac53282';
    expect(runtimeLabel({...profile, runtime: {...profile.runtime, model: path}})).toBe('Local Qwen 3.6 27B (4-bit)');
    expect(runtimeLabel({...profile, runtime: {...profile.runtime, model: path}})).not.toMatch(/\/|Users|taskowner|snapshots/);
    expect(runtimeLabel({...profile, runtime: {...profile.runtime, model: 'mlx-community/Qwen3.6-27B-4bit'}})).toBe('Local Qwen 3.6 27B (4-bit)');
  });
});
