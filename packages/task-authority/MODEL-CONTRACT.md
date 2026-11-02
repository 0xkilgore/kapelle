# Task Authority model contract

Date: 2026-08-13
Status: input contract for the generated Powerhouse 6.2.1 model spike

## Document identity

- Document type: `kilgore/task`
- Schema version: `1`
- One Powerhouse document per task
- Reactor PHID is the canonical task identity
- The gateway derives `CREATE_TASK.id` from the Reactor document header. It is
  an internal action field, never caller input, and created state must satisfy
  `state.id === document.header.id`.
- A caller-supplied `CREATE_TASK.id` is rejected before an idempotency
  reservation or Reactor document allocation is created; it is not silently
  ignored or overridden.
- Dates are UTC ISO-8601 instants; viewer timezone belongs in projections
- Accepted instants are normalized to millisecond UTC form with `toISOString()`
  before comparison or storage.
- Operation history is the audit record; projections are disposable

## State

```text
Task
  id: PHID
  schema_version: 1

  title: non-empty string, max 500
  body_markdown: string, max 100000
  status: OPEN | SNOOZED | BLOCKED | DONE | ARCHIVED
  priority: HIGH | MED | LOW | null

  project_id: opaque string | null
  labels: normalized unique strings[]
  owner_id: opaque actor string
  assignee_id: opaque actor string | null

  due_at: datetime | null
  snoozed_until: datetime | null
  created_at: datetime
  updated_at: datetime
  completed_at: datetime | null
  archived_at: datetime | null

  open_block: { reason, set_at, set_by } | null
  block_history: append-only block records[]
  comments: append-only comment records[]
  depends_on: unique task PHIDs[]
  external_refs: unique opaque refs[]

  source: HUMAN | CLI | AGENT | PERSONAL_CRM | MIGRATION
  source_ref: opaque string | null
  created_by: actor string
  updated_by: actor string
```

Do not carry `Trello`, `email`, local filesystem path, source line, dispatch,
artifact body, contact details, agent orchestration, Goal, Track, or Idea fields
into the v1 authority model. Those are adapter or external-authority concerns.

## Operation envelope

Every mutation receives this metadata at the gateway boundary:

```text
operation_id: caller-generated UUID or ULID
actor_id: authenticated actor
expected_revision: exact current revision
occurred_at: server-assigned UTC datetime
source_client: authenticated client id
```

`actor_id` and `occurred_at` are included in the document action input because
they are durable audit fields. The gateway derives them from authentication and
server time; callers cannot choose or override them. `operation_id`,
`expected_revision`, and `source_client` remain gateway receipt/concurrency
metadata and are not task-domain state.

Each authenticated client has an explicit non-empty `source` allowlist. The
Taskview client may write only `CLI`; callers cannot relabel their writes as
agent, CRM, or migration activity. Non-privileged clients must also set
`owner_id` to their authenticated actor. Cross-owner assignment requires an
explicit privileged client configuration.

The gateway stores an idempotency receipt for `operation_id`. Repeating the same
operation with the same canonical payload returns the original receipt. Reusing
an operation ID with a different payload fails closed. A stale
`expected_revision` returns a conflict and does not append an operation.

Retry identity is the operation ID plus the canonical caller-visible payload.
`expected_revision` is enforced on first execution but excluded from that hash,
so a retry after the accepted revision advances still returns its original
receipt. This is deliberate retry behavior, not a concurrency bypass.

Prepared receipts retain the exact JSON-transport form of every canonical action
input. Recovery matches operation index, action type, and canonical input before
accepting a Reactor write; matching type alone is insufficient.

The gateway is the sole supported writer to its dedicated task drive. One
gateway host uses one canonical `TASK_GATEWAY_LOCK_DIR`; startup acquires an
exclusive lock keyed by Reactor drive ID and refuses a second local gateway for
that drive even when it uses a different receipt database. External MCP or
GraphQL writers, a gateway on another host, or bypassing that lock void the
idempotency and recovery guarantees. Multi-writer support is explicitly out of
scope. Generated reducers retain an internal `CREATE_TASK.id` action field
because state-scope reducers cannot read the immutable document header; the
gateway always derives that field from the header PHID and asserts identity
again after every operation and on every load.

## Operations

### Creation and content

- `CREATE_TASK(title, body_markdown?, project_id?, due_at?, priority?, labels?, assignee_id?, source, source_ref?)`
- `UPDATE_TITLE(title)`
- `UPDATE_BODY(body_markdown)`
- `SET_PROJECT(project_id | null)`
- `SET_DUE(due_at | null)`
- `SET_PRIORITY(priority | null)`
- `SET_ASSIGNEE(assignee_id | null)`

### Lifecycle

- `COMPLETE_TASK(resolution? | null)`
- `REOPEN_TASK(reason? | null)`
- `SNOOZE_TASK(snoozed_until, reason? | null)`
- `UNSNOOZE_TASK()`
- `BLOCK_TASK(reason)`
- `UNBLOCK_TASK(resolution? | null)`
- `ARCHIVE_TASK(reason? | null)`

There is deliberately no network operation that destroys a task or erases its
history. Archived tasks are excluded from normal views and remain auditable.

