// local-mlx adapter (LOCAL-MLX-ADAPTER-SPEC): the vendored Pi agent core drives ONE assistant turn through a controlled stream
// function that makes exactly one MLX request (transport.ts). Pins checked before every run: the catalog profile hash, the
// vendored Pi digest, the model manifest. A runtime-wide durable reservation (reservation.ts) brackets the request: taken
// before, marked sent immediately before transmission, released only on a validated terminal response or a refusal before
// send; any uncertainty after send leaves the runtime unavailable. Nothing is retried, repaired, compacted or discovered.
import {readdirSync, readFileSync, lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha} from '../../worker/contracts.js';
import {ProviderRejectedBeforeInference, ProviderRejectedAfterInference, localInferenceInputSchema, localOutputEvidenceSchema, localRuntimeEvidenceSchema,
  type LocalAdapter, type LocalInferenceInput} from '../../worker/execution.js';
import {profileHash, localProfileSchema, type LocalProfile} from '../runtime-catalog.js';
import {runAgentLoop} from './vendor/pi/agent-loop.js';
import {AssistantMessageEventStream} from './vendor/pi/event-stream.js';
import type {AssistantMessage, Message, Model, StreamFn, SystemMessage, UserMessage} from './vendor/pi/types.js';
import {mlxComplete, MlxTransportError, MLX_UNSETTLED, type MlxFetch} from './transport.js';
import {RuntimeReservation} from './reservation.js';

export const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), 'vendor', 'pi');
/** sha256 over the vendored files sorted by name: name + NUL + bytes + NUL (vendor/pi/SOURCES.md). */
export function vendoredPiDigest(dir = VENDOR_DIR): string {
  const h = createHash('sha256');
  for (const name of readdirSync(dir).filter(n => !n.startsWith('.')).sort()) {
    const st = lstatSync(join(dir, name));
    if (!st.isFile()) throw new ProviderRejectedBeforeInference('local_harness_changed'); // no symlinks or nested code
    h.update(name); h.update('\0'); h.update(readFileSync(join(dir, name))); h.update('\0');
  }
  return 'sha256:' + h.digest('hex');
}
/** Chat-template allowance on top of the byte bound (Qwen ChatML framing for two messages + assistant header). */
export const TEMPLATE_TOKEN_ALLOWANCE = 64;

export type LocalMlxAdapterOptions = {
  profile: unknown;
  /** The admitted host service generation (deployment identity of com.kapelle.local-llm). */
  serviceGeneration: string;
  reservationDir: string;
  fetch?: MlxFetch;
  vendorDir?: string;
  /** Pinned tokenizer count for system+user. Absent: UTF-8 byte length is used as a safe upper bound (a byte-level BPE token
   *  covers at least one byte), plus the template allowance. Over-estimates, never truncates. */
  countPromptTokens?: (system: string, user: string) => number;
};

const refuse = (reason: string) => new ProviderRejectedBeforeInference(reason);

