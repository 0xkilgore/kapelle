/** Isolated qualification helper: reopen an existing synthetic authority in a new process. */
import { readFileSync } from 'node:fs';
import { openFrameworkRuntime } from '../src/service/runtime.js';
import { TaskDelegations } from '../src/task-delegation/adapter.js';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(config.synthetic!==true)throw Error('Synthetic fixture required');
const runtime=await openFrameworkRuntime({...config.options,now:()=>config.now,facts:async()=>config.facts,taskDelegation:{permissionRef:'task-delegation:owner',readTask:async(id:string)=>{if(id!==config.task.id)throw Error('Task unavailable');return config.task;}}});
try{console.log('COLD_RECEIPT='+JSON.stringify(await new TaskDelegations(runtime.authority).lookup(config.operationId)));}finally{await runtime.close();}
