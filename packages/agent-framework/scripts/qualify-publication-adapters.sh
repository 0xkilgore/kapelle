#!/bin/sh
# Isolated actual-driver qualification; never starts Manager or opens its live DB.
set -eu
: "${KAPELLE_PUBLICATION_MANAGER_ROOT:?Installed Manager source/dist root required}"
: "${KAPELLE_SCOPED_REACTOR_ROOT:?Scoped Reactor root required}"
: "${KAPELLE_PLATFORM_MODELS_ROOT:?Platform models root required}"
: "${KAPELLE_WORKER_HOST_TSX:?Absolute TSX loader required for child-process proof}"
: "${KAPELLE_QUALIFICATION_NODE:?Node binary compatible with installed better-sqlite3 required}"
cd "$(dirname "$0")/.."
test -f "$KAPELLE_PUBLICATION_MANAGER_ROOT/dist/db/sqlite-adapter.js"
test -f "$KAPELLE_WORKER_HOST_TSX"
exec "$KAPELLE_QUALIFICATION_NODE" node_modules/vitest/vitest.mjs run \
  tests/manager-publication.test.ts tests/publication-host.test.ts \
  tests/publication-task-reader.test.ts tests/publication-settlement.test.ts \
  --maxWorkers=1 --testTimeout=30000
