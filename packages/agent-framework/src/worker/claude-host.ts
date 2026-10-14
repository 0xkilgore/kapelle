import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readProviderAuthBinding } from './claude-provider-auth.js';
import { RestrictedClaudeAdapter, type Query, type OAuthCredential } from './claude-adapter.js';

/** Loads the already installed Claude Agent SDK host and credential delivery; never makes a model call. */
export async function loadRestrictedClaudeAdapter(options:{managerRoot:string;cliPath:string;runtimeRoot:string;providerAuthBindingFile?:string}) {
  // Safe mode still honors managed policy hooks. An unqualified managed host must not run this adapter.
  if(process.platform!=='darwin')throw Error('claude_host_platform_not_qualified');
  for(const path of ['/Library/Application Support/ClaudeCode/managed-settings.json','/Library/Application Support/ClaudeCode/managed-settings.d','/Library/Application Support/ClaudeCode/managed-mcp.json']) {
    try {await lstat(path);throw Error('claude_managed_configuration_not_qualified');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  for (const value of [options.managerRoot,options.cliPath,options.runtimeRoot]) if (!isAbsolute(value)) throw Error('claude_explicit_host_paths_required');
  if (await realpath(options.managerRoot) !== resolve(options.managerRoot)) throw Error('claude_manager_path_invalid');
  const req = createRequire(join(options.managerRoot,'package.json'));
  const sdkPath = req.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkPackage = JSON.parse(await readFile(join(options.managerRoot,'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),'utf8'));
  const sdkHash=createHash('sha256').update(await readFile(sdkPath)).digest('hex');
  const cliHash=createHash('sha256').update(await readFile(options.cliPath)).digest('hex');
  const providerAuth=options.providerAuthBindingFile!==undefined ? await readProviderAuthBinding(options.providerAuthBindingFile) : undefined;
  // Byte pins are checked before SDK import, CLI launch, or any credential lookup.
  if(providerAuth && (providerAuth.sdkVersion!==sdkPackage.version || providerAuth.sdkSha256!==sdkHash ||
      providerAuth.cliSha256!==cliHash || await realpath(options.cliPath)!==resolve(options.cliPath)))
    throw Error('claude_provider_runtime_pin_mismatch');
  const sdk = await import(/* @vite-ignore */ pathToFileURL(sdkPath).href);
  if(typeof sdk.query!=='function')throw Error('claude_manager_contract_unavailable');
  let version=providerAuth?.cliVersion;
  let credential:((teamId:string)=>Promise<OAuthCredential|null>)|undefined;
  let credentialEnv:((credential:OAuthCredential)=>Record<string,string>)|undefined;
  if(!providerAuth) {
    const auth = await import(/* @vite-ignore */ pathToFileURL(join(options.managerRoot,'dist/lib/claude-auth-store.js')).href);
    if(typeof auth.OsKeychainClaudeCredentialStore!=='function' || typeof auth.credentialEnv!=='function')throw Error('claude_manager_contract_unavailable');
    const {stdout}=await promisify(execFile)(options.cliPath,['--version'],{timeout:5000,maxBuffer:4096});
    version=/^(\d+\.\d+\.\d+) \(Claude Code\)\s*$/.exec(stdout)?.[1];
    const store=new auth.OsKeychainClaudeCredentialStore();
    credential=(teamId:string)=>store.get(teamId);
    credentialEnv=auth.credentialEnv;
  }
  if(!version || typeof sdkPackage.version!=='string')throw Error('claude_version_unavailable');
  return new RestrictedClaudeAdapter(sdkPackage.version,version,{
    query:sdk.query as Query,credential,credentialEnv,providerAuth,
    root:options.runtimeRoot,cliPath:options.cliPath,
    processPins:await Promise.all([sdkPath,options.cliPath,process.execPath].map(async path=>({path,sha256:path===sdkPath?sdkHash:path===options.cliPath?cliHash:createHash('sha256').update(await readFile(path)).digest('hex')}))),
  });
}
