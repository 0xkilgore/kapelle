# Fixed Report Drive metadata snapshot

`compose-snapshot.mjs` adds one MCP tool to the exact installed Reactor MCP 6.2.1 bundle. It rejects any other preimage. Install `report-snapshot.mjs` beside that bundle and beside the authorization proxy. This supersedes the outgoing-relationship patch for the private Report path; it does not change general native listing behavior.

The native tool accepts only the literal configured Drive ID. The proxy independently enforces its configured Drive and reader/reviewer/producer roles, with producer-only identity projection. The existing native MCP trust boundary is loopback; this is not a new arbitrary SQL or database access endpoint. It uses `client.documentView._db`, the owning Kysely connection. There is no second database owner, migration, filesystem modification, or durability bypass.

One SELECT supplies a single MVCC observation of Drive membership, child relationships, Report metadata and materialization evidence. It requires:

- Exact unique Drive-file/child-relationship sets, including blank intents.
- A live Report header and global scope for every member, plus the Drive header/global scope.
- Exact journal/index operation multisets for the relevant documents and main branch, so a journal/index commit gap cannot be hidden by a global maximum ordinal.
- Each scope's expected latest operation hash/index and materialization count. The calculation follows installed `KyselyDocumentView.commitOperations`: every operation writes the header; ordinary operations write their scope; CREATE initializes document/auth; first UPGRADE initializes other missing scopes.
- No deleted document or unsupported/malformed metadata. Unexpected historical materialization counts fail closed rather than being repaired or ignored.

Native 6.2.1 histories with missing initial scopes, unusual upgrade sequences, rebuild duplicates or unsupported deletion/recreation may fail this deliberately conservative check. Live history compatibility has not been admitted. No claim of backend-wide uniqueness is made: publisher publicationId/reportRef locks and native expected revisions retain their existing guarantees.

Metadata is projected inside SQL before materializing intermediate rows. Markdown, feedback, credentials and operation action payloads do not leave the connection. The result carries all IDs, ordered metadata rows, explicit pending/registered classification, totalCount, complete, no continuation, and a digest covering rows and materialization fences. It is a point-in-time observation, not an authority cache or a future-write reservation. Reader detail requests refresh scope before forwarding the selected body request.

The publisher takes membership and identities from one native snapshot under its existing locks, independently checks the reader before writes, refreshes before create/addActions and independently verifies final native bytes. It does not hydrate the Drive or the entire Report library. The Library uses the same metadata tool; descriptor hashes alone cannot claim verified content bytes.

Limits remain 10,000 nodes, 2,000,000 response bytes, six seconds per metadata call, ten seconds for producer HTTP and 30 seconds/64MB for the private command. A query exceeding six seconds is rejected even if it eventually returns; this check is not database-query cancellation. No retries, partial-list fallback or deadline widening are hidden in this path.

Source qualification is distinct from live qualification. Synthetic measurements demonstrate the single-query path, but a cold deadline failure and substantial whole-store filesystem synchronization cost remain documented. The complete live publisher command, actual corpus compatibility and Product consumer/build acceptance must pass before any release admission or publication.

## October 7 source repair and repeatable proof

The raw query explicitly qualifies Reactor tables in the `reactor` schema; Kysely's schema plugin does not qualify raw SQL. Report JSON projection preserves saved JSON types, requires the mandatory Report shape, and checks all five required native scopes instead of deriving completeness only from scopes that happen to remain present. The metadata response still omits bodies and uses one MVCC statement with the same bounds.

`tests/report-snapshot-native.mjs` reuses the pinned6.2.1 native view/indexer preimage against isolated PGlite. Set `KAPELLE_SNAPSHOT_RUNTIME_ROOT` to the existing synthetic API runtime containing PGlite/Kysely, `KAPELLE_SNAPSHOT_FIXTURE_ROOT` to the captured fixture/preimage directory, `KAPELLE_SNAPSHOT_MCP_PREIMAGE` to the exact installed MCP capture, and `KAPELLE_SNAPSHOT_OUTPUT_ROOT` to a private evidence directory, then run Node24 on that file. It verifies1,804records, actual native cursor traversal over19pages, completeness under a public search_path, missing scopes/members/materialization refusal, composed MCP registration and the real proxy/publisher-reader path. Fixture expansion clones native-materialized representative states; it is not a replay or admission of live history. The small1,804-record metadata result stays within the unchanged2MB/six-second bounds.

Deployment must carry these matching artifacts: the MCP bundle emitted by `composeSnapshotMcp` from its exact accepted preimage, `report-snapshot.mjs` beside that emitted bundle, and `mcp-auth-proxy.ts` with the same `report-snapshot.mjs` beside it. The composed tool is fixed to the existing Report Drive. The proxy grants identity lookup only to its existing producer role; no credential or Drive scope is broadened. The general native listing implementation is not replaced by this rollout.

Operations must verify the actual installed MCP preimage hash and its import location, capture Reactor/proxy source/config preimages and persistent-volume ownership, and include both Reactor and proxy in the explicitly approved service scope. A different installed MCP hash requires reviewed composition, not bypassing the preimage check. Restore service/code preimages on rollback while retaining new native receipts and journals; do not roll older data over new writes. Read-only qualification must execute the selected publisher's completeList through the installed proxy and compare the complete native metadata and producer identity inventory, including a member beyond100. This source proof does not authorize rollout or replace those live checks.

## Installed compatibility baseline (October 7)

The sole accepted MCP preimage is `94e885d8046482570d13346e686f87e0468d231a9f2aefc6d2833f18c30495c3`. The earlier `0f25` baseline is obsolete and is refused. Composition retains the installed summary module import, mandatory summaryReportModule owner, and every prior tool. The native proof reproduces the installed node_modules/@powerhousedao/reactor-mcp/dist layout, compares the complete baseline/candidate tool sets, and rejects modified preimages.

The proxy is merged onto active source `1653f840176c3828fd3c509b3d9cfbfe261d4ac5ed0562b4ba105a1782688ed2`. Existing reader-only v2 summary/detail routes, producer publication lookup, reviewer scope/revision checks and membership receipt, revision-conflict409 response, and CLI SIGTERM draining are retained. Reviewer invalid-scope/model/lifecycle upstream results retain the active proxy's502 behavior, while invalid request envelopes remain403. Complete inventory replaces only the listing/identity path and refreshes reader document eligibility.

The seven report-summary-read JavaScript files are byte-for-byte captures of the installed dependency sources. They are preserved runtime dependencies, not a new summary implementation. Verify their hashes before switching; do not overwrite a drifted installed dependency. The summary import resolves from the MCP bundle to deploy/report-summary-read/register.mjs, and the proxy imports deploy/report-summary-read/aggregate.mjs. The new snapshot helper is required in both deploy and MCP/dist. The aggregate.d.mts file is source-only typing, not a runtime deployment dependency.

Run the focused regression files report-snapshot.test.ts, mcp-auth-proxy.test.ts, proxy-shutdown.test.ts, private-publication.test.ts and task-publication.test.ts with Node24's type stripping. Shutdown verification uses a disposable child proxy and a held synthetic upstream write: SIGTERM must preserve the admitted response and exit0 after completion. No live write is part of this verification.
