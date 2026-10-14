import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { createZip, type DocumentModelModule, type PHDocument } from "document-model";
import { assert } from "../src/validation.js";
import { digest, canonical } from "../src/content.js";
import { bytesHash } from "../src/publication/manifest.js";
import { at } from "./fixtures.js";

/** Loads the actual existing Task/Report native models into an isolated Reactor.
 * This proves model operations/export, not the production HTTP gateways. */
export async function nativePlatformFixture(platformRoot: string) {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), ".native-model-fixture-"));
  let stop = async () => {};
  try {
    const specs = [
      { name: "TaskAuthority", base: "task-authority-package/generated/task-authority/v1" },
      {
        name: "ReportRegistry",
        base: "report-registry-package/document-models/report-registry/v1",
      },
    ];
    const models: DocumentModelModule[] = [],
      hashes: Record<string, string> = {};
    for (const spec of specs) {
      const file = join(dir, spec.name + ".mjs"),
        base = join(platformRoot, spec.base);
      await build({
        entryPoints: [join(base, "module.ts")],
        outfile: file,
        bundle: true,
        platform: "node",
        format: "esm",
        external: ["document-model", "@powerhousedao/reactor-browser", "react", "zod"],
        logLevel: "silent",
        plugins: [
          {
            name: "typescript-syntax-compatibility",
            setup(build) {
              build.onLoad({ filter: /\.tsx?$/ }, ({ path }) => ({
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
      const loaded = await import(/* @vite-ignore */ pathToFileURL(file).href);
      const model = loaded[spec.name] as DocumentModelModule;
      assert(model.version === 1, "Existing native model version differs");
      models.push(model);
      hashes[spec.name] = bytesHash(readFileSync(join(base, "schema.graphql")));
    }
    const [Task, Report] = models;
    const module = await new ReactorClientBuilder()
      .withReactorBuilder(new ReactorBuilder().withDocumentModels(models))
      .buildModule();
    stop = async () => {
      await module.reactor.kill().completed;
    };
    const docs = new Map<string, DocumentModelModule>();
    async function create(model: DocumentModelModule, name: string) {
      const d = model.utils.createDocument();
      d.header.name = name;
      const stored = await module.client.create(d);
      docs.set(stored.header.id, model);
      return stored.header.id;
    }
    async function act(
      id: string,
      action: string,
      input: Record<string, unknown>,
      actorId: string,
    ) {
      const model = docs.get(id)!;
      const creator = (model.actions as unknown as Record<string, (input: unknown) => any>)[action];
      await module.client.execute(id, "main", [creator({ ...input, actorId, occurredAt: at })]);
      const d = await read(id);
      assert(
        !d.operations.global.at(-1)?.error,
        "Existing native model rejected synthetic operation",
      );
      await persist(id);
      return d;
    }
    async function persist(id: string) {
      const d = await read(id),
        zip = await createZip(d);
      writeFileSync(join(dir, id + ".zip"), Buffer.from(zip));
    }
    async function read(id: string) {
      const snapshot = await module.client.get(id);
      const model = docs.get(id)!;
      let replay = model.utils.createDocument();
      replay.header.id = id;
      const page = await module.client.getOperations(id, { scopes: ["global"] }, undefined, {
        cursor: "0",
        limit: 1000,
      });
      assert(!page.nextCursor, "Synthetic fixture exceeded bounded operation export");
      for (const op of page.results) {
        replay = model.reducer(replay, op.action);
        assert(
          (replay.operations.global.at(-1)?.error ?? null) === (op.error ?? null),
          "Native operation replay differs",
        );
      }
      assert(
        canonical((replay.state as any).global) === canonical((snapshot.state as any).global),
        "Native Task/Report replay differs from stored state",
      );
      return replay;
    }
    const taskId = await create(Task, "Synthetic publication commitment");
    await act(
      taskId,
      "createTask",
      {
        id: taskId,
        ownerId: "owner",
        source: "HUMAN",
        title: "Publish the reviewed synthetic cleanup page",
        bodyMarkdown:
          "Success requires the exact approved page, verified provider receipt, and a separate owner completion action.",
      },
      "owner",
    );
    async function task() {
      const d = await read(taskId),
        s = (d.state as any).global;
      return {
        authorityRef: "task-authority:synthetic",
        taskRef: taskId,
        ownerId: s.ownerId,
        scopeRef: "synthetic-league",
        commitmentHash: digest({
          title: s.title,
          bodyMarkdown: s.bodyMarkdown,
          ownerId: s.ownerId,
        }),
        status: s.status,
        document: d,
      };
    }
    async function report(markdown: string, sourceRef: string, producerId: string) {
      const id = await create(Report, "Synthetic retained original deliverable");
      await act(
        id,
        "registerReport",
        {
          id,
          reportRef: "report:" + id,
          title: "Synthetic publication report",
          sourceRef,
          producer: { kind: "AGENT", id: producerId },
          content: {
            storage: "INLINE_MARKDOWN",
            mimeType: "text/markdown",
            contentHash: bytesHash(markdown),
            byteSize: Buffer.byteLength(markdown),
            markdown,
          },
          lifecycle: "DRAFT",
        },
        producerId,
      );
      await act(id, "publishReport", { expectedRevision: 1 }, producerId);
      return id;
    }
    return {
      taskId,
      task,
      async createTask(title:string) {
        const id=await create(Task,title);
        await act(id,'createTask',{id,ownerId:'owner',source:'HUMAN',title,bodyMarkdown:'Synthetic supplied context'},'owner');
        return id;
      },
      report,
      read,
      act,
      hashes,
      async coldRead(id: string): Promise<PHDocument> {
        return docs
          .get(id)!
          .utils.loadFromInput(new Uint8Array(readFileSync(join(dir, id + ".zip"))));
      },
      async close() {
        await stop();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stop();
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
