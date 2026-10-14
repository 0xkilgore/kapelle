# Code map

A reading order for an engineer, from the data to the protocol to the edges. If you only have ten minutes, start with the [worker contract](../packages/agent-framework/src/task-delegation/WORKER.md) and the reducers in section 1.

> Package-level READMEs and `*.md` files under `src/` are working notes copied from the private tree. Where they disagree with these docs, these docs are current. Some comments mention a "Manager" (a legacy agent queue that is not part of this repository) or label a case as "observed live"; the surrounding code and tests carry the rationale.

The Task model's generated module lives at `packages/task-authority/generated/task-authority/` (the package predates the `document-models/` layout used elsewhere). Document type IDs `kilgore/report` and `kilgore/task` predate the `kapelle/*` namespace and are kept as protocol identity. Line counts are approximate. The `gen/` directories are `ph-cli` output; skip them unless you want to see what Powerhouse generates from a schema.

## 1. The documents (30 minutes)

Start with the shapes. Everything else enforces transitions between them.

| Read | Why |
|---|---|
| [`report-registry/.../v1/schema.graphql`](../packages/report-registry/document-models/report-registry/v1/schema.graphql) | The Report: identity, producer, content (inline Markdown with SHA-256 and byte size), lifecycle, attention, publication metadata. |
| [`reducers/content.ts`](../packages/report-registry/document-models/report-registry/v1/src/reducers/content.ts) (85 lines) | `REGISTER_REPORT`: how a Report gets its bytes and why it can only happen once. |
| [`v1/src/publication.ts`](../packages/report-registry/document-models/report-registry/v1/src/publication.ts) (40 lines) | The publication metadata validator. Author must equal producer; content hash must match. A rejected registration leaves a blank draft, which is why readback is required. |
| [`reducers/lifecycle.ts`](../packages/report-registry/document-models/report-registry/v1/src/reducers/lifecycle.ts), [`reducers/attention.ts`](../packages/report-registry/document-models/report-registry/v1/src/reducers/attention.ts) | Review is state: DRAFT → FINAL → SUPERSEDED/WITHDRAWN, opened/read, attention requests, feedback. |
| [`dispatch/v1/schema.graphql`](../packages/agent-framework/document-models/dispatch/v1/schema.graphql) (45 lines) | One authorized execution: the offer (Task, recipient, instructions hash, sources, permission, expiry), acceptance (input hash) and result (Report ID, content version and hash, verification ref). |
| [`dispatch/v1/src/reducers/control.ts`](../packages/agent-framework/document-models/dispatch/v1/src/reducers/control.ts) | The Dispatch phase machine. Acceptance and `RECORD_DISPATCH_RESULT` both require the input hash to equal the approved offer's content hash. |
| [`review-intent/v1/schema.graphql`](../packages/agent-framework/document-models/review-intent/v1/schema.graphql), [`v3/`](../packages/agent-framework/document-models/review-intent/v3) | Proposals and owner decisions bound to an exact version and hash. v3 adds Task proposal generations. |
| [`agent-instance/v1/schema.graphql`](../packages/agent-framework/document-models/agent-instance/v1/schema.graphql) | An owned agent: pinned definition release, grants, model and budget policy, pause and retire. Skills confer no permissions. |
| [`task-authority/.../v1/schema.graphql`](../packages/task-authority/generated/task-authority/v1/schema.graphql) | The Task: a commitment, with lifecycle and context. |

## 2. Authority: who may change what (45 minutes)

| Read | Why |
|---|---|
| [`agent-framework/src/command-boundary.ts`](../packages/agent-framework/src/command-boundary.ts) (600 lines) | The single entry for native commands: owner-only, current-fact validation, stale-revision rejection, exact hashing, retained actions for idempotent retry. |
| [`agent-framework/src/authority-port.ts`](../packages/agent-framework/src/authority-port.ts) (70 lines) | The atomic contract: document, action and receipt in one durable transaction, unique on owner/scope/operation ID. |
| [`agent-framework/src/service/authority.ts`](../packages/agent-framework/src/service/authority.ts) (780 lines) | The native authority on a scoped Reactor. Look for `APPROVE_TASK_PROPOSAL` (approval creates the Dispatch) and `RECORD_DISPATCH_RESULT` (only verified facts). |
| [`task-authority/src/gateway/core.ts`](../packages/task-authority/src/gateway/core.ts) | The same idea for Tasks: command gateway, receipts, Drive lock. |

## 3. Execution: one approved run (45 minutes)

