# Runnable publication host and bounded recovery

`openPublicationHost(authority, config)` is explicit composition over one retained native authority, not a new authority. It requires an exact manifest/review/instance, stable broker and Manager identity, actual Manager queue/database ports, trusted facts binding, and separate owner/Manager/executor credentials. It mounts only ephemeral numeric-loopback listeners. Callers must retain the native runtime's single-writer lock and close this host before closing its authority.

The existing owner decision facade preserves its command/receipt routes and adds GET `/publication-status`. That read verifies native review/proposal/instance, saved Manager operation/Dispatch/outbox, native effect references and a stable native revision. It returns decision, delivery, queue presence, executor/wakeup availability and project hold independently. A failed source read returns unavailable; it does not invent an absent queue. Status reads cannot enqueue, claim, reconcile or settle. Decision-triggered and startup wakeups are explicitly opt-in and bounded to one attempt; there is no installed timer or paid inference.

## Run the isolated demonstration

From `agent-framework`, set `KAPELLE_SCOPED_REACTOR_ROOT` to the qualified scoped Reactor checkout and `KAPELLE_PUBLICATION_MANAGER_ROOT` to the inspected existing Manager checkout. Execute with a Node runtime supporting `node:sqlite` and compatible with the installed Manager better-sqlite3 ABI (September22 qualification used Node23.7.0), and the already available TSX loader:

```sh
node --import /absolute/path/to/tsx/dist/loader.mjs scripts/publication-host-demo.ts serve /absolute/new/private/demo
node --import /absolute/path/to/tsx/dist/loader.mjs scripts/publication-host-demo.ts status /absolute/new/private/demo
node --import /absolute/path/to/tsx/dist/loader.mjs scripts/publication-host-demo.ts approve /absolute/new/private/demo
```

A separate fresh root can use `request-changes ROOT 'Exact comment'`. The owner CLI saves one operation before transmitting it and reuses that same request after uncertainty. The native decision binds the comment and recipient instance, but this host does not claim the agent received a changes-request message.

The demo stores distinct generated synthetic credentials in a private file, retained native documents/journal, the actual Manager reactor/migrations with its installed better-sqlite3 SqliteAdapter and isolated storage, and a transactional synthetic target. It prints no credential values. A marker prevents accidental adoption of an unrelated directory. Optional `KAPELLE_SYNTHETIC_REPORT_FILE` freezes a custom Markdown report, including Product's synthetic same-origin preview links. `binding.json` and `report-document.json` provide matching console/Registry fixture envelopes. The proposal/grants expire 24 hours after initialization; restart does not refresh approval identity or expiry.

SIGTERM closes the listeners and stores. Starting the same command against the same root reopens native and Manager identities, then performs one bounded recovery wakeup. The listener ports can change; `endpoints.json` records current ports. Initial provisioning interrupted before its binding file is retained requires inspection and a fresh synthetic root, not blind partial reprovisioning. Crash recovery of an embedded native `writer.lock` remains the runtime's separate ownership procedure.

`KAPELLE_SYNTHETIC_PUBLICATION_FAULT=lost-response` commits a terminal synthetic request receipt and loses its acknowledgement. `pending` retains an unresolved request. Neither mode contacts Vercel. The target's operation receipt and target mutation are one SQLite transaction; that is a stronger contract than Vercel's documented promotion interface, deliberately used to qualify the settlement port rather than pretend Vercel supplies it.

## Smallest safe settlement paths

**Completed request:** a trusted `readRequestSettlement(binding)` port must return an immutable terminal proof tied to exact operation, complete binding hash, project/team/deployment and proof identity. The host must independently establish that this proof means the original request can never act again. The synthetic target provides this through its atomic transaction. After actual native terminal evidence is retained, one local transaction marks contact settled, archives the complete hold and proof as a permanent tombstone, and frees the project slot. Wrong bindings and failed transactions retain the hold. Replaying the old operation reads its native receipt and cannot acquire a new invocation or send. A new operation can use the freed slot.

**Provably no contact:** trusted-host `sealNoContact` acquires the same project/run guard used by every invocation, verifies a retained native invocation, and requires absence of the mandatory pre-send contact record. It writes a permanent exact-operation seal before any native failure claim. All future sends check the seal and fail. Ordinary reconciliation then records independently verified native FAILED evidence and atomically archives/releases the hold with NO_CONTACT proof. A crash between seal and native commit resumes the same reconciliation. The consumed native invocation and all original operations remain intact. A present contact row—even a timeout, rejected response, identical live bytes or an Owner acknowledgement—makes this path unavailable. An active publisher blocks sealing; a dead local process retires only its run under the inherited host/PID proof.

`recoverNoContact()` is a trusted in-process host maintenance method, not an HTTP route or browser button. There is no force-clear, time-based expiry of a hold, new-operation retry, or claimed failure for a possibly transmitted request. Preserve no-contact seals, settled hold tombstones, contacts, runs, native command history and Manager keys across restart and rollback. Older executor releases do not implement these tombstones and are not a qualified execution rollback. This slice does not migrate a live/legacy journal or qualify cross-host failover.

## Deliberate provider decision

The documented Vercel promotion endpoint has 201/202 success responses with an empty payload; it provides no request-specific settlement identifier in that contract. Its alias status endpoint describes the latest promotion and offers project/time filters. Neither documented interface establishes an immutable terminal receipt for our exact possibly delayed request. [Promotion API](https://vercel.com/docs/rest-api/projects/point-production-traffic-to-a-given-deployment), [current-promotion alias status](https://vercel.com/docs/rest-api/projects/gets-a-list-of-aliases-with-status-for-the-current-promote).

Consequently the default real Vercel adapter leaves `readRequestSettlement` absent. It can verify observed publication while returning `held=true, requestSettlement=UNPROVEN`. The test where an Owner independently publishes identical bytes while the original request is pending retains that hold. HTTP status, matching bytes/aliases, elapsed time, process death and owner confirmation are not substituted for request settlement.

Production needs either a provider/contract with a qualified per-request settlement or cancellation proof, or an explicitly reviewed change to the promised writer/recovery policy that acknowledges the remaining race and recovery consequences. The proposed v3 writer mode stays disabled. Git disconnection, credential isolation or a local serialization lock alone does not supply the missing proof. This is a concrete provider boundary, not a reason to keep adding speculative retries.

The isolated demo is runnable now. Live activation additionally needs a future real Task/output commitment, trusted real Report/source/build/staging readers, exact new owner approval, qualified writer assurance/provider settlement, installed retained host/Manager driver and credentials, and an authorized release. The completed cleanup Task is not eligible. No live setting or website is changed by this composition or its tests.
