import { pilotAllocationReader } from './pilot-observation.js';
import { acquireWriterLock, releaseWriterLock } from '../worker/writer-lock.js';
import { guardedClose } from './close-guard.js';
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  fstatSync,
  readdirSync,
  openSync, closeSync, constants, readSync,
} from "node:fs";
import { digest, modules } from "../command-boundary.js";
import { assert } from "../validation.js";
import { NativeBackend } from "./native-backend.js";
import { FrameworkAuthority, type Facts, type ServiceOptions } from "./authority.js";
import { CommandJournal } from "./journal.js";
import { withVersionedSnapshot } from "./versioned-snapshot.js";
import { addVersionedFile } from "./versioned-allocation.js";
export interface BeforeDatabaseOpenContext {
  readonly stateRoot: string;
  readonly signal: AbortSignal | undefined;
  /** Check the runtime's existing native writer lease; no descriptor is exposed. */
  readonly assertOwnership: () => void;
}
export interface RuntimeOptions {
  /** Refuse creation/replacement of authority metadata; observation startup only. */
  requireExistingAuthority?: boolean;
  /** Optional offline cold capture under the native writer lock, before any DB construction.
   * Must settle all capture work before returning or rejecting; do not mutate source state,
   * open a database, release the lease, or leave background capture work running.
   * Cancellation is cooperative: an unsettled callback keeps exclusion held. */
  beforeDatabaseOpen?: (context: BeforeDatabaseOpenContext) => void | Promise<void>;
  /** Cancels opening, never an already-returned runtime. No timeout races release the lock. */
  openSignal?: AbortSignal;
  taskProposalProducer?: ServiceOptions["taskProposalProducer"];
  taskDelegation?: ServiceOptions["taskDelegation"];
  stateRoot: string;
  reactorRoot: string;
  ownerId: string;
  scopeRef: string;
  facts: () => Promise<Facts>;
  now?: () => string;
  effectPolicy?: ServiceOptions["effectPolicy"];
}
/** Start in the existing scoped Reactor implementation, with a private dedicated Drive.
 * No generic Reactor HTTP/MCP endpoint is exposed; all writes use FrameworkAuthority.
 * One process owns the embedded database. A stale process lock requires an explicit recovery check.
 */
