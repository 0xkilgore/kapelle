# Task/result context binding adoption

The binding repair requires `producer.instructionsHash` in the private `TaskResultBinding`.
It is the SHA-256 of the exact UTF-8 accepted Dispatch instructions, using the existing
`instructionsHash` helper. The reader checks the independent private pin, the saved
instructionsHash, the instructions bytes, the full offer hash and acceptance together.

This is a coordinated, breaking required-field revision of the development binding
shape. The projection discriminator remains `kapelle/task-result-context/v1`; it is
not a promise that old private binding files are accepted. Both Operations and the
Product mirror must adopt the required field together. Missing fields are rejected
before source reads. There is no legacy default, inferred hash, automatic rewrite or
fallback to hashing text returned by the facade.

An owner must inspect the selected accepted Dispatch and approve the complete new
private binding, including the instructions pin. The full binding is already part of
the retained publication host identity. Adding or changing this field changes that
identity; an existing host marker cannot silently retarget. This repair does not
migrate markers, rewrite installed bindings, restart hosts or authorize adoption.
Synthetic fixture bindings are development evidence only.

## Shared limits

- Offered pins: at most17, including the saved-context manifest itself.
- Resolved inputs: at most16, excluding that manifest.
- Full HTTP response `{ok:true,context}`: at most65536 UTF-8 bytes, including JSON
  escaping and the envelope. Reader and owner HTTP boundary use the same helper.
- Existing raw instructions cap32768 bytes, source read cap262144 bytes and10-second
  projection deadline are unchanged. A large valid individual source can still exceed
  the aggregate response budget and be refused.

`taskResultBoundaryFixture()` supplies a fully bound17-offered/16-resolved fixture for
cross-repository validation. The backend refuses18 offered pins even with otherwise
coherent offer/acceptance hashes. The receipt schema refuses17 resolved entries.

## Offered-inventory trust boundary

The private offerHash authenticates the full offer, including ordered source pins,
at the Operations reader. Product receives a projection, not the complete offer, so
it cannot independently recompute that offer hash. An additional independently pinned
offered-inventory digest would defend against a faulty or compromised authenticated
facade, just as the new instructions pin does for text. No such field is added in this
repair: it needs a coordinated canonical encoding/order rule and binding adoption.
Product must not describe the offered list as independently reverified from its private
binding. It remains authenticated upstream metadata; it is not proof of resolution,
current source permission, approval or effect admission. This limitation is explicit,
not a claim that an extra digest would have no value.

## Evidence and installation limits

The old synthetic provider/queue placeholder tables were never connected to execution
and their zero counts were not provider-isolation evidence. Those assertions have been
removed. The retained tests exercise real file snapshots, a read-only SQLite artifact,
repeated GET, two cold Node processes, WAL refusal before SELECT, current ACL rejection,
and a native command trap. These support the scoped adapter claims, not live provider
or live-store qualification.

Active WAL/SHM or WAL headers remain unavailable before SQL reads. A host-qualified
immutable non-WAL artifact and already-open read-only query capability, or another
separately qualified side-effect-free read capability, remains an installation gate.
Real Task/producer/result pins, Registry immutable-version and ACL adapters, retained
host adoption, provider settlement and daily-publication holds remain unchanged.
