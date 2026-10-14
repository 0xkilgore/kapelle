# Single existing Task pilot eligibility

This opt-in permits one explicitly pinned Task plan to supply its first live outcome. It does not assert production qualification, successful authentication/inference, cleanup or publication. The existing `kapelle.task-runtime-qualification/v1` / `PASS` receipt and production issuer are unchanged. Never use the old issuer to manufacture a pilot PASS.

## Host inputs and review

Set launcher `pilotMode: "single-task-pilot"` and add a strict `pilot` object to the immutable profile's worker binding. Both are required; omission preserves production mode. The pilot object contains exactly:

- `mode: "single-task-pilot"`, `liveOutcome: "PENDING"`.
- `ownerId`, `scopeRef`, `instanceId`, `taskId`, `permissionRef`, `runtimeBindingRef`.
- `definitionHash`, `modelPolicyHash`, `planHash`, `packetHash`: canonical `sha256:` digests. Model policy includes the complete native policy, including disabled paid fallback.
- `operationId`: the exact proposal draft operation UUID; `sourceHash`: the Task source's raw64-hex digest.
- `approvedAt`: the immutable pre-execution UTC anchor T0. `expiresAt` must equal T0+2 hours; `recoveryExpiresAt` must equal T0+24 hours. Admission expires at the first deadline, completed-output recovery at the second (both exclusive). Profile, launcher and eligibility expiry must equal `recoveryExpiresAt`. No renewal or rolling window.

Exactly one profile packet must match Task/packet/permission. The binding hash includes the complete pilot, inference, recipient/capability and owner configuration. Recipient capabilities and current grants still undergo ordinary native checks. Precompute the owner-authored proposal version and planHash using `makeVersion` with the real admitted Task and exact intended draft; actor/time are excluded from that hash. Do not create a synthetic approval. Native `APPROVE_TASK_PROPOSAL` must match this version and produce the real Dispatch before execution. Generated-plan refinement is unavailable in pilot mode.

The private eligibility file uses this separate strict contract:

```json
{
  "contract": "kapelle.single-task-pilot-eligibility/v1",
  "status": "ELIGIBLE",
  "liveOutcome": "PENDING",
  "bindingHash": "sha256:<canonical binding digest>",
  "publisherSourceHash": "sha256:<publisher tree digest>",
  "approvedAt": "<T0>",
  "admissionExpiresAt": "<T0+2 hours>",
  "expiresAt": "<T0+24 hours>",
  "sourcePins": [{"path": "<absolute canonical file>", "sha256": "<raw64hex>"}],
  "dependencyPins": [{"path": "<absolute canonical file>", "sha256": "<raw64hex>"}]
}
```

This is a schema illustration, not a usable receipt. The host-reviewed packet must enumerate the complete selected source/entrypoint and dependency closure, including Node/loader/SDK/CLI as applicable. Arrays are nonempty and bounded (4096 source files,65536 dependency files); receipt size is bounded to16MiB. The validator checks supplied canonical file paths and bytes on each admission check, plus the publisher tree, immutable receipt/config/profile and release assets. It cannot infer omitted dependency coverage: completeness/provenance remains an independent exact deployment review, as with the existing production closure. No live metadata, model result or automatic issuer attestation is inferred from these hashes. Repeated checks may be expensive for large closures; no runtime performance claim is made by injected tests.

Operations renders the reviewed file and pins its exact byte hash in existing `qualification.evidencePath/evidenceHash`; this schema path deliberately does not call the production attempt7 issuer. The independently reviewed release and actual published native definition are still required. No signature or hostile same-user isolation is claimed.

## Scope propagation

The launcher emits `{release, qualified:false, pilot}`. Authority preserves that scope only for the matching published release. It never promotes pilot eligibility to production qualification. Only the exact instance may receive narrowly checked create/model/runtime/read-Task/receive-permission/resume controls; generic connections, schedules, migrations and generic review effects cannot use the pilot. The native command boundary permits only REQUEST_PAUSE, REVOKE_CAPABILITY and RETIRE_INSTANCE after pilot expiry, with exact owner/instance checks. REQUEST_STOP is not a native command. New grants/resume and all other pilot admission still expire. Immutable launcher/profile metadata remains valid through the recovery deadline. Conservative native reductions remain possible during that interval; ordinary admission and new grants remain expired. After recovery expiry, only exact owner cancel/pause/revoke/retire can use integrity-checked metadata; Task reads, execution, publication and recovery still refuse access. Restart may open the same immutable pilot metadata/journals for these reductions without loading a provider. Process stop/settlement remains the separate graceful host path.

Task proposals must match the fixed Task, draft operation, source and planHash. Dispatch admission additionally requires exactly one task-authority/task source for the pinned Task, the direct owner sender, no parent/continuation or agent sender, exact recipient/model/runtime, current permission/grants and native approval. Worker checks the same immutable plan/packet and reuses the normal same-child account gate and restrictions. Another Task, instance, proposal or generic effect receives no pilot eligibility.

