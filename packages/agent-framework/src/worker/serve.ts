import { providerAuthPath } from './claude-provider-auth.js';
/** Explicit owner-hosted process. Starting it does not provision or resume an instance. */
import { createServer } from "node:http";
import { openSync, fstatSync, readFileSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { openFrameworkRuntime } from "../service/runtime.js";
import { frameworkHandler } from "../service/http.js";
import { ProductionSources, ReportSourceClient } from "./sources.js";
import { RestrictedWorker } from "./worker.js";
import { workerHandler } from "./http.js";
import { openTaskRuntime, openLegacyTaskReadHost } from '../task-delegation/runtime.js';
import { prepareKitLauncher } from '../agent-kit/kit-launcher.js';
import { openKitRuntime } from '../agent-kit/kit-runtime.js';
import { prepareTaskLauncher } from '../task-delegation/launcher.js';
import { createServiceStop, closeStoresInOrder } from './service-stop.js';
import { loadRestrictedClaudeAdapter } from './claude-host.js';
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw Error(`Missing ${name}`);
  return value;
};
function secret(name: string) {
  const file = required(name);
  return () => {
    try {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const s = fstatSync(fd);
        if (!s.isFile() || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.() || s.size > 1024)
          return "";
        const value = readFileSync(fd, "utf8").trim();
        return value.length >= 32 ? value : "";
      } finally {
        closeSync(fd);
      }
    } catch {
      return "";
    }
  };
}
const requireExisting = process.env.KAPELLE_FRAMEWORK_REQUIRE_EXISTING_AUTHORITY;
if (requireExisting !== undefined && requireExisting !== '1') throw Error('Invalid existing-authority option');
const taskConfig = process.env.KAPELLE_TASK_LAUNCHER_CONFIG;
if (requireExisting === '1' && taskConfig !== undefined) throw Error('observation_task_launcher_forbidden');
// Agent kit (Fable R-4b-1): the kit runtime replaces the pilot Task runtime in this process; the pilot-era execution status
// stays readable through the READ-ONLY legacy host when the pilot launcher config is still installed (Director, Oct 14).
const kitLauncherConfig = process.env.KAPELLE_KIT_LAUNCHER_CONFIG;
if (requireExisting === '1' && kitLauncherConfig !== undefined) throw Error('observation_kit_launcher_forbidden');
const owner = required("KAPELLE_FRAMEWORK_OWNER"),
  scope = required("KAPELLE_FRAMEWORK_SCOPE"),
  root = required("KAPELLE_FRAMEWORK_STATE_ROOT");
const sources = new ProductionSources(
  required("KAPELLE_FRAMEWORK_PROFILE"),
  owner,
  scope,
  new ReportSourceClient(
    required("KAPELLE_FRAMEWORK_SOURCE_URL"),
    secret("KAPELLE_FRAMEWORK_SOURCE_TOKEN_FILE"),
    owner,
    scope,
  ),
);
const profile = await sources.profile();
if (requireExisting === '1' && [profile.documentIds, profile.inboxDocumentIds, profile.inboxAgents, profile.releases, profile.bindings].some(items => items.length !== 0))
  throw Error('observation_empty_profile_required');
const claude = profile.bindings.some(b=>b.runtime==='claude-agent-sdk')
  ? await loadRestrictedClaudeAdapter({managerRoot:required('KAPELLE_CLAUDE_MANAGER_ROOT'),
      cliPath:required('KAPELLE_CLAUDE_CLI_PATH'),providerAuthBindingFile:providerAuthPath(process.env),runtimeRoot:join(root,'claude-runtime')})
  : undefined;
const authorityToken = secret("KAPELLE_FRAMEWORK_AUTHORITY_TOKEN_FILE"),
  workerToken = secret("KAPELLE_FRAMEWORK_WORKER_TOKEN_FILE");
if (!authorityToken() || !workerToken()) throw Error("Private service credentials unavailable");
const ports = ["KAPELLE_FRAMEWORK_AUTHORITY_PORT", "KAPELLE_FRAMEWORK_WORKER_PORT"].map((k) =>
  Number(required(k)),
);
if (ports.some((p) => !Number.isSafeInteger(p) || p < 1024 || p > 65535) || ports[0] === ports[1])
  throw Error("Distinct explicit local ports required");
