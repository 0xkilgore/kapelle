import { describe, expect, it } from 'vitest';
import type { Action } from 'document-model';
import * as actions from '../document-models/report-registry/v1/gen/creators.js';
import { reducer } from '../document-models/report-registry/v1/gen/reducer.js';
import { reducer as deployedReducer } from '../deployed-model/v1/gen/reducer.js';
import { utils } from '../document-models/report-registry/v1/utils.js';
const T0 = '2026-09-14T10:00:00.000Z', T1 = '2026-09-14T10:01:00.000Z', T2 = '2026-09-14T10:02:00.000Z';
const input = (expectedRevision: number, occurredAt = T1) => ({expectedRevision, occurredAt, actorId: 'synthetic'});
const register = (lifecycle: 'DRAFT' | 'FINAL') => actions.registerReport({id:'synthetic-replay', reportRef:'report:synthetic-replay',title:'Synthetic replay',producer:{kind:'SERVICE',id:'synthetic'},content:{storage:'INLINE_MARKDOWN',mimeType:'text/markdown',contentHash:'sha256:synthetic',byteSize:4,markdown:'Text'},lifecycle,occurredAt:T0,actorId:'synthetic'});
const scenarios: [string, Action[]][] = [
  ['historical DRAFT read, publish, first-read preservation and withdrawal', [register('DRAFT'), actions.markOpened(input(1)), actions.markRead(input(2)), actions.publishReport(input(3)), actions.requestReview({...input(4),request:'READ'}),actions.markRead(input(5,T2)),actions.withdrawReport(input(6))]],
  ['feedback duplicate validation order and route results', [register('FINAL'),actions.addFeedback({...input(1),feedbackId:'feedback',bodyMarkdown:'Keep'}),actions.addFeedback({...input(2),feedbackId:'feedback',bodyMarkdown:''}),actions.markFeedbackRouteFailed({...input(2),feedbackId:'feedback',error:'synthetic'}),actions.markFeedbackRouted({...input(3),feedbackId:'feedback',destination:'synthetic'})]],
  ['explicit non-read resolution', [register('FINAL'),actions.requestReview({...input(1),request:'APPROVE'}),actions.markRead(input(2)),actions.resolveAttention(input(3))]],
  ['dismissal remains distinct from reading', [register('FINAL'),actions.requestReview({...input(1),request:'READ'}),actions.dismissAttention(input(2)),actions.markRead(input(3))]],
  ['supersession and rejection history', [register('FINAL'),actions.supersedeReport({...input(1),supersededByRef:'report:next'}),actions.markRead(input(2))]],
];
describe('exact deployed preimage replay compatibility', () => {
  it.each(scenarios)('preserves %s', (_name, history) => {
    let candidate = utils.createDocument();
    let deployed = structuredClone(candidate);
    for (const action of JSON.parse(JSON.stringify(history)) as Action[]) {
      candidate = reducer(candidate, action);
      deployed = deployedReducer(deployed, action);
      expect(candidate.state).toStrictEqual(deployed.state);
      expect(candidate.operations).toStrictEqual(deployed.operations);
    }
  });
});
