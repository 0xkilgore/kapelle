import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createZip, type PHDocument } from "document-model";
import type {
  DispatchAgentRef,
  DispatchOffer,
  DispatchState,
} from "../document-models/dispatch/v1/index.js";
import { canonical, digest, releaseHash, type ModelType } from "../src/command-boundary.js";
import { assert } from "../src/validation.js";
import { dispatchOfferHash, instructionsHash } from "../src/dispatch/contracts.js";
import { PublicationFactsAdapter } from "../src/publication/facts.js";
import {
  publicationManifest,
  publicationProposal,
  bytesHash,
  type PublicationManifest,
} from "../src/publication/manifest.js";
import {
  PublicationCoordinator,
  publicationEffectFacts,
  publicationDelivery,
  websiteEffectPolicy,
} from "../src/publication/effects.js";
import { publicationReviewPlan } from "../src/publication/provision.js";
import { openFrameworkRuntime } from "../src/service/runtime.js";
import { policy } from "./fixtures.js";
import {
  publicationFixture,
  SyntheticDispatch,
  SyntheticProvider,
} from "./publication-fixtures.js";
import { nativePlatformFixture } from "./native-platform-fixture.js";

const reactorRoot = process.env.KAPELLE_SCOPED_REACTOR_ROOT,
  platformRoot = process.env.KAPELLE_PLATFORM_MODELS_ROOT;
