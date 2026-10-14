import type { DispatchState } from "../../document-models/dispatch/v1/index.js";
import type { AgentInstanceState } from "../../document-models/agent-instance/v1/index.js";
import type { ModelType, NativeDocument, TrustedContext } from "../command-boundary.js";
import { assert, opaque } from "../validation.js";
import { authorizeDispatchLineage } from "./contracts.js";

export interface DispatchNativeReader {
  read(id: string, type: ModelType): Promise<{ document: NativeDocument }>;
}
/** Uses the scoped backend directly while the authority already owns its command
 * lock. Calling the public command/read queue here would deadlock that lock. */
export async function verifyNativeDispatch(
  reader: DispatchNativeReader,
  id: string,
  ctx: TrustedContext,
) {
  opaque(id);
  const document = (await reader.read(id, "kapelle/dispatch")).document;
  const state = document.state.global as DispatchState;
  assert(
    document.header.documentType === "kapelle/dispatch" &&
      document.state.document.version === 1 &&
      state.dispatchId === id &&
      state.ownerId === ctx.ownerId &&
      state.scopeRef === ctx.scopeRef &&
      state.offer &&
      state.acceptance?.inputHash === state.offer.contentHash &&
      state.acceptance.actorId === state.offer.recipient.instanceId &&
      state.phase === "ACCEPTED",
    "Native execution Dispatch is not accepted or was cancelled/completed",
  );
  assert(ctx.dispatch, "Dispatch authority facts unavailable");
  const parents: DispatchState[] = [],
    offers = [state.offer],
    seen = new Set([id]);
  let parentId = state.offer.parentDispatchRef;
  while (parentId) {
    opaque(parentId);
    assert(!seen.has(parentId) && parents.length < 8, "Dispatch parent cycle or depth exceeded");
    seen.add(parentId);
    const parent = (await reader.read(parentId, "kapelle/dispatch")).document.state
      .global as DispatchState;
    assert(
      parent.offer &&
        parent.dispatchId === parentId &&
        parent.ownerId === ctx.ownerId &&
        parent.scopeRef === ctx.scopeRef,
      "Native Dispatch parent unavailable or outside scope",
    );
    parents.push(parent);
    offers.push(parent.offer);
    parentId = parent.offer.parentDispatchRef;
  }
  const ids = new Set(
    offers.flatMap((o) => [
      o.recipient.instanceId,
      ...(o.senderAgent ? [o.senderAgent.instanceId] : []),
    ]),
  );
  const agents: AgentInstanceState[] = [];
  for (const agentId of ids)
    agents.push(
      (await reader.read(agentId, "kapelle/agent-instance")).document.state
        .global as AgentInstanceState,
    );
  const current = { ...ctx, dispatch: { ...ctx.dispatch, parents, agents } };
  authorizeDispatchLineage(id, state.offer, current);
  return state;
}
