// Scoped delegation client tokens: pure checks (ported from the shared-chat candidate 28eea41a; Increment 2 step 6 narrows the
// action set to watch and cancel).
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,createHmac} from 'node:crypto';
import {mintDelegationClientToken,verifyDelegationClientToken,delegationSigningKey,normalizeActions,bearerDelegationToken,DELEGATION_TOKEN_PREFIX,DELEGATION_TOKEN_DEFAULT_TTL_SECONDS,DELEGATION_TOKEN_MAX_TTL_SECONDS,DELEGATION_TOKEN_TYPE} from '../app/ops/_lib/delegationClientTokens';
import {delegationOperationId} from '../app/ops/_lib/taskDelegationIdentity';
const hash=async(s:string)=>createHash('sha256').update(s).digest('hex');
const credential='synthetic-ops-credential-'+'x'.repeat(24),taskId='task:fixture-1',instanceId='inst-'+'a'.repeat(8),now=Date.parse('2026-10-09T12:00:00Z');
const base={clientId:'codex-mobile',taskId,instanceId,round:2,proposalId:null,actions:['read','cancel'] as const};

test('round trip: claims bind task, instance, round and the recomputed operation id; default and max TTL hold',async()=>{
 const m=await mintDelegationClientToken(credential,{...base,actions:[...base.actions],now},hash);
 assert.ok(m.token.startsWith(DELEGATION_TOKEN_PREFIX));
 assert.equal(m.claims.operationId,await delegationOperationId(taskId,instanceId,2,hash));
 assert.equal(m.claims.exp-m.claims.iat,DELEGATION_TOKEN_DEFAULT_TTL_SECONDS);
 const v=await verifyDelegationClientToken(credential,m.token,hash,now+1000);
 assert.ok(v.ok);assert.deepEqual(v.ok&&v.claims,m.claims);
 const max=await mintDelegationClientToken(credential,{...base,actions:[...base.actions],now,ttlSeconds:DELEGATION_TOKEN_MAX_TTL_SECONDS},hash);
 assert.ok((await verifyDelegationClientToken(credential,max.token,hash,now+DELEGATION_TOKEN_MAX_TTL_SECONDS*1000-1000)).ok);
 await assert.rejects(mintDelegationClientToken(credential,{...base,actions:[...base.actions],now,ttlSeconds:DELEGATION_TOKEN_MAX_TTL_SECONDS+1},hash),/lifetime/);
 await assert.rejects(mintDelegationClientToken(credential,{...base,actions:[...base.actions],now,ttlSeconds:30},hash),/lifetime/);
});