const runtimeOptions = {
  requireExistingAuthority: requireExisting === '1',
  stateRoot: join(root, "native"),
  reactorRoot: required("KAPELLE_SCOPED_REACTOR_ROOT"),
  ownerId: owner,
  scopeRef: scope,
  facts: () => sources.facts(),
};
const pilotLauncherBase = () => ({runtime: runtimeOptions, workerRoot: join(root,"task-worker"), token: authorityToken,
  claudeHost:{managerRoot:required("KAPELLE_CLAUDE_MANAGER_ROOT"),cliPath:required("KAPELLE_CLAUDE_CLI_PATH"),providerAuthBindingFile:providerAuthPath(process.env),runtimeRoot:join(root,"task-claude-runtime")}});
const taskRuntime = taskConfig && !kitLauncherConfig ? await openTaskRuntime(await prepareTaskLauncher(taskConfig, pilotLauncherBase())) : undefined;
const kit = kitLauncherConfig ? await (async () => {
  // CP launch prereq 3: Claude is optional for a kit host (a hosted-only Linux VM has no Claude manager/CLI or Keychain). Both
  // variables set = Claude profiles available; neither = they refuse at load; exactly one = a misconfiguration (refuse start).
  const claudeVars = [process.env.KAPELLE_CLAUDE_MANAGER_ROOT, process.env.KAPELLE_CLAUDE_CLI_PATH].filter(Boolean).length;
  if (claudeVars === 1) throw Error("kit_claude_runtime_partially_configured");
  const prepared = await prepareKitLauncher(kitLauncherConfig, {runtime: runtimeOptions, workerRoot: join(root, "kit-worker"), token: authorityToken,
    ...(claudeVars === 2 ? {claudeHost: {managerRoot: required("KAPELLE_CLAUDE_MANAGER_ROOT"), cliPath: required("KAPELLE_CLAUDE_CLI_PATH"), providerAuthBindingFile: providerAuthPath(process.env), runtimeRoot: join(root, "kit-claude-runtime")}} : {})});
  const kitRuntime = await openKitRuntime(prepared.options);
  prepared.attach(kitRuntime);
  try {
    const legacy = taskConfig ? await openLegacyTaskReadHost(await prepareTaskLauncher(taskConfig, pilotLauncherBase()), kitRuntime.authority) : null;
    return {runtime: kitRuntime, legacy};
  } catch (error) { await kitRuntime.close(); throw error; }
})() : undefined;
const runtime = kit?.runtime ?? taskRuntime ?? await openFrameworkRuntime(runtimeOptions);
const worker = await RestrictedWorker.open(join(root, "worker"), runtime.authority, sources, fetch, claude).catch(
  async (error) => {
    await runtime.close();
    throw error;
  },
);
const servers = [
  createServer(kit ? (req, res) => kit.legacy ? kit.legacy.handler(req, res, () => kit.runtime.handler(req, res)) : kit.runtime.handler(req, res)
    : taskRuntime?.handler ?? frameworkHandler(runtime.authority, authorityToken)),
  createServer(workerHandler(worker, workerToken, requireExisting === '1')),
];
const stop = createServiceStop(servers, () => {worker.stop();taskRuntime?.stop();void kit?.runtime.exec.stop();},
  closeStoresInOrder([() => worker.close(), ...(kit?.legacy ? [() => kit.legacy!.close()] : []), () => runtime.close()]), 15000);
try {
  for (let i = 0; i < servers.length; i++)
    await new Promise<void>((resolve, reject) => {
      servers[i].once("error", reject);
      servers[i].listen(ports[i], "127.0.0.1", resolve);
    });
} catch (error) {
  await stop().catch(() => undefined);
  throw error;
}
// Failure retains locks and the process; another signal can retry graceful cleanup.
// Never force-close active sockets or exit with storage still unconfirmed closed.
const onStop = () => {void stop().catch(() => {console.error('framework_graceful_stop_incomplete; locks retained; retry required');});};
process.on("SIGTERM", onStop);
process.on("SIGINT", onStop);
