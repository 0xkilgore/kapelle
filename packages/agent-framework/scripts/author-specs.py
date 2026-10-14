"""Author the three Vetra model specifications. No runtime state or secrets."""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]

def spec(slug, name, types, fields, initial, ops):
    common = 'revision: Int!\nownerId: ID\ncreatedAt: DateTime\nupdatedAt: DateTime'
    schema = types + '\ntype '+name+'State {\n'+common+'\n'+fields+'\n}'
    operations=[]
    for op, fields_in, extra in ops:
        camel=''.join(x.title() for x in op.lower().split('_'))
        operations.append(dict(id=slug+'-'+op.lower().replace('_','-'),name=op,description=op.replace('_',' ').capitalize(),schema='input '+camel+'Input {\n actorId: ID!\n occurredAt: DateTime!\n expectedRevision: Int!\n'+fields_in+'\n}\n'+extra,template='',reducer='',errors=[],examples=[],scope='global'))
    doc=dict(id='kapelle/'+slug,name=' '.join(__import__('re').findall('[A-Z][a-z]*',name)),description='Portable agent framework: '+slug,author={'name':'Chris Powers','website':'https://kapelle.ai'},extension={'agent-definition':'phagentdef','agent-instance':'phagent','review-intent':'phreview'}[slug],specifications=[dict(version=1,changeLog=[],state={'local':{'schema':'','examples':[],'initialValue':''},'global':{'schema':schema,'examples':[],'initialValue':json.dumps(dict(revision=0,ownerId=None,createdAt=None,updatedAt=None,**initial))}},modules=[dict(id=slug+'-control',name='control',description='Deterministic document operations; authenticated commands are enforced by the service boundary.',operations=operations)])])
    p=ROOT/'document-models'/slug/(slug+'.json');p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(doc,indent=2)+'\n')

# Shared versioned references are value objects, never credentials or local paths.
refs='''
type VersionedRef { id: ID! version: String! contentHash: String! }
'''
refinput='input VersionedRefInput { id: ID! version: String! contentHash: String! }'

definition_types=refs+'''
enum Requirement { REQUIRED OPTIONAL }
type CapabilityDeclaration { id: ID! requirement: Requirement! resourceType: String! actions: [String!]! outputTypes: [String!]! }
type ModelDependency { documentType: String! version: Int! }
type MigrationDeclaration { fromVersion: String! migrationRef: VersionedRef! compatibilityFixtureRef: VersionedRef! }
type ViewDeclaration { id: ID! codeRef: VersionedRef! }
type DefinitionRelease {
 definitionId: ID! packageVersion: String! schemaVersion: Int! publisherRef: ID! licenseRef: String! contentHash: String!
 previousVersionRef: VersionedRef title: String! description: String! tags: [String!]! avatarRef: ID examples: [String!]! instructionTokenCount: Int tokenizerRef: String purpose: String! responsibilities: [String!]!
 instructions: VersionedRef! skills: [VersionedRef!]! capabilities: [CapabilityDeclaration!]!
 runtimeContracts: [String!]! modelProfiles: [String!]! documentModels: [ModelDependency!]!
 migrations: [MigrationDeclaration!]! views: [ViewDeclaration!]! exportRequirements: [String!]! qualificationFixtures: [VersionedRef!]!
}
'''
definition_inputs=refinput+'''
input CapabilityDeclarationInput { id: ID! requirement: Requirement! resourceType: String! actions: [String!]! outputTypes: [String!]! }
input ModelDependencyInput { documentType: String! version: Int! }
input MigrationDeclarationInput { fromVersion: String! migrationRef: VersionedRefInput! compatibilityFixtureRef: VersionedRefInput! }
input ViewDeclarationInput { id: ID! codeRef: VersionedRefInput! }
input DefinitionReleaseInput {
 definitionId: ID! packageVersion: String! schemaVersion: Int! publisherRef: ID! licenseRef: String! contentHash: String!
 previousVersionRef: VersionedRefInput title: String! description: String! tags: [String!]! avatarRef: ID examples: [String!]! instructionTokenCount: Int tokenizerRef: String purpose: String! responsibilities: [String!]!
 instructions: VersionedRefInput! skills: [VersionedRefInput!]! capabilities: [CapabilityDeclarationInput!]!
 runtimeContracts: [String!]! modelProfiles: [String!]! documentModels: [ModelDependencyInput!]!
 migrations: [MigrationDeclarationInput!]! views: [ViewDeclarationInput!]! exportRequirements: [String!]! qualificationFixtures: [VersionedRefInput!]!
}
'''
spec('agent-definition','AgentDefinition',definition_types,'release: DefinitionRelease',{'release':None},[('PUBLISH_DEFINITION','release: DefinitionReleaseInput!',definition_inputs)])

