# Kapelle

Kapelle is a personal agent platform built on [Powerhouse](https://github.com/powerhouse-inc/powerhouse) document models. You approve a Task, an agent does the work, and you get back a Report whose identity and exact bytes the system checks before it records the result. Approval is required before any agent runs. Each Dispatch records which Report its approved execution produced. Nothing outside the system changes unless you approve that change separately.

This repository is a curated, readable snapshot of the code behind that loop. It is not a hosted service and not a turnkey install. The private deployment it came from runs on the author's own machines. What that means for running it is covered in [docs/STATUS.md](docs/STATUS.md#running-it).

## The thesis: document models as the ledger for agent work

An agent's reasoning is not deterministic. Its authority and the state changes it makes should be.

Most agent systems let a model write rows or overwrite files, then try to reconstruct what happened from logs. Kapelle instead gives agents, and the people supervising them, a **constrained vocabulary of typed operations** on event-sourced documents:

- **Typed operations.** A Task, a Dispatch (one authorized execution), a ReviewIntent (a proposal and the owner's decision) and a Report each have a closed set of operations with generated schemas. Unknown input is rejected.
- **Reducers.** Deterministic reducers validate every operation and make the resulting state reproducible under a pinned model version. No reducer reads the clock, network, filesystem or a model.
- **Provenance.** The Dispatch records the Report it produced: Report ID, input hash, producing agent and the SHA-256 of the exact bytes. It records them only after a separate reader credential has read the Report back and matched every field. A plausible-looking document with a matching title proves nothing; that binding does. This is verification by the owner's own system, not third-party attestation. Reports are not signed. The Registry's producer credential is a role, not a per-Task capability (see [STATUS](docs/STATUS.md#what-is-not-built)).
- **Approval as a gate.** The owner approves an *exact* proposal version and hash, and approval creates the Dispatch. A language model can propose; it cannot grant itself authority. The console authenticates the owner either through the private network (an identity header bound to one host) or with a scoped token, so approval is only as strong as that boundary.

The documents are the ledger. Much of the safety comes from the protocol around them: durable claims before a model call, an fsynced intent before a remote write, independent readback, a deploy lock and an authorization proxy. Document models make the consequential state changes inspectable, replayable and subject to invariants. They don't make an LLM reproducible, and they don't remove the need for authorization, concurrency control or careful handling of external effects. Effects such as deploying a website need their own adapters and evidence, and Kapelle keeps them outside the agent's authority.

## What is proven

**Proven once, live, on earlier revisions of this code.** One owner-approved Task ran end to end (N = 1). This snapshot is the release candidate that includes the fixes that run surfaced. It has not itself run a live Task. Two steps of the chain below are **not in this repository**: inbox capture (it processes personal mail) and the final website deploy, which the owner applied by hand as a separate reviewed step.

```
inbox message → Task → owner approval → one agent run → hash-verified Report → reviewed change applied to a live website
```

1. A request arrived in the owner's inbox and became a Task. *(Inbox pipeline not in this repo.)*
2. The owner approved one exact, saved plan. Approval produced one Dispatch.
3. One agent run (no tools, pinned model and budget) produced a result: a concrete website change, with cited sources and a patch.
4. The publisher wrote the result to the Report Registry as a Report bound to that Dispatch. It then read the Report back with a separate credential and checked identity, provenance and content hash. Only then was the result recorded on the Dispatch.
5. A separate review checked that the retrieved content hash matched, that the patch applied to the pinned source, and that the resulting data was valid.
6. The owner then applied the change by hand, as a separate approved step outside this code. It shipped to a live community website. The diff against the previously live version was exactly the new entry and its image.

The agent never had authority to deploy. The system kept enough identity and evidence to show which authorized execution produced which durable result, and the downstream change was reviewed on its own.

At the time, the live Registry held about 2,450 Reports and 15,000 operations in a store of roughly 400 MB. That scale exposed most of the problems described in [docs/STATUS.md](docs/STATUS.md#known-limits).

## Status at a glance

| Component | Status | Notes |
|---|---|---|
| Report document model (content, lifecycle, attention reducers) | ![BUILT](https://img.shields.io/badge/-BUILT-2ea44f) | Runs in the live Registry. This snapshot includes the newer model version that adds publication metadata; the live Registry still runs the previous version. |
| Task, Dispatch, ReviewIntent, AgentDefinition, AgentInstance models | ![BUILT](https://img.shields.io/badge/-BUILT-2ea44f) | Generated with Powerhouse `ph-cli` 6.2.1, with authored reducers and tests. |
| Framework: command boundary, approval → Dispatch, one-run worker | ![BUILT](https://img.shields.io/badge/-BUILT-2ea44f) | Ran in the single live pilot (earlier revision). |
| Publisher: durable intent, reconciliation, verified readback | ![BUILT](https://img.shields.io/badge/-BUILT-2ea44f) | Ran in the single live pilot (earlier revision). |
| Model admission and deployment fence | ![BUILT](https://img.shields.io/badge/-BUILT-2ea44f) | Tested against an isolated real Registry. Not yet deployed. |
| Registry scale bridge (point reads, native publication lookup) | ![IN PROGRESS](https://img.shields.io/badge/-IN%20PROGRESS-dbab09) | Measured on synthetic data: publish + independent readback in 6.3–8.4 s at 1,000 and 2,500 Reports, with zero full-Drive listings. Awaiting deployment. |
| Console delegation UX (single "Approve and start", status, history) | ![IN PROGRESS](https://img.shields.io/badge/-IN%20PROGRESS-dbab09) | Built on the release branch. Owner acceptance pending. |
| Single-machine deployment, immutable releases | ![IN PROGRESS](https://img.shields.io/badge/-IN%20PROGRESS-dbab09) | In rehearsal. |
| PGlite → Postgres, indexed lookups, Drive partitioning | ![PLANNED](https://img.shields.io/badge/-PLANNED-6e7781) | See [docs/ROADMAP.md](docs/ROADMAP.md). |
| Agent management through the console and chat | ![PLANNED](https://img.shields.io/badge/-PLANNED-6e7781) | Watching and cancelling from chat are built. Proposing work from chat is not. |

A **Drive** is Powerhouse's container document that lists member documents (here, Reports). Full detail and known limits are in [docs/STATUS.md](docs/STATUS.md).

## Quick tour

| Read | To understand |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, the publication protocol, fences and read paths |
| [docs/CODE-MAP.md](docs/CODE-MAP.md) | Where to start reading, in order |
| [docs/STATUS.md](docs/STATUS.md) | What's built, what isn't, known limits, how to run the tests |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What comes next |
| [SOURCES.md](SOURCES.md) | Where every file came from (source repository and commit) |

Repository layout:

```
packages/
  report-registry/   Report document model, the publisher, the Registry auth proxy and read bridge
  agent-framework/   Agent, Dispatch and ReviewIntent models; command boundary; Task delegation worker
  task-authority/    Task document model and its command gateway
console/             The Next.js console slice for Task delegation and verified Report reads
scripts/
  report-publication/  Owner-scoped publication journal (Python), used by the console's publish path
docs/
```

If you have ten minutes:

1. Read the [delegation sequence](docs/ARCHITECTURE.md#the-delegated-task-step-by-step).
2. Read the [worker contract](packages/agent-framework/src/task-delegation/WORKER.md).
3. Read the [Report reducer](packages/report-registry/document-models/report-registry/v1/src/reducers/content.ts), the [Dispatch reducer](packages/agent-framework/document-models/dispatch/v1/src/reducers/control.ts) and the [publication validator](packages/report-registry/document-models/report-registry/v1/src/publication.ts).

The protocol code ([publisher](packages/report-registry/src/task-publication.ts), [worker](packages/agent-framework/src/task-delegation/worker.ts)) is dense and defensive. Read it after the prose.

## Quick start

Each package is independent. Run each line from the repository root. You need Node 24 (tested with 24.18) and Python 3 for the journal.

```sh
# Report Registry: publisher, proxy and read bridge (196 tests) and document model (37 tests)
(cd packages/report-registry && npm ci --legacy-peer-deps --ignore-scripts && npm test)

# Framework: several tests spawn TypeScript child processes, so they need a tsx loader
(cd packages/agent-framework && npm ci --legacy-peer-deps --ignore-scripts && npm install --no-save tsx@4.22.4 \
  && KAPELLE_WORKER_HOST_TSX="$PWD/node_modules/tsx/dist/loader.mjs" npm test)

# Task Authority
(cd packages/task-authority && npm ci --legacy-peer-deps --ignore-scripts && npm test)

# Console slice and the Python publication journal
(cd console && npm ci && npm test)
(cd scripts/report-publication && python3 -m unittest test_store.py)
```

Expected result: everything passes, and 174 Framework tests skip because they need private infrastructure. See [STATUS](docs/STATUS.md#test-results).

These suites are offline. They use synthetic fixtures, an in-process Reactor where needed, fake model adapters, and loopback listeners that the tests start themselves. No test calls a model provider or a remote service. The npm installs need network access.

## Built on Powerhouse

Kapelle uses Powerhouse's document-model stack: `document-model`, Reactor, `ph-cli` / Vetra code generation, and Drives, at version 6.2.1 throughout. The generated `gen/` directories under each document model are `ph-cli` output and keep Powerhouse's generated structure. Powerhouse is licensed AGPL-3.0, and so is this repository.

The engineering feedback in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#what-hurt-and-what-would-help) is written for the Powerhouse team. It covers what worked, what hurt at about 2,500 Reports, and what native support would remove the most custom code.

## License

[AGPL-3.0](LICENSE). Copyright © 2026 Chris Powers.
