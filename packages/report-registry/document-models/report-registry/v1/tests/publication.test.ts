import { describe, it, expect } from "vitest";
import { registerReport } from "../gen/content/creators.js";
import { markRead } from "../gen/attention/creators.js";
import { reducer } from "../gen/reducer.js";
import { utils } from "../utils.js";
const at = "2026-09-24T20:00:00.000Z";
const agent = {id:"author",label:"Research author",instanceId:"author-instance",definitionId:"research-definition",definitionVersion:"1",definitionHash:"b".repeat(64)};
const publication = {publicationId:"publication:fixture",author:agent,publisher:{...agent,id:"publisher",label:"Publishing agent",instanceId:"publisher-instance"},runRef:"run:fixture",sourceRef:"source:fixture",provenanceRef:"provenance:fixture",contentHash:"a".repeat(64),contentVersion:1,authorizationRef:"authorization:fixture",publishedAt:at};
const input = {id:"report-fixture",reportRef:"report:fixture",title:"Research",sourceRef:"source:fixture",producer:{kind:"AGENT" as const,id:"author",label:"Research author"},content:{storage:"INLINE_MARKDOWN" as const,mimeType:"text/markdown",contentHash:"a".repeat(64),byteSize:5,markdown:"hello"},lifecycle:"FINAL" as const,actorId:"service:publisher",occurredAt:at};
describe("native agent Report publication",()=>{
 it("retains distinct snapshots and native registration operation across serialization and review",()=>{
  const action=registerReport({...input,publication}); let doc=reducer(utils.createDocument(),action);
  expect(doc.operations.global.at(-1)?.error).toBeFalsy();expect(doc.state.global.publication).toEqual(publication);
  expect(doc.state.global.createdBy).toBe("service:publisher");expect(doc.operations.global[0].action.id).toBe(action.id);
  doc=reducer(JSON.parse(JSON.stringify(doc)),markRead({expectedRevision:1,actorId:"owner",occurredAt:at}));
  expect(doc.state.global.publication).toEqual(publication);
 });
 it("retains unknown instance and definition snapshots as null",()=>{
  const unknown={id:"author",label:"Claude Code",instanceId:null,definitionId:null,definitionVersion:null,definitionHash:null};
  const doc=reducer(utils.createDocument(),registerReport({...input,publication:{...publication,author:unknown,publisher:unknown}}));
  expect(doc.operations.global.at(-1)?.error).toBeFalsy();expect(doc.state.global.publication?.author).toEqual(unknown);
 });
 it("does not fabricate metadata or change legacy state shape",()=>{
  const doc=reducer(utils.createDocument(),registerReport(input));expect(doc.operations.global.at(-1)?.error).toBeFalsy();
  expect(Object.hasOwn(doc.state.global,"publication")).toBe(false);
 });
 it.each([
  {contentHash:"c".repeat(64)}, {sourceRef:"source:other"}, {publishedAt:"2026-09-25T00:00:00.000Z"},
  {contentVersion:0}, {authorizationRef:""}, {author:{...agent,id:"wrong"}},
  {publisher:{...agent,definitionHash:"invalid"}},
 ])("rejects unbound metadata without mutating state: %j",patch=>{
  const doc=reducer(utils.createDocument(),registerReport({...input,publication:{...publication,...patch}}));
  expect(doc.operations.global.at(-1)?.error).toBeTruthy();expect(doc.state.global.revision).toBe(0);
 });
 it("rejects a draft publication and a second registration",()=>{
  const draft=reducer(utils.createDocument(),registerReport({...input,lifecycle:"DRAFT",publication}));expect(draft.operations.global.at(-1)?.error).toBeTruthy();
  const doc=reducer(utils.createDocument(),registerReport({...input,publication}));
  const retry=reducer(doc,registerReport({...input,publication}));expect(retry.operations.global.at(-1)?.error).toBeTruthy();expect(retry.state.global).toEqual(doc.state.global);
 });
});