| Read | Why |
|---|---|
| [`task-delegation/WORKER.md`](../packages/agent-framework/src/task-delegation/WORKER.md) | The worker contract in prose: statuses, what is retryable and what is not. |
| [`task-delegation/worker.ts`](../packages/agent-framework/src/task-delegation/worker.ts) (475 lines) | `begin(dispatchId)`: native checks, durable started claim, one provider call, a publication claim before publish, lookup-only after ambiguity, and recording the result only after independent readback. |
| [`task-delegation/runtime.ts`](../packages/agent-framework/src/task-delegation/runtime.ts), [`host.ts`](../packages/agent-framework/src/task-delegation/host.ts), [`launcher.ts`](../packages/agent-framework/src/task-delegation/launcher.ts) | How the worker is composed and admitted, including the single-Task pilot mode ([docs/single-task-pilot.md](../packages/agent-framework/docs/single-task-pilot.md)). |
| [`task-delegation/failure-labels.ts`](../packages/agent-framework/src/task-delegation/failure-labels.ts) | Fixed, human-readable failure reasons. Raw error text never reaches the UI. |
| [`worker/claude-adapter.ts`](../packages/agent-framework/src/worker/claude-adapter.ts), [`worker/invocation-fence.ts`](../packages/agent-framework/src/worker/invocation-fence.ts), [`worker/writer-lock.ts`](../packages/agent-framework/src/worker/writer-lock.ts) | The restricted model adapter (no tools, no fallback, receipts checked), the durable invocation fence, and single-writer journal locking with dead-owner reclaim. |

## 4. Publication: identity before response (45 minutes)

| Read | Why |
|---|---|
| [`report-registry/src/task-publication.ts`](../packages/report-registry/src/task-publication.ts) (200 lines) | The Task bridge: deterministic publication ID, fsynced plan installed with `link()`, publish or lookup under the deploy lock. |
| [`report-registry/src/private-publication.ts`](../packages/report-registry/src/private-publication.ts) (280 lines) | Create → register → verify against MCP. Model admission and live-deployment checks. |
| [`report-registry/src/deploy-lock.ts`](../packages/report-registry/src/deploy-lock.ts) (34 lines) | Shared `flock` for publishers, exclusive for deploy and restart. |
| [`scripts/report-publication/store.py`](../scripts/report-publication/store.py) | The same protocol as an owner-scoped Python journal, used by the console's publish path. |
| Tests: [`tests/task-publication.test.ts`](../packages/report-registry/tests/task-publication.test.ts), [`tests/point-publication.test.ts`](../packages/report-registry/tests/point-publication.test.ts), [`tests/legacy-model-publication.test.ts`](../packages/report-registry/tests/legacy-model-publication.test.ts) | Lost responses, rejected registrations, the 47-file model refusal. |

## 5. The Registry edge (30 minutes)

| Read | Why |
|---|---|
| [`deploy/mcp-auth-proxy.ts`](../packages/report-registry/deploy/mcp-auth-proxy.ts) (630 lines) | Reader, producer and reviewer roles; per-tool Drive scoping; listing admission (`503 listing_suspended`). |
| [`deploy/report-summary-read/`](../packages/report-registry/deploy/report-summary-read) | The read bridge: point reads (`detail.mjs`), native lookup (`publication-lookup.mjs`), deployment identity (`deployment.mjs`), summary projection. |
| [`deploy/report-listing-runtime/model-inventory.json`](../packages/report-registry/deploy/report-listing-runtime/model-inventory.json) | The exact 49-file model the publisher admits, by SHA-256. |

## 6. The console slice (30 minutes)

| Read | Why |
|---|---|
| [`console/app/ops/_lib/delegationState.ts`](../console/app/ops/_lib/delegationState.ts) (130 lines) | Three independent facts (saved assignment, read availability, permission for new work) turned into one view state. It never derives one fact from another. Pair it with [`tests/delegation-state.test.ts`](../console/tests/delegation-state.test.ts), one test per state-table row. |
| [`console/app/ops/_lib/taskHost.ts`](../console/app/ops/_lib/taskHost.ts), [`taskHostContract.ts`](../console/app/ops/_lib/taskHostContract.ts) | The server-side client for the Framework host, with strict zod contracts. A timeout means "unconfirmed", not "absent". |
| [`console/app/ops/_lib/reportSelectedSource.ts`](../console/app/ops/_lib/reportSelectedSource.ts), [`reportRegistryContract.ts`](../console/app/ops/_lib/reportRegistryContract.ts) | Verified Report reads: the content hash is recomputed over the exact bytes before display. |
| [`console/app/ops/_components/TaskHostDelegation.tsx`](../console/app/ops/_components/TaskHostDelegation.tsx) | The UI: exact plan, single *Approve and start*, finite polling, no automatic resend. |
| [`console/app/ops/_lib/delegationClientTokens.ts`](../console/app/ops/_lib/delegationClientTokens.ts) | Scoped short-lived tokens for chat clients (watch and cancel only). |

## Where to look for…

| Question | File |
|---|---|
| How does a lost reply avoid a duplicate Report? | `report-registry/src/task-publication.ts`, `scripts/report-publication/store.py` |
| How is a model change prevented mid-publication? | `report-registry/src/deploy-lock.ts`, `deploy/report-summary-read/deployment.mjs` |
| What does the owner actually approve? | `agent-framework/src/task-delegation/proposals.ts`, `review-intent/v3/` |
| What stops a second model run? | `agent-framework/src/worker/invocation-fence.ts`, `task-delegation/worker.ts` |
| How is website publication kept outside agent authority? | `agent-framework/src/publication/host.ts` and `project-hold.ts` (prose notes in `publication/README.md` are dense and mention the legacy Manager) |
