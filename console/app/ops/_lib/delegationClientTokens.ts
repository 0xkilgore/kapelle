/** Scoped delegation client tokens. Ported from the shared-chat candidate (a6c98dec → 28eea41a) for Increment 2 step 6,
 * narrowed to WATCH AND CANCEL: the only actions are `read` and `cancel`. Proposing, revising, starting and approving are not
 * representable in a token, so a chat connection has no path to them (they happen only in the signed-in console).
 *
 * A token lets ONE chat connection watch ONE assignment: an exact Task,
 * the single bound recipient instance, one delegation round and that round's deterministic
 * proposal operation id (recomputed server-side from taskDelegationIdentity.ts), and optionally the
 * native proposal document id once it exists. It carries an explicit action set that can never
 * include approval: approval happens only through the owner's authenticated console session.
 *
 * Signing key: a dedicated subkey derived from the ops credential with a fixed, versioned purpose
 * label, so a sign-in code, the raw ops credential and a scoped token are never interchangeable.
 * Format: `kdt1.<base64url claims>.<base64url hmac>`. Stateless: expiry is the only cryptographic
 * end. Cancelling the native assignment changes what the assignment permits; it does not revoke
 * the token (reads stay possible until expiry, and that is said so in the UI and the tool).
 *
 * Pure functions, no I/O; the hash function is injected like taskDelegationIdentity.ts so the same
 * derivation runs in tests and on the server. */
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {delegationOperationId,MAX_DELEGATION_ROUNDS} from './taskDelegationIdentity';
/** A connection LABEL chosen by the owner at mint time (e.g. claude-phone). It names the connection, not who typed. */
export const CHAT_CLIENT_ID=/^[a-z0-9][a-z0-9-]{0,39}$/;

export const DELEGATION_TOKEN_PURPOSE='kapelle.delegation-client-token/v1';
export const DELEGATION_TOKEN_TYPE='kapelle.delegation-client';
export const DELEGATION_TOKEN_AUDIENCE='kapelle-console:host-delegation';
export const DELEGATION_TOKEN_PREFIX='kdt1.';
export const DELEGATION_TOKEN_DEFAULT_TTL_SECONDS=60*60;
export const DELEGATION_TOKEN_MAX_TTL_SECONDS=24*60*60;
export const DELEGATION_TOKEN_MIN_TTL_SECONDS=60;
export const DELEGATION_TOKEN_MAX_LENGTH=2048;
/** Watch and cancel only. Approval, proposals and starting work are deliberately absent: possession of a token or a plan hash
 * never approves or starts anything. A token naming any other action fails verification (invalid_actions). */
export const DELEGATION_CLIENT_ACTIONS=['read','cancel'] as const;
export type DelegationClientAction=typeof DELEGATION_CLIENT_ACTIONS[number];
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type DelegationClientClaims={
 typ:typeof DELEGATION_TOKEN_TYPE;aud:typeof DELEGATION_TOKEN_AUDIENCE;v:1;jti:string;
 clientId:string;taskId:string;instanceId:string;round:number;operationId:string;
 /** Native proposal document id, pinned when the round already had a proposal at mint time. */
 proposalId:string|null;
 actions:DelegationClientAction[];iat:number;exp:number;
};
export type DelegationClientVerification={ok:true;claims:DelegationClientClaims}|{ok:false;reason:string};

/** Dedicated subkey: HMAC(ops credential, purpose label). Never the raw credential. */
export function delegationSigningKey(credential:string){
 if(typeof credential!=='string'||credential.length<16)throw Error('Delegation signing credential unavailable');
 return createHmac('sha256',credential).update(DELEGATION_TOKEN_PURPOSE).digest();
}
const b64=(v:Buffer|string)=>Buffer.from(v).toString('base64url');
function sign(key:Buffer,payload:string){return createHmac('sha256',key).update(DELEGATION_TOKEN_TYPE+'\n'+payload).digest();}

export function normalizeActions(input:unknown):DelegationClientAction[]|null{
 if(!Array.isArray(input)||input.length===0||input.length>DELEGATION_CLIENT_ACTIONS.length)return null;
 const out:DelegationClientAction[]=[];
 for(const a of input){if(typeof a!=='string'||!(DELEGATION_CLIENT_ACTIONS as readonly string[]).includes(a)||out.includes(a as DelegationClientAction))return null;out.push(a as DelegationClientAction);}
 if(!out.includes('read'))return null; // every scoped client can read its own assignment; nothing else is implied
 return [...DELEGATION_CLIENT_ACTIONS].filter(a=>out.includes(a));
}

