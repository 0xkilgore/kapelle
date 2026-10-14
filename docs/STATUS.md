# Status

As of 14 October 2026. Every item says what it is, with its evidence. **BUILT** means the code exists here and its tests pass. About a fifth of the Framework tests (the native-Reactor integration and restart proofs) need private infrastructure and skip here; claims that rest on them say *private qualification*. **Proven live** means it ran on the real system, once (N = 1), on earlier revisions of this code. **IN PROGRESS** means built but not yet deployed or accepted. **PLANNED** means not built.

## What is built

| Area | Status | Evidence and limits |
|---|---|---|
| Report document model (content, lifecycle, attention) | BUILT, proven live | Serves the live Registry, about 2,450 Reports. The live Registry still runs the previous model package (47 files). The newer package here (49 files) adds publication metadata and is the only one the publisher admits. |
| Task document model and command gateway | BUILT, proven live | Idempotent receipts, Drive lock, replay tests. |
| Agent models: Definition, Instance, ReviewIntent (v1–v3), Dispatch | BUILT | Generated with `ph-cli` 6.2.1 plus authored reducers. Tests exercise every custom operation, including rejection paths: owner/scope spoofing, stale revisions, hash tampering, duplicate effects. |
| Command boundary and native authority | BUILT, proven live | Scoped Reactor mutations with durable receipts. Lost-response recovery across process restart is proven in private qualification (those tests skip here). |
| Approval → Dispatch → one agent run | BUILT, proven live | One live pilot: one approval, one run, one verified Report. A durable claim before the provider call means at most one invocation per Dispatch. |
| Publisher: durable intent, reconciliation, verified readback | BUILT, proven live | The pilot's Report was verified by independent readback and by a separate review of its content hash. |
| Model admission and deployment fence, deploy lock | BUILT | Proven against an isolated real Registry. A Registry running the previous model package is refused before inference with 0 writes. A stale or withdrawn admission is refused. While the deploy lock is held there are no writes; after release, one reconcile publishes exactly once. |
| Registry read bridge: point reads, native lookup, summary projection, listing admission | IN PROGRESS | Measured on a real Reactor at 1,000 and 2,500 synthetic Reports: publish + independent readback in 6.3–8.4 s (the upper end with a competing full-listing poller), with zero full-Drive listings on the publication path. Not yet deployed to the live Registry. |
| Console delegation UX: exact plan preview, single *Approve and start*, status, history, finite polling | IN PROGRESS | On the release branch, with unit and route tests here. Owner acceptance pending. |
| Chat clients: scoped watch and cancel | IN PROGRESS | Scoped delegation tokens. Chat cannot propose, approve or run. |
| Website publication effect (Vercel adapter, project hold, staging, preflight) | BUILT, not activated | Tested against a synthetic provider. The live website change in the pilot was applied as a separate, owner-reviewed step outside this adapter. |
| Inbox capture → Task | Ran live, **not in this repo** | The inbox pipeline processes the owner's personal mail and filing rules, so it is excluded. |

## What is not built

- **Proposing work from chat.** Chat can watch and cancel. It cannot create or approve assignments.
- **Development agents** that change a repository in a dedicated worktree and return a branch, diff and test evidence.
- **Postgres persistence, indexed publication lookup, and Drive partitioning.** See [ROADMAP.md](ROADMAP.md).
- **Per-Task Registry capabilities.** The Registry's producer credential is a role, broader than one approved Report. Task-specific limits are enforced in the Framework and publisher, not in the Registry.
- **Multi-user.** Kapelle is single-owner. There is no claim of isolation against a hostile process running as the same OS user.

## Known limits

