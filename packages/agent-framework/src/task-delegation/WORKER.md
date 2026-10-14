# One supplied-source Task worker

`TaskWorker` is a source-only host library for `kapelle.task-delegation/v1`. It adds no server, scheduler, credential, browsing tool, Task store or Report Registry. Instantiate it with the existing Framework authority, a private execution-journal directory, one exact worker binding, the existing restricted Claude adapter (or deterministic test adapter), an admitted packet reader and optionally a Report adapter.

## Input and execution

Before creating the native proposal, save `packetTaskNotes(packet, notes)` in the existing Task body. It contains the canonical SHA256 of a bounded supplied packet (up to eight unique documents, 128 KiB total), plus owner notes. The proposal must include notes. Every document carries exact bytes/hash/version and source reference/capture time. The host packet reader must enforce its current owner/scope/instance admission; a matching hash alone grants no read access. There is no URL fetching. A link without approved packet bytes is insufficient.

`run(dispatchId)` reads the actual native Dispatch bundle. The existing authority rechecks the exact native ReviewIntent approval, Task revision/source, READY qualified recipient, pinned definition/runtime/model policy, current grants, expiry and lineage. The worker verifies its installed binding, approved PREPARE_ONLY plan and packet hash. The fixed no-tools research prompt, exact plan, selected Task text, packet and model/budget/runtime configuration are hashed and retained before provider execution. The installed definition/runtime qualification must cover this fixed prompt and code; this library does not qualify a definition itself.

The worker reuses the restricted Claude adapter, runtime/output evidence validators, private writer lock and immutable publication byte hashing. Extracting the common inference input type does not relax the old document-review work schema. Tools, browsing, MCP, shell, fallback and external effects remain absent. Provider receipts must match model/session/SDK/CLI and exact output bytes; costs must fit the installed budget.

A FULL-synchronous SQLite journal retains execution evidence only. Native Task, proposal, Dispatch and Report stay authoritative. Native acceptance is bound to the locally retained session operation identity; a different empty worker journal cannot reuse an already accepted Dispatch. One private journal writer is enforced. Retain the journal across upgrades; do not erase it to retry. A provably dead writer is automatically reclaimed under the exclusive acquisition guard. An orphan guard fails closed for offline recovery; the explicit `recoverDeadWriterLock(root, expectedPid)` remains available for the writer lock.

A durable started claim grants at most one inference invocation. A crash, timeout or lost response returns EXECUTION_UNCERTAIN. Optional host `recoverExecution(sessionId,inputHash)` is strictly read-only and must return confirmed matching evidence; absence never grants a new invocation. Captured output before a lost response remains evidence, not proof of completed execution. This intentionally may require operator reconciliation for a crash before the invocation actually began; it does not promise exactly-once success.

Only a local failure proven before SDK query submission is retryable: missing credentials, a refused private runtime directory, or the provider-managed binding/context checks (`claude_provider_binding_mismatch`, `claude_provider_context_invalid`, all raised as `ProviderRejectedBeforeInference`). Execution, historical-record admission and inspection share the same exact reason allowlist. Such attempts retain fixed reasons and allow at most three local refusals on the same Dispatch/session. The SDK initialization contract is checked after query invocation, so init mismatches remain uncertain even without assistant/result events. An abort or a late rejection never releases the claim.

`begin(dispatchId)` is the host entry: it performs the native checks and acceptance, persists the started claim, and returns `EXECUTION_RUNNING` while the provider call and publication continue in this process. `inspect` reports `EXECUTION_RUNNING` only for the Dispatch this process is executing now; after a restart the same journal row reads as uncertain, exactly as before. `run` awaits the whole sequence and is unchanged for library callers. `stop()` aborts and `drain()` awaits the detached run so a service stop can close the journal.

## Report adapter and return

The optional host-installed `TaskReportAdapter` exposes `admitted`, `publish`, read-only `lookup`, and independently authenticated `read`. It must wrap the existing Registry publisher/recovery and reader, with its already-admitted publisher identity, model and credentials. No write adapter is installed by this change. The publication request binds a deterministic publicationId to owner, scope, instance, Dispatch/input hash, Task, packet hash, execution evidence hash and exact Markdown bytes.

The publisher must enforce that full immutable binding, atomic publication identity and current admission itself. The worker persists the publication claim before calling publish, at most once. After any ambiguous reply it only looks up that identity; null or unavailable lookup leaves REPORT_PENDING. It never issues another publish because a lookup says absent. A changed publisher binding is refused. The existing Registry is the publication authority; this journal is not a second registry.

Independent readback must match the Report ID, owner/scope, original Dispatch/source, producer, publication identity, immutable content version, verification reference and exact output bytes. The host must also supply independently verified result facts to FrameworkAuthority; the worker cannot insert those facts. Native RECORD_DISPATCH_RESULT now revalidates Task scope/qualification/lineage within the command boundary. A matching publish response alone is insufficient.

Statuses:
- EXECUTION_UNCERTAIN: no safe invocation retry; retained output may exist.
- REPORT_PENDING: output retained, publisher unavailable/unadmitted, publication uncertain or independent readback unconfirmed. Native Task remains open and native Dispatch has no new result until verified.
- REPORT_PUBLISHED: independent readback and native Dispatch result match. This does not complete the Task, approve another effect or mark the Report read.

No Report adapter is required to retain execution output. Pending state is returned from this library; wiring it into Product status is still required. Errors for changed/revoked scope refuse further work instead of presenting a false success. An already recorded result can be recovered by its independent reader without demanding an unchanged Task forever.

## Remaining production wiring

1. Qualify exactly one native Task-capable definition/instance, fixed runtime code/prompt, no-tools model profile and budget; retain existing read/receive grants only. Bind installed configuration to that qualification.
2. Admit a supplied packet in controlled storage and pin its hash in the Task before proposal approval. Install its scoped reader; no browsing capability is added.
3. Compose the existing restricted provider/credential host with TaskWorker; qualify genuine execution and read-only session recovery if available. No provider was called in source qualification.
4. Implement/install the Report adapter on an admitted existing Registry route and independent reader, and its matching authority facts provider. Resolve the separately paused publication/model/publisher gates; this source does not bypass them.
5. Wire status into the existing Product flow and qualify an authenticated complete production journey, including current host preimages and rollback. No service activation is included here.

Correction: only local credential/private-directory refusals before query submission permit bounded retries. Init mismatch after query is uncertain even with no assistant/result. All lock acquisitions and explicit recovery serialize under recovery.lock. Dead writer.lock is reclaimed automatically; an orphan recovery.lock fails closed for offline operator reconciliation. Atomic rename alone is not exclusion.
