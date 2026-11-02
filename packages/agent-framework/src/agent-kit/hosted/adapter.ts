// Hosted API adapter (CP agent launch): the HostedAdapter port over hostedComplete. Before send it checks the input against the
// pinned profile, reads the bearer key from a server-only secret FILE (owner-only, not a link, one line; never logged, never in
// evidence or errors), reserves the worst case in the spend ledger and records 'sent' durably; then exactly one request. It
// settles on the provider-returned cost (also for a rejected response that reports one), or holds the reservation unsettled when the outcome/cost is unknown. No agent loop.
import {closeSync, fstatSync, lstatSync, openSync, readSync, constants} from 'node:fs';
import {sha} from '../../worker/contracts.js';
import {hostedInferenceInputSchema, hostedRuntimeEvidenceSchema, hostedOutputEvidenceSchema, ProviderRejectedAfterInference, ProviderRejectedBeforeInference, type HostedAdapter} from '../../worker/execution.js';
import {hostedProfileSchema, hostedProfileHash, hostedReservationUsd, type HostedProfile} from './profile.js';
import {hostedComplete, HostedTransportError, HOSTED_UNSETTLED, HOSTED_REFUSED_BEFORE_INFERENCE, hostedBaseLabel, type HostedFetch} from './transport.js';
import type {SpendLedger} from './ledger.js';

/** Read the bearer key: owner-only regular file (not a symlink), <= 4 KiB, a single token. Refusals name no content. */
export function readSecretFile(path: string): string {
  const l = lstatSync(path);
  if (l.isSymbolicLink() || !l.isFile()) throw Error('hosted_secret_not_regular_file');
  if ((l.mode & 0o077) !== 0) throw Error('hosted_secret_not_private');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (st.size < 1 || st.size > 4096 || st.ino !== l.ino) throw Error('hosted_secret_invalid');
    const buf = Buffer.alloc(st.size); readSync(fd, buf, 0, st.size, 0);
    const key = buf.toString('utf8').trim();
    if (!key || /\s/.test(key)) throw Error('hosted_secret_invalid');
    return key;
  } finally { closeSync(fd); }
}

export function openHostedAdapter(o: {profile: unknown; secretFile: string; ledger: SpendLedger; fetch?: HostedFetch}): HostedAdapter & {transportCalls(): number} {
  const profile: HostedProfile = hostedProfileSchema.parse(o.profile), runtimeProfileHash = hostedProfileHash(profile);
  const fetchImpl: HostedFetch = o.fetch ?? ((url, init) => fetch(url, init));
  let calls = 0;
  return {
    runtime: 'hosted-api', runtimeProfileHash, transportCalls: () => calls,
    async run(raw, sessionId, signal, capture) {
      // ---- before send: refusals here send nothing and hold nothing ----
      const input = hostedInferenceInputSchema.parse(raw);
      if (input.runtimeProfileHash !== runtimeProfileHash || input.model !== profile.runtime.model || input.contextTokens !== profile.runtime.contextTokens ||
        input.maxOutputTokens > profile.limits.maxOutputTokens || input.timeoutMs > profile.limits.timeoutMs || input.maxBudgetUsd > profile.limits.maxBudgetUsd) throw Error('hosted_profile_changed');
      const promptBytes = Buffer.byteLength(input.system) + Buffer.byteLength(input.user);
      if (Math.ceil(promptBytes / 3) + input.maxOutputTokens > input.contextTokens) throw Error('hosted_context_exceeded');
      if (signal.aborted) throw Error('hosted_aborted_before_send');
      const apiKey = readSecretFile(o.secretFile);
      // A spend-cap refusal happens before anything is sent: a definite rejection, never an uncertain outcome. The monthly cap
      // may clear later (pre-send, retryable); a run cap below the reservation is a configuration mismatch that cannot succeed
      // on retry, so it is terminal (Fable C-D N-4).
      try { o.ledger.reserve(sessionId, profile.id, hostedReservationUsd(profile, promptBytes, input.maxOutputTokens), input.maxBudgetUsd); }
      catch (e) {
        if (e instanceof Error && e.message === 'hosted_monthly_cap_exceeded') throw new ProviderRejectedBeforeInference(e.message);
        if (e instanceof Error && e.message === 'hosted_run_cap_exceeded') throw new ProviderRejectedBeforeInference(e.message, true);
        throw e;
      }
      try {
        capture.runtime(hostedRuntimeEvidenceSchema.parse({provider: 'hosted', runtime: 'hosted-api', model: input.model, sessionId, runtimeProfileHash, origin: profile.runtime.origin, tools: []}));
        o.ledger.markSent(sessionId); calls++;
        let r;
        try {
          r = await hostedComplete({origin: profile.runtime.origin, apiKey, model: input.model, system: input.system, user: input.user, maxTokens: input.maxOutputTokens,
            providers: profile.runtime.providers, dataPolicy: profile.runtime.dataPolicy,
            ...(profile.runtime.providerNames ? {providerNames: profile.runtime.providerNames} : {}), ...(profile.runtime.responseModels ? {responseModels: profile.runtime.responseModels} : {}),
            ...(profile.runtime.reasoningOff ? {reasoningOff: profile.runtime.reasoningOff} : {})}, {fetch: fetchImpl, signal, deadlineMs: input.timeoutMs, maxOutputTokens: input.maxOutputTokens, pinnedOrigin: profile.runtime.origin});
        } catch (e) {
          const reason = e instanceof HostedTransportError ? e.reason : 'hosted_transport_failed', sent = !(e instanceof HostedTransportError) || e.sent;
          if (!sent) { o.ledger.release(sessionId, reason); throw Error(reason); }
          if (HOSTED_UNSETTLED.has(reason)) { o.ledger.markUnsettled(sessionId, reason); capture.uncertain?.(); throw Error(reason); }
          // A complete, rejected response is definite and consumed: the provider refused before generating (402/429/4xx) ->
          // released; it returned a cost (wrong model/provider, reasoning, truncation, ...) -> settled at THAT cost, not the
          // worst case; no cost in the body (malformed, not JSON) -> held unsettled for Ops to reconcile.
          const cost = e instanceof HostedTransportError ? e.costUsd : null;
          if (HOSTED_REFUSED_BEFORE_INFERENCE.has(hostedBaseLabel(reason))) o.ledger.release(sessionId, reason);
          else if (cost !== null) o.ledger.settle(sessionId, cost, reason);
          else o.ledger.markUnsettled(sessionId, reason);
          throw new ProviderRejectedAfterInference(reason);
        }
        o.ledger.settle(sessionId, r.costUsd);
        capture.output(hostedOutputEvidenceSchema.parse({text: r.text, contentHash: sha(r.text), byteSize: Buffer.byteLength(r.text), stopReason: 'end_turn',
          resultId: r.responseId ?? 'host:' + sessionId, routedProvider: r.routedProvider, usage: r.usage, providerCostUsd: r.costUsd}));
      } catch (e) {
        // Anything unexpected after the reservation: if it may have been sent, keep it held.
        const entry = o.ledger.entry(sessionId);
        if (entry?.state === 'sent') o.ledger.markUnsettled(sessionId, 'hosted_execution_unconfirmed');
        else if (entry?.state === 'reserved') o.ledger.release(sessionId);
        throw e;
      }
    },
  };
}
