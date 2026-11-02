// Lean runtime step 4: the org runtime's Task source. The Framework's task-delegation port reads Tasks from the org's
// own authority (the lifted kilgore/task model), never from the personal Task Authority.
import { taskSchema, type Task } from "../task-delegation/contract.js";
import type { FrameworkAuthority } from "../service/authority.js";

export async function orgReadTask(authority: FrameworkAuthority, id: string): Promise<Task> {
  const { document, nativeRevision } = await authority.backend.read(id, "kilgore/task");
  const s = document.state.global as unknown as { id: string; ownerId: string; title: string; status: Task["status"]; projectId: string | null; bodyMarkdown: string;
    comments: { bodyMarkdown: string }[]; externalRefs: { authority: string; opaqueId: string }[] };
  return taskSchema.parse({ id: s.id, ownerId: s.ownerId, revision: nativeRevision, title: s.title, status: s.status, projectId: s.projectId ?? null,
    bodyMarkdown: s.bodyMarkdown ?? "", comments: (s.comments ?? []).map((c) => ({ bodyMarkdown: c.bodyMarkdown })),
    externalRefs: (s.externalRefs ?? []).map((r) => ({ authority: r.authority, opaqueId: r.opaqueId })) });
}
