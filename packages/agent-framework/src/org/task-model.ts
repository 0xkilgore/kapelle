// Lean runtime step 4 (Fable step-4 ruling): Tasks live INSIDE the org runtime as the native `kilgore/task` model,
// lifted verbatim from the owner's Task Authority (task-authority-package/generated/task-authority at the live commit
// 41f90f34; see document-models/task-authority/SOURCES.md). The model is registered behind the same command boundary,
// version-pinned with a reducer digest so step-1 export/replay parity covers Tasks.
//
// Admitted operations ONLY: create-on-adopt, update body, add a note, and status (complete / reopen / archive). Every other
// model operation is refused here. CREATE_TASK must carry a runtime (step 2) Authorization for `task.adopt`
// bound to this exact operationId and input; its id is the authority-minted document id and can never be an intake id;
// its sourceRef names the adopted intake. The personal Task Authority is never reachable from an org runtime.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Action } from "document-model";
import * as task from "../../document-models/task-authority/v1/index.js";
import { canonical, digest } from "../content.js";
import { assert } from "../validation.js";

export const ORG_TASK_TYPE = "kilgore/task" as const;
export const ORG_TASK_MODEL_VERSION = 1;
export const ORG_TASK_OPERATIONS = ["CREATE_TASK", "UPDATE_BODY", "ADD_COMMENT", "COMPLETE_TASK", "REOPEN_TASK", "ARCHIVE_TASK"] as const;
/** sha256 over the lifted reducer + generated reducer sources, in this order; checked by tests (no silent drift). */
export const ORG_TASK_REDUCER_FILES = ["src/reducers/content.ts", "src/reducers/context.ts", "src/reducers/lifecycle.ts", "src/utils.ts", "gen/reducer.ts"] as const;
export const ORG_TASK_REDUCER_DIGEST = "sha256:7bf9e804ff312aa791d338b2222d3a247b6c3a8fce3c169386b3b55ac06fe475";
export function orgTaskReducerDigest() {
  const root = fileURLToPath(new URL("../../document-models/task-authority/v1/", import.meta.url));
  const h = createHash("sha256");
  for (const f of ORG_TASK_REDUCER_FILES) h.update(f + "\0").update(readFileSync(root + f)).update("\0");
  return "sha256:" + h.digest("hex");
}
/** Intake candidates use a distinct, schema-enforced id namespace; a Task id can never be one. */
export const INTAKE_ID = /^intake_[A-Za-z0-9_-]{16,64}$/;
export type OrgAuthorization = { memberId: string; action: string; bodyHash: string; operationId: string };

const creators = { CREATE_TASK: task.createTask, UPDATE_BODY: task.updateBody, ADD_COMMENT: task.addComment,
  COMPLETE_TASK: task.completeTask, REOPEN_TASK: task.reopenTask, ARCHIVE_TASK: task.archiveTask } as const;
const schemas = { CREATE_TASK: task.CreateTaskInputSchema, UPDATE_BODY: task.UpdateBodyInputSchema, ADD_COMMENT: task.AddCommentInputSchema,
  COMPLETE_TASK: task.CompleteTaskInputSchema, REOPEN_TASK: task.ReopenTaskInputSchema, ARCHIVE_TASK: task.ArchiveTaskInputSchema } as const;

/** Transcription T-5: a Task adopted from a contiguous range of transcript parts (Fable R-5): transcript:<job>#p<first>-p<last>. */
export const TRANSCRIPT_REF = /^transcript:(tj_[a-f0-9]{32})#p([1-9][0-9]?)-p([1-9][0-9]?)$/;
/** Chat C-5 (Fable E-4): the Records Task of a chat draft envelope: chat:<conversationId>#<envelopeId>. */
export const CHAT_REF = /^chat:(conv_[a-f0-9]{32})#(env_[a-f0-9]{32})$/;
/** What a reviewer's `task.adopt` approval binds: the intake (or transcript part range) and the title (never the later-minted
 *  Task id). */
export const adoptBody = (input: Record<string, unknown>) => {
  const t = TRANSCRIPT_REF.exec(String(input.sourceRef ?? ""));
  return t ? { transcriptJobId: t[1], parts: [Number(t[2]), Number(t[3])], title: String(input.title ?? "") }
    : { intakeId: String(input.sourceRef ?? "").replace(/^intake:/, ""), title: String(input.title ?? "") };
};
/** Build the native action for an admitted org Task command. The caller has already checked document identity. */
export function prepareOrgTaskCommand(c: { operationId: string; documentId: string; expectedRevision: number; type: string; input: Record<string, unknown> },
  document: { state: { global: unknown }; operations: { global: unknown[] } },
  ctx: { principalId: string; ownerId: string; occurredAt: string; authorization?: OrgAuthorization }): Action {
  assert((ORG_TASK_OPERATIONS as readonly string[]).includes(c.type), "org_task_operation_not_admitted");
  assert(document.operations.global.length === c.expectedRevision, "Stale document revision");
  const state = document.state.global as { id?: string | null; ownerId?: string | null };
  assert(!state.ownerId || state.ownerId === ctx.ownerId, "Wrong document owner");
  if (c.type === "CREATE_TASK") {
    const z_ = ctx.authorization;
    // Chat C-5 (E-4): a draft envelope's Records Task is created under the chat.draft.approve Authorization itself (same
    // operationId, same member); the approved card names the conversation, the envelope id derives from the operationId.
    if (typeof c.input.sourceRef === "string" && CHAT_REF.test(c.input.sourceRef)) {
      assert(z_ && z_.action === "chat.draft.approve" && z_.operationId === c.operationId && ctx.principalId.startsWith("member:") && ctx.principalId.split(":")[2] === z_.memberId,
        "org_task_chat_requires_draft_authorization");
      assert(c.input.id === c.documentId && !INTAKE_ID.test(String(c.input.id)), "org_task_id_not_authority_minted");
      assert(c.input.ownerId === ctx.ownerId && c.input.source === "HUMAN", "org_task_owner_or_source");
    } else {
      // The reviewer approves "adopt THIS intake under THIS title"; the Task id is minted afterwards by the authority.
      assert(z_ && z_.action === "task.adopt" && z_.operationId === c.operationId && z_.bodyHash === digest(adoptBody(c.input)) &&
        ctx.principalId.startsWith("member:") && ctx.principalId.split(":")[2] === z_.memberId, "org_task_adopt_requires_passkey_authorization");
      assert(c.input.id === c.documentId && !INTAKE_ID.test(String(c.input.id)), "org_task_id_not_authority_minted");
      assert(typeof c.input.sourceRef === "string" && ((INTAKE_ID.test(String(c.input.sourceRef).replace(/^intake:/, "")) && String(c.input.sourceRef).startsWith("intake:"))
        || TRANSCRIPT_REF.test(c.input.sourceRef)), "org_task_adopt_requires_intake_ref");
      assert(c.input.ownerId === ctx.ownerId && c.input.source === "HUMAN", "org_task_owner_or_source");
    }
  } else assert(state.id === c.documentId, "org_task_not_created");
  const raw = { ...c.input, actorId: ctx.principalId, occurredAt: ctx.occurredAt };
  const parsed = (schemas[c.type as keyof typeof schemas] as () => z.ZodType)().parse(raw);
  assert(canonical(parsed) === canonical(raw), "Unknown or unsupported input field");
  const action = (creators[c.type as keyof typeof creators] as (i: never) => Action)(parsed as never);
  assert(canonical(action.input) === canonical(raw), "Unknown or unsupported input field");
  return action;
}