test('tampered, expired, future-dated, overlong, wrong-purpose and foreign-key tokens fail with named reasons',async()=>{
 const m=await mintDelegationClientToken(credential,{...base,actions:[...base.actions],now},hash);
 const [payload,sig]=m.token.slice(DELEGATION_TOKEN_PREFIX.length).split('.');
 const forge=(claims:Record<string,unknown>,key=credential)=>{const p=Buffer.from(JSON.stringify(claims)).toString('base64url');const s=createHmac('sha256',delegationSigningKey(key)).update(DELEGATION_TOKEN_TYPE+'\n'+p).digest('base64url');return DELEGATION_TOKEN_PREFIX+p+'.'+s;};
 const reason=async(t:unknown,at=now+1000)=>{const v=await verifyDelegationClientToken(credential,t,hash,at);return v.ok?'ok':v.reason;};
 assert.equal(await reason(m.token),'ok');
 assert.equal(await reason(DELEGATION_TOKEN_PREFIX+payload+'.'+sig.slice(0,-2)+'AA'),'bad_signature');
 const tampered=JSON.parse(Buffer.from(payload,'base64url').toString());tampered.round=3;
 assert.equal(await reason(DELEGATION_TOKEN_PREFIX+Buffer.from(JSON.stringify(tampered)).toString('base64url')+'.'+sig),'bad_signature');
 assert.equal(await reason(forge({...m.claims,round:3})),'operation_identity_differs','a re-signed token still cannot name another round');
 assert.equal(await reason(forge({...m.claims,taskId:'task:other'})),'operation_identity_differs');
 assert.equal(await reason(forge({...m.claims,instanceId:'inst-other'})),'operation_identity_differs');
 assert.equal(await reason(forge({...m.claims},'another-credential-'+'y'.repeat(24))),'bad_signature');
 assert.equal(await reason(m.token,now+DELEGATION_TOKEN_DEFAULT_TTL_SECONDS*1000+1),'expired');
 assert.equal(await reason(forge({...m.claims,iat:m.claims.iat+120,exp:m.claims.exp+120})),'issued_in_future');
 assert.equal(await reason(forge({...m.claims,exp:m.claims.iat+DELEGATION_TOKEN_MAX_TTL_SECONDS+1})),'lifetime_out_of_range');
 assert.equal(await reason(forge({...m.claims,typ:'kapelle.sign-in-code'})),'wrong_purpose');
 assert.equal(await reason(forge({...m.claims,aud:'kapelle-console:everything'})),'wrong_purpose');
 assert.equal(await reason(forge({...m.claims,v:2})),'wrong_purpose');
 assert.equal(await reason(forge({...m.claims,extra:true})),'unexpected_claims');
 assert.equal(await reason(forge({...m.claims,actions:['read','approve']})),'invalid_actions');
 assert.equal(await reason(forge({...m.claims,actions:['cancel']})),'invalid_actions','read is always part of a valid set');
 for(const a of ['propose','revise','run'])assert.equal(await reason(forge({...m.claims,actions:['read',a]})),'invalid_actions','a correctly signed token still cannot carry '+a);
 assert.equal(await reason(forge({...m.claims,actions:[]})),'invalid_actions');
 assert.equal(await reason(forge({...m.claims,clientId:'Bad Client'})),'invalid_client');
 assert.equal(await reason(forge({...m.claims,proposalId:'not-a-uuid'})),'invalid_proposal');
 assert.equal(await reason(forge({...m.claims,round:13})),'invalid_round');
 assert.equal(await reason('kdt1.'+'A'.repeat(3000)),'not_a_delegation_token');
 assert.equal(await reason('ABCDE FGHIJ'),'not_a_delegation_token','a sign-in code is never a token');
 assert.equal(await reason(credential),'not_a_delegation_token','the raw ops credential is never a token');
 assert.equal(await reason(DELEGATION_TOKEN_PREFIX+'x'),'malformed');
 assert.equal(await reason(DELEGATION_TOKEN_PREFIX+payload+'.'+sig+'.extra'),'malformed');
 const short=await verifyDelegationClientToken('short',m.token,hash,now);assert.ok(!short.ok&&short.reason==='signing_credential_unavailable');
});

test('the signing key is a purpose-labelled subkey, never the credential; action sets are normalised; bearer parsing is strict',()=>{
 assert.notEqual(delegationSigningKey(credential).toString('hex'),Buffer.from(credential).toString('hex'));
 assert.equal(delegationSigningKey(credential).length,32);
 assert.deepEqual(normalizeActions(['cancel','read']),['read','cancel']);assert.equal(normalizeActions(['read','propose']),null);assert.equal(normalizeActions(['read','run']),null);
 assert.equal(normalizeActions(['read','read']),null);assert.equal(normalizeActions(['read','approveProposal']),null);assert.equal(normalizeActions('read'),null);
 assert.equal(bearerDelegationToken('Bearer kdt1.abc.def'),'kdt1.abc.def');
 assert.equal(bearerDelegationToken('Bearer synthetic-task-pipeline'),null);
 assert.equal(bearerDelegationToken('kdt1.abc.def'),null);
 assert.equal(bearerDelegationToken(null),null);
});

