/** Integrate with ONE native document authority. No scheduler, worker or second Run.
 * Implement atomic() with a durable transaction (including cross-document reads),
 * or reject commands requiring facts the authority cannot read consistently.
 * A receipt and the exact generated action must commit with the native document.
 */
import type { Action } from "document-model";
import {
  applyNative,
  prepareCommand,
  requestIdentity,
  type NativeDocument,
  type TrustedContext,
} from "./command-boundary.js";
import { assert } from "./validation.js";
export interface Receipt {
  ownerId: string;
  scopeRef: string;
  operationId: string;
  requestHash: string;
  documentId: string;
  revision: number;
  action: Action;
}
export interface Transaction {
  getDocument(id: string): NativeDocument;
  getReceipt(ownerId: string, scopeRef: string, operationId: string): Receipt | undefined;
  /** Read definition/instance/resource/binding facts inside this same transaction. */
  contextFor(documentId: string): TrustedContext;
  save(document: NativeDocument, receipt: Receipt): void;
}
export interface AuthorityPort {
  atomic<T>(operation: (tx: Transaction) => T): T;
}
/** Authentication must precede receipt lookup; exact retries need no current projection. */
export function executeCommand(
  port: AuthorityPort,
  raw: unknown,
  identity: Pick<TrustedContext, "principalId" | "ownerId" | "scopeRef">,
): Receipt {
  const { command, requestHash } = requestIdentity(raw, identity);
  return port.atomic((tx) => {
    const existing = tx.getReceipt(identity.ownerId, identity.scopeRef, command.operationId);
    if (existing) {
      assert(existing.requestHash === requestHash, "Operation ID conflicts with original request");
      return existing;
    }
    const context = tx.contextFor(command.documentId);
    assert(
      context.principalId === identity.principalId &&
        context.ownerId === identity.ownerId &&
        context.scopeRef === identity.scopeRef,
      "Transaction identity mismatch",
    );
    const document = tx.getDocument(command.documentId);
    const prepared = prepareCommand(command, document, context);
    const next = applyNative(document, prepared.action);
    const receipt: Receipt = {
      ownerId: identity.ownerId,
      scopeRef: identity.scopeRef,
      operationId: command.operationId,
      requestHash,
      documentId: command.documentId,
      revision: next.state.global.revision,
      action: prepared.action,
    };
    tx.save(next, receipt);
    return receipt;
  });
}
