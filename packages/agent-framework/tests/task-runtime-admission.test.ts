import {describe,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync,chmodSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {TaskRuntimeAdmission} from '../src/task-delegation/runtime.js';
import {digest} from '../src/content.js';
import {sha} from '../src/worker/contracts.js';
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'task-runtime-')),path=join(root,'profile.json'),packetPath=join(root,'packet.json');
 const packet={contract:'kapelle.task-source-packet/v1',sources:[{document:{id:randomUUID(),version:1,hash:sha('evidence'),title:'Fixture',project:null,mimeType:'text/markdown',content:'evidence'},reference:'fixture:evidence',capturedAt:'2026-10-06T00:00:00.000Z'}]};
 const binding={ownerId:'owner',scopeRef:'scope',instanceId:'pipeline',runtimeBindingRef:'runtime',definitionHash:digest('release'),capabilityHash:'a'.repeat(64),modelProfile:'profile',budgetPolicyRef:'budget',inference:{model:'fixture',credentialTeamId:randomUUID(),credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'fixture',cliVersion:'fixture',maxOutputTokens:1000,maxBudgetUsd:1,timeoutMs:1000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'}};
 const profile={contract:'kapelle.task-runtime-profile/v1',expiresAt:'2026-10-07T00:00:00.000Z',permissionRef:'task-delegation:owner',publisherBindingRef:'publisher',binding,packets:[{taskId:'task',hash:digest(packet),path:packetPath}]};
 const save=()=>writeFileSync(path,JSON.stringify(profile),{mode:0o600});save();writeFileSync(packetPath,JSON.stringify(packet),{mode:0o600});
 return {root,path,packetPath,packet,profile,save,load:()=>TaskRuntimeAdmission.load(path,()=> '2026-10-06T00:00:00.000Z'),close:()=>rmSync(root,{recursive:true,force:true})};
}
describe('host-owned Task packet admission',()=>{
 it('reads only the exact admitted Task/hash/binding and rejects content substitution',async()=>{
  const f=fixture();try{const a=await f.load(),b=a.profile.binding,h=digest(f.packet);
   expect(await a.packet('task',h,b)).toEqual(f.packet);
   await expect(a.packet('other',h,b)).rejects.toThrow('not_admitted');
   await expect(a.packet('task',h,{...b,instanceId:'other'})).rejects.toThrow('binding_changed');
   writeFileSync(f.packetPath,JSON.stringify({...f.packet,sources:[]}));await expect(a.packet('task',h,b)).rejects.toThrow();
  }finally{f.close();}
 });
 it('revocation/expiry require a reviewed restart and fail closed',async()=>{
  const f=fixture();try{const a=await f.load();f.profile.publisherBindingRef='changed';f.save();await expect(a.current()).rejects.toThrow('changed_or_expired');
   f.profile.expiresAt='2026-10-05T00:00:00.000Z';f.save();await expect(f.load()).rejects.toThrow('changed_or_expired');
  }finally{f.close();}
 });
 it('refuses public profile and symlink packet',async()=>{
  const f=fixture();try{chmodSync(f.path,0o644);await expect(f.load()).rejects.toThrow('private_file');chmodSync(f.path,0o600);
   const alias=join(f.root,'alias');symlinkSync(f.packetPath,alias);f.profile.packets[0].path=alias;f.save();const a=await f.load();await expect(a.packet('task',digest(f.packet),a.profile.binding)).rejects.toThrow();
  }finally{f.close();}
 });
});
