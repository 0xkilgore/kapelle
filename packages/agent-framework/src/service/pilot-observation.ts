import { z } from 'zod';
import { releaseHash } from '../command-boundary.js';
import { assert } from '../validation.js';
import type { NativeBackend } from './native-backend.js';

export const pilotAuthority = 'kapelle-framework:946802432b81e2eb0ca9301226981c78c6fe2e12a266f9a3a09e52c13d222f7f';
const prefix = 'allocate:task-report-pilot';
const id = z.string().min(1).max(200);
const rowSchema = z.object({
  authorityId: z.literal(pilotAuthority), collectionId: id,
  operationId: id.startsWith(prefix), documentId: id,
  documentType: z.enum(['kapelle/agent-definition', 'kapelle/agent-instance', 'kapelle/review-intent', 'kapelle/dispatch']),
  status: z.enum(['PENDING', 'ALLOCATED']), completedAt: z.preprocess(value => value instanceof Date ? value.toISOString() : value, z.iso.datetime().nullable()),
}).strict();
export type PilotAllocation = z.infer<typeof rowSchema>;
/** Fixed SELECT on the already-open owner's database. No input SQL or new store. */
export function pilotAllocationReader(database: any, authorityId: string, collectionId: string, ownership: () => void) {
  return async (): Promise<PilotAllocation[]> => {
    assert(authorityId === pilotAuthority, 'pilot_observation_identity');
    ownership();
    const rows = await database.selectFrom('scoped_authority_allocations')
      .select(['authorityId', 'collectionId', 'operationId', 'documentId', 'documentType', 'status', 'completedAt'])
      .where('authorityId', '=', authorityId).where('collectionId', '=', collectionId)
      .where('operationId', 'like', `${prefix}%`).orderBy('operationId', 'asc').limit(201).execute();
    ownership();
    assert(rows.length <= 200, 'pilot_observation_incomplete');
    const parsed = rows.map((row: unknown) => rowSchema.parse(row));
    assert(parsed.every((row: PilotAllocation) => row.collectionId === collectionId &&
      (row.status === 'PENDING' ? row.completedAt === null : row.completedAt !== null)), 'pilot_observation_row');
    assert(new Set(parsed.map((row: PilotAllocation) => row.operationId)).size === parsed.length, 'pilot_observation_duplicate');
    return parsed;
  };
}

/** The single pilot owner; configurable, defaults to a neutral id. */
export const pilotOwnerId = () => process.env.KAPELLE_PILOT_OWNER_ID?.trim() || 'human:owner';

export async function observePilotNative(backend: NativeBackend, ownerId: string, scopeRef: string) {
  assert(ownerId === pilotOwnerId() && scopeRef === 'kapelle' && backend.authorityId === pilotAuthority,
    'pilot_observation_identity');
  assert(backend.readPilotAllocations, 'pilot_observation_unavailable');
  const ids = await backend.list('kapelle/agent-definition');
  assert(ids.length <= 200 && new Set(ids).size === ids.length, 'pilot_observation_incomplete');
  const definitions = [];
  let bytes = 0;
  for (const documentId of ids) {
    const { document, nativeRevision } = await backend.read(documentId, 'kapelle/agent-definition');
    const size = Buffer.byteLength(JSON.stringify(document)); bytes += size;
    assert(size <= 2 * 1024 * 1024 && bytes <= 10 * 1024 * 1024, 'pilot_observation_bound');
    const state = document.state.global as any, release = state.release;
    assert(document.header.id === documentId && document.header.documentType === 'kapelle/agent-definition' &&
      state.ownerId === ownerId && Number.isSafeInteger(nativeRevision) && nativeRevision >= 0,
    'pilot_observation_definition_identity');
    assert(!release || releaseHash(release) === release.contentHash, 'pilot_observation_definition_hash');
    definitions.push({ documentId, nativeRevision, release: release ? {
      definitionId: release.definitionId, packageVersion: release.packageVersion, contentHash: release.contentHash,
      runtimeContracts: release.runtimeContracts, modelProfiles: release.modelProfiles, capabilities: release.capabilities,
    } : null });
  }
  const result = { contract: 'kapelle.pilot-native-observation/v1', ownerId, scopeRef,
    authorityId: backend.authorityId, collectionId: backend.collectionId, complete: true,
    definitions, allocations: await backend.readPilotAllocations() };
  assert(Buffer.byteLength(JSON.stringify(result)) <= 1024 * 1024, 'pilot_observation_bound');
  return result;
}