## One durable claim and actual outcomes

The existing private worker SQLite database holds a singleton `pilot_claim`; its insert and the started attempt are committed in one synchronous FULL transaction before provider entry. A failed started write rolls back both and does not invoke the provider. It is not keyed by receipt hash, expiry or generated eligibility ID. Receipt regeneration cannot reset it. Existing binding digest persistence rejects changed pilot/plan inputs on restart. Preserve the same admitted worker root/database and native journals; copying/resetting stores or changing roots is not recovery or permission for a new attempt. Existing native acceptance also refuses a missing execution history for an already accepted Dispatch.

One SDK query is the maximum. Even an allowlisted pre-child refusal becomes consumed uncertainty in pilot mode; production's bounded retry path remains unchanged. Started/uncertain records do not invoke again. A substitute Dispatch is refused by the singleton claim and native approved-Dispatch identity. Existing completed output may be independently read and the same publication reconciled; no second inference or publication identity is minted.

`liveOutcome: PENDING` describes the admission proof permanently. Actual execution outcome remains in the existing durable worker/Dispatch/publication receipts: uncertain, completed output, Report pending, or independently verified Report published. There is no automatic production promotion or receipt rewriting after success. Existing account/email/Claude Max gate, private cwd/TMPDIR with opted-in OS HOME, no tools/fallback, exact runtime pins, budgets and graceful-only uncertainty remain unchanged.

## Operational boundary

Source/offline acceptance grants no staging, login, service, native provisioning, Registry, model or Task execution authority. The final exact rollout packet still needs current identities/grants/approval, complete file closure, fresh finite expiry and separate owner execution approval. Existing frozen console/browser and composite qualification evidence retain their original identities; this delta does not repin or rerun GET, build or full-suite checks. Live UI/phone/Report evidence remains pending until the separately authorized pilot.

## Bounded completed-output recovery

Provision the exact Task/read and permission/receive grants once before execution, expiring no later than `recoveryExpiresAt`; use that deadline for the pilot so the intended recovery interval is available. Full grant identities/actions/expiry/revocation state remain pinned by recipient capability hash and approved plan. Earlier native or Registry permission expiry shortens effective recovery. No grant renewal, permission fallback or revoked-grant exception exists.

An authenticated explicit `POST /task-executions/:dispatchId/reconcile`, with strict empty JSON body `{}`, uses only the existing completed attempt and publisher/readback ports. It never calls the provider, accepts a new Dispatch, changes a plan or opens a new inference. `/run` stays expired; GET is read-only. There is no automatic reconciliation loop.

The owned worker validates its current lock, immutable binding, singleton claim/request and persisted `startedAt`, `completedAt`, `settledAt` on every recovery boundary. All three timestamps must be ordered, at or after T0 and strictly before admission expiry. Completed output/input/runtime/session must validate, and no unresolved provider fence may remain. Older records without these timestamps, uncertain/partial output or settlement after admission expiry cannot recover. A restart opens metadata/journals without loading the provider/SDK; new execution alone loads the adapter and retains the existing same-child account gate.

The internal per-Dispatch recovery scope is never accepted from HTTP or a serialized receipt. Native approval/version/plan, acceptance actor/input, Task/source/packet, recipient/runtime/model/capability, cancellation, grant expiry/revocation and all launcher/source/dependency/publisher pins are checked at current time. Source/provider pins are not repinned for recovery. No global expired-authorization flag or clock backdating is used.

- Publication not started: one first publication of retained bytes is permitted. The installed transport runs publisher preparation, credential/config/source checks and fresh native permission/deadline preflight first. After request framing, immediately before its first mutating MCP send, synchronous callbacks persist worker publication-started and publisher CREATE_ATTEMPTED under the original deterministic publicationId; no await separates these markers from fetch. A local preflight refusal leaves publication null. It may be presented again only by a later explicit request; no inference or automatic retry is added.
- Publication started, receipt absent: same-ID lookup only. Lookup-null or an unknown response remains uncertain, including across restart; never republish.
- Receipt retained: independent readback must verify exact Report/version/body/hash before recording the matching native result under the original operation ID.
- Result already recorded: readback only; no new publication or native command. GET never performs lookup or reconciliation.

