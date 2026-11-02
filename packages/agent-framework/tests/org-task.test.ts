// Lean runtime step 4, Fable Task ruling: the lifted kilgore/task model inside the org authority. Version + reducer
// digest pinned; only adopt/update-body/note/status admitted; adopt needs the runtime passkey Authorization bound to the
// exact command; Task ids are authority-minted and never intake ids; identical receipts and state on Reactor and SQLite.
import { describe, it, expect } from "vitest";
import { mkdtempSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openFrameworkRuntime } from "../src/service/runtime.js";
import { digest } from "../src/command-boundary.js";
import { ORG_TASK_REDUCER_DIGEST, orgTaskReducerDigest, adoptBody, type OrgAuthorization } from "../src/org/task-model.js";
import { context } from "./fixtures.js";

const enabled = !!process.env.KAPELLE_SCOPED_REACTOR_ROOT && !!process.env.KAPELLE_PLATFORM_MODELS_ROOT;
const ctx = context();
const dir = (p: string) => { const d = realpathSync(mkdtempSync(join(tmpdir(), p))); chmodSync(d, 0o700); return d; };
const MEMBER = "m-11111111-1111-4111-8111-111111111111", PRINCIPAL = `member:org-a:${MEMBER}:v0`;
const INTAKE = "intake_AAAAAAAAAAAAAAAAAAAAAAAA";

it("the lifted kilgore/task reducer is pinned (no silent drift)", () => {
  expect(orgTaskReducerDigest()).toBe(ORG_TASK_REDUCER_DIGEST);
});

describe.skipIf(!enabled)("org Tasks in the org authority (step 4)", () => {
  async function run(backend: "reactor" | "sqlite") {
    const rt = await openFrameworkRuntime({ stateRoot: dir(`orgtask-${backend}-`), reactorRoot: process.env.KAPELLE_SCOPED_REACTOR_ROOT!, ownerId: "owner",
      scopeRef: "synthetic-league", facts: async () => ({ ...ctx }), now: () => ctx.occurredAt, backend } as never);
    const out: unknown[] = [];
    try {
      const a = rt.authority;
      const { documentId: id } = await a.allocate("org-task-alloc-1", "kilgore/task", "Draft the Oct 8 minutes");
      const rev = async () => (await a.backend.read(id, "kilgore/task")).nativeRevision;
      const create = (input: Record<string, unknown>, op: string) => ({ operationId: op, documentId: id, documentType: "kilgore/task", expectedRevision: 0, type: "CREATE_TASK", input });
      const input = { id, title: "Draft the Oct 8 minutes", bodyMarkdown: "From intake", ownerId: "owner", source: "HUMAN", sourceRef: `intake:${INTAKE}` };
      const z = (over: Partial<OrgAuthorization> = {}, i = input, op = "adopt-op-0001"): OrgAuthorization => ({ memberId: MEMBER, action: "task.adopt", bodyHash: digest(adoptBody(i)), operationId: op, ...over });
      const refuse = async (p: Promise<unknown>, reason: string) => out.push({ refused: reason, got: await p.then(() => "ACCEPTED", (e: Error) => e.message) });
      await refuse(a.orgTaskCommand(create(input, "adopt-op-0001"), PRINCIPAL), "no authorization");
      await refuse(a.orgTaskCommand(create(input, "adopt-op-0001"), PRINCIPAL, z({ bodyHash: digest({ other: 1 }) })), "body mismatch");
      await refuse(a.orgTaskCommand(create(input, "adopt-op-0001"), PRINCIPAL, z({ operationId: "other-op-0001" })), "operation mismatch");
      await refuse(a.orgTaskCommand(create(input, "adopt-op-0001"), PRINCIPAL, z({ action: "proposal.approve" })), "wrong action");
      await refuse(a.orgTaskCommand(create(input, "adopt-op-0001"), `member:org-a:m-22222222-2222-4222-8222-222222222222:v0`, z()), "other member");
      await refuse(a.command(create(input, "adopt-op-0001")), "owner principal");
      const intakeId = { ...input, id: INTAKE };
      await refuse(a.orgTaskCommand(create(intakeId, "adopt-op-0002"), PRINCIPAL, z({}, intakeId, "adopt-op-0002")), "intake id as task id");
      const noRef = { ...input, sourceRef: "manual" };
      await refuse(a.orgTaskCommand(create(noRef, "adopt-op-0003"), PRINCIPAL, z({}, noRef, "adopt-op-0003")), "no intake ref");
      const created = await a.orgTaskCommand(create(input, "adopt-op-0004"), PRINCIPAL, z({}, input, "adopt-op-0004"));
      out.push({ created: created.result });
      const next = (type: string, inp: Record<string, unknown>, op: string) => (async () => a.orgTaskCommand({ operationId: op, documentId: id, documentType: "kilgore/task", expectedRevision: await rev(), type, input: inp }, PRINCIPAL))();
      out.push({ body: (await next("UPDATE_BODY", { bodyMarkdown: "Edited" }, "body-op-0001")).result });
      out.push({ note: (await next("ADD_COMMENT", { id: "note-1", bodyMarkdown: "Robin: check the flyer time" }, "note-op-0001")).result });
      await refuse(next("SET_PRIORITY", { priority: "HIGH" }, "prio-op-0001"), "not admitted");
      await refuse(next("ADD_DEPENDENCY", { taskId: id }, "dep-op-0001"), "not admitted 2");
      out.push({ done: (await next("COMPLETE_TASK", { resolution: "Notes published" }, "done-op-0001")).result });
      const d = await a.backend.read(id, "kilgore/task");
      const s = d.document.state.global as Record<string, unknown>;
      out.push({ state: { title: s.title, status: s.status, body: s.bodyMarkdown, ownerId: s.ownerId, revision: d.nativeRevision } });
      return { out: JSON.stringify(out).split(id).join("<task>"), revision: d.nativeRevision };
    } finally { await rt.close(); }
  }
  it("adopt needs the bound passkey authorization; only admitted operations; byte-identical on Reactor and SQLite", async () => {
    const reactor = await run("reactor"), sqlite = await run("sqlite");
    expect(sqlite.out).toBe(reactor.out);
    const out = JSON.parse(sqlite.out) as { refused?: string; got?: string }[];
    for (const r of out.filter((x) => x.refused)) expect(r.got, r.refused).not.toBe("ACCEPTED");
    expect(out.find((x) => x.refused === "not admitted")!.got).toBe("org_task_operation_not_admitted");
    expect(out.find((x) => x.refused === "no authorization")!.got).toBe("org_task_adopt_requires_passkey_authorization");
    expect(out.find((x) => x.refused === "intake id as task id")!.got).toBe("org_task_id_not_authority_minted");
    expect(out.find((x) => x.refused === "owner principal")!.got).toBe("org_task_adopt_requires_passkey_authorization");
    expect(sqlite.out).toContain('"status":"DONE"');
    expect(sqlite.revision).toBe(4);
  }, 120_000);
});
