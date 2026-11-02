/** Deterministic child fixture. No provider/network/live database. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {openFrameworkRuntime} from '../../src/service/runtime.js';
import {TaskWorker} from '../../src/task-delegation/worker.js';
const c=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(c.synthetic!==true)throw Error('synthetic fixture required');
const runtime=await openFrameworkRuntime({...c.options,now:()=>c.now,facts:async()=>c.facts,taskDelegation:{permissionRef:'task-delegation:owner',readTask:async(id:string)=>{if(id!==c.task.id)throw Error('Task unavailable');return c.task;}}});
const worker=TaskWorker.open(c.workerRoot,runtime.authority,c.binding,{packet:async()=>c.packet,provider:{
 sdkVersion:c.binding.inference.sdkVersion,cliVersion:c.binding.inference.cliVersion,
 async run(){writeFileSync(join(c.workerRoot,'synthetic-invocation'),'1',{mode:0o600,flag:'wx'});await runtime.close();process.exit(73);},
}});
await worker.run(c.dispatchId);
throw Error('crash fixture failed');