export async function mintDelegationClientToken(credential:string,input:{clientId:string;taskId:string;instanceId:string;round:number;proposalId:string|null;actions:DelegationClientAction[];ttlSeconds?:number;now?:number},hash:(text:string)=>Promise<string>){
 const key=delegationSigningKey(credential),now=Math.floor((input.now??Date.now())/1000);
 const ttl=input.ttlSeconds??DELEGATION_TOKEN_DEFAULT_TTL_SECONDS;
 if(!Number.isSafeInteger(ttl)||ttl<DELEGATION_TOKEN_MIN_TTL_SECONDS||ttl>DELEGATION_TOKEN_MAX_TTL_SECONDS)throw Error('Token lifetime out of range');
 if(!CHAT_CLIENT_ID.test(input.clientId))throw Error('Invalid chat client label');
 if(!ID.test(input.taskId)||!ID.test(input.instanceId))throw Error('Invalid assignment identity');
 if(input.proposalId!==null&&!UUID.test(input.proposalId))throw Error('Invalid proposal identity');
 const actions=normalizeActions(input.actions);if(!actions)throw Error('Invalid action set');
 const operationId=await delegationOperationId(input.taskId,input.instanceId,input.round,hash);
 const claims:DelegationClientClaims={typ:DELEGATION_TOKEN_TYPE,aud:DELEGATION_TOKEN_AUDIENCE,v:1,jti:randomBytes(12).toString('base64url'),clientId:input.clientId,taskId:input.taskId,instanceId:input.instanceId,round:input.round,operationId,proposalId:input.proposalId,actions,iat:now,exp:now+ttl};
 const payload=b64(JSON.stringify(claims));
 const token=DELEGATION_TOKEN_PREFIX+payload+'.'+b64(sign(key,payload));
 if(token.length>DELEGATION_TOKEN_MAX_LENGTH)throw Error('Token too long');
 return {token,claims};
}

/** Every check is explicit; a failure names the first reason and nothing about the claims is trusted before the signature holds. */
export async function verifyDelegationClientToken(credential:string,token:unknown,hash:(text:string)=>Promise<string>,now=Date.now()):Promise<DelegationClientVerification>{
 if(typeof token!=='string'||token.length>DELEGATION_TOKEN_MAX_LENGTH||!token.startsWith(DELEGATION_TOKEN_PREFIX))return {ok:false,reason:'not_a_delegation_token'};
 const rest=token.slice(DELEGATION_TOKEN_PREFIX.length),dot=rest.indexOf('.');
 if(dot<=0||rest.indexOf('.',dot+1)!==-1)return {ok:false,reason:'malformed'};
 const payload=rest.slice(0,dot),signature=rest.slice(dot+1);
 let key:Buffer;try{key=delegationSigningKey(credential);}catch{return {ok:false,reason:'signing_credential_unavailable'};}
 const expected=sign(key,payload);let actual:Buffer;
 try{actual=Buffer.from(signature,'base64url');}catch{return {ok:false,reason:'malformed'};}
 if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return {ok:false,reason:'bad_signature'};
 let raw:unknown;try{raw=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{return {ok:false,reason:'malformed'};}
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {ok:false,reason:'malformed'};
 const c=raw as Record<string,unknown>;
 const keys=Object.keys(c).sort().join(',');
 if(keys!=='actions,aud,clientId,exp,iat,instanceId,jti,operationId,proposalId,round,taskId,typ,v')return {ok:false,reason:'unexpected_claims'};
 if(c.typ!==DELEGATION_TOKEN_TYPE||c.aud!==DELEGATION_TOKEN_AUDIENCE||c.v!==1)return {ok:false,reason:'wrong_purpose'};
 if(typeof c.jti!=='string'||c.jti.length<8||c.jti.length>64)return {ok:false,reason:'invalid_id'};
 if(typeof c.clientId!=='string'||!CHAT_CLIENT_ID.test(c.clientId))return {ok:false,reason:'invalid_client'};
 if(typeof c.taskId!=='string'||!ID.test(c.taskId)||typeof c.instanceId!=='string'||!ID.test(c.instanceId))return {ok:false,reason:'invalid_assignment'};
 if(!Number.isSafeInteger(c.round)||(c.round as number)<1||(c.round as number)>MAX_DELEGATION_ROUNDS)return {ok:false,reason:'invalid_round'};
 if(c.proposalId!==null&&(typeof c.proposalId!=='string'||!UUID.test(c.proposalId)))return {ok:false,reason:'invalid_proposal'};
 const actions=normalizeActions(c.actions);
 if(!actions||actions.length!==(c.actions as unknown[]).length)return {ok:false,reason:'invalid_actions'};
 if(!Number.isSafeInteger(c.iat)||!Number.isSafeInteger(c.exp))return {ok:false,reason:'invalid_time'};
 const nowSeconds=Math.floor(now/1000),iat=c.iat as number,exp=c.exp as number;
 if(exp-iat<DELEGATION_TOKEN_MIN_TTL_SECONDS||exp-iat>DELEGATION_TOKEN_MAX_TTL_SECONDS)return {ok:false,reason:'lifetime_out_of_range'};
 if(iat>nowSeconds+30)return {ok:false,reason:'issued_in_future'};
 if(exp<=nowSeconds)return {ok:false,reason:'expired'};
 // The operation id is a function of (task, instance, round); a token cannot name another one.
 if(typeof c.operationId!=='string'||c.operationId!==await delegationOperationId(c.taskId as string,c.instanceId as string,c.round as number,hash))return {ok:false,reason:'operation_identity_differs'};
 return {ok:true,claims:{typ:DELEGATION_TOKEN_TYPE,aud:DELEGATION_TOKEN_AUDIENCE,v:1,jti:c.jti as string,clientId:c.clientId as string,taskId:c.taskId as string,instanceId:c.instanceId as string,round:c.round as number,operationId:c.operationId as string,proposalId:c.proposalId as string|null,actions,iat,exp}};
}

export function bearerDelegationToken(authorization:string|null){
 const m=/^Bearer\s+(\S+)\s*$/i.exec(authorization??'');
 return m&&m[1].startsWith(DELEGATION_TOKEN_PREFIX)?m[1]:null;
}
