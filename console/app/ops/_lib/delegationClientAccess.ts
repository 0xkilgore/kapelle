import 'server-only';
import {createHash} from 'node:crypto';
import {getOpsConfig} from './config';
import {isLoopbackOpsRequest} from './securityTopology';
import {bearerDelegationToken,verifyDelegationClientToken,CHAT_CLIENT_ID,DELEGATION_TOKEN_DEFAULT_TTL_SECONDS,DELEGATION_TOKEN_MAX_TTL_SECONDS,DELEGATION_TOKEN_MIN_TTL_SECONDS,type DelegationClientClaims} from './delegationClientTokens';

/** Dedicated guard for scoped delegation clients (shared-chat candidate a6c98dec, ported for Increment 2 step 6). It is NOT `requireOpsApiAccess`:
 * a scoped token never yields the generic owner `ok:true`, only these claims, and only the routes
 * that explicitly call this guard accept it. Owner credentials and sign-in codes are not accepted here. */
export type DelegationClientAccess={ok:true;claims:DelegationClientClaims}|{ok:false;status:401|403|404;reason:string};
const hash=async(s:string)=>createHash('sha256').update(s).digest('hex');
export function presentsDelegationToken(request:Request){return bearerDelegationToken(request.headers.get('authorization'))!==null;}
export async function requireDelegationClientAccess(request:Request,now=Date.now()):Promise<DelegationClientAccess>{
 const config=getOpsConfig(),h=request.headers;
 if(!config.enabled)return {ok:false,status:404,reason:'Kapelle ops is disabled.'};
 const token=bearerDelegationToken(h.get('authorization'));
 if(!token)return {ok:false,status:401,reason:'A delegation connection token is required.'};
 // Configured remote-access restrictions apply unchanged; a token does not widen where requests may come from.
 if(!config.allowRemote&&!isLoopbackOpsRequest({host:h.get('host'),forwardedFor:h.get('x-forwarded-for'),realIp:h.get('x-real-ip')}))return {ok:false,status:403,reason:'Remote ops access is disabled.'};
 if(!config.token)return {ok:false,status:403,reason:'KAPELLE_OPS_TOKEN is not configured.'};
 // Credentials are never mixed: a request carrying an owner cookie or header token is not a scoped client.
 if(h.get('x-kapelle-ops-token')||/(^|;\s*)(KAPELLE_OPS_TOKEN|kapelle_ops_token)=/.test(h.get('cookie')??''))return {ok:false,status:403,reason:'Owner credentials cannot be combined with a connection token.'};
 const verified=await verifyDelegationClientToken(config.token,token,hash,now);
 if(!verified.ok)return {ok:false,status:401,reason:verified.reason==='expired'?'This connection expired. Create a new one from Kapelle; the assignment itself is unaffected.':'Connection token refused ('+verified.reason+').'};
 return {ok:true,claims:verified.claims};
}

/** Owner choices, left to configuration (Increment 2 step 6): which chat clients may be connected and how long a connection
 * lives. Unset KAPELLE_DELEGATION_CLIENTS = chat connections are off and nothing can be minted. */
export function delegationClientConfig(env:NodeJS.ProcessEnv=process.env){
 const clients=(env.KAPELLE_DELEGATION_CLIENTS??'').split(',').map(s=>s.trim()).filter(Boolean);
 const ttl=Number(env.KAPELLE_DELEGATION_CLIENT_TTL_SECONDS??DELEGATION_TOKEN_DEFAULT_TTL_SECONDS);
 const valid=clients.length>0&&clients.every(c=>CHAT_CLIENT_ID.test(c))&&Number.isSafeInteger(ttl)&&ttl>=DELEGATION_TOKEN_MIN_TTL_SECONDS&&ttl<=DELEGATION_TOKEN_MAX_TTL_SECONDS;
 return valid?{enabled:true as const,clients,ttlSeconds:ttl}:{enabled:false as const,clients:[] as string[],ttlSeconds:ttl};
}