- **One live pilot (N = 1).** The full path ran once, on earlier revisions of these components. This snapshot is the current release candidate, which includes fixes the pilot surfaced. It has not itself run a live Task. Two steps of that run are outside this repo: inbox capture, and the website deploy the owner applied by hand.
- **No exactly-once claim.** The protocol prevents duplicate runs and duplicate Reports by identity and reconciliation. A crash at the wrong moment leaves `EXECUTION_UNCERTAIN` or `REPORT_PENDING` for explicit reconciliation. It never retries automatically.
- **Full-Drive listings fail at about 2,500 Reports** on PGlite: 12–13 s against a 6 s limit. The bridge refuses them quickly (`503 listing_suspended`). Any client that still lists will get errors at live scale.
- **Persistence rewrites the whole store.** The PGlite filesystem integration serializes the whole snapshot after writes, and even during read-only passes. That is 145 MB per pass at 1,000 Reports and 523 MB at 2,500. Write rate fell below 1 op/s above about 2,000 Reports.
- **V1 lookup bounds.** `lookupReportPublicationV1` validates the whole Drive membership document. It fails closed above 3,000 nodes or 2 MB of node JSON. One rejected action anywhere on the Drive made V1 fail closed for every identity; the publisher detects this on readback, but it blocks publication.
- **Verification is self-verification.** Reports are not signed. "Verified" means the owner's own system read the Report back with a separate reader credential and matched identity, provenance and the SHA-256 of the exact bytes. It is not a third-party attestation.
- **Owner authentication is the network boundary.** The console accepts the owner through a private-network identity header bound to one configured host, or a scoped token. Approval is only as strong as that boundary.
- **Rejected operations look like success over MCP.** `addActions` can return OK for an action the reducer rejected. Only readback reveals it.
- **The production runtime is `vetra --dev`.** A sealed, read-only release rehearsal failed because Vite writes its cache into the application directory.

## Test results

Run on macOS with Node 24.18.0 against a fresh clone of this repository (dependency installs need network; the tests are offline):

| Suite | Command | Result |
|---|---|---|
| `packages/report-registry` (publisher, proxy, bridge) | `npm run test:registry` | **196 / 196 pass** |
| `packages/report-registry` (document model) | `npm run test:model` | **37 / 37 pass** |
| `packages/agent-framework` | `npm test` with `KAPELLE_WORKER_HOST_TSX` set | **667 pass, 0 fail, 174 skipped**; `npm run typecheck` clean |
| `packages/task-authority` | `npm test` | **120 / 120 pass** (also outside a git checkout) |
| `console` | `npm test` and `npm run typecheck` | **51 / 51 pass**; typecheck clean |
| `scripts/report-publication` | `python3 -m unittest test_store.py` | **32 / 32 pass** |

**Fixed before release.** `private-command.test.ts` used a fake MCP server that predated the publisher's listing-completeness check, so the publisher refused before the simulated lost response. The fake now returns the complete drive-snapshot envelope, and the test exercises lost-response recovery as intended. No assertion was weakened.

**Environment note.** The writer-lock and process-ownership tests read the boot time (`sysctl kern.boottime` on macOS) and inspect processes with `ps`. Inside a sandbox that blocks those calls, about 20 Framework tests fail with `claude_boot_identity_unavailable`.

**Skipped Framework tests.** 174 tests skip unless they are given:

- a built Powerhouse Reactor checkout with Kapelle's scoped-authority patch (`KAPELLE_SCOPED_REACTOR_ROOT`), which is not in this snapshot;
- the sibling model packages (`KAPELLE_PLATFORM_MODELS_ROOT`);
- the legacy Manager service, which is not in this snapshot.

These are the native-Reactor integration and restart proofs. They run in the private qualification environment, which can't yet be reproduced from this repository.

## Running it

**What runs anywhere:** every test suite above. They use synthetic fixtures, an in-process Reactor where needed, fake model adapters and loopback listeners that the tests start themselves. No suite calls a model provider or any remote service.

The commands are the README's [Quick start](../README.md#quick-start). Run each line from the repository root.

Without `KAPELLE_WORKER_HOST_TSX`, four Framework tests that spawn TypeScript child processes fail. They are not skipped.

**What needs the owner's infrastructure,** and is therefore not runnable from this repository alone:

- **A Registry.** A Powerhouse Vetra/Reactor 6.2.1 project that loads the Report model and the `deploy/report-summary-read` bridge, with the auth proxy in front. This snapshot doesn't include the project scaffold, its lockfile or the three small engine patches it needs.
- **Native authority.** The Framework service running on a scoped Reactor build, with the Task Authority service beside it.
- **A model provider.** The worker drives Claude through a restricted adapter: no tools, pinned model, budget and session checks. Provider credentials are bound by the host and never read from requests.
- **The full console.** This repo carries only the delegation and Report-read slice. Its UI components (`TaskHostDelegation.tsx` and the components it renders) expect the rest of the Next.js app.

A minimal reproducible local stack (Registry + Framework + console on one machine with synthetic data) is the first item on the [roadmap](ROADMAP.md) for contributors.
