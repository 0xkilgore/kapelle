import { describe, it, expect } from "vitest";
import { ReactorBuilder, ReactorClientBuilder } from "@powerhousedao/reactor";
import { createZip } from "document-model";
import { documentModels } from "../document-models/document-models.js";
import { prepareCommand, type NativeDocument } from "../src/command-boundary.js";
import {
  D,
  I,
  R,
  command,
  context,
  release,
  installed,
  ready,
  approved,
  reserve,
} from "./fixtures.js";

describe("Native Powerhouse 6.2.1 qualification", () => {
  it("registers all three generated modules, executes commands, and reads retained native operations in an isolated Reactor", async () => {
    const module = await new ReactorClientBuilder()
      .withReactorBuilder(new ReactorBuilder().withDocumentModels([...documentModels]))
      .buildModule();
    try {
      const ctx = context();
      const inputs = [
        { model: D.AgentDefinition, type: "PUBLISH_DEFINITION", input: { release: release() } },
        {
          model: I.AgentInstance,
          type: "CREATE_INSTANCE",
          input: installed().operations.global[0].action.input,
        },
        {
          model: R.ReviewIntent,
          type: "CREATE_REVIEW",
          input: approved({ ...ctx, instance: ready().state.global }).operations.global[0].action
            .input,
        },
      ];
      for (const item of inputs) {
        const registered = await module.client.getDocumentModelModule(
          item.model.documentModel.global.id,
        );
        expect(registered.version).toBe(1);
        // Explicitly exercise retained v1 documents; createEmpty defaults to latest.
        const doc = await module.client.create<NativeDocument>(item.model.utils.createDocument());
        const {
          actorId: _,
          occurredAt: __,
          expectedRevision: ___,
          ...input
        } = item.input as Record<string, unknown>;
        if (item.type === "CREATE_INSTANCE") input.instanceId = doc.header.id;
        if (item.type === "CREATE_REVIEW") input.reviewId = doc.header.id;
        const c = command(doc, item.type, input);
        const prepared = prepareCommand(c, doc, { ...ctx, instance: ready().state.global });
        const next = await module.client.execute<NativeDocument>(doc.header.id, "main", [
          prepared.action,
        ]);
        expect(next.state.global.revision).toBe(1);
        expect(next.state.global.ownerId).toBe("owner");
        const read = await module.client.get<NativeDocument>(doc.header.id);
        expect(read.state.global).toEqual(next.state.global);
        const ops = await module.client.getOperations(doc.header.id);
        expect(JSON.stringify(ops)).toContain(prepared.action.id);
      }
    } finally {
      await module.reactor.kill().completed;
    }
  }, 30000);
  it("exports native ZIPs and restores state plus operation identity with the generated versioned loaders", async () => {
    const ctx = { ...context(), instance: ready().state.global };
    const definitionDoc = D.reducer(
      D.utils.createDocument(),
      D.publishDefinition({
        actorId: "owner",
        occurredAt: ctx.occurredAt,
        expectedRevision: 0,
        release: release(),
      }),
    );
    const items = [
      { doc: definitionDoc, load: D.utils.loadFromInput },
      { doc: ready(), load: I.utils.loadFromInput },
      { doc: reserve(approved(ctx), ctx), load: R.utils.loadFromInput },
    ];
    for (const item of items) {
      const zip = await createZip(item.doc);
      const restored = await item.load(zip);
      expect(restored.header.id).toBe(item.doc.header.id);
      expect(restored.state.global).toEqual(item.doc.state.global);
      expect(restored.operations.global.map((o) => o.action.id)).toEqual(
        item.doc.operations.global.map((o) => o.action.id),
      );
    }
  });
});