describe.skipIf(!reactorRoot || !platformRoot)(
  "Existing native Task/Report → agent Dispatch → publication trace",
  () => {
    it.each([
      { requester: "owner", fault: "none" },
      { requester: "standing-agent", fault: "none" },
      { requester: "owner", fault: "parent-cancelled-after-reservation" },
      { requester: "owner", fault: "sender-revoked-after-claim" },
      { requester: "owner", fault: "request-changes" },
    ])(
      "reconstructs $requester work with $fault, without inherited approval or implicit Task completion",
      async ({ requester, fault }) => {
        const platform = await nativePlatformFixture(platformRoot!);
        const root = mkdtempSync(join(tmpdir(), "kapelle-native-trace-")),
          f = publicationFixture();
        const dispatch = new SyntheticDispatch(join(root, "synthetic-manager.sqlite")),
          provider = new SyntheticProvider(f);
        let runtime: Awaited<ReturnType<typeof openFrameworkRuntime>> | undefined;
        let manifest: PublicationManifest | undefined, adapter: PublicationFactsAdapter | undefined;
        let reviewId = "unprovisioned",
          domainId = "unprovisioned",
          resultFact: any;
        const ctx = f.ctx,
          r = ctx.definitions[0].release;
        r.capabilities = [
          {
            id: "dispatch",
            resourceType: "agent-dispatch",
            actions: ["dispatch", "receive"],
            requirement: "OPTIONAL",
            outputTypes: ["report"],
          },
          {
            id: "task",
            resourceType: "task",
            actions: ["read"],
            requirement: "OPTIONAL",
            outputTypes: ["report"],
          },
          {
            id: "website",
            resourceType: "website",
            actions: ["read", "publish"],
            requirement: "OPTIONAL",
            outputTypes: ["report"],
          },
        ];
        r.documentModels = [
          { documentType: "kapelle/dispatch", version: 1 },
          { documentType: "kapelle/review-intent", version: 2 },
        ];
        r.contentHash = releaseHash(r);
        const permissions = ["inbox:coordinator", "inbox:domain"].map((id) => ({
          id,
          resourceType: "agent-dispatch",
          revision: 1,
          contentHash: digest(id),
          allowedActions: ["dispatch", "receive"],
        }));
        const options = {
          stateRoot: join(root, "framework"),
          reactorRoot: reactorRoot!,
          ownerId: "owner",
          scopeRef: ctx.scopeRef,
          now: () => f.state.now,
          effectPolicy: async (...args: Parameters<ReturnType<typeof websiteEffectPolicy>>) => {
            assert(manifest && runtime, "No concrete publication binding");
            await websiteEffectPolicy(manifest, domainId, runtime.authority.backend)(...args);
          },
          facts: async () => {
            const task = await platform.task(),
              { document: _, ...taskFact } = task;
            const source = {
              documentRef: task.taskRef,
              documentType: "kilgore/task",
              contentVersion: 1,
              contentHash: task.commitmentHash,
              ownerId: task.ownerId,
              scopeRef: task.scopeRef,
            };
            const base = {
              ...ctx,
              effects: [],
              deliveryReceipts: [],
              artifacts: [],
              resources: [
                ...permissions,
                {
                  id: task.taskRef,
                  resourceType: "task",
                  revision: 1,
                  contentHash: task.commitmentHash,
                  allowedActions: ["read"],
                },
                ...(!adapter
                  ? [
                      {
                        id: f.m.target.bindingRef,
                        resourceType: "website",
                        revision: 1,
                        contentHash: digest(f.m.target),
                        allowedActions: ["read", "publish"],
                      },
                    ]
                  : []),
              ],
              dispatch: {
                tasks: [taskFact],
                sources: [source],
                agents: [],
                parents: [],
                results: resultFact ? [resultFact] : [],
              },
            };
            return adapter
              ? publicationEffectFacts(base, adapter, reviewId, domainId, dispatch, provider)
              : base;
          },
        };
        try {
          runtime = await openFrameworkRuntime(options);
          let n = 0;
          const allocate = async (type: ModelType, version = 1) =>
            (
              await runtime!.authority.allocate(
                `allocate-${n++}`,
                type,
                "Synthetic complete native trace",
                version,
              )
            ).documentId;
          async function command(
            id: string,
            type: ModelType,
            action: string,
            input: Record<string, unknown>,
            actor = "owner",
          ) {
            const d = await runtime!.authority.read(id, type);
            const request = {
              operationId: `trace-operation-${n++}`,
              documentId: id,
              documentType: type,
              expectedRevision: d.state.global.revision,
              type: action,
              input,
            };
            const receipt =
              actor === "owner"
                ? await runtime!.authority.command(request)
                : await runtime!.authority.dispatchCommand(request, actor);
            expect(receipt.result.disposition, JSON.stringify(receipt.result)).toBe("ACCEPTED");
            return receipt;
          }
          const definitionId = await allocate("kapelle/agent-definition");
          await command(definitionId, "kapelle/agent-definition", "PUBLISH_DEFINITION", {
            release: r,
          });
          async function install(): Promise<DispatchAgentRef> {
            const id = await allocate("kapelle/agent-instance");
            await command(id, "kapelle/agent-instance", "CREATE_INSTANCE", {
              instanceId: id,
              scopeRef: ctx.scopeRef,
              definitionRef: {
                id: r.definitionId,
                version: r.packageVersion,
                contentHash: r.contentHash,
              },
              name: "Synthetic scoped worker",
              responsibilities: ["Reconstruct native dispatch and act within current grants"],
              operatingPolicy: "No inherited approval",
              modelPolicy: policy,
            });
            await command(id, "kapelle/agent-instance", "SET_RUNTIME_BINDING", {
              runtimeBindingRef: "local-adapter",
            });
            for (const resourceRef of [
              ...permissions.map((p) => p.id),
              platform.taskId,
              f.m.target.bindingRef,
            ])
              await command(id, "kapelle/agent-instance", "GRANT_CAPABILITY", {
                grant: {
                  id: "grant:" + resourceRef,
                  principalId: id,
                  resourceRef,
                  actions:
                    resourceRef === platform.taskId
                      ? ["read"]
                      : resourceRef === f.m.target.bindingRef
                        ? ["read", "publish"]
                        : ["dispatch", "receive"],
                  expiresAt: f.m.expiresAt,
                  reviewPolicy: "ALWAYS",
                },
              });
            await command(id, "kapelle/agent-instance", "REQUEST_RESUME", {});
            return {
              instanceId: id,
              definitionId: r.definitionId,
              definitionVersion: r.packageVersion,
              definitionHash: r.contentHash,
            };
          }
          const initiator = await install(),
            coordinator = await install(),
            domain = await install();
          domainId = domain.instanceId;
          const task = await platform.task();
          const originalRequester = requester === "owner" ? "owner" : initiator.instanceId;
          function offer(input: Partial<DispatchOffer>): DispatchOffer {
            const p: DispatchOffer = {
              scopeRef: ctx.scopeRef,
              contentHash: "",
              task: {
                authorityRef: task.authorityRef,
                taskRef: task.taskRef,
                commitmentHash: task.commitmentHash,
              },
              originalRequesterId: originalRequester,
              senderId: originalRequester,
              senderAgent: requester === "owner" ? null : initiator,
              recipient: coordinator,
              parentDispatchRef: null,
              parentContentHash: null,
              continuationOfRef: null,
              instructions:
                "Coordinate the publication request. A child result does not complete this Task.",
              instructionsHash: "",
              sources: [
                {
                  documentRef: task.taskRef,
                  documentType: "kilgore/task",
                  contentVersion: 1,
                  contentHash: task.commitmentHash,
                },
              ],
              permissionRef: "inbox:coordinator",
              expiresAt: f.m.expiresAt,
              ...input,
            };
            p.instructionsHash = instructionsHash(p.instructions);
            p.contentHash = dispatchOfferHash(p);
            return p;
          }
          const parentOffer = offer({}),
            parentId = await allocate("kapelle/dispatch");
          await command(
            parentId,
            "kapelle/dispatch",
            "CREATE_DISPATCH",
            { dispatchId: parentId, ownerId: "owner", offer: parentOffer },
            originalRequester,
          );
          await command(
            parentId,
            "kapelle/dispatch",
            "ACCEPT_DISPATCH",
            { inputHash: parentOffer.contentHash },
            coordinator.instanceId,
          );
          const childOffer = offer({
            senderId: coordinator.instanceId,
            senderAgent: coordinator,
            recipient: domain,
            permissionRef: "inbox:domain",
            parentDispatchRef: parentId,
            parentContentHash: parentOffer.contentHash,
            instructions:
              "Prepare exact publication content for owner review, publish only after a separate approval, and return the original verified result.",
          });
          const childId = await allocate("kapelle/dispatch");
          await command(
            childId,
            "kapelle/dispatch",
            "CREATE_DISPATCH",
            { dispatchId: childId, ownerId: "owner", offer: childOffer },
            coordinator.instanceId,
          );
          await command(
            childId,
            "kapelle/dispatch",
            "ACCEPT_DISPATCH",
            { inputHash: childOffer.contentHash },
            domainId,
          );
          await runtime.close();
          runtime = await openFrameworkRuntime(options);
          const cold = await runtime.authority.dispatchBundle(childId, domainId),
            savedTask = await platform.coldRead(task.taskRef);
          expect(cold.instructions).toBe(childOffer.instructions);
          expect(cold.originalRequesterId).toBe(originalRequester);
          expect(cold.parents[0].dispatchId).toBe(parentId);
          expect((savedTask.state as any).global.createdBy).toBe("owner");
          const reportId = await platform.report(
            f.state.reportBytes.toString(),
            "dispatch:" + childId,
            domainId,
          );
          const report = (await platform.read(reportId)).state as any;
          manifest = publicationManifest({
            ...f.m,
            originDispatch: { documentId: childId, contentHash: childOffer.contentHash },
            report: {
              id: reportId,
              reportRef: report.global.reportRef,
              sourceRef: report.global.sourceRef,
              contentHash: bytesHash(report.global.content.markdown),
              bytes: Buffer.byteLength(report.global.content.markdown),
            },
            task: {
              managerTaskRef: "manager-task:synthetic-existing",
              authorityRef: task.authorityRef,
              authorityTaskRef: task.taskRef,
              commitmentHash: task.commitmentHash,
            },
          });
          const makeAdapter = (bound: PublicationManifest) =>
            new PublicationFactsAdapter(
              bound,
              {
                report: async (id) => {
                  const d = await platform.read(id),
                    s = (d.state as any).global;
                  return {
                    id: d.header.id,
                    ownerId: "owner",
                    scopeRef: ctx.scopeRef,
                    reportRef: s.reportRef,
                    sourceRef: s.sourceRef,
                    bytes: Buffer.from(s.content.markdown),
                    revision: s.revision,
                  };
                },
                task: async () => {
                  const t = await platform.task();
                  return {
                    ...bound.task,
                    ownerId: t.ownerId,
                    scopeRef: t.scopeRef,
                    commitmentHash: t.commitmentHash,
                  };
                },
                source: async (source) =>
                  assert(
                    canonical(source) === canonical(f.m.source) && !f.state.sourceError,
                    "Synthetic source changed",
                  ),
                build: async () => f.state.build,
                target: async () => f.state.target,
              },
              () => f.state.now,
            );
          adapter = makeAdapter(manifest);
          const plan = publicationReviewPlan(manifest),
            a = plan.allocation;
          reviewId = (await runtime.authority.allocate(a.operationId, a.documentType, a.name, 2))
            .documentId;
          expect(
            (await runtime.authority.command(plan.createReview(reviewId, domainId))).result
              .disposition,
          ).toBe("ACCEPTED");
          const executor = () =>
            new PublicationCoordinator(runtime!.authority, manifest!, domainId, dispatch, provider);
          await expect(executor().run(reviewId)).rejects.toThrow(/approval/);
          const decision = {
            proposalHash: publicationProposal(manifest).contentHash,
            proposalVersion: 1,
            approved: true,
            reason: null,
          };
          await expect(
            command(
              reviewId,
              "kapelle/review-intent",
              "RECORD_DECISION",
              decision,
              coordinator.instanceId,
            ),
          ).rejects.toThrow(/owner/);
          expect(provider.calls).toBe(0);
          expect(dispatch.all()).toHaveLength(0);
          await platform.act(reportId, "markRead", { expectedRevision: 2 }, "owner");
          if (fault === "request-changes") {
            await command(reviewId, "kapelle/review-intent", "RECORD_DECISION", {
              ...decision,
              approved: false,
              reason: "Revise the requested publication content",
            });
            const continuationOffer = offer({
              parentDispatchRef: childId,
              parentContentHash: childOffer.contentHash,
              continuationOfRef: childId,
              senderId: domainId,
              senderAgent: domain,
              recipient: coordinator,
              instructions:
                "Owner requested changes; return revised source content for a new proposal and owner decision.",
            });
            const nextId = await allocate("kapelle/dispatch");
            await command(
              nextId,
              "kapelle/dispatch",
              "CREATE_DISPATCH",
              {
                dispatchId: nextId,
                ownerId: "owner",
                offer: continuationOffer,
              },
              domainId,
            );
            await command(
              nextId,
              "kapelle/dispatch",
              "ACCEPT_DISPATCH",
              { inputHash: continuationOffer.contentHash },
              coordinator.instanceId,
            );
            const nextReportId = await platform.report(
              "Revised synthetic content requires a separate owner decision.",
              "dispatch:" + nextId,
              coordinator.instanceId,
            );
            const nextReport = ((await platform.read(nextReportId)).state as any).global;
            const nextManifest = publicationManifest({
              ...manifest,
              originDispatch: { documentId: nextId, contentHash: continuationOffer.contentHash },
              report: {
                id: nextReportId,
                reportRef: nextReport.reportRef,
                sourceRef: nextReport.sourceRef,
                contentHash: bytesHash(nextReport.content.markdown),
                bytes: Buffer.byteLength(nextReport.content.markdown),
              },
            });
            expect(publicationProposal(nextManifest).contentHash).not.toBe(decision.proposalHash);
            await expect(executor().run(reviewId)).rejects.toThrow(/approval/);
            expect(
              (
                (await runtime.authority.dispatchBundle(nextId, coordinator.instanceId)).document
                  .state.global as DispatchState
              ).offer?.continuationOfRef,
            ).toBe(childId);
            expect(
              (
                (await runtime.authority.read(childId, "kapelle/dispatch")).state
                  .global as DispatchState
              ).offer?.instructions,
            ).toBe(childOffer.instructions);
            expect(((await platform.coldRead(reportId)).state as any).global.content.markdown).toBe(
              f.state.reportBytes.toString(),
            );
            const rejectedReviewId = reviewId;
            manifest = nextManifest;
            adapter = makeAdapter(manifest);
            domainId = coordinator.instanceId;
            const nextPlan = publicationReviewPlan(manifest);
            reviewId = (
              await runtime.authority.allocate(
                nextPlan.allocation.operationId,
                nextPlan.allocation.documentType,
                nextPlan.allocation.name,
                2,
              )
            ).documentId;
            expect(
              (await runtime.authority.command(nextPlan.createReview(reviewId, domainId))).result
                .disposition,
            ).toBe("ACCEPTED");
            expect(
              (
                (await runtime.authority.read(reviewId, "kapelle/review-intent")).state
                  .global as any
              ).decision,
            ).toBe(null);
            expect(
              (
                (await runtime.authority.read(rejectedReviewId, "kapelle/review-intent")).state
                  .global as any
              ).status,
            ).toBe("REJECTED");
            await expect(executor().run(reviewId)).rejects.toThrow(/approval/);
            expect(provider.calls).toBe(0);
            expect(dispatch.all()).toHaveLength(0);
            expect((await platform.task()).status).toBe("OPEN");
            return;
          }
          await command(reviewId, "kapelle/review-intent", "RECORD_DECISION", decision);
          if (fault !== "none") {
            // Inject a real native mutation between separate authority calls, never inside its command lock.
            const claim = runtime.authority.claimPublicationInvocation.bind(runtime.authority);
            runtime.authority.claimPublicationInvocation = async (...args) => {
              if (fault === "parent-cancelled-after-reservation") {
                await command(parentId, "kapelle/dispatch", "REQUEST_DISPATCH_CANCEL", {
                  reason: "Stop delegation before invocation",
                });
                return claim(...args);
              }
              const right = await claim(...args);
              await command(coordinator.instanceId, "kapelle/agent-instance", "REVOKE_CAPABILITY", {
                grantId: "grant:inbox:domain",
              });
              return right;
            };
            await expect(executor().run(reviewId)).rejects.toThrow(/cancelled|revoked/);
            expect(provider.calls).toBe(0);
            const blocked = (await runtime.authority.read(reviewId, "kapelle/review-intent")).state
              .global as any;
            expect(blocked.effect).not.toBe(null);
            expect(Boolean(blocked.execution)).toBe(fault === "sender-revoked-after-claim");
            expect((await platform.task()).status).toBe("OPEN");
            return;
          }
          expect(await executor().run(reviewId)).toEqual({ status: "DELIVERED" });
          expect(provider.calls).toBe(1);
          const review = await runtime.authority.read(reviewId, "kapelle/review-intent"),
            state = review.state.global as any;
          expect(state.decision.actorId).toBe("owner");
          expect(state.execution.executorId).toBe(domainId);
          expect(
            review.operations.global.filter((o) => o.action.type === "CLAIM_EXECUTION" && !o.error),
          ).toHaveLength(1);
          const evidence = await publicationDelivery(dispatch.all()[0], manifest, provider);
          const originalOutput = "Synthetic published result. Verification: " + evidence.id;
          const resultId = await platform.report(originalOutput, "dispatch:" + childId, domainId);
          resultFact = {
            dispatchId: childId,
            inputHash: childOffer.contentHash,
            reportId: resultId,
            contentVersion: 1,
            contentHash: bytesHash(originalOutput),
            verificationRef: evidence.id,
          };
          const { dispatchId: _, ...resultInput } = resultFact;
          await command(
            childId,
            "kapelle/dispatch",
            "RECORD_DISPATCH_RESULT",
            resultInput,
            domainId,
          );
          const original = await platform.coldRead(resultId);
          expect((original.state as any).global.content.markdown).toBe(originalOutput);
          expect((await platform.task()).status).toBe("OPEN");
          expect(
            (
              (await runtime.authority.read(parentId, "kapelle/dispatch")).state
                .global as DispatchState
            ).phase,
          ).toBe("ACCEPTED");
          await runtime.close();
          runtime = await openFrameworkRuntime(options);
          expect(await executor().run(reviewId)).toEqual({ status: "DELIVERED" });
          expect(provider.calls).toBe(1);
          await platform.act(
            task.taskRef,
            "completeTask",
            { resolution: "Owner separately verified the linked original result." },
            "owner",
          );
          expect((await platform.task()).status).toBe("DONE");
          const output = process.env.KAPELLE_NATIVE_TRACE_OUTPUT;
          if (output) {
            const evidenceDir = join(output, requester);
            mkdirSync(evidenceDir, { recursive: true });
            const retained: Record<string, PHDocument> = {
              "original-task": savedTask,
              "completed-task": (await platform.task()).document,
              "proposal-report": await platform.read(reportId),
              "original-result-report": original,
            };
            for (const [name, id, type] of [
              ["definition", definitionId, "kapelle/agent-definition"],
              ["initiator", initiator.instanceId, "kapelle/agent-instance"],
              ["coordinator", coordinator.instanceId, "kapelle/agent-instance"],
              ["domain", domainId, "kapelle/agent-instance"],
              ["parent-dispatch", parentId, "kapelle/dispatch"],
              ["child-dispatch", childId, "kapelle/dispatch"],
              ["publication-review", reviewId, "kapelle/review-intent"],
            ])
              retained[name] = await runtime.authority.read(id, type as ModelType);
            const records = [];
            for (const [name, doc] of Object.entries(retained)) {
              writeFileSync(join(evidenceDir, name + ".zip"), Buffer.from(await createZip(doc)));
              records.push({
                name,
                id: doc.header.id,
                documentType: doc.header.documentType,
                version: doc.state.document.version,
                operations: doc.operations.global.map((o) => ({
                  id: o.action.id,
                  type: o.action.type,
                  index: o.index,
                  error: o.error ?? null,
                })),
              });
            }
            writeFileSync(
              join(evidenceDir, "trace.json"),
              JSON.stringify(
                {
                  synthetic: true,
                  productionGatewayQualified: false,
                  requester,
                  originalRequester,
                  actualPlatformSchemaHashes: platform.hashes,
                  records,
                  manifest,
                  managerQueue: { nativeModel: false, entries: dispatch.all() },
                  provider: { fake: true, calls: provider.calls, evidence },
                  separateTaskCompletion: true,
                },
                null,
                2,
              ) + "\n",
            );
          }
        } finally {
          await runtime?.close();
          dispatch.close();
          await platform.close();
          rmSync(root, { recursive: true, force: true });
        }
      },
      30000,
    );
  },
);
