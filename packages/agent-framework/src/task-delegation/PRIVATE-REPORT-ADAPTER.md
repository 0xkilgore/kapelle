# Private Task Report bridge (local library candidate)

`PrivateTaskReportAdapter` implements the existing TaskReportAdapter. Install an
explicit `PrivateTaskReportPublisher` from the paired Report Registry package's
`./task-publication` export. Its structural port is checked here; no source path,
endpoint, credential, legacy Manager database, HTTP route or background service is
selected by this library. Run on Node 24 with the Framework; do not import the
legacy Manager's incompatible better-sqlite3 runtime.

The host's mandatory `authorize(request)` must freshly verify the actual author,
publishing Agent, authorization reference, owner/reader scope, Drive and qualified
native publication model before returning admission. It must call the existing
model-admission gate with the exact qualified inventory; a fixture admission is
not suitable for a real host. No production admission implementation is provided.
Use separate admitted producer and independent-reader clients. Private Report
model fields contain publication provenance, not owner/scope; those two values
come explicitly from fresh host/reader admission. The existing synthetic console
schema and its `synthetic:true` fence are unchanged.

## Exact mapping

- publicationId remains `task-report:` plus the canonical Dispatch/input digest.
- reportRef is `report:task:` plus that same digest; sourceRef is the original
  `dispatch:<uuid>`. Publisher request parsing allows only this specific new form.
- runRef is `kapelle-task://dispatch/<uuid>?input=<bare SHA256>`.
- provenanceRef is `kapelle-task://execution/<bare SHA256>?packet=<bare SHA256>`.
- Author id and instanceId must both identify the admitted worker instance.
- Content and host definition hashes strip exactly one `sha256:` prefix when
  entering native metadata. Worker readbacks restore the content hash prefix.
- Immutable contentVersion is native publication.contentVersion (1 for this
  bridge); document revision is separate and may increase after attention changes.
- verificationRef hashes Drive, document ID and the exact retained plan digest
  AFTER independent native verification. It is an identifier, not an authority
  token; a caller-provided verificationRef alone never establishes completion.

## Retention and recovery

Before any native write the publisher atomically retains an owner-only
`.task-plan-<publication-id-hash>.json` request artifact in its existing receipt
root, using create-only link and fsync. It contains exact input, admission snapshot,
Markdown, timestamp and plan digest. This is not a second queue or Report store.
A retry must match all retained input/admission bytes; publishedAt never changes.
The existing publisher owns its publication/report locks and create-intent ledger.
No new native identity or write-retry mechanism is introduced.

The worker retains its one-publication-invocation rule. `lookup` and `read` load the
saved plan and call the new read-only verifier; they never invoke publish/promote,
write receipts, change attention, create a plan, or release an orphaned write lock.
Missing plan/blank intent stays pending. A FINAL registered Report with exact
native metadata and bytes can recover a lost reply. Attention is a separate,
mutable operation and is not the publication-completion fact. This bridge requests
NONE. Conflicts, incomplete scope, missing/mismatched reader output and changed
admission refuse completion. Identity scanning is repeated after independent
readback to catch a competing registration with unchanged membership.

An interrupted create may require separately controlled existing-publisher
reconciliation using the retained plan. Do not call publish as lookup or regenerate
an artifact to make recovery succeed. `verifiedPrivateTaskResultFact` performs
another independent adapter read before supplying a Framework fact. The authority
still controls RECORD_DISPATCH_RESULT; Task completion/effects stay separate.

## Evidence boundary

The paired tests load the actual candidate Report reducer and publisher library,
then exercise the actual native Framework and TaskWorker with deterministic
inference and synthetic MCP/admission. Native metadata is produced by that model,
not injected into the older fixture Report. Scope/ACL and production MCP transport
remain simulated. Separate child-process tests SIGKILL the publisher after create
and registration, retain synthetic service state on disk, and recover in fresh
processes by lookup only. These prove publisher-process recovery, not destruction
of a real inference/generation producer, billing/cancellation, native server crash,
production storage durability, ACL admission or performance qualification.

The exact paired heads, source patches, hashes and commands are in Operations'
real-report-readiness/implementation packet. Production publication remains held.
