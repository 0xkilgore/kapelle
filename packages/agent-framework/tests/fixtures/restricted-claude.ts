import type { FrameworkAuthority } from '../../src/service/authority.js';
import type { ProductionSources } from '../../src/worker/sources.js';
import type { Work } from '../../src/worker/contracts.js';
import { sha } from '../../src/worker/contracts.js';
export const work:Work = {
  dispatchId:'phid:disp-synthetic-claude',queryId:'synthetic-query',
  request:{operationId:'10000000-0000-4000-8000-000000000001',agent:'review-fixture',comment:'Review exactly this source.',
    document:{id:'20000000-0000-4000-8000-000000000002',version:1,hash:sha('Saved café 🐦\n'),
      title:'Synthetic source',project:null,mimeType:'text/markdown',content:'Saved café 🐦\n'}},
  pin:{instanceId:'30000000-0000-4000-8000-000000000003',definitionHash:'sha256:'+sha('synthetic-definition'),
    instanceRevision:1,runtimeBindingRef:'runtime:synthetic-claude',scopeRef:'synthetic-owner',targetUrl:'http://127.0.0.1:1'},
};
export function fixtureSources() {
  const binding={ref:work.pin.runtimeBindingRef,instanceId:work.pin.instanceId,agent:work.request.agent,
    contract:'kapelle.document-review/v1',modelProfile:'synthetic-claude',model:'synthetic-claude',runtime:'claude-agent-sdk',
    credentialKind:'claude-code-oauth',credentialTeamId:'40000000-0000-4000-8000-000000000004',
    budgetRef:'synthetic-oauth-budget',maxInputBytes:64000,maxOutputTokens:1000,maxBudgetUsd:.5,timeoutMs:5000};
  let revision=1;
  const authority={options:{ownerId:'synthetic-owner',scopeRef:'synthetic-owner'},
    admission:async()=>({...work.pin,instanceId:work.pin.instanceId}),
    read:async()=>({state:{global:{revision,modelPolicy:{preferredProfile:binding.modelProfile,budgetPolicyRef:binding.budgetRef,paidFallback:false},skills:[]}}}),
  } as unknown as FrameworkAuthority;
  const sources={profile:async()=>({bindings:[binding],releases:[{release:{contentHash:work.pin.definitionHash,instructions:{id:'role'},skills:[]}}]}),
    read:async()=>work.request.document,asset:async()=>'Pinned role instructions.\n',
  } as unknown as ProductionSources;
  return {authority,sources,binding,changeInstance:()=>{revision++;}};
}
