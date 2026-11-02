# Additive unread overlay for the observed Registry runtime

This is the deployment candidate for the Report Registry runtime observed on
2026-09-14 at 18:45:19 UTC. `manifest.json` enumerates exactly eleven target
files, their observed preimage SHA-256 values, candidate SHA-256 values, and
source paths relative to this package. A mismatch requires fresh review; never
force an overlay onto a different preimage.

## Why attention.ts is supplied separately

The deployed attention reducer predates the repository's FINAL-only and legacy
review hardening. Replacing it with the current source reducer would change the
meaning of historical operations, including a historical DRAFT MARK_READ and
feedback duplicate validation order. The deployment `attention.ts` is the
observed deployed file plus one inserted `markUnreadOperation`; removing that
method reproduces the deployed file byte-for-byte. Every old operation body is
preserved. The authored model specification is semantically identical to the
observed specification after removing the new MARK_UNREAD operation.

The source model at `document-models/report-registry/v1/src/reducers/attention.ts`
retains the accepted repository behavior. **Do not deploy that source reducer
over this Registry runtime.** Use the manifest's explicit source-to-target mapping.
Future deployments must account for this compatibility overlay instead of
copying the package wholesale.

The package's other exported model, `src/model.ts`, also supports MARK_UNREAD
with equivalent final/revision/read/attention semantics and standalone history
replay tests. It is not installed in this Vetra runtime. The existing CLI offers
registration, promotion and attention projection, with no review commands; this
change does not add a separate review CLI.

## New operation

MARK_UNREAD accepts exactly the existing common review fields
`expectedRevision`, `occurredAt`, and `actorId`. It requires FINAL, the exact
revision and valid metadata before changing state or materializing a missing
legacy review field. It clears readAt and reopens only READ attention previously
resolved specifically by READ. It preserves first openedAt, content, feedback,
other attention decisions and prior operations. Task state is outside this model.

## Generation provenance

Authored `report-registry.json` was extended with MARK_UNREAD, then generated
using the pinned Vetra 6.2.1 toolchain: `@powerhousedao/ph-cli`, codegen, config,
shared and `document-model` all 6.2.1, under Node 24. The isolated command was
`ph-cli generate all` in this package. The generator requires an array manifest;
the source runtime manifest uses a string entry. Only during local generation,
the manifest's `documentModels` was temporarily an empty array, and its exact
original bytes were restored afterward. No runtime manifest change is included.

Generated bindings and schema came from that generator. Unrelated scaffolding,
rewritten top-level exports, authored reducer formatting and trailing-newline
churn were removed. Existing MARK_READ source behavior was not edited.

## Verification

Source model suite: 25 tests and model TypeScript check. Standalone registry
suite: 115 tests, including 15 proxy tests. The gateway has a separately signed
candidate and uses current-state goal satisfaction for unread rather than
attributing a null timestamp to one request.

An isolated runtime replica was built from the observed deployed report model,
then the exact manifest overlay was applied. Its 28 tests comprise the eight
observed invariant tests, fifteen new unread tests, and five preimage replay
comparisons; TypeScript check passed. `deployed-replay.test.ts` is the signed
replay fixture. To reproduce, place it at `runtime-checks/deployed-replay.test.ts`
in a temporary package containing the overlaid model at `document-models/report-registry`
and an untouched observed model at `deployed-model`. Use this package's pinned
dependencies, tsconfig, Vitest config and test-only top-level report export.
Copy the unread runtime test into the model's tests directory. Run:

```sh
vitest run document-models/report-registry/v1/tests/invariants.test.ts document-models/report-registry/v1/tests/unread-runtime.test.ts runtime-checks/deployed-replay.test.ts
tsc --noEmit
```

The five comparisons replay the same serialized synthetic actions against both
actual reducers, checking state and operations after every action. They cover
DRAFT reads, publication, first-read timestamps, duplicate feedback, routing,
explicit approval resolution, dismissal, supersession and rejected operations.
No real report or task operations were emitted during preparation.

## Controlled deployment requirements

Direction owns the live decision and execution. Recheck all eleven preimages,
then preserve all eleven original code files with modes/ownership and a hash
manifest in a private rollback directory. Because Reactor runs Vetra with --dev,
do not copy a partial generated model into a running watcher. Quiesce only this
project's auth-proxy and Reactor for the coherent file replacement, then start
Reactor and verify loaded MARK_UNREAD schema, existing review schema, health and
content-free report identity/revision reads before starting the updated proxy.
Verify existing reader/producer/reviewer access without native writes.

Use the existing Compose configuration and scoped services. No credential,
Compose, package/dependency, shared entrypoint, Task Authority model, blob or
`var/reactor` file is a payload target. This Reactor also loads a Task Authority
model; its same-process endpoint can be briefly unavailable during the reload,
but its code and data must remain intact. Do not regenerate on the live host.
Do not replay September 4 publication/send receipts or invoke publishers.

Only after native readiness may Direction run the reviewed console promotion.
The canonical console supervisor reacts to HEAD drift, so a canonical fast-forward
must be part of that controlled promotion rather than a preparation step.
The console rollback archive was full at 8/8: preserve-only relocate its oldest
archived bundle before the next normal promotion, retaining the active immediate
rollback bundle and all evidence.

## Rollback boundary

Before any MARK_UNREAD operation could have been accepted, restoring the exact
prior eleven code files is possible only after proving no new unread history
exists and quiescing the same services. Once a new unread operation may exist,
**do not restore the old model against the current store**: it cannot replay the
new operation. Prefer rolling the console back while retaining the additive
native model, or roll forward with a compatible native correction. Never edit,
rewind, migrate or restore live document storage as part of this code rollback.
