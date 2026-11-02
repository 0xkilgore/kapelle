/** Authored native extension (agent launch kit, slice 2): AgentDefinition v2 = v1 + a typed launchPolicy.
 *  Same pattern as review-intent v3: only FRESH v2 allocations use it; v1 documents and their replay are unchanged, and v1
 *  releases are never upgraded into kit eligibility. PUBLISH_DEFINITION runs the unchanged v1 release validation, then
 *  requires a valid, canonical launch policy. The release hash (checked in command-boundary) covers the policy. */
import {z} from 'zod';
import {createAction, createReducer, isDocumentAction, baseCreateDocument, baseSaveToFileHandle, baseLoadFromInputVersioned, type PHDocument, type DocumentModelModule, type DocumentModelUtils} from 'document-model';
import {AgentDefinition as v1, type AgentDefinitionPHState as V1State} from '../v1/index.js';
import {agentDefinitionControlOperations} from '../v1/src/reducers/control.js';
import {PublishDefinitionInputSchema as V1PublishInputSchema} from '../v1/gen/schema/zod.js';
import {canonical} from '../../../src/content.js';
import {assert} from '../../../src/validation.js';
import {launchPolicySchema} from '../../../src/agent-kit/launch-policy.js';

export type AgentDefinitionPHState = V1State & {global: V1State['global'] & {launchPolicyJson: string | null}};
export type AgentDefinitionDocument = PHDocument<AgentDefinitionPHState>;

export const PublishDefinitionInputSchema = () => V1PublishInputSchema().extend({launchPolicyJson: z.string().min(2).max(20000)}).strict();
export const schemas = {PUBLISH_DEFINITION: PublishDefinitionInputSchema};
export const actions = {PUBLISH_DEFINITION: (input: unknown) => createAction<any>('PUBLISH_DEFINITION', input, undefined, PublishDefinitionInputSchema, 'global')};

const reducer = createReducer<AgentDefinitionPHState>((state, action) => {
  if (isDocumentAction(action)) return state;
  assert(action.type === 'PUBLISH_DEFINITION', 'Unknown agent definition operation');
  const i = PublishDefinitionInputSchema().parse(action.input);
  const {launchPolicyJson, ...v1Input} = i;
  let raw: unknown;
  try { raw = JSON.parse(launchPolicyJson); } catch { assert(false, 'Launch policy is not JSON'); }
  const parsed = launchPolicySchema.safeParse(raw);
  assert(parsed.success, 'Invalid launch policy: ' + (parsed.success ? '' : parsed.error.issues.map(x => x.message).join('; ')));
  assert(canonical(parsed.data) === launchPolicyJson, 'Launch policy must be canonical JSON');
  // The unchanged v1 release validation (identity, refs, capabilities, qualification fixtures, publisher = owner, once only).
  agentDefinitionControlOperations.publishDefinitionOperation(state.global, {type: 'PUBLISH_DEFINITION', input: v1Input, scope: 'global'} as never);
  state.global.launchPolicyJson = launchPolicyJson;
});

const initial = () => ({...v1.utils.createState(), document: {...v1.utils.createState().document, version: 2}, global: {...v1.utils.createState().global, launchPolicyJson: null}});
export const utils: DocumentModelUtils<AgentDefinitionPHState> = {
  ...(v1.utils as unknown as DocumentModelUtils<AgentDefinitionPHState>),
  createState(partial) { const d = initial(); return {...d, ...partial, document: {...d.document, ...partial?.document, version: 2}, global: {...d.global, ...partial?.global}} as AgentDefinitionPHState; },
  createDocument(state) { return baseCreateDocument(utils.createState, state, 'kapelle/agent-definition'); },
  saveToFileHandle: baseSaveToFileHandle,
  loadFromInput(input) { return baseLoadFromInputVersioned(input, {reducers: {2: reducer as any}, upgradeManifest: {documentType: 'kapelle/agent-definition', latestVersion: 2, supportedVersions: [2], upgrades: {}}}); },
  isStateOfType(state): state is AgentDefinitionPHState { return v1.utils.isStateOfType(state) && typeof (state as AgentDefinitionPHState).global.launchPolicyJson !== 'undefined'; },
  assertIsStateOfType(state): asserts state is AgentDefinitionPHState { assert(utils.isStateOfType(state), 'Invalid agent definition state'); },
  isDocumentOfType(doc): doc is AgentDefinitionDocument { return v1.utils.isDocumentOfType(doc) && utils.isStateOfType(doc.state); },
  assertIsDocumentOfType(doc): asserts doc is AgentDefinitionDocument { assert(utils.isDocumentOfType(doc), 'Invalid agent definition document'); },
};

const documentModel = structuredClone(v1.documentModel);
const spec = structuredClone(documentModel.global.specifications.find(s => s.version === 1)!);
spec.version = 2;
spec.state.global.schema += '\nextend type AgentDefinitionState { launchPolicyJson: String }';
spec.state.global.initialValue = JSON.stringify(initial().global);
for (const m of spec.modules) for (const o of m.operations) if (o.name === 'PUBLISH_DEFINITION') {
  const next = (o.schema ?? '').replace(/release:\s*DefinitionReleaseInput!/, 'release: DefinitionReleaseInput!\n launchPolicyJson: String!');
  assert(next !== o.schema, 'v1 PUBLISH_DEFINITION schema shape changed');
  o.schema = next;
}
documentModel.global.specifications = [spec];
export const AgentDefinition = {version: 2, reducer, actions, utils, documentModel} satisfies DocumentModelModule<AgentDefinitionPHState>;
