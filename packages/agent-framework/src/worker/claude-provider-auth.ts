/** Explicit nonsecret owner binding. Never reads provider credential contents. */
import { open, lstat, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, resolve, join } from 'node:path';
import { userInfo } from 'node:os';
import { z } from 'zod';

const providerAuthBindingBase = z.object({
  mode:z.literal('provider-managed'), uid:z.number().int().nonnegative(),
  teamId:z.string().uuid(), configDir:z.string().min(1),
  email:z.string().email(), credentialHome:z.literal('os-user').optional(),
  cliVersion:z.string().regex(/^\d+\.\d+\.\d+$/), cliSha256:z.string().regex(/^[a-f0-9]{64}$/),
  sdkVersion:z.literal('0.2.90'), sdkSha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const providerAuthBindingSchema = z.union([
  providerAuthBindingBase.extend({
    accountBinding:z.literal('organization').optional(),
    organization:z.string().min(1), subscriptionType:z.enum(['pro','max']),
  }).strict(),
  providerAuthBindingBase.extend({
    accountBinding:z.literal('personal-email-plan'),
    subscriptionType:z.literal('max'), cliVersion:z.literal('2.1.295'),
  }).strict(),
]);
export type ProviderAuthBinding = z.infer<typeof providerAuthBindingSchema>;

export async function checkProviderContext(binding:ProviderAuthBinding) {
  if(binding.uid!==process.getuid?.() || !isAbsolute(binding.configDir) ||
     binding.configDir!==resolve(binding.configDir) ||
     binding.configDir===userInfo().homedir || binding.configDir===join(userInfo().homedir,'.claude'))
    throw Error('claude_provider_context_invalid');
  const s=await lstat(binding.configDir);
  if(!s.isDirectory() || s.isSymbolicLink() || s.uid!==binding.uid || (s.mode&0o077) ||
     await realpath(binding.configDir)!==binding.configDir)
    throw Error('claude_provider_context_invalid');
}

export async function readProviderAuthBinding(path:string):Promise<ProviderAuthBinding> {
  if(!isAbsolute(path) || await realpath(path)!==resolve(path)) throw Error('claude_provider_binding_invalid');
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const s=await f.stat();
    if(!s.isFile() || s.uid!==process.getuid?.() || (s.mode&0o077) || s.size>8192)
      throw Error('claude_provider_binding_invalid');
    const binding=providerAuthBindingSchema.parse(JSON.parse(await f.readFile('utf8')));
    await checkProviderContext(binding);
    return Object.freeze(binding);
  } catch { throw Error('claude_provider_binding_invalid'); }
  finally {await f.close();}
}

export function providerAccountMatches(value:unknown,binding:ProviderAuthBinding):boolean {
  if(!value || typeof value!=='object')return false;
  const a=value as Record<string,unknown>;
  // Pinned CLI2.1.295 initialization forwards the display label from pvr().
  // Personal mode intentionally asserts no organization identity; never infer it from a UUID/name.
  const accountMatches=binding.accountBinding==='personal-email-plan'
    ? binding.cliVersion==='2.1.295' && binding.subscriptionType==='max' && a.subscriptionType==='Claude Max'
    : a.organization===binding.organization && a.subscriptionType===binding.subscriptionType;
  return a.apiProvider==='firstParty' && a.email===binding.email && accountMatches &&
    (a.tokenSource===undefined || a.tokenSource==='claude.ai') &&
    (a.apiKeySource===undefined || a.apiKeySource==='none');
}

export function providerContextEnv(binding:ProviderAuthBinding):Record<string,string> {
  // The provider scopes its macOS credential service to this explicit config directory.
  // Explicit OS HOME supports native credential resolution; cwd/TMPDIR remain job-private.
  // Without opt-in, the adapter retains fresh job HOME. Never inherit ambient HOME/overrides.
  const user=userInfo();
  return {CLAUDE_CONFIG_DIR:binding.configDir,USER:user.username,LOGNAME:user.username,
    ...(binding.credentialHome==='os-user'?{HOME:user.homedir}:{})};
}

export function providerAuthPath(env:NodeJS.ProcessEnv):string|undefined {
  const mode=env.KAPELLE_CLAUDE_AUTH_MODE, path=env.KAPELLE_CLAUDE_AUTH_BINDING_FILE;
  if(mode===undefined || mode==='manager-oauth') {
    if(path!==undefined)throw Error('claude_auth_mode_required');
    return undefined;
  }
  if(mode!=='provider-managed' || !path)throw Error('claude_auth_mode_invalid');
  return path;
}
