import { RestrictedWorker } from '../../src/worker/worker.js';
import { fixtureSources, work } from './restricted-claude.js';
import type { ClaudeAdapter } from '../../src/worker/execution.js';
import { sha } from '../../src/worker/contracts.js';
const {authority,sources}=fixtureSources();
const adapter:ClaudeAdapter={sdkVersion:'fake-sdk',cliVersion:'fake-cli',async run(input,sessionId,_signal,capture){
  capture.runtime({runtime:'claude-agent-sdk',provider:'anthropic',model:input.model,sessionId,sdkVersion:'fake-sdk',cliVersion:'fake-cli',tools:[]});
  if(process.argv[3]==='returned')capture.output({text:'Unchanged completed output\n',contentHash:sha('Unchanged completed output\n'),byteSize:Buffer.byteLength('Unchanged completed output\n'),stopReason:'end_turn',resultId:'fake-result',costUsd:0});
  process.stdout.write('DURABLE\n');
  await new Promise<void>(()=>{setInterval(()=>{},1000);});
}};
const worker=await RestrictedWorker.open(process.argv[2],authority,sources,fetch,adapter);
await worker.run(work);