export function openLocalMlxAdapter(o: LocalMlxAdapterOptions): LocalAdapter & {reservation: RuntimeReservation; transportCalls(): number} {
  const profile: LocalProfile = localProfileSchema.parse(o.profile);
  const runtimeProfileHash = profileHash(profile), reservation = new RuntimeReservation(o.reservationDir, profile.runtime.server.service);
  reservation.recoverAtStart();
  const fetchImpl: MlxFetch = o.fetch ?? ((url, init) => fetch(url, init));
  let transportCalls = 0;
  return {
    runtime: 'pi-agent-core', harnessDigest: profile.harness.vendoredDigest, runtimeProfileHash, reservation,
    transportCalls: () => transportCalls,
    async run(raw: LocalInferenceInput, sessionId, signal, capture) {
      // ---- before send: every refusal here sends nothing and takes no reservation ----
      const input = localInferenceInputSchema.parse(raw);
      if (input.runtimeProfileHash !== runtimeProfileHash || input.model !== profile.runtime.model || input.modelManifestHash !== profile.runtime.modelManifestHash ||
        input.contextTokens !== profile.runtime.contextTokens || input.maxOutputTokens > profile.limits.maxOutputTokens || input.timeoutMs > profile.limits.timeoutMs) throw refuse('local_profile_changed');
      if (input.harnessDigest !== profile.harness.vendoredDigest || vendoredPiDigest(o.vendorDir) !== profile.harness.vendoredDigest) throw refuse('local_harness_changed');
      const promptTokens = (o.countPromptTokens ? o.countPromptTokens(input.system, input.user) : Buffer.byteLength(input.system) + Buffer.byteLength(input.user)) + TEMPLATE_TOKEN_ALLOWANCE;
      if (promptTokens + input.maxOutputTokens > input.contextTokens) throw refuse('local_context_exceeded');
      if (signal.aborted) throw Error('local_aborted_before_send');
      try { reservation.acquire(sessionId, o.serviceGeneration); } catch (e) { throw refuse(e instanceof Error ? e.message : 'local_runtime_busy'); }

      type Outcome = {kind: 'ok'; text: string; responseId: string | null; usage: {promptTokens: number; completionTokens: number} | null} | {kind: 'failed'; reason: string; sent: boolean};
      const run: {outcome: Outcome | null; requests: number} = {outcome: null, requests: 0};
      try {
        capture.runtime(localRuntimeEvidenceSchema.parse({provider: 'local', runtime: 'pi-agent-core', model: input.model, sessionId, runtimeProfileHash,
          harnessDigest: input.harnessDigest, modelManifestHash: input.modelManifestHash, serviceGeneration: o.serviceGeneration, tools: []}));
        const model: Model = {id: input.model, name: input.model, api: 'openai-completions', provider: 'local-mlx', baseUrl: profile.runtime.server.endpoint,
          reasoning: false, contextWindow: input.contextTokens, maxTokens: input.maxOutputTokens};
        // The controlled stream function: ONE request per execution (actual transport calls are counted, not Pi turns).
        const streamFn: StreamFn = (m, context) => {
          const stream = new AssistantMessageEventStream();
          const base = (): AssistantMessage => ({role: 'assistant', content: [], api: m.api, provider: m.provider, model: m.id, stopReason: 'pending', timestamp: Date.now(),
            usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}});
          const fail = (reason: string, sent: boolean, record = true) => { if (record) run.outcome = {kind: 'failed', reason, sent}; const e = base(); e.stopReason = signal.aborted ? 'aborted' : 'error'; e.errorMessage = reason;
            stream.push({type: 'error', reason: e.stopReason as 'aborted' | 'error', error: e}); };
          void (async () => {
            if (run.requests++ > 0) return fail('local_second_request_refused', false, false); // never overwrites the first outcome
            // The transcript must be exactly the admitted system + user text (nothing added by the loop).
            const msgs = context.messages;
            if (msgs.length !== 2 || msgs[0].role !== 'system' || msgs[0].content !== input.system || msgs[1].role !== 'user' || msgs[1].content !== input.user) return fail('local_transcript_changed', false);
            try {
              reservation.markSent(sessionId);
              transportCalls++;
              const r = await mlxComplete({endpoint: profile.runtime.server.endpoint, model: input.model, system: input.system, user: input.user, maxTokens: input.maxOutputTokens, temperature: profile.runtime.sampling.temperature},
                {fetch: fetchImpl, signal, deadlineMs: input.timeoutMs, maxOutputTokens: input.maxOutputTokens});
              run.outcome = {kind: 'ok', ...r};
              const done = base();
              done.content = [{type: 'text', text: r.text}]; done.stopReason = 'stop'; done.responseId = r.responseId ?? undefined;
              if (r.usage) done.usage = {...done.usage, input: r.usage.promptTokens, output: r.usage.completionTokens, totalTokens: r.usage.promptTokens + r.usage.completionTokens};
              const start = {...base(), content: []};
              stream.push({type: 'start', partial: start});
              stream.push({type: 'text_start', contentIndex: 0, partial: {...start, content: [{type: 'text', text: ''}]}});
              stream.push({type: 'text_delta', contentIndex: 0, delta: r.text, partial: {...start, content: [{type: 'text', text: r.text}]}});
              stream.push({type: 'text_end', contentIndex: 0, content: r.text, partial: {...start, content: [{type: 'text', text: r.text}]}});
              stream.push({type: 'done', reason: 'stop', message: done});
            } catch (e) { fail(e instanceof MlxTransportError ? e.reason : 'mlx_transport_failed', !(e instanceof MlxTransportError) || e.sent); }
          })();
          return stream;
        };
        const system: SystemMessage = {role: 'system', content: input.system, timestamp: 0}, user: UserMessage = {role: 'user', content: input.user, timestamp: 0};
        const messages = await runAgentLoop([system, user], {messages: []}, {model, convertToLlm: ms => ms as Message[]}, () => {}, signal, streamFn);
        const last = messages.at(-1) as AssistantMessage | undefined;
        const settled = run.outcome;
        if (!settled) throw Error('local_execution_unconfirmed');
        if (run.requests !== 1) throw Error('local_second_request_refused');
        if (settled.kind === 'failed') {
          if (!settled.sent) { reservation.release(sessionId); throw Error(settled.reason === 'mlx_aborted_before_send' ? 'local_aborted_before_send' : settled.reason); }
          if (MLX_UNSETTLED.has(settled.reason)) { reservation.markUncertain(sessionId, settled.reason); throw Error(settled.reason); }
          // A complete (rejected) response: the server settled; the invocation right is consumed; the outcome is definite.
          reservation.release(sessionId); throw new ProviderRejectedAfterInference(settled.reason);
        }
        if (!last || last.role !== 'assistant' || last.stopReason !== 'stop' || last.content.length !== 1 || last.content[0].type !== 'text' || last.content[0].text !== settled.text) {
          reservation.release(sessionId); throw Error('local_execution_unconfirmed');
        }
        const text = settled.text;
        capture.output(localOutputEvidenceSchema.parse({text, contentHash: sha(text), byteSize: Buffer.byteLength(text), stopReason: 'end_turn',
          resultId: settled.responseId ?? 'host:' + sessionId, resultIdSource: settled.responseId ? 'server' : 'host', usage: settled.usage, providerCostUsd: 0}));
        reservation.release(sessionId);
      } catch (e) {
        // Anything unexpected after the reservation was taken: if the request may have left, the runtime stays uncertain.
        const held = reservation.read();
        if (held?.sessionId === sessionId && held.state !== 'uncertain') {
          if (held.state === 'sent') reservation.markUncertain(sessionId, 'local_execution_unconfirmed'); else reservation.release(sessionId);
        }
        throw e;
      }
    },
  };
}
