import {it,expect} from 'vitest';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {realpathSync} from 'node:fs';
import {taskDelegationFixture} from './task-delegation-fixture.js';
import {TaskProposals} from '../src/task-delegation/proposals.js';
import {openTaskExecutionHost} from '../src/task-delegation/host.js';
import {taskRuntimeProfileSchema} from '../src/task-delegation/runtime.js';
import {packetTaskNotes,taskCapabilityHash,reportResultFact,type TaskWorkerBinding,type TaskReportReceipt} from '../src/task-delegation/worker-contract.js';
import {sha} from '../src/worker/contracts.js';
import {digest} from '../src/content.js';
import {policy} from './fixtures.js';
const enabled=process.env.KAPELLE_SCOPED_REACTOR_ROOT&&process.env.KAPELLE_PLATFORM_MODELS_ROOT;
it.skipIf(!enabled)('one host retains distinct exact Task grants across execution, restart and revocation',async()=>{
 const f=await taskDelegationFixture();let host:ReturnType<typeof openTaskExecutionHost>|undefined,server:ReturnType<typeof createServer>|undefined;
 try{
  const ids=[f.platform.taskId,await f.addTask('Second synthetic Task')];
  const packets=new Map<string,any>(),pins:Record<string,string>={},dispatches:string[]=[];
  let recipient:any;
  for(const [i,id] of ids.entries()){
   const text='Synthetic evidence '+i,packet={contract:'kapelle.task-source-packet/v1' as const,sources:[{document:{id:randomUUID(),title:'Evidence '+i,version:1,hash:sha(text),content:text,mimeType:'text/markdown' as const,project:null},reference:'fixture:'+i,capturedAt:f.ctx.occurredAt}]};
   packets.set(digest(packet),packet);
   const task=await f.readTask(id);await f.platform.act(id,'updateBody',{expectedRevision:task.revision,bodyMarkdown:packetTaskNotes(packet,'Prepare report '+i)},'owner');
   const roster=await f.authority.taskDelegationAgents(id);recipient=roster.agents.find(a=>a.id===f.instance)!.recipient!;pins[id]=recipient.capabilityHash;
   const api=new TaskProposals(f.authority),op=randomUUID(),proposal=(await api.create({operationId:op,draft:{operationId:op,taskId:id,revision:roster.task.revision,sourceHash:roster.task.sourceHash,agentId:f.instance,recipient,includeNotes:true,includeComments:false,includeReferences:false,instructions:'Prepare report '+i}}))!;
   dispatches.push((await api.approveAndSend(proposal.proposalId,{operationId:randomUUID(),expectedRevision:proposal.revision,version:1,planHash:proposal.versions[0].planHash})).item!.dispatchId);
  }
  expect(pins[ids[0]]).not.toBe(pins[ids[1]]);
  const binding:TaskWorkerBinding={ownerId:'owner',scopeRef:f.ctx.scopeRef,instanceId:f.instance,runtimeBindingRef:recipient.runtimeBindingRef,definitionHash:recipient.definitionHash,capabilityHash:pins[ids[0]],taskCapabilityHashes:pins,modelProfile:policy.preferredProfile,budgetPolicyRef:policy.budgetPolicyRef,inference:{model:'synthetic',credentialTeamId:randomUUID(),credentialKind:'claude-code-oauth',runtime:'claude-agent-sdk',sdkVersion:'fixture',cliVersion:'fixture',maxOutputTokens:1024,maxBudgetUsd:1,timeoutMs:5000,tools:[],settings:'isolated',thinking:'adaptive',effort:'high'}};
  const profile={contract:'kapelle.task-runtime-profile/v1',expiresAt:'2026-09-11T00:00:00.000Z',permissionRef:'task-delegation:owner',publisherBindingRef:'fixture',binding,packets:ids.map((id,i)=>({taskId:id,hash:[...packets.keys()][i],path:'/private/fixture-'+i}))};
  expect(taskRuntimeProfileSchema.safeParse(profile).success).toBe(true);
  expect(taskRuntimeProfileSchema.safeParse({...profile,binding:{...binding,taskCapabilityHashes:undefined}}).success).toBe(false);
  expect(taskRuntimeProfileSchema.safeParse({...profile,binding:{...binding,taskCapabilityHashes:{...pins,extra:'a'.repeat(64)}}}).success).toBe(false);
  expect(()=>taskCapabilityHash(binding,'unadmitted')).toThrow('not_admitted');
  const records=new Map<string,{receipt:TaskReportReceipt,markdown:string}>();let invocations=0,publications=0;
  const ports:any={packet:async(hash:string)=>packets.get(hash),provider:{sdkVersion:'fixture',cliVersion:'fixture',async run(input:any,sessionId:string,_signal:any,capture:any){invocations++;const text='Synthetic report '+invocations;capture.runtime({provider:'anthropic',runtime:'claude-agent-sdk',model:input.model,sessionId,sdkVersion:'fixture',cliVersion:'fixture',tools:[]});capture.output({text,contentHash:sha(text),byteSize:Buffer.byteLength(text),stopReason:'end_turn',resultId:'fixture-'+invocations,costUsd:0});}},reports:{bindingRef:'fixture',admitted:async()=>true,async publish(request:any){publications++;const id=await f.platform.report(request.markdown,request.sourceRef,request.instanceId),doc:any=await f.platform.coldRead(id),s=doc.state.global;const receipt={publicationId:request.publicationId,dispatchId:request.dispatchId,inputHash:request.inputHash,reportId:id,contentVersion:1,contentHash:s.content.contentHash,verificationRef:'fixture:'+id};records.set(id,{receipt,markdown:request.markdown});f.setResultFact(reportResultFact(receipt));return receipt;},async lookup(){throw Error('unexpected lookup');},async read(receipt:TaskReportReceipt){const record=records.get(receipt.reportId)!,doc:any=await f.platform.coldRead(receipt.reportId),s=doc.state.global;return {id:receipt.reportId,ownerId:binding.ownerId,scopeRef:binding.scopeRef,reportRef:s.reportRef,sourceRef:s.sourceRef,bytes:Buffer.from(record.markdown),revision:s.revision,contentVersion:1,publicationId:receipt.publicationId,dispatchId:receipt.dispatchId,inputHash:receipt.inputHash,producerId:s.producer.id,verificationRef:receipt.verificationRef};}}};
  const root=join(realpathSync(f.root),'multi-worker');
  async function start(){host=openTaskExecutionHost({root,authority:f.authority,binding,ports,token:()=>f.token,admitted:async id=>ids.includes(id)});server=createServer(host.handler);await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));return 'http://127.0.0.1:'+(server!.address() as any).port;}
  async function stop(){if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));server=undefined;}host?.close();host=undefined;}
  let origin=await start();const headers={authorization:'Bearer '+f.token,'content-type':'application/json'};
  for(const [i,id] of ids.entries()){
   expect(await (await fetch(origin+'/task-executions/admission?taskId='+id,{headers})).json()).toMatchObject({ready:true});
   expect(await (await fetch(origin+'/task-executions/'+dispatches[i]+'/run',{method:'POST',headers,body:'{}'})).json()).toMatchObject({item:{status:'REPORT_PUBLISHED'}});
  }
  await stop();
  expect(()=>openTaskExecutionHost({root,authority:f.authority,binding:{...binding,taskCapabilityHashes:{...pins,[ids[0]]:pins[ids[1]]}},ports,token:()=>f.token,admitted:async()=>true})).toThrow('worker_binding_changed');
  expect(()=>openTaskExecutionHost({root,authority:f.authority,binding:{...binding,taskSourceOwnerId:'other-owner'},ports,token:()=>f.token,admitted:async()=>true})).toThrow('worker_binding_changed');
  await f.restart();origin=await start();
  for(const dispatch of dispatches)expect(await (await fetch(origin+'/task-executions/'+dispatch+'/run',{method:'POST',headers,body:'{}'})).json()).toMatchObject({item:{status:'REPORT_PUBLISHED'}});
  expect(invocations).toBe(2);expect(publications).toBe(2);
  await f.command(f.instance,'kapelle/agent-instance','REVOKE_CAPABILITY',{grantId:'grant:'+ids[1]});
  expect(await (await fetch(origin+'/task-executions/admission?taskId='+ids[1],{headers})).json()).toMatchObject({ready:false});
  expect(await (await fetch(origin+'/task-executions/admission?taskId='+ids[0],{headers})).json()).toMatchObject({ready:true});
  expect((await fetch(origin+'/task-executions/'+dispatches[1]+'/run',{method:'POST',headers,body:'{}'})).status).toBe(503);
  expect(invocations).toBe(2);expect(publications).toBe(2);
  for(const id of ids)expect((await f.readTask(id)).status).toBe('OPEN');
  await stop();
 }finally{if(server){server.closeAllConnections();await new Promise<void>(r=>server!.close(()=>r()));}host?.close();await f.close();}
},120000);