instance_types=refs+'''
enum DesiredState { READY PAUSED RETIRED }
enum SkillSource { BUILTIN MARKET USER }
enum ConnectionDirection { RECEIVE PREPARE SEND }
enum ReviewPolicy { ALWAYS WITHIN_GRANT }
enum DocumentAccess { PRIVATE SHARED PUBLIC }
enum CatchUpPolicy { SKIP COALESCE }
type EnabledSkill { ref: VersionedRef! source: SkillSource! }
type CapabilityGrant { id: ID! principalId: ID! resourceRef: ID! actions: [String!]! expiresAt: DateTime! reviewPolicy: ReviewPolicy! revokedAt: DateTime }
type ConnectionBinding { id: ID! connectionRef: ID! label: String! accountRef: ID! directions: [ConnectionDirection!]! revokedAt: DateTime }
type DocumentLink { documentRef: ID! access: DocumentAccess! }
type ScheduleBinding { id: ID! schedulerRef: ID! timezone: String! maxExecutions: Int! conditionRef: ID! catchUp: CatchUpPolicy! watermarkRef: ID! lastRunRef: ID }
type ModelPolicy { preferredProfile: String! concurrencyLimit: Int! budgetPolicyRef: ID! paidFallback: Boolean! fallbackProvider: String fallbackScopeRef: ID fallbackBudgetRef: ID }
'''
model_input='input ModelPolicyInput { preferredProfile: String! concurrencyLimit: Int! budgetPolicyRef: ID! paidFallback: Boolean! fallbackProvider: String fallbackScopeRef: ID fallbackBudgetRef: ID }'
initial=dict(instanceId=None,scopeRef=None,definitionRef=None,name=None,responsibilities=[],operatingPolicy=None,desiredState='PAUSED',runtimeBindingRef=None,skills=[],grants=[],connections=[],documentLinks=[],schedules=[],modelPolicy=None)
ops=[
 ('CREATE_INSTANCE','instanceId: ID!\n scopeRef: ID!\n definitionRef: VersionedRefInput!\n name: String!\n responsibilities: [String!]!\n operatingPolicy: String!\n modelPolicy: ModelPolicyInput!',refinput+'\n'+model_input),
 ('SET_RESPONSIBILITIES','responsibilities: [String!]!',''),
 ('SET_OPERATING_POLICY','operatingPolicy: String!',''),
 ('ENABLE_SKILL','ref: VersionedRefInput!\n source: SkillSource!', ''),
 ('DISABLE_SKILL','skillId: ID!',''),
 ('GRANT_CAPABILITY','grant: CapabilityGrantInput!','input CapabilityGrantInput { id: ID! principalId: ID! resourceRef: ID! actions: [String!]! expiresAt: DateTime! reviewPolicy: ReviewPolicy! }'),
 ('REVOKE_CAPABILITY','grantId: ID!',''),
 ('BIND_CONNECTION','binding: ConnectionBindingInput!','input ConnectionBindingInput { id: ID! connectionRef: ID! label: String! accountRef: ID! directions: [ConnectionDirection!]! }'),
 ('REVOKE_CONNECTION','connectionId: ID!',''),
 ('SET_RUNTIME_BINDING','runtimeBindingRef: ID!',''),
 ('SET_MODEL_POLICY','modelPolicy: ModelPolicyInput!',''),
 ('LINK_DOCUMENT','documentRef: ID!\n access: DocumentAccess!',''),
 ('UNLINK_DOCUMENT','documentRef: ID!',''),
 ('BIND_SCHEDULE','schedule: ScheduleBindingInput!','input ScheduleBindingInput { id: ID! schedulerRef: ID! timezone: String! maxExecutions: Int! conditionRef: ID! catchUp: CatchUpPolicy! watermarkRef: ID! lastRunRef: ID }'),
 ('UNBIND_SCHEDULE','scheduleId: ID!',''),
 ('PIN_DEFINITION_VERSION','definitionRef: VersionedRefInput!\n migrationRef: VersionedRefInput!\n compatibilityFixtureRef: VersionedRefInput!',''),
 ('REQUEST_PAUSE','',''),('REQUEST_RESUME','',''),('RETIRE_INSTANCE','','')]
