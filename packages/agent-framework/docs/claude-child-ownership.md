# Graceful-only Claude invocation ownership

The restricted adapter uses SDK 0.2.90's supported `spawnClaudeCodeProcess` hook.
A single signal adapter allows at most one SIGTERM to the positively identified
invocation-owned direct child. It denies SDK SIGKILL, all other signals and numeric
variants. Node spawn receives no AbortSignal; an explicit listener routes abort
through this same policy. There is no process-group or descendant signaling.
Arguments, private environment, cwd and pipe isolation retain the SDK contract.

Before spawn, the worker persists an exclusive invocation fence. Before admitting
messages it records the opaque invocation ID, binary/CLI/SDK pins, child PID,
parent PID, boot/start identity and cwd identity. Cancellation persists consumed
uncertainty before any allowed signal; the signal attempt itself is durable
before sending. Identity mismatch or audit failure prevents signaling and requires
reconciliation even if the child later closes. Audit contains metadata, never
credentials, prompts or output bodies. Loader pins snapshot exact bytes; Operations
must independently admit those pins in the release evidence. A runtime change
invalidates the earlier proof.

At cancellation T0+10 seconds without confirmed closure, the audit records
`termination_unconfirmed_worker_unavailable`. Task status already shows
`EXECUTION_UNCERTAIN` / `provider_termination_unconfirmed` while cleanup is pending.
The worker remains occupied and its writer lock cannot be released. Ten seconds
is an observation deadline, not a promise of termination. No lease is released
by racing a timer. `killed`, EOF, AbortError and iterator settlement are not proof
of exit. Actual Node `close` joins direct-child exit and required stream closure.

A valid result stays provisional until cleanup. After successful iterator
completion, allow two seconds for natural close, then enter cancellation and
retain output only as consumed uncertain evidence. Late callbacks cannot publish
a result. Once cleanup is confirmed, an uncertain attempt remains non-replayable
across restart; the worker can release active resources. A stalled iterator may
still block indefinitely even after process close.

A surviving `provider-invocation.json` blocks writer acquisition, release and
ordinary dead-writer recovery after parent crash. Recovery requires separate
operator reconciliation; there is no automatic fence erasure. An exited direct
child with an inherited pipe still open retains ownership. Arbitrary detached
descendants and remote inference/billing are not supervised or guaranteed stopped.
This policy accepts potentially indefinite worker unavailability.

Offline tests use disposable synthetic children: normal/cooperative exit,
result-before-exit, stdout closure while alive, late output, duplicate/disallowed
signals, pin mismatch, persistence failure, pre-abort, inherited pipes, crash
fences, close/reopen and no replay. A separate pinned installed-SDK test observes
its actual two-second SIGTERM and seven-second SIGKILL requests; only SIGTERM
reaches the child. Ownership remains held beyond the ten-second observation point
and clears only after voluntary child exit. Historical model success on 4903 is
not successor qualification. No provider or deployment approval is implied.
