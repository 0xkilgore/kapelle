# Native framework service and Dispatch integration

This candidate adds a real scoped Reactor-backed service. It has been qualified with a temporary on-disk Reactor database and the existing manager's real router, SQLite Dispatch and HTTP transport. It is not installed in the live service.

## Record ownership and recovery

`NativeBackend` uses the same local scoped Reactor extension as Task Authority: allocation reservations, authoritative membership checks, operation snapshots, transaction-bound mutation receipts and exact reconciliation. The internal extension still calls its protocol `task-authority/v1`; the new HTTP facade identifies itself as `kapelle-framework/v1` and accepts only the three framework model types.

Reactor owns native model operations and terminal receipts. `commands.sqlite` retains the exact prepared request/action tuple for crash/response recovery; it is not another agent/task/run store. The request is saved before commit. A lost response reconciles against Reactor before any repeat attempt. Accepted receipt lookup survives unavailable current projections. Changed payloads under the same operation ID conflict. An unresolved older mutation blocks subsequent mutations and admissions until reconciled.

One process owns a private dedicated framework state directory and Drive. A process lock prevents competing embedded writers. The service exposes no generic Reactor write/import route. Native configuration changes are serialized. It cannot claim transactional fencing with an external Report store or worker, so `RESERVE_EFFECT` and `RECORD_DELIVERY` remain explicitly closed at this service until that integration is qualified. Their native models remain implemented.

## HTTP surface

Every route requires the server-configured owner bearer token, including reads. The token callback is checked per request, allowing revocation/rotation without treating loopback or caller headers as credentials. Owner and scope come from runtime configuration; caller identity headers are rejected.

- `GET /health`: narrow contract/scope readiness.
- `POST /allocate`: stable operation ID, framework document type and name; replay returns the same native document.
- `POST /commands`: existing model command envelope. Actor and time are server-derived.
- `GET /operations/:operationId`: exact native mutation receipt/reconciliation state.
- `GET /documents/:documentId?type=...`: private owned native document readback.
- `GET /instances`: bounded native instance list.
- `POST /admission`: current instance/source checks for document work. Checks owner/scope, desired state, qualified native release, runtime/model compatibility, declared capability, document read permission, grant expiry/revocation, source revision/hash and allowed budget. Paid fallback remains off in this first runtime.

`Facts` is a trusted server adapter, not request JSON. A real implementation must retrieve current scoped Report/resource facts and verified artifact bytes, qualified release evidence, connection/runtime bindings and budget policy from their owners. An instance or definition is read from the native Drive rather than accepted from that adapter. Only actually published native releases can qualify an installation. Do not replace this adapter with stale UI projection data or accept a caller-supplied `qualified` flag.

## Manager integration

The companion `codex/framework-manager-integration` candidate adds a `FrameworkClient` to the existing document request router and scheduler transport. It validates admission before enqueue, saves the exact native instance/definition/runtime/endpoint binding with the immutable request, then performs a fresh check immediately before worker delivery. A changed runtime target, definition or instance mapping cannot silently redirect queued work. Exact request retry still returns the original Dispatch receipt after pause or revocation.

Configuration is server-side: `KAPELLE_FRAMEWORK_URL`, `KAPELLE_FRAMEWORK_TOKEN`, and `KAPELLE_FRAMEWORK_BINDINGS` map an agent name to its native instance, runtime reference and qualified local worker endpoint. Missing configuration denies new document work. URL validation permits only explicit local HTTP endpoints and denies redirects. Non-document transport remains unchanged.

Permission denial records `validation_failed` in existing Dispatch. It does not bounce as a provider failure or choose an LLM fallback. Review and an explicit existing-dispatch retry are needed after correcting access. This release does not add a task/report retry UI or acknowledge the stopping of already running workers.

## Repeat the qualification

Use the package's pinned Node 24 environment for native tests and the manager dependency-compatible Node for its child test:

```sh
KAPELLE_SCOPED_REACTOR_ROOT=/absolute/path/to/qualified-scoped-reactor \
KAPELLE_MANAGER_INTEGRATION_ROOT=/absolute/path/to/manager-candidate \
KAPELLE_MANAGER_NODE=/absolute/path/to/manager-compatible-node \
npm test
npm run typecheck
```

When integration paths are absent the native-model tests run, and host-dependent service suites are explicitly skipped. The recorded qualification used Node 24.19.0 for native services, Node 23.7.0 for the manager's installed SQLite ABI, scoped Reactor revision recorded in the evidence, and only synthetic data/recipients. No shared native dependencies were rebuilt.

42 framework tests pass with integration configured. The combined child test provisions a native instance, enqueues two synthetic requests in real manager Dispatch, delivers one to a loopback test worker, pauses the native instance, blocks the second delivery and a new admission, and returns the original request receipt without creating another row. The manager regression result is recorded separately.

## Before live registration

1. Implement the production `Facts` adapter against authoritative scoped sources and qualified release/binding evidence.
2. Qualify the dedicated worker's actual tool/retrieval restrictions and output publication. A prompt or a generic `/talk` endpoint does not enforce tool permissions; this candidate's test worker only acknowledges synthetic requests.
3. Add actual worker pause acknowledgement and the remaining clarification, output Report and explicit retry controls.
4. Recheck current accepted candidates, backup/restore the Reactor database plus prepared journal together, and prepare concrete activation/rollback. Reuse prior internal activation authorization; do not substitute another permission request for unfinished integration.

A stale process lock after an actual crash is not automatically removed. Verify the recorded PID is gone and the embedded store has no competing writer before removing that one lock and restarting with the same state directory. Clean restart and lost-response recovery are tested; a killed-worker/automatic stale-lock recovery drill remains a separate gate.

## Lean per-org SQLite authority (lean runtime step 1)

`RuntimeOptions.backend: 'sqlite'` keeps native documents, operations, receipts, allocations, the effect outbox and the
command journal in one `authority.sqlite` (WAL, `synchronous=FULL`) beside `authority.json` (`backend: "sqlite"`,
`installationId`). Reactor remains the default; an existing authority always reopens with its recorded backend.

- **Local disk only.** Dropbox paths are refused; network mounts are not detected, so deployment config and the Ops
  precheck must place the state root on local disk (Fable N-4).
- **Interrupted first start (N-1).** If a process dies after creating `authority.sqlite` but before writing
  `authority.json`, the next start refuses (`Existing directory is not a framework authority` or an identity mismatch).
  That root never served a command, so it holds no authority. Cleanup is manual: stop the service, confirm
  `authority.json` is absent and the journal has no rows (`sqlite3 authority.sqlite 'select count(*) from commands'` is
  0), move the root aside (never delete it in place), and start again on an empty private directory.
- **Backup/restore.** `backupSqliteAuthority` (between commands, via `authority.maintenance`) writes a verified copy and
  a manifest whose counts are read from the copy. `restoreSqliteAuthority` restores only into a new empty root under a
  new installation id; native writes stay refused until every `sent`/`unsettled` effect is reconciled, then
  `releaseRestoreHold()`.
- **Publication outbox lifecycle (N-3, wired).** Reserved intents are written in the
  `RESERVE_EFFECT` transaction; an accepted `CLAIM_EXECUTION` (the durable claim before the provider call) marks them
  `sent`, and an accepted `RECORD_DELIVERY` settles DELIVERED/FAILED, holds UNCERTAIN as `unsettled`, keeps ACCEPTED
  `sent`, all in the same transaction as the operation. A claim without an intent row fails the command.
