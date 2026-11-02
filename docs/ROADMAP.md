# Roadmap

These are ordered outcomes, not dates. Each step has an exit condition. A step is done when that condition is observed on the running system; passing tests alone don't count.

## Done: Increment 1, one real delegated Task

An existing Task produced a recommended action. The owner edited the instructions and approved them, one qualified execution ran, and an independently verified Report appeared on the Task, persisting across refresh and chat closure. Task completion stayed with the owner. This ran once, live, and the result was applied to a live website as a separate approved step. See the [README](../README.md#what-is-proven).

## Now: make it fast and boring on one machine

**1. Single-machine deployment.** ![IN PROGRESS](https://img.shields.io/badge/-IN%20PROGRESS-dbab09)
Consolidate the Registry, Framework and console onto one machine, with a layout that can later move to one VM. Registry traffic stays on loopback. Immutable application releases are kept apart from mutable stores, caches, logs and secrets. Runtime state lives outside synchronized folders.
*Exit:* a cutover rehearsal passes, including backup, restore and rollback, and the deploy lock keeps a restart from interleaving with a publication.

**2. Deploy the Registry read bridge and the 49-file model.** ![IN PROGRESS](https://img.shields.io/badge/-IN%20PROGRESS-dbab09)
Point reads, native publication lookup, the summary projection and listing admission. The model upgrade adds publication metadata, and model admission plus the deploy lock protect it.
*Exit:* on the live Registry, one publication plus independent readback completes in under 10 s with zero full-Drive listings on the publication path.

**3. A minimal local stack for contributors.** ![PLANNED](https://img.shields.io/badge/-PLANNED-6e7781)
A published Vetra project scaffold for the Report model and bridge, plus one command that starts Registry, Framework and console on loopback with synthetic data and a fake model adapter.
*Exit:* someone outside the project can run the full Task → Report loop on a laptop.

## Next: storage and scale

**4. PGlite → Postgres.** ![PLANNED](https://img.shields.io/badge/-PLANNED-6e7781)
Reactor 6.2.1 already supports Postgres for both stores, Reactor state and read model. Upstream's development line also replaces the whole-snapshot filesystem persistence with durable NodeFS. Qualify that path first, then remeasure, then migrate both stores. Documents, operation history, errored heads and projections must survive with verifiable equality.
*Exit:* a migrated copy of the live store passes an identity, operation-count and content-hash comparison. Concurrent reads no longer queue behind a long listing.

**5. Indexed publication lookups with trustworthy negatives.** ![PLANNED](https://img.shields.io/badge/-PLANNED-6e7781)
The current V1 lookup validates the whole Drive membership document, bounded at 3,000 nodes. Build on reactor-drive's indexed relationships instead. A missing index entry must not mean "safe to create" while the index is behind, so an authoritative lookup needs a completeness or watermark contract. A rejected action on one document must only affect that document.
*Exit:* lookup cost no longer grows with Drive size, and a negative answer carries proof that the index is current.

**6. Drive partitioning with explicit routing.** ![PLANNED](https://img.shields.io/badge/-PLANNED-6e7781)
Smaller membership domains, for example by producer or period, with routing recorded in the publication identity. Partitioning does not fix persistence cost if every partition shares one rewritten store, so it comes after step 4.
*Exit:* publication and lookup stay bounded beyond 10,000 Reports.

## Then: Increment 2, manage agents through the console and chat

**7. One approval, one assignment, visible results.** ![IN PROGRESS](https://img.shields.io/badge/-IN%20PROGRESS-dbab09)
From a phone, the owner sees the exact saved plan, approves and starts it once, watches the actual assignment, and opens its Report. Reopening the Task or a connected chat recovers the same assignment. When permission to run expires, readable history stays. Today shows recent agent results alongside the daily briefings.
*Exit:* a fresh authorized pilot runs from the phone, end to end.

**8. Chat as a first-class client.** ![PLANNED](https://img.shields.io/badge/-PLANNED-6e7781)
An authorized chat client can submit a bounded assignment. It appears in the console for approval, executes once, and shows the same status and result in every client. Chat uses scoped short-lived tokens. Approval stays a human action, and no chat client can grant authority.
*Exit:* an assignment submitted from chat runs once and shows identical state across clients.

## Later

- **Bounded development agents.** One small repository change in a dedicated worktree, with bounded tools, tests and budget, returning a branch, diff and test evidence.
- **Broader capture.** Explicit email and messaging requests enter the same recommendation and approval flow. Voice input follows.
- **Capability-specific effects.** Bounded website edits and other external actions, each with its own permission, preflight and evidence, like the website publication adapter in `packages/agent-framework/src/publication`.
- **Native authority in Powerhouse.** Wherever upstream offers it, replace Kapelle-specific code: model-digest preconditions on writes, scoped per-document write capabilities, and approval as an operation type. The questions are listed in [ARCHITECTURE.md](ARCHITECTURE.md#questions-for-powerhouse).

## What we won't do

- Let a model decide that approval is unnecessary because a task is repetitive. Standing automation needs explicit standing instructions.
- Treat a Report as completing its Task.
- Retry an uncertain execution or publication automatically.
