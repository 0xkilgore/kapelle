/** Deterministic Product fixture only. No inference, network or live credentials.
 * Receipts survive browser refresh, not fixture-process replacement; absent lookup stays uncertain.
 */
import {canonical,digest} from '../../src/content.js';
import {planSchema} from '../../src/task-delegation/proposal-contract.js';
import type {TaskProposalProducer,GenerationReceipt} from '../../src/task-delegation/generation-contract.js';
export function syntheticTaskPlanProducer():TaskProposalProducer {
 const identity={id:'synthetic-comment-plan-producer',version:'deterministic-v1',configHash:digest({fixture:'comment-as-instructions',version:1})};
 const receipts=new Map<string,{inputHash:string;receipt:GenerationReceipt}>();
 return {identity,timeoutMs:5000,
  admitted:async input=>canonical(input.producer)===canonical(identity)&&input.plan.effectLimit==='PREPARE_ONLY',
  async generate(input,invocationId,signal){
   signal.throwIfAborted();const inputHash=digest(input),old=receipts.get(invocationId);
   if(old){if(old.inputHash!==inputHash)throw Error('synthetic input conflict');return old.receipt;}
   const receipt={producer:identity,inputHash,resultId:'synthetic:'+invocationId,plan:planSchema.parse({
    recommendedAction:'Revise the research plan using the owner feedback and the saved source context.',
    instructions:input.comment,deliverable:'A concise Report with findings, supplied source references and open questions.',effectLimit:'PREPARE_ONLY',
   })};receipts.set(invocationId,{inputHash,receipt});return receipt;
  },
  async lookup(input,invocationId){const old=receipts.get(invocationId);if(old&&old.inputHash!==digest(input))throw Error('synthetic input conflict');return old?.receipt??null;},
 };
}
