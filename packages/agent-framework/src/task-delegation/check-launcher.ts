import { providerAuthPath } from '../worker/claude-provider-auth.js';
/** Offline config/source/credential validation only. No listener, provider load,
 * native store open, provisioning, model invocation or MCP request. */
import {join} from 'node:path';
import {TaskRuntimeAdmission} from './runtime.js';
import {prepareTaskLauncher,privateToken} from './launcher.js';
const env=(name:string)=>{const v=process.env[name];if(!v)throw Error('Missing '+name);return v;};
const config=env('KAPELLE_TASK_LAUNCHER_CONFIG'),root=env('KAPELLE_FRAMEWORK_STATE_ROOT');
const token=await privateToken(env('KAPELLE_FRAMEWORK_AUTHORITY_TOKEN_FILE'));
const options=await prepareTaskLauncher(config,{
 runtime:{stateRoot:join(root,'native'),reactorRoot:env('KAPELLE_SCOPED_REACTOR_ROOT'),ownerId:env('KAPELLE_FRAMEWORK_OWNER'),scopeRef:env('KAPELLE_FRAMEWORK_SCOPE'),facts:async()=>{throw Error('offline_check_has_no_live_facts');}},
 workerRoot:join(root,'task-worker'),token:()=>token,
 claudeHost:{managerRoot:env('KAPELLE_CLAUDE_MANAGER_ROOT'),cliPath:env('KAPELLE_CLAUDE_CLI_PATH'),providerAuthBindingFile:providerAuthPath(process.env),runtimeRoot:join(root,'task-claude-runtime')},
});
const profile=(await TaskRuntimeAdmission.load(options.profilePath)).profile;
const admission=await TaskRuntimeAdmission.load(options.profilePath);
for(const p of profile.packets)await admission.packet(p.taskId,p.hash,profile.binding);
console.log(JSON.stringify({status:'CONFIG_AND_SOURCE_VALID',taskCount:profile.packets.length,productionChanges:false,providerQualified:false,nativeGrantsVerified:false,todayVerified:false}));
