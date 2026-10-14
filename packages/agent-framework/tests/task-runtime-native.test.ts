import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {digest} from '../src/content.js';
import {sha} from '../src/worker/contracts.js';
import {TaskSourceClient} from '../src/task-delegation/task-client.js';
import {openTaskRuntime} from '../src/task-delegation/runtime.js';
import {packetTaskNotes,type TaskWorkerBinding,type TaskSourcePacket} from '../src/task-delegation/worker-contract.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {taskDelegationFixture} from './task-delegation-fixture.js';
import {privateTaskPublisherFixture} from './fixtures/private-task-publisher.js';
import {policy} from './fixtures.js';
const enabled=process.env.KAPELLE_SCOPED_REACTOR_ROOT&&process.env.KAPELLE_PLATFORM_MODELS_ROOT&&process.env.KAPELLE_TASK_PUBLISHER_ROOT;
describe.skipIf(!enabled)('Task runtime composition over native authority and real publisher library',()=>{
 it.each([undefined,'source-owner'])('serves admitted sources, executes once, independently records result; restart/read loss never republishes (source owner %s)',async(sourceOwnerId)=>{
  const f=await taskDelegationFixture(),pub=await privateTaskPublisherFixture();
  try{
   const root=realpathSync(f.root),text='Synthetic supplied evidence';
   const packet:TaskSourcePacket={contract:'kapelle.task-source-packet/v1',sources:[{document:{id:randomUUID(),title:'Evidence',version:1,hash:sha(text),content:text,mimeType:'text/markdown',project:null},reference:'fixture:evidence',capturedAt:f.ctx.occurredAt}]};
   const task=await f.readTask(f.platform.taskId);
   await f.platform.act(task.id,'updateBody',{expectedRevision:task.revision,bodyMarkdown:packetTaskNotes(packet,'Prepare a decision brief')},'owner');
   const roster=await f.authority.taskDelegationAgents(task.id),pin=roster.agents.find(a=>a.id===f.instance)!.recipient!;
   const b:TaskWorkerBinding={...(sourceOwnerId?{taskSourceOwnerId:sourceOwnerId}:{}),ownerId:'owner',scopeRef:f.ctx.scopeRef,instanceId:f.instance,runtimeBindingRef:pin.runtimeBindingRef,definitionHash:pin.definitionHash,capabilityHash:pin.capabilityHash,modelProfile:policy.preferredProfile,budgetPolicyRef:policy.budgetPolicyRef,inference:{model:'synthetic',credentialTeamId:randomUUID(),credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'fixture',cliVersion:'fixture',maxOutputTokens:1024,maxBudgetUsd:1,timeoutMs:5000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'}};
   const proposals=new TaskProposals(f.authority),op=randomUUID();
   const proposal=(await proposals.create({operationId:op,draft:{operationId:op,taskId:task.id,revision:roster.task.revision,sourceHash:roster.task.sourceHash,agentId:f.instance,recipient:pin,includeNotes:true,includeComments:false,includeReferences:false,instructions:'Prepare a decision brief'}}))!;
   const dispatch=(await proposals.approveAndSend(proposal.proposalId,{operationId:randomUUID(),expectedRevision:proposal.revision,version:1,planHash:proposal.versions[0].planHash})).item!;
   const packetPath=join(root,'packet.json'),profilePath=join(root,'profile.json');
   const profile={contract:'kapelle.task-runtime-profile/v1',expiresAt:'2026-09-11T00:00:00.000Z',permissionRef:'task-delegation:owner',publisherBindingRef:'fixture-publisher',binding:b,packets:[{taskId:task.id,hash:digest(packet),path:packetPath}]};
   writeFileSync(packetPath,JSON.stringify(packet),{mode:0o600});writeFileSync(profilePath,JSON.stringify(profile),{mode:0o600});
   const author={id:f.instance,label:'Fixture',instanceId:f.instance,definitionId:pin.definitionId,definitionVersion:pin.definitionVersion,definitionHash:pin.definitionHash};
   const publisher=new pub.PrivateTaskReportPublisher({bindingRef:'fixture-publisher',receiptDir:join(root,'receipts'),lockDir:join(root,'publication-locks'),mcp:pub.mcp,...(pub.modelAdmission?{modelAdmission:pub.modelAdmission}:{}),reader:pub.reader,authorize:async()=>({bindingRef:'fixture-publisher',ownerId:b.ownerId,scopeRef:b.scopeRef,driveId:'drive',actorId:'publisher-actor',authorizationRef:'fixture:authorization',libraryOrigin:'https://private.example',author,publisher:{...author,id:'publisher',instanceId:'publisher'}})});
   let calls=0;
   await f.offline(async(raw)=>{
    const cfg=raw as any;cfg.task={...cfg.task,ownerId:sourceOwnerId??'owner'};let taskReadable=true;
    const options={runtime:{...cfg.options,now:()=>cfg.now,facts:async()=>cfg.facts},profilePath,workerRoot:join(root,'composed-worker'),token:()=>f.token,
     taskSource:new TaskSourceClient('http://127.0.0.1:4261','owner',()=>f.token,async()=>taskReadable?Response.json(cfg.task):new Response(null,{status:403}),sourceOwnerId??'owner'),publisher,
     claudeHost:{managerRoot:'/unused',cliPath:'/unused',runtimeRoot:'/unused'},
     provider:{sdkVersion:'fixture',cliVersion:'fixture',async run(input:any,sessionId:string,_signal:any,capture:any){calls++;const output='Synthetic decision brief';capture.runtime({provider:'anthropic',runtime:'claude-agent-sdk',model:input.model,sessionId,sdkVersion:'fixture',cliVersion:'fixture',tools:[]});capture.output({text:output,contentHash:sha(output),byteSize:Buffer.byteLength(output),stopReason:'end_turn',resultId:'fixture',costUsd:0});}}};
    let host=await openTaskRuntime(options);
    async function withServer(run:(url:string)=>Promise<void>){const server=createServer(host.handler);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));try{await run('http://127.0.0.1:'+(server.address() as any).port);}finally{await new Promise<void>(r=>server.close(()=>r()));}}
    const headers={authorization:'Bearer '+f.token,'content-type':'application/json'};
    try{
     await withServer(async url=>{
      expect((await fetch(url+'/task-executions/admission?taskId='+task.id)).status).toBe(403);
      expect(await (await fetch(url+'/task-executions/sources?taskId='+task.id,{headers})).json()).toMatchObject({ready:true,packet});
      const done=await (await fetch(url+'/task-executions/'+dispatch.dispatchId+'/run',{method:'POST',headers,body:'{}'})).json() as any;
      expect(done.item.status).toBe('REPORT_PUBLISHED');expect(calls).toBe(1);
     });
     const writes=pub.counts().writes;await host.close();host=await openTaskRuntime(options);
     await withServer(async url=>{
      const inspect=()=>fetch(url+'/task-executions/'+dispatch.dispatchId,{headers}).then(r=>r.json()) as Promise<any>;
      expect((await inspect()).item.status).toBe('REPORT_PUBLISHED');
      pub.readerAvailable(false);expect((await inspect()).item.status).toBe('REPORT_PENDING');
      pub.readerAvailable(true);expect((await inspect()).item.status).toBe('REPORT_PUBLISHED');
      const read=()=>fetch(url+'/task-executions/'+dispatch.dispatchId,{headers});
      const run=()=>fetch(url+'/task-executions/'+dispatch.dispatchId+'/run',{method:'POST',headers,body:'{}'});
      const originalTask=structuredClone(cfg.task);
      cfg.task={...cfg.task,revision:cfg.task.revision+1,bodyMarkdown:'Owner edited the notes after execution'};
      expect((await read()).status).toBe(200);expect((await inspect()).item.status).toBe('REPORT_PUBLISHED');
      expect((await run()).status).toBe(503);
      cfg.task=originalTask;
      async function instanceCommand(type:string,input:Record<string,unknown>){
       const d=await host.authority.read(f.instance,'kapelle/agent-instance');
       const result=await host.authority.command({operationId:randomUUID(),documentId:f.instance,documentType:'kapelle/agent-instance',expectedRevision:d.state.global.revision,type,input});
       expect(result.result.disposition).toBe('ACCEPTED');
      }
      await instanceCommand('REQUEST_PAUSE',{});
      expect((await read()).status).toBe(200);expect((await inspect()).item.status).toBe('REPORT_PUBLISHED');
      expect((await run()).status).toBe(503);
      await instanceCommand('REQUEST_RESUME',{});
      cfg.task={...originalTask,ownerId:'different-owner'};expect((await read()).status).toBe(403);cfg.task=originalTask;
      taskReadable=false;expect((await read()).status).toBe(403);taskReadable=true;
      expect((await read()).status).toBe(200);
      await instanceCommand('REVOKE_CAPABILITY',{grantId:'grant:'+task.id});
      expect((await read()).status).toBe(403);expect((await run()).status).toBe(503);
      profile.expiresAt='2026-09-09T00:00:00.000Z';writeFileSync(profilePath,JSON.stringify(profile));
      expect((await fetch(url+'/task-executions/'+dispatch.dispatchId+'/run',{method:'POST',headers,body:'{}'})).status).toBe(503);
     });
     expect(calls).toBe(1);expect(pub.counts().writes).toBe(writes);
    }finally{await host.close();}
   });
   expect((await f.platform.task()).status).toBe('OPEN');
  }finally{pub.close();await f.close();}
 },120000);
});
