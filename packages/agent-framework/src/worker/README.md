# Restricted document worker

This layer connects the native framework to existing Report records and Dispatch. The first runtime contract is `kapelle.document-review/v1`. It prepares Markdown from one explicitly admitted document and the owner's comment. It does not expose shell, filesystem paths, MCP, browsing, messaging or arbitrary tool execution to the model.

## Sources and package admission

`ReportSourceClient` calls the console's credential-protected `/api/internal/framework/source?documentId=...`. The console reuses its uncached Report Registry membership read and publication object verification. Inline and published Markdown/CSV content must match the recorded hash and byte size. The response binds owner, scope and the exact document/version. Each side has an explicit document allowlist; no library crawl supplies context to inference.

`ProductionSources` reads an owner-private JSON profile on every check. Its `ownerId`, `scopeRef` and expiry must match the runtime. It admits only named native releases, instruction/skill/qualification artifact hashes, local runtime bindings and local budget references. Native Definition and Instance state still comes from Reactor. A profile is an administrator's admission decision, not evidence that arbitrary packages passed independent review. Install only a reviewed release with retained qualification evidence. Model output and HTTP callers cannot edit this file.

Profile shape (see the exported `WorkerProfile` type and executable fixture in `tests/worker.test.ts`):

- `ownerId`, `scopeRef`, `expiresAt`, `documentIds` (at most 32).
- `releases`: native `release` plus `assets`, each containing its exact versioned `ref` and an owner-controlled absolute `path`. All instruction, skill and qualification assets must match their byte hashes. Asset files may be world-readable but cannot be group/world-writable; the profile must be owner-only.
- `bindings`: `ref`, native `instanceId`, logical `agent`, `contract`, `modelProfile`, exact local `model`, `modelUrl`, `maxInputBytes` (up to 64,000), `maxOutputTokens` (up to 4,096), and `budgetRef`. Only explicit loopback HTTP origins are accepted. The instance's model and budget policy must match; paid fallback is off.

The read contract retains the existing source version semantics: publication edition for an immutable published document, otherwise its native Report revision. Metadata and bytes are compared again before a result is retained. Changes to instance revision or runtime binding during generation invalidate that result.

## Execution and recovery

Manager saves the native instance/definition/runtime pin in the existing Dispatch. Document work uses the `local` provider lane with concurrency one. It never enters legacy provider fallback routing or a general-purpose `/talk` endpoint.

The scheduler marks the Dispatch started and launches generation asynchronously, so local inference does not hold up its tick or other provider lanes. A bounded scan of existing in-flight document Dispatches resumes work after a manager restart. An in-memory map prevents duplicate runners in that process; it is not a second queue.

The authenticated worker `/run` accepts the typed saved request, not a free-form executable prompt. It fetches current authoritative bytes and checks native admission before generation. The only inference operation is a bounded local chat-completions request with no tools. It verifies the returned model identity, rejects tool calls, truncation, empty output and oversized responses, and never falls back to a paid endpoint.

The worker rechecks permission while running. A pause/revocation aborts its model connection and prevents result acceptance; `/status` exposes whether that worker has stopped. This confirms host execution stopped, not that every already-running GPU operation halted instantly. Permission/source failures are recorded as Dispatch validation failures and require review before explicit retry.

The worker journal retains exact request identity and completed Markdown. It is prepared-output storage, not execution authority. A lost reply or reopened manager reuses the result without another model call. A changed payload under the same Dispatch ID conflicts. Both native and worker stores have exclusive writer locks; stale locks after a killed process require verifying the old process is gone before removal. Clean close/reopen is tested. Do not delete a lock merely because a request timed out.

## Output ownership

Manager verifies the result's complete request hash, source, instance, definition and output hash. It writes an immutable artifact through an atomic link, then commits the result and Report publication intent together through existing Dispatch storage. The existing publication outbox remains the publisher. Export failure does not lose the saved response or allocate another Dispatch.

