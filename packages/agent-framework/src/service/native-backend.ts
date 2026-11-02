import type { Action, PHDocument } from "document-model";
import {
  canonical,
  nativeModel,
  type NativeDocument,
  type ModelType,
} from "../command-boundary.js";
import { assert } from "../validation.js";

// Structural surface of the same scoped Reactor primitive used by Task Authority.
// The published 6.2.1 package does not include the local scoped-authority extension.
export interface NativeReceipt {
  disposition: string;
  revision?: number;
  operationIndexes?: number[];
  currentRevision?: number;
  errors?: string[];
  replayed?: boolean;
}
export interface Preconditions {
  contract: "task-authority/v1";
  authorityId: string;
  collectionId: string;
  membershipIncarnation: string;
  documentType: string;
  operationId: string;
  expectedRevision: number;
  actionDigest: string;
  actionCount: number;
}
export interface PreparedNative {
  preconditions: Preconditions;
  action: Action;
}
export interface ScopedStore {
  inspectOwned(input: {
    collectionId: string;
    documentId: string;
    documentType: string;
  }): Promise<{ disposition: string; membershipIncarnation?: string; currentRevision?: number }>;
  readOwnedOperationSnapshot(input: {
    collectionId: string;
    documentId: string;
    documentType: string;
  }): Promise<{
    documentId: string;
    name: string;
    revision: number;
    operations: { action: Action; error?: string }[];
    /** Captured with ownership/global operations in the same transaction. */
    initialModelVersion?: number;
  } | null>;
  listOwnedDocumentIds(input: {
    collectionId: string;
    documentType: string;
    cursor: string | null;
    limit: number;
  }): Promise<{ documentIds: string[]; nextCursor: string | null }>;
  reserveAllocation(input: {
    authorityId: string;
    operationId: string;
    collectionId: string;
    documentType: string;
    name: string;
    document: PHDocument;
  }): Promise<{ kind: string; document?: PHDocument; completed?: boolean; replayed?: boolean }>;
  finishAllocation(input: {
    authorityId: string;
    operationId: string;
    documentId: string;
  }): Promise<void>;
  reconcile(
    p: Preconditions,
    job: { documentId: string; scope: string; branch: string; actions: Action[] },
  ): Promise<NativeReceipt>;
}
export interface ScopedClient {
  drives: { addFile(driveId: string, document: PHDocument): Promise<unknown> };
  executeScopedAuthority(id: string, actions: Action[], p: Preconditions): Promise<NativeReceipt>;
}
export class NativeBackend {
  constructor(
    readonly authorityId: string,
    readonly collectionId: string,
    readonly driveId: string,
    readonly store: ScopedStore,
    readonly client: ScopedClient,
    readonly actionDigest: (actions: Action[]) => string,
    readonly readPilotAllocations?: () => Promise<import("./pilot-observation.js").PilotAllocation[]>,
  ) {}
  async allocate(operationId: string, type: ModelType, name: string, modelVersion = 1, beforeNative?: (documentId:string)=>Promise<void>) {
    const model = nativeModel(type, modelVersion);
    const candidate = model.utils.createDocument();
    candidate.header.name = name;

    const reservation = await this.store.reserveAllocation({
      authorityId: this.authorityId,
      operationId: `allocate:${operationId}`,
      collectionId: this.collectionId,
      documentType: type,
      name,
      document: candidate,
    });
    assert(reservation.kind !== "IDEMPOTENCY_CONFLICT", "Allocation conflict");
    assert(reservation.document, "Allocation unavailable");
    const d = reservation.document;
    assert(d.state.document.version === modelVersion, "Allocation conflict: model version changed");
    // Reservation identity is durable even on replay. No native membership/write
    // may start until the authority checks ordering for that exact document.
    await beforeNative?.(d.header.id);
    const owned = () =>
      this.store.inspectOwned({
        collectionId: this.collectionId,
        documentId: d.header.id,
        documentType: type,
      });
    if ((await owned()).disposition !== "OWNED") {
      assert(!reservation.completed, "Allocation no longer owned");
      try {
        await this.client.drives.addFile(this.driveId, d);
      } catch (e) {
        if ((await owned()).disposition !== "OWNED") throw e;
      }
    }
    assert((await owned()).disposition === "OWNED", "Allocation unconfirmed");

    await this.store.finishAllocation({
      authorityId: this.authorityId,
      operationId: `allocate:${operationId}`,
      documentId: d.header.id,
    });
    return { documentId: d.header.id, documentType: type };
  }
  async read(
    id: string,
    type: ModelType,
  ): Promise<{ document: NativeDocument; nativeRevision: number }> {
    const snapshot = await this.store.readOwnedOperationSnapshot({
      collectionId: this.collectionId,
      documentId: id,
      documentType: type,
    });
    assert(snapshot, "Document unavailable");
    assert(snapshot.initialModelVersion !== undefined, "Native snapshot model version unavailable");
    const model = nativeModel(type, snapshot.initialModelVersion);
    let doc = model.utils.createDocument() as NativeDocument;
    doc.header.id = id;
    doc.header.name = snapshot.name;
    // Rebuild from retained native operations, not an eventually-consistent UI projection.
    const reduce = model.reducer as (d: NativeDocument, a: Action) => NativeDocument;
    for (const op of snapshot.operations) {
      const next = reduce(doc, op.action);
      assert(
        canonical(next.operations.global.at(-1)?.error ?? null) === canonical(op.error ?? null),
        "Native replay disagrees with retained operation",
      );
      doc = next;
    }
    return { document: doc, nativeRevision: snapshot.revision };
  }
  async list(type: ModelType) {
    const page = await this.store.listOwnedDocumentIds({
      collectionId: this.collectionId,
      documentType: type,
      cursor: null,
      limit: 200,
    });
    assert(!page.nextCursor, "Scope exceeds bounded pilot limit");
    return page.documentIds;
  }
  /** One bounded page of owned document ids with an explicit continuation. Unlike list(), a
   * further page is reported, not refused, so readers can state completeness honestly. */
  async listPage(type: ModelType, cursor: string | null, limit: number) {
    assert(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200, "Page limit out of bounds");
    const page = await this.store.listOwnedDocumentIds({
      collectionId: this.collectionId,
      documentType: type,
      cursor,
      limit,
    });
    return { documentIds: page.documentIds, nextCursor: page.nextCursor ?? null };
  }
  async prepare(
    id: string,
    type: ModelType,
    operationId: string,
    nativeRevision: number,
    action: Action,
  ): Promise<PreparedNative> {
    const ownership = await this.store.inspectOwned({
      collectionId: this.collectionId,
      documentId: id,
      documentType: type,
    });
    assert(
      ownership.disposition === "OWNED" && ownership.membershipIncarnation,
      "Document unavailable",
    );
    return {
      action,
      preconditions: {
        contract: "task-authority/v1",
        authorityId: this.authorityId,
        collectionId: this.collectionId,
        membershipIncarnation: ownership.membershipIncarnation,
        documentType: type,
        operationId,
        expectedRevision: nativeRevision,
        actionDigest: this.actionDigest([action]),
        actionCount: 1,
      },
    };
  }
  reconcile(id: string, p: PreparedNative) {
    return this.store.reconcile(p.preconditions, {
      documentId: id,
      scope: "global",
      branch: "main",
      actions: [p.action],
    });
  }
  commit(id: string, p: PreparedNative) {
    return this.client.executeScopedAuthority(id, [p.action], p.preconditions);
  }
}
