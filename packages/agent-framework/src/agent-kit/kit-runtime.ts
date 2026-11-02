// Agent launch kit: the one service composition Ops starts (once): Framework runtime + kit facts + kit host (owner routes) +
// kit execution (/task-executions/kit/*). No per-agent file; everything per agent/run comes from native state + the pinned
// catalog + the creation ledger. Host-level inputs (publisher, tokens, Task source, provider loader, host pins) are installed
// once by the host's launcher.
import type {IncomingMessage, ServerResponse} from 'node:http';
import {openFrameworkRuntime, type RuntimeOptions} from '../service/runtime.js';
import {frameworkHandler} from '../service/http.js';
import type {Facts} from '../service/authority.js';
import {KitHost, withKitFacts} from './kit-host.js';
import {openKitChat} from './chat.js';
import {join} from 'node:path';
import {openKitExecution, type KitExecutionOptions} from './kit-execution.js';

export type KitRuntimeOptions = {
  runtime: Omit<RuntimeOptions, 'facts' | 'taskDelegation'> & {facts: () => Promise<Facts>};
  kitConfig: unknown; workerRoot: string; token: () => string; permissionRef: string;
  /** Hosted spend ledger status for GET /agents/spend (present only with a hosted runtime). */
  hostedSpend?: () => unknown;
} & Pick<KitExecutionOptions, 'loadProvider' | 'loadLocalProvider' | 'loadHostedProvider' | 'publisher' | 'privatePublisher' | 'reportProbe' | 'checkHostPins' | 'readTask' | 'recoverExecution'>;

export async function openKitRuntime(o: KitRuntimeOptions) {
  let kit: KitHost | null = null, exec: ReturnType<typeof openKitExecution> | null = null;
  const kitFacts = withKitFacts(o.runtime.facts, () => kit);
  const runtime = await openFrameworkRuntime({...o.runtime, taskDelegation: {readTask: o.readTask, permissionRef: o.permissionRef},
    facts: async () => { const f = await kitFacts(); return {...f, dispatch: {parents: f.dispatch?.parents ?? [], agents: f.dispatch?.agents ?? [], tasks: f.dispatch?.tasks ?? [],
      sources: f.dispatch?.sources ?? [], results: [...(f.dispatch?.results ?? []), ...(exec ? await exec.resultFacts() : [])]}}; }} as RuntimeOptions);
  try {
    kit = KitHost.open(o.kitConfig, runtime.authority);
    exec = openKitExecution({root: o.workerRoot, authority: runtime.authority, kit, token: o.token, loadProvider: o.loadProvider, loadLocalProvider: o.loadLocalProvider, loadHostedProvider: o.loadHostedProvider, publisher: o.publisher, privatePublisher: o.privatePublisher,
      reportProbe: o.reportProbe, checkHostPins: o.checkHostPins, readTask: o.readTask, recoverExecution: o.recoverExecution});
    const owner = frameworkHandler(runtime.authority, o.token, () => kit, o.hostedSpend);
    // AGENT-MODEL-V2 slice 2: read-only folder-grounded chat (owner token; no native writes).
    const chat = openKitChat({kit, authority: runtime.authority, root: join(kit.config.stateDir, 'chats'), token: o.token,
      loadProvider: o.loadProvider, loadLocalProvider: o.loadLocalProvider, loadHostedProvider: o.loadHostedProvider, checkHostPins: o.checkHostPins});
    const resumed = await kit.resumeAll(); // unfinished creations finish at start (each independent)
    const handler = (req: IncomingMessage, res: ServerResponse) => chat.handler(req, res, () => exec!.handler(req, res, () => owner(req, res)));
    return {authority: runtime.authority, kit, exec, chat, handler, resumed,
      async close() { await exec!.stop(); exec!.close(); await runtime.close(); }};
  } catch (e) { exec?.close(); await runtime.close(); throw e; }
}
