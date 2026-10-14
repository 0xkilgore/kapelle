import {managerQualificationAdapter} from './manager-qualification-adapter.js';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import {
  ManagerPublicationStore,
  type ManagerQueue,
} from "../src/publication/manager-transport.js";
import type { PublicationManifest } from "../src/publication/manifest.js";

/** Actual Manager reactor/migrations and byte-identical installed compiled SqliteAdapter.
 * Optional isolated qualification dependency must pass explicit hash/version/ABI preflight.
 * No fallback driver: absent/incompatible native module fails qualification.
 * Only isolated storage is opened; the deployed Manager entrypoint is not loaded. */
export async function managerPublicationFixture(
  root: string,
  manifest: PublicationManifest,
  reviewId = "review",
  instanceId = "publisher",
  admit: () => Promise<void> = async () => {},
  retainedDirectory?: string,
) {
  const adapterIdentity = managerQualificationAdapter(root);
  const dir = retainedDirectory ?? mkdtempSync(join(tmpdir(), "manager-publication-"));
  mkdirSync(dir, {recursive:true,mode:0o700});
  const output = join(dir, "manager.mjs");
  await build({
    stdin: {
      contents: `export {SqliteDispatchReactor} from ${JSON.stringify(join(root, "src/dispatch-scheduler/sqlite-dispatch-reactor.ts"))}; export {migrateSqlite} from ${JSON.stringify(join(root, "src/db/migrations/sqlite.ts"))};`,
      resolveDir: root,
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "typescript",
        setup(b) {
          b.onLoad({ filter: /\.ts$/ }, ({ path }) => ({
            contents: ts.transpileModule(readFileSync(path, "utf8"), {
              fileName: path,
              compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
            }).outputText,
            loader: "js",
          }));
        },
      },
    ],
  });
  const loaded = await import(/* @vite-ignore */ pathToFileURL(output).href);
  const {adapterPath} = adapterIdentity;
  const { SqliteAdapter } = await import(/* @vite-ignore */ pathToFileURL(adapterPath).href);
  const driverIdentity = { ...adapterIdentity,
    node: process.version, modulesAbi: process.versions.modules };
  let db = new SqliteAdapter(join(dir, "queue.sqlite"));
  const database = {
    dialect: "sqlite",
    exec: (sql: string) => db.exec(sql),
    query: <T>(sql: string, params: unknown[] = []) => db.query(sql, params) as Promise<{rows:T[];rowCount:number}>,
  };
  await loaded.migrateSqlite(database);
  database.exec(
    "INSERT OR IGNORE INTO teams(id,name) VALUES ('synthetic-team','synthetic'); UPDATE dispatch_operation_outbox_control SET shadow_enabled=1",
  );
  let queue = new loaded.SqliteDispatchReactor({
    adapter: database,
    teamId: "synthetic-team",
    now: () => "2026-09-11T10:00:00.000Z",
  });
  const config = {
    teamId: "synthetic-team",
    ownerId: manifest.ownerId,
    scopeRef: manifest.scopeRef,
    manifest,
    reviewId,
    instanceId,
    executorAgent: "publication-executor",
    admit,
    database,
  };
  let store = new ManagerPublicationStore({ ...config, queue });
  return {
    driverIdentity,
    database,
    get queue(): ManagerQueue & { claim: (input: unknown) => Promise<any> } {
      return queue;
    },
    get store() {
      return store;
    },
    async restart() {
      db.close();
      db = new SqliteAdapter(join(dir, "queue.sqlite"));
      queue = new loaded.SqliteDispatchReactor({
        adapter: database,
        teamId: config.teamId,
        now: () => "2026-09-11T10:00:00.000Z",
      });
      store = new ManagerPublicationStore({ ...config, queue });
    },
    close() {
      db.close();
      if (!retainedDirectory) rmSync(dir, { recursive: true, force: true });
    },
  };
}
