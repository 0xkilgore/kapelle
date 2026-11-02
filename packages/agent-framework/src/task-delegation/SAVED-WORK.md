# Read-only saved Task result work

`createTaskSavedWorkLoader(worker, access)` binds an authenticated subject and a
mandatory host Dispatch-read authorizer to an EXISTING TaskWorker owned by its
service. It exposes only `loadSavedWork(dispatchId)`. `TaskWorker.readSavedWork`
implements the same guarded projection; both are exported via `./task-worker`.
No writer is opened, journal/table created, provider recovered/invoked, Report
looked up/published, native command issued or retained state saved by this path.
Existing run/inspect and publication APIs retain their behavior.

## Host composition and trust

Supply `{subjectId, ownerId, scopeRef}` from established server authentication, not
query parameters or a browser DTO. `authorizeDispatchRead(selection)` must perform
actual current read authorization for that subject, selected native Dispatch and
its retained result context. It returns the same subject/owner/scope/Dispatch plus
an authorizationRef, or null. Matching identity fields are necessary but do not
implement ACL policy; only the real host can supply that policy. There is no default
allow, owner-name inference, hardcoded credential or endpoint. A delegated reader
may differ from the owner only under the injected host's actual grant.

The bound subject is copied/frozen and both authorization checks must pass: before
native/history access, and again before the final native/source stability reads.
Wrong owner/scope is rejected against the worker's actual authority binding before
any native read. Wrong returned subject/Dispatch is rejected too. Missing grants
or host inputs fail closed. This is a library seam, not a transport authentication
endpoint or proof of production admission.

## Returned contract

The result is a frozen `{request, nativeResult}` or null, structurally matching
Product's SavedResultWork. The request uses the existing TaskWorker's exact
publication-request and completed-execution validators. It includes the retained
Markdown, original packet/execution hashes, Dispatch/input/publication identity,
Task, worker instance, owner and scope. Do not return this internal DTO wholesale
to a browser. Product's verified consumer uses it as its server-side expectation.

`nativeResult` is ONLY a projection of the existing native Dispatch.result, with
Dispatch ID and inputHash from the native Dispatch/offer. It is never synthesized
from a Report lookup, worker status label, external fact or
verifiedPrivateTaskResultFact. The latter remains a separate Report check in the
consumer. If a retained worker publication receipt exists, its identity must agree
with the request and native result. A missing native result stays null, even if
some external facts provider supplies a Report fact.

Absent/incomplete/uncertain execution history returns null. Completed history with
no recorded native result returns a request with nativeResult:null. Invalid scope,
changed native identity/offer, stale or inconsistent history, unavailable Task or
packet, changed current Task, or a source change across reads throws; the consumer
already suppresses these as unavailable. This path never repairs those states.

## Native source and history checks

- Read the actual owned native Dispatch; bind header/state ID, owner, scope and
  recipient to the worker. Recompute the immutable offer hash and verify native
  acceptance of that exact input by that recipient.
- Reuse the original input construction from the approved envelope and freshly
  admitted packet. Compare complete input, request hash, packet and Task identity
  to the retained execution journal, then validate the completed runtime/output.
- Read the Task through the existing Task authority reader; require its owner and
  exact accepted envelope/source to agree with the Dispatch, plus native Task
  reference/commitment binding. No alternate Task snapshot/store is introduced.
- Re-read authorization, current Task and native Dispatch; compare authoritative
  state and retained attempt again. Native backend reconstruction gives headers
  fresh metadata, so compare stable ID/model/global state, not ephemeral headers.
  A concurrent worker action or native/source change suppresses the projection.

This bounded policy deliberately requires the CURRENT Task source still to match
its approved snapshot. Subsequent Task edits/completion can therefore make this
new loader unavailable even when a historical Report exists. Existing inspect is
unchanged. Relaxing that condition for a historical-result view requires a separate
reviewed authority policy, not fabrication of the old Task as current. The loader
is not a cross-authority transaction and cannot prevent revocation after response.

## What Product still needs for authenticated GET

Bind the loader in the owning Node24 worker/authority service; do not call
TaskWorker.open per request or scrape its private SQLite/receipt artifacts from
Next. The existing service must be running/available with its exact worker binding,
Task reader, admitted packet reader and retained completed history. This change
adds no remote transport, lifecycle manager or production host configuration.

Product can supply `loader.loadSavedWork` to createVerifiedTaskResultHost with the
reviewed private publisher adapter and independent readback composition. Bind the
host's real authenticated principal and scoped access policy first. Then add a
separately gated GET using existing Ops access plus actual Dispatch authorization,
validated Dispatch selection, bounded no-store responses and fixed error handling.
Only the verified-result envelope crosses that route. No POST/run/publish fallback.
Preserve old synthetic schema/preview and client stale-response suppression.

The Framework head changes with this implementation; review/update exact source
pins in Product's isolated composition/tests explicitly. No silent pin relaxation.
Real publisher/model/reader admission and live provenance remain separate; do not
use synthetic tests or this loader as live rollout approval. Existing Inbox and
snapshot/model/performance/provider/ACL/storage gates remain held.

## Read-only evidence and physical I/O limit

Read-only here means no authority/Task/Dispatch operations or retained command/
execution mutations. The existing scoped native reader uses a database transaction;
its engine can update transaction/WAL bookkeeping on SELECT, and SQLite can update
shared-memory read marks. Do not claim an immutable entire runtime directory or
zero OS writes. Tests deny native mutation/command/Report/provider APIs, allow only
SELECT on the worker connection, compare native operation snapshots and Task state,
compare command journal rows, and compare worker DB/WAL/lock files. The volatile
SQLite `-shm` bytes and native engine transaction-log bytes are deliberately not used
as domain-mutation evidence. No engine settings or transaction behavior is changed.