The request page shows the saved Markdown immediately. It adds an output Report link only after the configured registry returns a unique FINAL record with matching report reference, Dispatch source, Manager producer, hash and byte size. A prepared artifact is not labeled published. The model cannot supply a path, arbitrary Report ID, recipient or publisher credential.

This runtime prepares reports. It does not activate `RESERVE_EFFECT`/`RECORD_DELIVERY`, external messages or other mutations. Those ReviewIntent adapters remain separate work.

## Host process

Run `src/worker/serve.ts` using the qualified Node 24 runtime and an installed TypeScript loader (the host's existing `tsx` runner was used for the surrounding console/manager). Do not start the framework service with the manager's older SQLite ABI runtime. No new dependency installation is required in the prepared environment.

Required host environment:

```
KAPELLE_FRAMEWORK_OWNER
KAPELLE_FRAMEWORK_SCOPE
KAPELLE_FRAMEWORK_STATE_ROOT
KAPELLE_FRAMEWORK_PROFILE
KAPELLE_SCOPED_REACTOR_ROOT
KAPELLE_FRAMEWORK_SOURCE_URL
KAPELLE_FRAMEWORK_SOURCE_TOKEN_FILE
KAPELLE_FRAMEWORK_AUTHORITY_TOKEN_FILE
KAPELLE_FRAMEWORK_WORKER_TOKEN_FILE
KAPELLE_FRAMEWORK_AUTHORITY_PORT
KAPELLE_FRAMEWORK_WORKER_PORT
```

Tokens are separate private files, read on each request. Both servers bind only `127.0.0.1`; port selection is explicit. Startup does not create, install or resume an agent instance. Keep the profile, native database/journal, worker journal and Manager artifact/outbox storage together in the release backup plan.

Console admission requires `KAPELLE_FRAMEWORK_SOURCE_TOKEN`, `KAPELLE_FRAMEWORK_OWNER`, `KAPELLE_FRAMEWORK_SCOPE` and `KAPELLE_FRAMEWORK_SOURCE_DOCUMENTS`. Manager uses the previous native authority settings plus `KAPELLE_DOCUMENT_WORKER_TOKEN` and the canonical private `KAPELLE_DOCUMENT_WORKER_OUTPUT_ROOT`. Existing Report publisher settings and allowed artifact root must admit that output directory before activation. Credentials are never carried in document models or model context.

## Qualification

`KAPELLE_SCOPED_REACTOR_ROOT` enables native service tests. `KAPELLE_WORKER_MANAGER_ROOT` and `KAPELLE_MANAGER_NODE` enable the combined persistent-manager recovery/outbox test. `KAPELLE_WORKER_TEST_LIVE_LOCAL_MODEL=1` explicitly runs a small synthetic case against a local model service. The ordinary suite uses synthetic inference; live-model checks remain opt-in and never contain private documents. The previous generic-worker combined test is superseded by this restricted-worker chain.

Before activation, verify current source revisions, install a reviewed owner/scope profile, provision the selected instance, prove the actual publisher consumes this directory, and exercise backup/restore and live request output. The owner identity must be configured explicitly; never infer it from historical documents.

Agent response pages and Dispatch-origin output Reports render Markdown images as inert text; ordinary links remain clickable. The browser qualification asserts that generated images make no automatic network requests.

## Host recovery qualification — September 11

`tests/worker-host.test.ts` runs the actual `serve.ts` entry point in test-owned child processes when `KAPELLE_SCOPED_REACTOR_ROOT` and `KAPELLE_WORKER_HOST_TSX` (absolute installed tsx loader path) are set. It verifies authenticated startup, duplicate-writer rejection, clean shutdown, native allocation identity after SIGKILL with explicit stale-lock recovery, and an offline backup restored into a separate private directory. Preserve directory permissions when copying backups: Node recursive copy alone can create directories with broader umask-derived modes, which the authority correctly rejects.

This uses an empty synthetic admission profile and makes no model calls. It qualifies native host/process recovery, not an interrupted inference, Manager/publisher recovery across all services, operating-system reboot, or private production source admission. Those coordinated activation checks remain open.
