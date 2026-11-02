# Vendored: Pi agent core (direct lift, MIT)

OSS lift: Pi agent loop + pi-ai helpers (MIT) — https://github.com/earendil-works/pi
(the repository formerly at https://github.com/badlogic/pi-mono redirects here)

- Upstream commit: `b06c1f2cf1dea6af8748ddeee18c23587d2cb7c6` (main, 2026-10-14T20:23:59Z)
- License: MIT, Copyright (c) 2025 Mario Zechner. The full text is in `./LICENSE`, copied byte-for-byte from the upstream root `LICENSE` at that commit.
- Package versions at that commit: `@earendil-works/pi-agent-core` 1.2.0 and `@earendil-works/pi-ai` 1.2.0. They are **not** installed. There is no npm dependency, so there are no transitive provider SDKs, telemetry or proxy agents.

| Vendored file | Upstream path | Upstream sha256 | Change |
|---|---|---|---|
| `event-stream.ts` | `packages/ai/src/utils/event-stream.ts` | `9fd5e33a8e295d88b5911af71d7afbfd437c9620288808d18331f16811e24dac` | import path only |
| `transcript.ts` | `packages/ai/src/utils/transcript.ts` | `e0814f35bdcc93b017fa45589a6920e46b5480b88fba01ef93e5d2d4e815f0f2` | subset: `createInitialSystemMessage`, `normalizeContext` (verbatim) |
| `types.ts` | `packages/ai/src/types.ts`; `packages/agent/src/types.ts` | `258627828297eb0165de9828cab62666265a77e932dea5dba1542ace9c47c7d5`; `2e116ef60fdaca4e26be5a1ace8d8b47f545d648d365de60b8c9f9d1ba629ee4` | trimmed: the provider, catalog, auth, telemetry and typebox types are removed; `Model` and `AgentLoopConfig` are reduced to the fields used |
| `agent-loop.ts` | `packages/agent/src/agent-loop.ts` | `28a2b03e34a7e32f004aa851e54d3b5be9dad71c392205614cbc9abdf3a9020a` | adapted: one turn only. Tool calls are refused, never executed. There is no steering, follow-up, request or turn preparation, context transform, continuation or API key. `streamAssistantResponse` is verbatim apart from the API-key line. |

**Why adapted:** Kapelle's local runtime allows exactly one generation request per execution and no tools (LOCAL-MLX-ADAPTER-SPEC, HARNESS-IN-RUNTIME). Each removed hook is a path that could start another inference.

**Harness pin:** the catalog's `pi-agent-core` harness entry pins `commit` and `vendoredDigest`. The digest is sha256 over this directory's regular, non-dot files, sorted by name, each as name + NUL + bytes + NUL; a symlink or subdirectory is refused. The adapter recomputes the digest before every run and refuses on drift (`local_harness_changed`).

**Updating:** fetch the same paths at a new reviewed commit, re-apply the changes in the table, update this file and the catalog pin, and send it for review. Nothing here is fetched at runtime.