spec('agent-instance','AgentInstance',instance_types,'''
instanceId: ID
scopeRef: ID
definitionRef: VersionedRef
name: String
responsibilities: [String!]!
operatingPolicy: String
desiredState: DesiredState!
runtimeBindingRef: ID
skills: [EnabledSkill!]!
grants: [CapabilityGrant!]!
connections: [ConnectionBinding!]!
documentLinks: [DocumentLink!]!
schedules: [ScheduleBinding!]!
modelPolicy: ModelPolicy
''',initial,ops)

review_types='''
enum ReviewState { PROPOSED APPROVED REJECTED INVALIDATED }
enum EffectKind { DOCUMENT_CHANGE PREPARE_MESSAGE SEND_MESSAGE }
enum DeliveryStatus { ACCEPTED DELIVERED FAILED UNCERTAIN }
type TargetRevision { documentRef: ID! revision: Int! contentHash: String! }
type Proposal { version: Int! contentHash: String! contentRef: ID! contentVersion: Int! artifactHash: String! effectKind: EffectKind! action: String! targets: [TargetRevision!]! senderConnectionRef: ID recipients: [String!]! }
type Decision { actorId: ID! occurredAt: DateTime! proposalHash: String! proposalVersion: Int! approved: Boolean! reason: String }
type EffectReservation { operationId: ID! dispatchRef: ID! outboxRef: ID! occurredAt: DateTime! }
type DeliveryEvidence { id: ID! status: DeliveryStatus! providerRef: ID! receiptRef: ID! occurredAt: DateTime! }
'''
review_input='''input TargetRevisionInput { documentRef: ID! revision: Int! contentHash: String! }
input ProposalInput { version: Int! contentHash: String! contentRef: ID! contentVersion: Int! artifactHash: String! effectKind: EffectKind! action: String! targets: [TargetRevisionInput!]! senderConnectionRef: ID recipients: [String!]! }
'''
spec('review-intent','ReviewIntent',review_types,'''
reviewId: ID
instanceId: ID
scopeRef: ID
proposal: Proposal
status: ReviewState!
decision: Decision
invalidatedReason: String
effect: EffectReservation
delivery: [DeliveryEvidence!]!
''',dict(reviewId=None,instanceId=None,scopeRef=None,proposal=None,status='PROPOSED',decision=None,invalidatedReason=None,effect=None,delivery=[]),[
 ('CREATE_REVIEW','reviewId: ID!\n instanceId: ID!\n scopeRef: ID!\n proposal: ProposalInput!',review_input),
 ('RECORD_DECISION','proposalHash: String!\n proposalVersion: Int!\n approved: Boolean!\n reason: String',''),
 ('INVALIDATE_REVIEW','reason: String!',''),
 ('RESERVE_EFFECT','operationId: ID!\n dispatchRef: ID!\n outboxRef: ID!\n proposalHash: String!\n proposalVersion: Int!',''),
 ('RECORD_DELIVERY','evidenceId: ID!\n operationId: ID!\n status: DeliveryStatus!\n providerRef: ID!\n receiptRef: ID!','')])