Native result uncertainty permits same-operation reconciliation only, never resubmission or recovery of unrelated pending operations. The prepared native result entry durably carries its pilot binding, so reopening without a pilot option cannot enable generic settlement. Exact owner cancel/pause/revoke/retire may skip that protected pending entry, retaining it byte-for-byte, and pass normal current identity/native checks. Commands on unrelated native documents skip that protected entry without settling it and retain their normal authorization, revision and qualification checks. Only exact pilot targets enter the pilot control scope; another agent or Dispatch gains no pilot eligibility or expired-metadata exception. The command-path ordering check covers the target document, input instance/resource and grant principal/resource, target instance, and Dispatch recipient/sender-agent/Task/permission references against the protected Dispatch/instance/Task/permission IDs. It is not universal reference discovery: LINK_DOCUMENT/UNLINK_DOCUMENT documentRef, nested CREATE_REVIEW proposal resources and arbitrary content references are not included by that command-path check. Normal per-document native authorization and revision checks still apply. Same-Dispatch cancellation uses fresh native revision preconditions: a competing revision returns a conflict instead of rewriting or settling the pending result. A cancellation after an already recorded result follows the native reducer refusal. No reopening without pilot, new grants or history repair is needed or permitted. Publisher write boundaries recheck the owned completed claim and current native permissions; native commit rechecks its current context. A call already in flight may settle naturally at a deadline, but no subsequent write starts. At the recovery deadline work/recovery endpoints refuse and preserve evidence; the narrow owner reductions described above remain available. Later ordinary owner Report access depends on existing independent ACLs, not expired pilot permission.

The limits are intentional: two hours for supervised admission/execution, twenty-four total hours for next-morning completed-output recovery. These are authorization deadlines, not force-kill timers. Production PASS and production retry semantics remain unchanged. Source/offline acceptance does not authorize a live reconcile, first publication, model call or service rollout.

### Accepted pilot limits

After admission expiry, saved GET cannot show started, rejected or uncertain execution: the existing recovery validator requires completed output and the endpoint returns unavailable. Operator evidence remains retained; this change adds no journal-only status feature. Cancellation blocks completed-output recovery, intentionally stricter than the general Dispatch allowance to record some trusted results after cancellation. Pause/revocation/retirement also retain their ordinary admission consequences.

Once any mutating publisher transport call may have begun, the marker is never reset: thrown sends, unknown responses, partial publication or later preflight failures remain lookup-only. Request framing is preflight; the fetch invocation and response handling are conservatively possibly sent. A transport-bound publisher successor is required for the pilot. Its optional callWithStart(name, args, beforeSend) contract propagates through promote and CompletePrivateReportMcp after identity/membership/independent-reader checks, then through Framework credential/permission/deadline checks to the HTTP transport. getReportIdentities is read-only, including during lookup; the independent reader remains limited to getDocuments/getDocument. The production Framework wrapper does not opt into this callback, preserving its prior path. Legacy publishers do not satisfy the pilot transport boundary.

The two durable markers are not an atomic cross-store transaction. The worker marker is saved first, then the publisher intent is fsynced, then fetch starts synchronously. A filesystem error or interruption between markers conservatively consumes the first attempt; neither marker is reset, deleted, or used to infer no send. Existing publisher ambiguous-intent checks, same-ID lookup, native identity/membership and independent readback remain enforced. Retained local preparation reuses the same immutable publication plan. The retained 827 release/evidence stays historical; admission must pin and independently review the exact publisher successor together with the Framework successor.


### Pilot stop guidance: incomplete Report publication

Creating the Report document and registering its content are separate writes. A lost create reply, or a refusal before REGISTER after create may have succeeded, can leave a permanent native DRAFT and `REPORT_PENDING`. Same-ID lookup does not complete REGISTER. Stop and retain the worker record, publisher intent and existing document identity; do not retry REGISTER, reset either marker, start another Dispatch, or treat the draft as a verified Report. Completing that draft would require a separately reviewed policy and authorization. No such completion or retry is authorized by this pilot.


### Shared-store settlement entrypoints

Protected pending pilot results are never generically reconciled. Ordinary work may skip one only after establishing a known disjoint target; malformed, missing or related scope fails closed. The same rule applies to all five settlePending callers, without a separate state root:

- Allocation: NativeBackend resolves the durable new/replayed reservation, then supplies its exact document ID to the authority before native membership inspection/add/finish. A reservation may be retained locally on refusal; no native allocation write starts. A replay naming a protected ID is blocked. The ordinary no-protected-entry path retains its previous settlement order.
- Task-generation claim: native v3 review identity/owner/scope and every retained version's draft agent, Task and recipient IDs, plus retained Dispatch ID if present.
- Publication invocation claim and effect admission: native v2 review identity/owner/scope, instance, all proposal target document IDs and effect Dispatch/outbox IDs.
- Worker admission: native instance identity/owner/scope and requested source document ID.

These are explicit schema reference sets, not a recursive scan of arbitrary strings. Each method still performs its ordinary qualification, source, ownership, policy, revision and one-claim checks as applicable. Generic receipt and same-operation recover remain protected; the command loop's exact owner reductions remain unchanged. No skip authorizes inference, publication, renewal or retry.
