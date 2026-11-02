# Report Registry

Durable Report truth outside the console. This package contains:

- the **Report document model** (`document-models/report-registry`): content, lifecycle and attention reducers, publication metadata validation, and the generated Powerhouse module;
- the **publisher** (`src/`): writes Reports into a Reactor Drive through MCP and proves them with an independent readback;
- the **Registry-side runtime** (`deploy/`): the loopback authorization proxy, the summary/point-read/lookup bridge, and the composed snapshot tool with its pinned model inventory.

Producer identity is data, not a package dependency. Any producer (an agent run, a service, an import) registers a Report through the same library API or CLI.

## Ownership

- The Report document owns identity, provenance, immutable content metadata, lifecycle, attention requests, review state, feedback, routing receipts and supersession.
- Markdown up to 256 KiB is stored inline in the document state. Binary content belongs in the content-addressed blob store (`src/blob-store.ts`; an AES-256-GCM variant is in `src/encrypted-content-v1.ts`).
- Consumers read `kapelle.report-attention.v1`, a bounded read model (`src/projection.ts`). They don't own lifecycle truth.

## Publication paths

| Path | Entry point | Use |
|---|---|---|
| Task publication | `src/task-publication.ts` | A Task worker publishes the result of one approved Dispatch. The publication identity is `task-report:` + `sha256(canonical({dispatchId, inputHash}))`. |
| Private request | `src/private-publication.ts` | One explicitly selected Report with a pinned binding: author, publisher, Drive, content hash. |
| Promotion request | `src/promotion-request.ts`, `src/promote.ts` | Producer-neutral: a strict request file goes to a content-free plan with a `planDigest`, then to a live write that requires that digest. |

All three share the same protocol. A durable named intent comes first, then exactly one create and one register. An independent readback with a separate reader credential follows. Uncertainty leads to reconciliation by identity, never to a blind resend. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#the-publication-protocol).

Safety properties enforced in code:

- MCP endpoints are loopback-only and need a bearer credential (`requireLoopbackMcpEndpoint`).
- There is one local writer per `reportRef`. Every publisher targeting a Drive shares one owner-only lock directory, and the lock key binds Drive ID and report reference.
- An identical retry returns the durable first receipt. A reused `reportRef` with different metadata or bytes fails closed.
- A request file's content path must be an absolute, canonical, single-link `.md` file below a configured allowed root. Symlinks, hard links, path escapes, invalid UTF-8 and files over 256 KiB fail before any MCP call.
- No Report body is copied into a local receipt or plan.
- Publishing requires a live model admission bound to one Registry deployment, and holds a shared deploy lock across check → create → register → readback (`src/deploy-lock.ts`).

## Registry-side runtime (`deploy/`)

| File | Role |
|---|---|
| `mcp-auth-proxy.ts` | Loopback authorization proxy. It keeps reader, producer and optional reviewer credentials separate and scopes each tool to one Drive. A listing admission control answers `503 listing_suspended` instead of queueing expensive full-Drive listings behind a stuck query. |
| `report-summary-read/register.mjs` | Attaches the bridge tools to the Reactor's MCP server. It allows at most two concurrent reads per owner. |
| `report-summary-read/detail.mjs` | Point reads: `getReportDocumentV1`, `getReportDetailV2`. |
| `report-summary-read/publication-lookup.mjs` | `lookupReportPublicationV1`, the native publication-identity lookup. It fails closed when the result can't be verified. |
| `report-summary-read/deployment.mjs` | `getRegistryDeploymentV1`: boot ID, release ID, and the model digest at boot and on disk now. |
| `report-summary-read/aggregate.mjs`, `snapshot.mjs`, `database.mjs` | The summary projection behind `/v2/report-summaries`. |
| `report-listing-runtime/` | The composed snapshot tool, its preimage check, and `model-inventory.json`, the exact 49-file model the publisher admits. |
| `report-unread-runtime/` | An additive overlay for unread/attention operations on an older runtime. |

These files run inside a Powerhouse Vetra/Reactor 6.2.1 project. The Reactor project itself (its `package.json`, lockfile and `powerhouse.config`) is not part of this snapshot. See [docs/STATUS.md](../../docs/STATUS.md#running-it).

## Tests

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm test     # node --test tests/*.test.ts (publisher, proxy, bridge) + vitest (document model)
```

The `tests/` suite drives the publisher and proxy against in-process fakes and the real generated reducers. It makes no network calls beyond loopback listeners that the tests start themselves. One model test, `private-command.test.ts`, is a known stale failure; see [docs/STATUS.md](../../docs/STATUS.md#test-results).