The current gateway exposes both directions of every reachable reversible
lifecycle state: snooze/unsnooze and block/unblock, as well as complete/reopen.

### Classification and context

- `ADD_LABEL(label)`
- `REMOVE_LABEL(label)`
- `ADD_COMMENT(comment_id, body_markdown)`
- `ADD_DEPENDENCY(task_phid)`
- `REMOVE_DEPENDENCY(task_phid)`
- `ADD_EXTERNAL_REF(ref_id, authority, opaque_id, deep_link? | null)`
- `REMOVE_EXTERNAL_REF(ref_id)`

Classification and context operations remain model capabilities only in Slice
2R. Labels, comments, dependencies, and external-reference mutations are not
yet exposed through the network gateway.

## Reducer invariants

1. `CREATE_TASK` is the only valid first operation and occurs exactly once.
2. A blank or whitespace-only title is rejected.
3. `ARCHIVED` is terminal in v1. All later content and lifecycle writes reject.
4. `COMPLETE_TASK` is valid from `OPEN`, `SNOOZED`, or `BLOCKED`; it clears an
   active snooze and closes any open block.
5. `REOPEN_TASK` is valid only from `DONE` and returns the task to `OPEN`.
6. `SNOOZE_TASK` is valid from `OPEN` or `BLOCKED`, requires a future instant,
   and produces `SNOOZED`.
7. `UNSNOOZE_TASK` is valid from `SNOOZED` and produces `OPEN`.
8. `BLOCK_TASK` is valid from `OPEN` or `SNOOZED`, permits one open block, and
   produces `BLOCKED`.
9. `UNBLOCK_TASK` is valid from `BLOCKED`, closes the block, and produces `OPEN`.
10. Same-value setters and duplicate set-like additions are deterministic no-ops.
11. Labels are lowercase, trimmed, dash-normalized, unique, and bounded.
12. A task cannot depend on itself. Cycle detection is a processor health signal,
    not a single-document reducer concern.
13. Content changes update `updated_at` and `updated_by`; no-op writes do not.
14. Reducer behavior is independent of every consuming application.

## Projections

### `task-authority.index.v1`

Rebuildable row per task containing only fields required for queries and lists:
identity, title, status, priority, project, due/snooze instants, labels, assignee,
timestamps, revision, and bounded external-ref identities.

### `task-authority.today.v1`

A bounded, deterministic projection for one viewer timezone:

- overdue open or blocked tasks;
- open or blocked tasks due on the viewer's local date;
- open tasks explicitly selected for Today by a later reviewed operation;
- snoozed tasks only when their snooze instant has elapsed;
- never archived or completed tasks;
- stable ordering: overdue first, then priority, due time, updated time, PHID;
- maximum 100 rows, with `has_more` and counts rather than silent truncation.

The initial spike may omit explicit Today selection and recurrence. If omitted,
that absence must be visible in the contract and UI rather than inferred.

### Recovery lanes

`BLOCKED` and `SNOOZED` queries return bounded status-specific recovery
projections with `totalCount` and `hasMore`. They do not require a due date or
project, so lifecycle state cannot make a task disappear from every query
surface.

## Gateway prohibition test

The generated OpenAPI contract must contain none of these terms in route paths:

`import`, `migrate`, `bulk`, `batch`, `directory`, `scan`, `delete-all`,
`purge`, `restore`.

Backup/restore and migration remain local operator procedures outside the
production gateway.

## Known synthetic bounds

- A fresh create never scans the drive. Only a retry of the narrow crash window
  between Reactor allocation and receipt attachment performs name recovery, and
  it fails closed before fetching candidates when the drive exceeds 100
  documents. A direct indexed lookup should replace this bound before scale.
- Rejected and interrupted synthetic creates can leave auditable orphan
  allocations in the development drive. They are not automatically destroyed.
- If a prior create using an operation ID reached Reactor and was rejected, the
  gateway returns `CREATE_REJECTED_USE_NEW_OPERATION_ID`; retrying that same
  operation ID cannot repair the rejected document.
- The local drive lock enforces one gateway process on the configured host. The
  dedicated-drive and no-external-writer rules remain operational invariants.
- Graceful SIGINT/SIGTERM releases the lock. An ungraceful crash leaves a stale
  lock that fails closed and requires operator removal after confirming that no
  gateway process still owns the drive; startup never races to delete it.

## Spike acceptance tests

- reducer transition table passes;
- same operation ID replay returns the original receipt;
- conflicting operation-ID payload fails;
- stale revision fails without mutation;
- processor rebuild from the operation log produces the same index hash;
- Reactor restart retains documents, revisions, and receipts;
- malformed, oversized, and unauthorized inputs fail closed;
- a synthetic 20-task fixture produces stable Inbox, Today, Upcoming, Project,
  Completed, and Archived query results;
- no prohibited route appears in the gateway contract.
- live synthetic reducer rejection advances the operation ledger and remains a
  prepared, non-accepted receipt;
- live crash-after-write replay accepts the existing operation without appending
  a duplicate;
- Taskview add, done, snooze, and unsnooze remain under the one-second capture
  bar against the isolated development Reactor.
