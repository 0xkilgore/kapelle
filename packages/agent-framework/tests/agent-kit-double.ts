// Shared test double for the agent kit: applies commands through the REAL prepareCommand/applyNative, with allocation
// reserved by operation id, a per-operation journal and fault injection (what FrameworkAuthority provides).
import {prepareCommand, applyNative, nativeModel, digest, type NativeDocument, type TrustedContext, type ModelType, type ResourceFact} from '../src/command-boundary.js';
import {CreationLedger, type ProvisionPort} from '../src/agent-kit/create-agent.js';
import {kitHostFacts} from '../src/agent-kit/host-facts.js';
import {releaseOfDocument, type ReleaseV2} from '../src/agent-kit/definition-v2.js';
import {runtimeCatalogSchema, claudeProfileFromBinding, type RuntimeCatalog} from '../src/agent-kit/runtime-catalog.js';
export const W4 = {model: 'claude-opus-5-5', credentialTeamId: '00000000-0000-4000-8000-0000000000aa', credentialKind: 'claude-code-oauth' as const, runtime: 'claude-agent-sdk' as const,
  sdkVersion: '0.2.90', cliVersion: '2.1.295', maxOutputTokens: 16000, maxBudgetUsd: 2, timeoutMs: 300000, tools: [] as never[], settings: 'isolated' as const, thinking: 'adaptive' as const, effort: 'high' as const};
export const catalogOf = (cli = '2.1.295') => runtimeCatalogSchema.parse({contract: 'kapelle.runtime-catalog/v1', profiles: [claudeProfileFromBinding('claude-current', {...W4, cliVersion: cli}, 'x')]});
export const OWNER = 'human:owner', SCOPE = 'kapelle';
export type Fault = {when: 'before' | 'after'; call: 'allocate' | string; times: number};
export class FakeAuthority implements ProvisionPort {
  docs = new Map<string, NativeDocument>(); reservations = new Map<string, string>(); journal = new Map<string, {hash: string; result: unknown}>();
  faults: Fault[] = []; calls: string[] = []; clock = Date.parse('2026-10-15T00:00:00.000Z');
  constructor(public catalog: RuntimeCatalog, public ledger: CreationLedger) {}
  private trip(when: Fault['when'], call: string) {
    const f = this.faults.find(x => x.when === when && x.call === call && x.times > 0);
    if (f) { f.times--; throw new Error(`injected ${when === 'before' ? 'crash before' : 'lost reply after'} ${call}`); }
  }
  async allocate(op: string, type: ModelType, name: string, version = 1) {
    this.calls.push('allocate:' + type);
    this.trip('before', 'allocate');
    let id = this.reservations.get(op);
    if (!id) {
      const d = nativeModel(type, version).utils.createDocument() as NativeDocument;
      (d.header as {name: string}).name = name; id = d.header.id;
      this.docs.set(id, d); this.reservations.set(op, id);
    }
    this.trip('after', 'allocate');
    return id;
  }
  async read(id: string) { return structuredClone(this.docs.get(id)!) as never; }
  context(doc: NativeDocument): TrustedContext {
    const releases = [...this.docs.values()].filter(d => d.header.documentType === 'kapelle/agent-definition').map(d => releaseOfDocument(d as never)).filter((r): r is ReleaseV2 => !!r);
    const approved = ['ledger'].flatMap(() => [...this.approvedManifests]);
    const f = kitHostFacts(releases, this.catalog, approved);
    this.clock += 1000;
    return {principalId: OWNER, ownerId: OWNER, scopeRef: SCOPE, occurredAt: new Date(this.clock).toISOString(), connectionRefs: [], scheduleRefs: [],
      artifacts: [], effects: [], deliveryReceipts: [], ...f, resources: [...this.resources], admittedTaskReads: [...this.admittedTaskReads],
      ...(doc.header.documentType === 'kapelle/agent-instance' && doc.state.global.revision > 0 ? {instance: doc.state.global as never} : {})};
  }
  approvedManifests: never[] = [];
  /** Host-admitted resource facts (the Task-delegation permission) and per-instance Task reads. */
  resources: ResourceFact[] = []; admittedTaskReads: {instanceId: string; resource: ResourceFact}[] = [];
  /** The trusted context the host would build for a recipient check right now (no clock advance side effects beyond one tick). */
  ctxFor(doc: NativeDocument) { return this.context(doc); }
  async command(raw: any) {
    this.calls.push('command:' + raw.type);
    this.trip('before', raw.type);
    const hash = digest(raw), j = this.journal.get(raw.operationId);
    if (j) { if (j.hash !== hash) throw new Error('Operation ID conflicts with original request'); return j.result; }
    const doc = this.docs.get(raw.documentId)!;
    const next = applyNative(doc, prepareCommand(raw, doc, this.context(doc)).action);
    this.docs.set(raw.documentId, next);
    const result = {revision: next.state.global.revision};
    this.journal.set(raw.operationId, {hash, result});
    this.trip('after', raw.type);
    return result;
  }
  count(type: string) { return [...this.docs.values()].filter(d => d.header.documentType === type).length; }
}

