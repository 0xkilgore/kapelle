/** Explicitly synthetic, isolated native lifecycle for Product's browser qualification. */
import { taskDelegationFixture } from '../tests/task-delegation-fixture.js';
import {syntheticTaskPlanProducer} from '../tests/fixtures/task-plan-producer.js';
const producer=process.env.KFB016_SYNTHETIC_GENERATION==='1'?syntheticTaskPlanProducer():undefined;
import {taskWorkerComposition} from '../tests/fixtures/task-worker-composition.js';
const f=await taskDelegationFixture(producer);
const composition=await taskWorkerComposition(f);
const url=await f.serve(Number(process.env.KFB016_FIXTURE_PORT??4496),true);
console.log(JSON.stringify({synthetic:true,generationProducer:producer?.identity??null,worker:composition.state(),url,token:f.token,taskId:f.platform.taskId,agentId:f.instance,stateRoot:f.root}));
let stopping=false;for(const sig of ['SIGINT','SIGTERM'] as const)process.on(sig,async()=>{if(stopping)return;stopping=true;await composition.close();process.exit(0);});
