import { describe, expect, it } from 'vitest';
import { taskResultFixture, taskResultBoundaryFixture } from './task-result-context-fixture.js';
import { dispatchOfferHash, instructionsHash } from '../src/dispatch/contracts.js';
import { TaskResultContextReader, taskResultBindingSchema, taskResultContextEnvelope,
  TASK_RESULT_MAX_ENVELOPE_BYTES, TASK_RESULT_MAX_OFFERED_PINS, TASK_RESULT_MAX_RESOLVED_INPUTS } from '../src/publication/task-result-context.js';
import { contextReceiptSchema } from '../src/publication/context-read-contracts.js';
import { publicationDecisionHandler } from '../src/publication/decision-http.js';

function acceptText(f: ReturnType<typeof taskResultFixture>, text: string, updateInstructionPin = true) {
  const offer = f.state.dispatch.offer;
  offer.instructions = text;
  offer.instructionsHash = instructionsHash(text);
  offer.contentHash = dispatchOfferHash(offer);
  f.state.dispatch.acceptance.inputHash = offer.contentHash;
  f.binding.producer.offerHash = offer.contentHash;
  if (updateInstructionPin) f.binding.producer.instructionsHash = offer.instructionsHash;
}

describe('binding and limit repairs', () => {
  it('requires an independently pinned instructions hash; old bindings are not adopted', () => {
    const f = taskResultFixture();
    const legacy = structuredClone(f.binding) as any;
    delete legacy.producer.instructionsHash;
    expect(taskResultBindingSchema.safeParse(legacy).success).toBe(false);
    expect(() => new TaskResultContextReader(legacy, f.ports)).toThrow();
    expect(f.calls).toEqual([]);
  });

  it('refuses substituted text with recomputed selfhash, offer hash and acceptance', async () => {
    const f = taskResultFixture();
    f.binding.context = null;
    // Even a coherently replaced offer pin cannot silently replace the independent text pin.
    acceptText(f, 'Substituted instructions with a matching selfhash.', false);
    const result = await f.reader().read();
    expect(result.instructions.availability).toBe('CHANGED');
    expect(result.instructions.data).toBeNull();
    expect(f.calls).not.toContain('instance');
  });

  it('accepts seventeen offered pins including the manifest and sixteen resolved inputs', async () => {
    const f = taskResultBoundaryFixture(), result = await f.reader().read();
    expect(TASK_RESULT_MAX_OFFERED_PINS).toBe(17);
    expect(TASK_RESULT_MAX_RESOLVED_INPUTS).toBe(16);
    expect(result.originalRun.availability).toBe('VERIFIED');
    expect(result.context.data?.offered).toHaveLength(17);
    expect(result.context.data?.resolved.availability).toBe('VERIFIED');
    expect(result.context.data?.resolved.data?.inputs).toHaveLength(16);
    // Seventeen resolved inputs cannot fit the saved-context receipt format.
    expect(contextReceiptSchema.safeParse({ ...f.state.receipt,
      entries: [...f.state.receipt.entries, f.state.receipt.entries[0]] }).success).toBe(false);
  });

  it('refuses eighteen offered pins even when the offer and acceptance are rehashed', async () => {
    const f = taskResultBoundaryFixture();
    f.binding.context = null;
    f.state.dispatch.offer.sources.push({ ...f.state.dispatch.offer.sources[1], documentRef: 'extra-input' });
    acceptText(f, f.state.dispatch.offer.instructions);
    const result = await f.reader().read();
    expect(result.originalRun.availability).toBe('CHANGED');
    expect(result.context.data).toBeNull();
  });

  it('uses the full UTF-8 envelope budget at exactly 64KiB and refuses the next byte', async () => {
    const f = taskResultFixture();
    f.binding.context = null;
    acceptText(f, 'x');
    const baseline = await f.reader().read();
    const remaining = TASK_RESULT_MAX_ENVELOPE_BYTES - Buffer.byteLength(JSON.stringify(taskResultContextEnvelope(baseline)));
    // Escaping makes the serialized text larger than its accepted 32KiB raw-text cap.
    const text = 'x' + '"'.repeat(Math.floor(remaining / 2)) + 'a'.repeat(remaining % 2);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32768);
    acceptText(f, text);
    const reader = f.reader(), result = await reader.read();
    expect(Buffer.byteLength(JSON.stringify(taskResultContextEnvelope(result)))).toBe(65536);
    const token = 'synthetic-owner-token-'.repeat(3);
    const invoke = async (projectionReader: TaskResultContextReader) => {
      let status = 0, body = '';
      const handler = publicationDecisionHandler({options:{ownerId:f.binding.ownerId,scopeRef:f.binding.scopeRef}} as any,
        {manifest:f.publication.m,reviewDocumentId:f.binding.reviewId,instanceId:'publication-instance',token:()=>token,taskResultContext:projectionReader});
      await handler({url:'/task-result-context',method:'GET',headers:{authorization:`Bearer ${token}`}} as any,
        {writeHead:(value:number)=>{status=value;},end:(value:string)=>{body=value;}} as any);
      return {status,body};
    };
    const exact = await invoke(reader);
    expect(exact.status).toBe(200);
    expect(Buffer.byteLength(exact.body)).toBe(65536);
    acceptText(f, text + 'a');
    await expect(f.reader().read()).rejects.toMatchObject({reasonCode:'RESPONSE_SIZE_EXCEEDED'});
    expect((await invoke(f.reader())).status).toBe(503);
    // Defense at HTTP boundary also refuses an injected reader's oversized projection.
    result.instructions.data!.text += 'é';
    expect(() => taskResultContextEnvelope(result)).toThrow('RESPONSE_SIZE_EXCEEDED');
    expect((await invoke({binding:reader.binding,read:async()=>result} as TaskResultContextReader)).status).toBe(503);
  });
});
