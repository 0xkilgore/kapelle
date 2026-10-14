# Kapelle agent framework

Four Powerhouse 6.2.1 document models (AgentDefinition, AgentInstance, ReviewIntent v1–v3 and Dispatch; the Task model lives in [`packages/task-authority`](../task-authority)), with authored deterministic reducers, the owner-only command boundary, the native authority service and the one-run Task worker. The approval → Dispatch → worker → verified Report path ran once live, on earlier revisions of this code; see the top-level [STATUS](../../docs/STATUS.md).

The sections after the model table are stage-by-stage development notes. Where they disagree with the top-level docs, the top-level docs are current.

| Model | Owns | Does not own |
|---|---|---|
| `kapelle/agent-definition` | Immutable package release, instructions/skills, required and optional capabilities, runtime/model contracts, dependencies, migration evidence, reviewed view references, export requirements and qualification fixtures | Installed permissions or automatic instance upgrades |
| `kapelle/agent-instance` | Stable native identity, owner/scope, pinned release, responsibilities, policy, skills, grants, named account connections, model/budget policy, runtime and existing-scheduler references | Credentials, worker checkpoints, observed runtime health or execution queue |
| `kapelle/review-intent` | Exact proposal and artifact version/hash, source revisions, owner decision, one effect reservation and verified delivery evidence | Dispatch status, a scheduler or an outbox worker |
| `kapelle/dispatch` | One authorized execution: offer (Task, recipient, instructions hash, sources, permission, expiry), acceptance and the verified result reference | The model run itself, credentials or the Report body |

Definitions are immutable on publication. Instances start paused with paid fallback off. Skills confer no permissions. Changing a runtime or pinned definition requires a paused instance. An upgrade must advance the same definition's version and match its qualified migration/compatibility references. A retired instance cannot resume. Pause expresses desired state; it is not an acknowledgement that a running worker has stopped.

Review decisions bind the exact proposed action, artifact bytes/version, targets, sender connection and recipients. Current target revisions are checked again before reserving an effect. A reservation must match an existing Dispatch/outbox reference. Uncertain delivery remains attached to that reservation and can only be reconciled with definitive evidence; a second reservation is rejected. No test sends a message or invokes an LLM.

## Contents and reproducibility

- `scripts/author-specs.py`: source for the authored model JSON and GraphQL shapes.
- `document-models/*/*.json`: retained Powerhouse specifications.
- `document-models/*/v1/gen`: generated schemas, typed creators, reducer adapters, controllers and factories.
- `document-models/*/v1/src`: authored reducer semantics; preserved by generation.
- `document-models/*/upgrades`: generated version manifests.
- `src/command-boundary.ts`: owner-only command preparation, current-fact validation and exact hashing.
- `src/authority-port.ts`: atomic native document/action/receipt integration contract.
- `tests`: behavioral, native Reactor, ZIP restore and SQLite transaction-port qualification. Generator scaffold tests are excluded from the qualification count.

Use Node 24 (tested with 24.18 and 24.19):

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm run typecheck
npm test
# Only after changing the authored specification:
python3 scripts/author-specs.py
npm run generate
```

`--legacy-peer-deps` avoids a reproducible npm 10 peer resolver exception in the pinned generator's dependency tree. `package-lock.json` pins the installed dependency graph. Generation uses `@powerhousedao/ph-cli@6.2.1`; it is not a handwritten compatibility module. The manifest uses the native object form `{id,name}`. Consumer code should import native modules through the `./document-models` export; the root command adapter uses Node crypto and is server-only.

## Hosting the command boundary

Authenticate first. Construct `TrustedContext` from verified session/token identity, authoritative instance/definition reads, authorized document/artifact facts and scoped binding/receipt registries. Never deserialize this context from request JSON. Initial commands are owner-only; a channel participant, body `actorId`, profile selector or loopback address is not an owner credential. Member identity mappings remain a later ingress integration.

The caller supplies a stable operation ID, native document ID/type, expected revision, operation type and operation-specific input. The host supplies actor and timestamp. Unknown input fields are rejected using the generated schemas. Retain the exact action generated on first admission; retry must not generate another action.

Implement `AuthorityPort.atomic` in the single chosen native authority. Save the native document, retained action and receipt in one durable transaction with uniqueness on owner/scope/operation ID. All facts used for authorization and stale-target checks must come from that transaction or a qualified locking/fencing mechanism. Return an existing matching receipt before requiring current projections; changed input under the same ID conflicts. The SQLite adapter is test-only and does not claim to implement a production cross-service transaction.

The side-effect executor must recheck pause/revocation, current target fences and the reserved idempotency key immediately before effect execution. A model reservation by itself does not prove exactly-once network delivery. Arbitrary native mutation/import/base-operation endpoints must not bypass the authenticated command adapter. Do not accept caller-crafted initial state as ownership evidence.

Definition qualification must verify retained package/fixture bytes and reviewed migrations before supplying `qualified: true`. A migration reference is evidence, not executable code that the reducer will fetch. Runtime hostnames, tokens and sessions belong in the binding store. No reducer reads the clock, network, filesystem or model; validation uses the recorded timestamps.

## Stage notes: models and command adapter

37 behavioral checks pass: all 25 custom operations are exercised, including rejected writes, owner/scope spoofing, stale revisions, hash tampering, disabled fallback, migration controls, pause/retirement, grant expiry/revocation, exact sender direction, artifact corruption, duplicate effects and unverified receipts. All three modules register in an ephemeral Reactor, accept commands, and read back native operations. Native ZIP restore retains identity/state/actions. The transaction fixture proves lost-response recovery after database close/reopen, receipt lookup without a current projection, and competing edits at the same revision.

This proves the models and the adapter contract. It does not prove a killed production worker, live member-channel support, real mailbox data, general blob storage, or cross-service atomicity. Before activation: integrate the adapter with the actual native authority and Dispatch; enforce grants in real tool/retrieval/send adapters; add pause acknowledgement; qualify combined recovery and output publication; then register the models and provision a pinned instance. Reuse existing Task, Report, Inbox and Dispatch ownership.


## Stage notes: native authority integration

The follow-on service now uses the actual scoped Reactor mutation/receipt implementation and has been tested with existing manager Dispatch and guarded transport. See [service integration](src/service/README.md) for configuration, the 42-test combined qualification, and remaining production source/worker gates. This supersedes the model-only note above that no native authority adapter existed.

## Stage notes: restricted worker

The restricted worker adds the production Report source adapter, owner-admitted package/runtime profile, local model worker, pause checks and durable prepared-output recovery. Its companion manager reuses existing Dispatch and the Report publication outbox; the console verifies output links. See [worker contract and hosting](src/worker/README.md). The Task worker in `src/task-delegation/` builds on it; see [WORKER.md](src/task-delegation/WORKER.md).