export async function openFrameworkRuntime(options: RuntimeOptions) {
  options.openSignal?.throwIfAborted();
  const root = resolve(options.stateRoot);
  if (!options.requireExistingAuthority) mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  assert(
    stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0,
    "State directory must be private",
  );
  assert(stat.uid === process.getuid?.(), "State directory owner mismatch");
  const entries = readdirSync(root);
  assert(
    entries.length === 0 || entries.includes("authority.json"),
    "Existing directory is not a framework authority",
  );
  const binding = digest({
      owner: options.ownerId,
      scope: options.scopeRef,
      contract: "kapelle-framework/v1",
    }),
    metaPath = resolve(root, "authority.json");
  if (!options.requireExistingAuthority && existsSync(metaPath))
    assert(
      JSON.parse(readFileSync(metaPath, "utf8")).binding === binding,
      "Authority scope mismatch",
    );
  // Use the existing native writer lock throughout capture, open and guarded close.
  const lock = acquireWriterLock(root);
  const lockIdentity = fstatSync(lock.fd);
  const assertOwnership = () => {
    const held = fstatSync(lock.fd), current = lstatSync(lock.path), directory = lstatSync(root);
    assert(held.dev === lockIdentity.dev && held.ino === lockIdentity.ino &&
      current.isFile() && !current.isSymbolicLink() && current.dev === held.dev && current.ino === held.ino &&
      directory.isDirectory() && !directory.isSymbolicLink() && directory.dev === stat.dev && directory.ino === stat.ino &&
      directory.uid === process.getuid?.() && (directory.mode & 0o077) === 0,
      'runtime_writer_ownership_changed');
  };
  let module: any, database: any, pglite: any, journal: CommandJournal | undefined;
  const stop = guardedClose([
    () => journal?.close(),
    async () => { if (module) await module.reactor.kill().completed; },
    async () => { if (module) await module.reactorModule.readModelCoordinator.drain(); },
    async () => { if (database) await database.destroy(); },
    async () => { if (pglite && !pglite.closed) await pglite.close(); },
  ], () => releaseWriterLock(lock));
  const storeIdentities = new Map<string, {dev:number;ino:number}>();
  const existingStores = () => {
    assertOwnership();
    for (const [relative, directory] of [['pglite', true], ['pglite/PG_VERSION', false], ['commands.sqlite', false]] as const) {
      const path = resolve(root, relative), st = lstatSync(path);
      assert(!st.isSymbolicLink() && (directory ? st.isDirectory() : st.isFile()) && st.uid === process.getuid?.() &&
        (st.mode & 0o022) === 0 && (directory || st.size > 0), 'existing_authority_store_invalid');
      const previous = storeIdentities.get(relative);
      assert(!previous || (previous.dev === st.dev && previous.ino === st.ino), 'existing_authority_store_changed');
      storeIdentities.set(relative, {dev:st.dev,ino:st.ino});
      if (!directory) {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const held = fstatSync(fd), bytes = Buffer.alloc(relative.endsWith('PG_VERSION') ? 32 : 16);
          assert(held.dev === st.dev && held.ino === st.ino, 'existing_authority_store_changed');
          const count = readSync(fd, bytes, 0, bytes.length, 0), value = bytes.subarray(0,count).toString();
          assert(relative.endsWith('PG_VERSION') ? held.size <= 32 && /^\d+\s*$/.test(value) : value === 'SQLite format 3\0',
            'existing_authority_store_invalid');
        } finally { closeSync(fd); }
      }
    }
  };
  let retained: { dev: number; ino: number; bytes: string; meta: {binding:string;driveId:string} } | undefined;
  const existingMetadata = () => {
    assertOwnership();
    const fd = openSync(metaPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      assert(before.isFile() && before.uid === process.getuid?.() && (before.mode & 0o077) === 0 &&
        before.size > 0 && before.size <= 16384, 'existing_authority_metadata_invalid');
      const bytes = readFileSync(fd, 'utf8'), meta = JSON.parse(bytes);
      const after = fstatSync(fd), current = lstatSync(metaPath);
      assert(current.isFile() && !current.isSymbolicLink() && current.dev === before.dev && current.ino === before.ino &&
        after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs,
        'existing_authority_metadata_changed');
      assert(meta && typeof meta === 'object' && !Array.isArray(meta) && meta.binding === binding &&
        typeof meta.driveId === 'string' && meta.driveId.length > 0 && meta.driveId.length <= 200,
        'existing_authority_metadata_invalid');
      if (retained) assert(retained.dev === before.dev && retained.ino === before.ino && retained.bytes === bytes,
        'existing_authority_metadata_changed');
      else retained = { dev: before.dev, ino: before.ino, bytes, meta };
      return meta as {binding:string;driveId:string};
    } finally { closeSync(fd); }
  };
  try {
    assertOwnership();
    if (options.requireExistingAuthority) { existingMetadata(); existingStores(); }
    options.openSignal?.throwIfAborted();
    if (options.beforeDatabaseOpen)
      await options.beforeDatabaseOpen(Object.freeze({ stateRoot: root, signal: options.openSignal, assertOwnership }));
    // Never construct a database after failed/cancelled capture or a changed lease.
    assertOwnership();
    options.openSignal?.throwIfAborted();
    if (options.requireExistingAuthority) { existingMetadata(); existingStores(); }
    const req = createRequire(resolve(options.reactorRoot, "packages/reactor/package.json"));
    const { PGlite } = req("@electric-sql/pglite"),
      { Kysely } = req("kysely"),
      { PGliteDialect } = req("kysely-pglite-dialect");
    const reactor = await import(
      /* @vite-ignore */ pathToFileURL(
        resolve(options.reactorRoot, "packages/reactor/dist/index.js"),
      ).href
    );
    const drive = await import(
      /* @vite-ignore */ pathToFileURL(
        resolve(options.reactorRoot, "packages/shared/dist/document-drive/index.js"),
      ).href
    );
    assert(
      reactor.KyselyScopedAuthorityStore && reactor.digestScopedAuthorityActions,
      "Scoped Reactor extension required",
    );

    assertOwnership();
    options.openSignal?.throwIfAborted();
    if (options.requireExistingAuthority) { existingMetadata(); existingStores(); }
    if (options.requireExistingAuthority) {
      journal = new CommandJournal(resolve(root, 'commands.sqlite'), binding, true);
      existingMetadata(); existingStores();
    }
    pglite = new PGlite(resolve(root, "pglite"));
    database = new Kysely({ dialect: new PGliteDialect(pglite) });

    module = await new reactor.ReactorClientBuilder()
      .withReactorBuilder(
        new reactor.ReactorBuilder()
          .withKysely(database)
          .withDocumentModels([...modules, drive.driveDocumentModelModule]),
      )
      .buildModule();

    let meta: { binding: string; driveId: string };
    if (options.requireExistingAuthority) {
      meta = existingMetadata();
      existingStores();
      const existingDrive = await module.client.get(meta.driveId);
      assert(existingDrive?.header?.id === meta.driveId && existingDrive.header.documentType === 'powerhouse/document-drive',
        'existing_authority_drive_unavailable');
      existingMetadata(); existingStores();
    } else if (existsSync(metaPath)) {
      meta = JSON.parse(readFileSync(metaPath, "utf8"));
      assert(meta.binding === binding, "Authority scope mismatch");
    } else {
      const d = await module.client.drives.create({ global: { name: "Kapelle framework" } });
      meta = { binding, driveId: d.header.id };
      writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600, flag: "wx" });
    }
    const backend = new NativeBackend(
      `kapelle-framework:${binding.slice(7)}`,
      reactor.DriveCollectionId.forDrive(meta.driveId).key,
      meta.driveId,
      withVersionedSnapshot(
        module.reactorModule.database,
        new reactor.KyselyScopedAuthorityStore(module.reactorModule.database),
      ),
      {
        executeScopedAuthority: module.client.executeScopedAuthority.bind(module.client),
        drives: {
          addFile: (driveId, document) =>
            document.state.document.version === 1
              ? module.client.drives.addFile(driveId, document)
              : addVersionedFile(module.client, drive.addFile, driveId, document),
        },
      },
      reactor.digestScopedAuthorityActions,
      async () => {
        if (options.requireExistingAuthority) {
          existingMetadata(); existingStores();
          const currentDrive = await module.client.get(meta.driveId);
          assert(currentDrive?.header?.id === meta.driveId && currentDrive.header.documentType === 'powerhouse/document-drive',
            'existing_authority_drive_unavailable');
          existingMetadata(); existingStores();
        }
        return pilotAllocationReader(module.reactorModule.database, `kapelle-framework:${binding.slice(7)}`,
          reactor.DriveCollectionId.forDrive(meta.driveId).key, assertOwnership)();
      },
    );
    if (!journal) journal = new CommandJournal(resolve(root, "commands.sqlite"), binding);
    const authority = new FrameworkAuthority(backend, journal, options);

    assertOwnership();
    options.openSignal?.throwIfAborted();
    if (options.requireExistingAuthority) { existingMetadata(); existingStores(); }
    return { authority, close: stop, assertOwnership };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
