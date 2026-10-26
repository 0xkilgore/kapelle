# Kapelle

Kapelle is an owner-approval-first agent platform: an agent works from an organization's files, proposes work, and produces drafts people can review. The platform records what was approved, what ran, and what result came back. Approval for a draft is separate from permission to send or publish it.

**As of October 26, 2026: one live organization deployment, the Cleveland Park agent.** Its three jobs are website updates through reviewed pull requests, newsletter drafting with previews and test emails, and preparing meeting notes and agendas. Team tasks, weekly schedules, an approved agent handbook and a runtime-generated system map support those jobs. The three-job Home navigation is live in Cleveland Park, deployed October 26 at 16:04 UTC.

**This public repository is an earlier source snapshot, not the current hosted app.** You can inspect its architecture and run its component tests. Cloning it does not give you the Cleveland Park deployment or a self-service agent-hosting product.

## What is available where?

| | Available now | Boundary |
|---|---|---|
| **Public repository** | Powerhouse Task, Dispatch, ReviewIntent, AgentDefinition, AgentInstance and Report models; delegation worker; publication protocol; Registry proxy/read bridge; console slice; tests | Curated October 14 snapshot. Not a complete runnable website or turnkey deployment. |
| **Private live deployment** | One organization's chat, source citations, website proposals/PR workflow, newsletter drafts/preview/test, meeting preparation, team tasks, weekly schedules, handbook and system map | Access is for admitted members. The hosted runtime and its deployment tooling are not included in this public snapshot. |
| **Next work** | Shared file library and public image hosting; a complete flyer-to-event workflow; enabling full-list newsletter sending | Not advertised as available in the public repo or as completed live workflows. Some supporting code exists behind gates. |

The current product has moved beyond the snapshot's original single-owner rehearsal. The repository has not yet caught up with that product. Its older status and roadmap documents describe the snapshot, not today's hosted deployment.

## How the Cleveland Park agent works

- **Website:** a reviewer proposes and checks a content change. Approval opens a draft GitHub pull request with a preview; a human maintainer merges it. The agent does not independently publish the site.
- **Newsletter:** a member works through a draft plan, previews the rendered newsletter and asks for revisions. Authorized reviewers can send a test to their own sign-in address. Full-list sending is not enabled in the deployment described here.
- **Meetings:** the agent prepares agendas and notes from supplied material and approved sources. Citations let people inspect the source; they do not guarantee a correct interpretation.
- **Team tasks:** a reviewer approves an exact plan, sources and budget. The bounded runner claims that run once and checks the saved result against the bytes it produced. A person reviews it and marks the task done. An uncertain attempt is held for reconciliation, not automatically replayed.
- **Schedules:** a reviewer approves a weekly template, source rule, expiry and spending limits. Each occurrence freezes its inputs. Changes to pinned behavior or the handbook pause affected schedules for review.
- **Context:** the handbook describes the organization, tone and working rules. The system map describes the files and features available to that run. Neither grants tools or permissions.

The hosted implementation uses a shared web hub and a separate organization runtime with a local SQLite authority, bounded tools and server-held connector credentials. It is not a deployment of the entire earlier Reactor stack per organization. Before a behavior-changing release is enabled, the project uses offline checks and scoped live qualification with synthetic cases and pinned evidence.

## Why document models still matter

Kapelle began with [Powerhouse document models](https://github.com/powerhouse-inc/powerhouse): typed operations and deterministic reducers for Tasks, approvals, Dispatches and Reports. The public code shows that work directly.

The durable idea is the separation between model output and authority. An LLM can propose a change; it cannot approve its own permissions. An exact approved version, a single-run claim, a durable write intent and a checked result make the work inspectable. The hosted implementation carries those principles into its organization runtime; it does not make LLM reasoning deterministic.

## What you can run now

The public packages have independent test suites. Use Node 24 (the snapshot was tested with 24.18) and Python 3. From the repository root:

```sh
(cd packages/report-registry && npm ci --legacy-peer-deps --ignore-scripts && npm test)

(cd packages/agent-framework && npm ci --legacy-peer-deps --ignore-scripts && npm install --no-save tsx@4.22.4 \
  && KAPELLE_WORKER_HOST_TSX="$PWD/node_modules/tsx/dist/loader.mjs" npm test)

(cd packages/task-authority && npm ci --legacy-peer-deps --ignore-scripts && npm test)
(cd console && npm ci && npm test)
(cd scripts/report-publication && python3 -m unittest test_store.py)
```

These are the snapshot's documented test commands, not a hosted-app install. Dependency installation needs network access; the suites use fixtures, fake providers and local listeners. Some Framework tests require private infrastructure and skip in the public snapshot; process restrictions can affect other tests. See [snapshot status](docs/STATUS.md) for its recorded results. These commands were not rerun for this README refresh.

## Where to read

- [Architecture](docs/ARCHITECTURE.md): the original delegation and publication protocols.
- [Code map](docs/CODE-MAP.md): entry points into the public code.
- [Status](docs/STATUS.md): snapshot coverage and omissions.
- [Sources](SOURCES.md): file provenance and source revisions.

## Limits

This is one live organization, not evidence of reliable operation across a fleet. Setup and operations remain assisted. Drafts can omit or alter details and need human review. A matching hash proves saved-byte identity, not factual truth. Qualification covers specified cases, not every future input. External sends and deployments need their own approval and recovery rules.

## License

The public source is [AGPL-3.0](LICENSE); package manifests specify **AGPL-3.0-only**. Third-party components retain their own licenses and attribution. This README does not change the license or imply that private deployment code has been published.

Project site: [kapelle.ai](https://kapelle.ai). To talk about launching an agent for your organization: [caneyfork.co](https://caneyfork.co).
