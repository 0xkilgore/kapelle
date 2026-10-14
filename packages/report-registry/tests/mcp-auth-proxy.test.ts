import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, it } from "node:test";
import { createMcpAuthProxy, requireAllowedTool } from "../deploy/mcp-auth-proxy.ts";

const READER = "reader-token-00000000000000000000000000000000";
const REVIEWER = "reviewer-token-000000000000000000000000000000";
const PRODUCER = "producer-token-000000000000000000000000000000";
const REVIEWER_ACTOR = "human:owner";
const DRIVE_ID = "drive:report-registry";
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixture(options: { reviewer?: boolean; timeoutMs?: number; listingSuspendMs?: number; readerListingReuseMs?: number; requireWriteGeneration?: boolean } = {}) {
  const calls: string[] = [];
  const state = {
    documentIds: ["11111111-1111-4111-8111-111111111111"],
    documentType: "kilgore/report",
    lifecycle: "FINAL",
    failListings: false,
    revision: 2,
    badDetail: false,
    incompleteSummary: false,
    driftOnFetch: false,
    pointDrive: undefined as string | undefined,
    listingDelayMs: 0,
    deployment: {bootId:"11111111-2222-4333-8444-555555555555",releaseId:"rel-1",bootReleaseId:"rel-1",modelDigest:"d".repeat(64),currentModelDigest:"d".repeat(64)},
    onMutation: undefined as undefined | (() => void),
  };
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    calls.push(body);
    const parsed = JSON.parse(body) as any;
    const tool = parsed.params?.name;
    response.setHeader("content-type", "application/json");
    if (tool === "getReportLibraryMetadata" && state.listingDelayMs) await new Promise(r => setTimeout(r, state.listingDelayMs));
    if (["getReportLibraryMetadata", "getReportReviewScope"].includes(tool) && state.failListings) {
      response.statusCode = 503; response.end('{}'); return;
    }
    const documentIds=[...state.documentIds].sort();
    if(tool === "getRegistryDeploymentV1"){const d=state.deployment;response.end(JSON.stringify({jsonrpc:"2.0",result:{structuredContent:{deployment:{schemaVersion:"kapelle.registry-deployment.v1",driveId:DRIVE_ID,bootId:d.bootId,startedAt:"x",bootReleaseId:d.bootReleaseId,releaseId:d.releaseId,bootModelDigest:d.modelDigest,currentModelDigest:d.currentModelDigest,observedAt:"x"}}}}));return;}
    if(["createDocument","addActions"].includes(tool))state.onMutation?.();
    if(tool === "getReportDocumentV1"){
      // Native scoped point read: a proof only for a current member of the configured Drive.
      const id=parsed.params.arguments.id;
      if(state.failListings||!state.documentIds.includes(id)){response.end(JSON.stringify({jsonrpc:"2.0",result:{isError:true,content:[{type:"text",text:"REPORT_DETAIL_UNAVAILABLE"}]}}));return;}
      const global={lifecycle:state.lifecycle,revision:state.revision,reportRef:"report:"+id};
      response.end(JSON.stringify({jsonrpc:"2.0",result:{structuredContent:{read:{schemaVersion:"kapelle.report-document-read.v1",driveId:state.pointDrive??DRIVE_ID,documentId:id,stamp:"b".repeat(64),lifecycle:state.lifecycle,revision:state.revision,blank:false,observedAt:new Date().toISOString(),document:{header:{id,name:"n",documentType:state.documentType},state:{global}}}}}}));return;
    }
    if(tool === "getDocument" && state.driftOnFetch) state.revision++;
    const now=new Date().toISOString();
    const structuredContent = tool === "getReportReviewScope"
      ? {scope:{schemaVersion:"kapelle.report-review-scope.v1",driveId:DRIVE_ID,documentId:state.documentIds.includes(parsed.params.arguments.id)?parsed.params.arguments.id:null,lifecycle:state.lifecycle,revision:state.revision,checkedAt:now}}
      : tool === "lookupReportPublicationV1" ? {lookup:{reportRef:parsed.params.arguments.reportRef,found:false}}
      : tool === "getReportDetailV2" ? {detail:{schemaVersion:"kapelle.report-detail.v2",source:"vetra-report-registry",driveId:state.badDetail?'wrong-drive':DRIVE_ID,availability:"available",document:{header:{id:parsed.params.arguments.id,documentType:"kilgore/report"},state:{global:{lifecycle:"FINAL",content:{markdown:"selected body"}}}}}}
      : tool === "getReportSummaryPage" ? {page:{schemaVersion:"kapelle.report-summary-page.v2",source:"vetra-report-registry",driveId:DRIVE_ID,observationId:"synthetic",observedAt:now,trust:"fixed-reader-drive-projected",membership:{snapshotId:"snapshot",capturedAt:now,expiresAt:new Date(Date.now()+20000).toISOString(),totalMembers:state.incompleteSummary?1:0,coverage:"projected-snapshot",consistency:"materialized-projection-snapshot",checkpoint:null,frontierKind:"unavailable",publicationSafe:false},offset:0,members:[],nextCursor:null,exhausted:true}}
      : tool === "getReportLibraryMetadata"
      ? {schemaVersion:'kapelle.report-drive-snapshot.v1',driveId:DRIVE_ID,branch:'main',complete:true,documentIds,totalCount:documentIds.length,hasMore:false,nextCursor:null,snapshotDigest:'a'.repeat(64),reports:documentIds.map(documentId=>({documentId,name:documentId,classification:'registered',reportRef:'report:'+documentId,title:'Test',projectRef:null,familyRef:null,sourceRef:null,supersedesRef:null,supersededByRef:null,revision:1,producer:{kind:'AGENT',id:'fixture',label:null},content:{storage:'INLINE_MARKDOWN',contentHash:'a'.repeat(64),byteSize:20},publication:null,lifecycle:'FINAL',updatedAt:'2026-09-25T00:00:00.000Z'}))}
      : tool === "getDocument"
        ? {document:{header:{id:parsed.params?.arguments?.id,documentType:state.documentType},state:{global:{lifecycle:state.lifecycle,revision:state.revision}}}}
        : {ok:true};
    response.end(JSON.stringify({
      jsonrpc: "2.0",
      result: { structuredContent },
    }));
  });
  servers.push(upstream);
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as { port: number }).port;

  const proxy = createMcpAuthProxy({
    readerToken: READER,
    ...(options.reviewer === false ? {} : { reviewerToken: REVIEWER, reviewerActorId: REVIEWER_ACTOR }),
    producerToken: PRODUCER,
    driveId: DRIVE_ID,
    upstream: `http://127.0.0.1:${upstreamPort}/mcp`,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.listingSuspendMs ? { listingSuspendMs: options.listingSuspendMs } : {}),
    readerListingReuseMs: options.readerListingReuseMs ?? 0,
    ...(options.requireWriteGeneration ? { requireWriteGeneration: true } : {}),
    audit: () => {},
  });
  servers.push(proxy);
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyPort = (proxy.address() as { port: number }).port;
  return { calls, state, url: `http://127.0.0.1:${proxyPort}/mcp` };
}

function reviewAction(type: string, input: Record<string, unknown> = {}) {
  return {
    documentId: "11111111-1111-4111-8111-111111111111",
    actions: [{
      type,
      scope: "global",
      input: {
        expectedRevision: 2,
        occurredAt: "2026-08-22T18:00:00.000Z",
        actorId: REVIEWER_ACTOR,
        ...input,
      },
    }],
  };
}

function request(url: string, token: string | null, name: string, args: Record<string, unknown> = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "test", method: "tools/call", params: { name, arguments: args } }),
  });
}

describe("MCP authorization proxy", () => {
  it("admits exact unread only for the scoped reviewer and a current FINAL report", async () => {
    const {calls, state, url} = await fixture();
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_UNREAD"))).status, 200);
    assert.equal((await request(url, READER, "addActions", reviewAction("MARK_UNREAD"))).status, 403);
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_UNREAD", {actorId: "human:other"}))).status, 403);
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_UNREAD", {readAt: null}))).status, 403);
    for (const lifecycle of ["DRAFT", "SUPERSEDED", "WITHDRAWN"]) {
      state.lifecycle = lifecycle;
      assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_UNREAD"))).status, 502);
    }
    state.lifecycle = "FINAL"; state.documentIds = [];
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_UNREAD"))).status, 502);
    assert.equal(calls.filter(body => (JSON.parse(body).params?.name ?? "graphql") === "addActions").length, 1);
  });
  it("rejects missing and invalid credentials without reaching upstream", async () => {
    const { calls, url } = await fixture();
    assert.equal((await request(url, null, "getDocuments")).status, 401);
    assert.equal((await request(url, `${READER}x`, "getDocuments")).status, 401);
    assert.equal(calls.length, 0);
  });

  it("permits read tools for the reader and blocks writes", async () => {
    const { calls, url } = await fixture();
    assert.equal((await request(url, READER, "getDocuments", { parentId: DRIVE_ID })).status, 200);
    assert.equal((await request(url, READER, "createDocument")).status, 403);
    assert.equal(calls.length, 1);
  });

  it("revalidates reviewer reads and every review write against the current report Drive", async () => {
    const { calls, url } = await fixture();
    assert.equal((await request(url, REVIEWER, "getDocument", { id: "11111111-1111-4111-8111-111111111111" })).status, 200);
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_READ"))).status, 200);
    assert.equal((await request(url, REVIEWER, "getDocuments", { parentId: DRIVE_ID })).status, 200);
    assert.equal((await request(url, REVIEWER, "getDocument", { id: "11111111-1111-4111-8111-111111111111" })).status, 200);
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_OPENED"))).status, 200);
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_READ"))).status, 200);
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("DISMISS_ATTENTION"))).status, 200);
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("RESOLVE_ATTENTION"))).status, 200);
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("ADD_FEEDBACK", {
      feedbackId: "6f0a0f4b-f6cc-4d73-8e65-46f1ac8ad735",
      bodyMarkdown: "Use the smaller pilot.",
    }))).status, 200);
    const tools = calls.map((body) => (JSON.parse(body).params?.name ?? "graphql"));
    assert.equal(tools.filter((tool) => tool === "addActions").length, 6);
    assert.equal(tools.filter((tool) => tool === "getReportReviewScope").length, 16);
  });

  it("rejects a write after its document is removed from the Drive", async () => {
    const { calls, state, url } = await fixture();
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_READ"))).status, 200);
    state.documentIds = [];
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_READ"))).status, 502);
    assert.equal(calls.map((body) => (JSON.parse(body).params?.name ?? "graphql")).filter((tool) => tool === "addActions").length, 1);
  });

  it("fails closed when current Drive membership cannot be refreshed", async () => {
    const { calls, state, url } = await fixture();
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_READ"))).status, 200);
    state.failListings = true;
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_READ"))).status, 502);
    assert.equal(calls.map((body) => (JSON.parse(body).params?.name ?? "graphql")).filter((tool) => tool === "addActions").length, 1);
  });

  it("rejects an in-Drive document whose live model is not kilgore/report", async () => {
    const { calls, state, url } = await fixture();
    state.documentType = "powerhouse/note";
    assert.equal((await request(url, REVIEWER, "addActions", reviewAction("MARK_READ"))).status, 502);
    assert.equal(calls.map((body) => (JSON.parse(body).params?.name ?? "graphql")).includes("addActions"), false);
  });

  it("rejects reviewer reads and writes for an unpublished DRAFT report", async () => {
    const { calls, state, url } = await fixture();
    state.lifecycle = "DRAFT";
    assert.equal(
      (await request(url, REVIEWER, "getDocument", { id: "11111111-1111-4111-8111-111111111111" })).status,
      502,
    );
    assert.equal(
      (await request(url, REVIEWER, "addActions", reviewAction("MARK_READ"))).status,
      502,
    );
    const tools = calls.map((body) => (JSON.parse(body).params?.name ?? "graphql"));
    assert.equal(tools.filter((tool) => tool === "addActions").length, 0);
  });

  it("independently revalidates simultaneous reviewer writes", async () => {
    const { calls, url } = await fixture();
    const responses = await Promise.all([
      request(url, REVIEWER, "addActions", reviewAction("MARK_READ")),
      request(url, REVIEWER, "addActions", reviewAction("MARK_OPENED")),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const tools = calls.map((body) => (JSON.parse(body).params?.name ?? "graphql"));
    assert.equal(tools.filter((tool) => tool === "getReportReviewScope").length, 4);
    assert.equal(tools.filter((tool) => tool === "getDocument").length, 2);
    assert.equal(tools.filter((tool) => tool === "addActions").length, 2);
  });

  it("rejects every reviewer write outside the exact review-operation envelope", async () => {
    const { calls, url } = await fixture();
    const rejected = [
      request(url, REVIEWER, "createDocument", {}),
      request(url, REVIEWER, "addActions", reviewAction("REGISTER_REPORT")),
      request(url, REVIEWER, "addActions", { ...reviewAction("MARK_READ"), documentId: "doc-2" }),
      request(url, REVIEWER, "addActions", { ...reviewAction("MARK_READ"), extra: true }),
      request(url, REVIEWER, "addActions", {
        documentId: "11111111-1111-4111-8111-111111111111",
        actions: [reviewAction("MARK_READ").actions[0], reviewAction("RESOLVE_ATTENTION").actions[0]],
      }),
      request(url, REVIEWER, "addActions", reviewAction("MARK_READ", { actorId: "agent:research-agent" })),
      request(url, REVIEWER, "addActions", reviewAction("MARK_READ", { expectedRevision: 0 })),
      request(url, REVIEWER, "addActions", reviewAction("MARK_READ", { occurredAt: "yesterday" })),
      request(url, REVIEWER, "addActions", reviewAction("ADD_FEEDBACK", {
        feedbackId: "not-a-uuid",
        bodyMarkdown: "Use the smaller pilot.",
      })),
      request(url, REVIEWER, "addActions", reviewAction("ADD_FEEDBACK", {
        feedbackId: "6f0a0f4b-f6cc-4d73-8e65-46f1ac8ad735",
        bodyMarkdown: "  padded feedback  ",
      })),
      request(url, REVIEWER, "addActions", reviewAction("ADD_FEEDBACK", {
        feedbackId: "6f0a0f4b-f6cc-4d73-8e65-46f1ac8ad735",
        body: "Legacy handwritten ABI must not pass the generated-model boundary.",
      })),
    ];
    for (const response of await Promise.all(rejected)) assert.equal(response.status, 403);
    assert.equal(calls.map((body) => (JSON.parse(body).params?.name ?? "graphql")).filter((tool) => tool === "addActions").length, 0);
  });

  it("pins the reader to the report drive: a selected read is a scoped native proof, never a listing", async () => {
    const { calls, state, url } = await fixture();
    const MEMBER = "11111111-1111-4111-8111-111111111111", FOREIGN = "22222222-2222-4222-8222-222222222222";
    assert.equal((await request(url, READER, "getDocuments", { parentId: "drive:other" })).status, 403);
    assert.equal((await request(url, READER, "getDocuments", { parentId: DRIVE_ID, limit: 9999 })).status, 403);
    // No listing prerequisite: the first selected read is answered from the native point proof alone.
    const first = await request(url, READER, "getDocument", { id: MEMBER });
    assert.equal(first.status, 200);
    assert.equal(((await first.json()) as any).result.structuredContent.document.header.id, MEMBER);
    assert.equal((await request(url, READER, "getDocument", { id: FOREIGN })).status, 403);
    assert.equal((await request(url, READER, "getDocument", { id: MEMBER, parentId: DRIVE_ID })).status, 403);
    assert.equal((await request(url, READER, "getDocument", { id: "doc-2" })).status, 403);
    for (const token of [READER, PRODUCER]) {
      const r = await request(url, token, "getReportDocumentV1", { id: MEMBER });assert.equal(r.status, 200);
      assert.equal(((await r.json()) as any).result.structuredContent.read.documentId, MEMBER);
      assert.equal((await request(url, token, "getReportDocumentV1", { id: MEMBER, extra: 1 })).status, 403);
      assert.equal((await request(url, token, "getReportDocumentV1", { id: "doc-2" })).status, 403);
    }
    assert.equal((await request(url, REVIEWER, "getReportDocumentV1", { id: MEMBER })).status, 403);
    // A proof for another Drive is refused, not translated.
    state.pointDrive = "drive:other";
    assert.equal((await request(url, READER, "getDocument", { id: MEMBER })).status, 502);
    const names = calls.map(body => JSON.parse(body).params.name);
    assert.equal(names.filter(n => ["getReportLibraryMetadata", "getDocuments", "getReportIdentities", "getDocument"].includes(n)).length, 0);
    assert.ok(names.every(n => n === "getReportDocumentV1"));
  });

  it("forwards canonical JSON rather than the raw duplicate-key envelope", async () => {
    const { calls, url } = await fixture();
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${READER}`, "content-type": "application/json" },
      body: `{"jsonrpc":"2.0","id":"test","method":"tools/call","params":{"name":"createDocument","arguments":{}},"params":{"name":"getDocuments","arguments":{"parentId":"${DRIVE_ID}"}}}`,
    });
    assert.equal(response.status, 200);
    assert.equal((calls[0].match(/"params"/g) ?? []).length, 1);
    assert.equal(JSON.parse(calls[0]).params.name, "getReportLibraryMetadata");
    assert.ok(calls.every(body=>JSON.parse(body).params?.name!=="createDocument"));
  });

  it("permits the exact producer write surface but blocks other tools", async () => {
    const { calls, url } = await fixture();
    assert.equal((await request(url, PRODUCER, "createDocument")).status, 200);
    assert.equal((await request(url, PRODUCER, "addActions")).status, 200);
    assert.equal((await request(url, PRODUCER, "deleteDocument")).status, 403);
    assert.equal(calls.length, 2);
  });

  it("keeps the established reader and producer roles available when reviewer rollout is disabled", async () => {
    const { calls, url } = await fixture({ reviewer: false });
    assert.equal((await request(url, READER, "getDocuments", { parentId: DRIVE_ID })).status, 200);
    assert.equal((await request(url, PRODUCER, "createDocument")).status, 200);
    assert.equal((await request(url, REVIEWER, "getDocuments", { parentId: DRIVE_ID })).status, 401);
    assert.equal(calls.length, 2);
  });

  it("rejects malformed JSON-RPC and unsafe startup configuration", async () => {
    assert.throws(() => requireAllowedTool(Buffer.from("{}"), "reader"), /REQUEST_INVALID/);
    assert.throws(() => createMcpAuthProxy({
      readerToken: READER,
      reviewerToken: READER,
      producerToken: PRODUCER,
      reviewerActorId: REVIEWER_ACTOR,
      driveId: DRIVE_ID,
    }), /must be distinct/);
    assert.throws(() => createMcpAuthProxy({
      readerToken: READER,
      reviewerToken: REVIEWER,
      producerToken: PRODUCER,
      reviewerActorId: REVIEWER_ACTOR,
      driveId: DRIVE_ID,
      upstream: "http://example.com/mcp",
    }), /loopback/);
    assert.throws(() => createMcpAuthProxy({
      readerToken: READER,
      reviewerToken: REVIEWER,
      producerToken: PRODUCER,
      reviewerActorId: " ",
      driveId: DRIVE_ID,
    }), /reviewer actor id/);
    assert.throws(() => createMcpAuthProxy({
      readerToken: READER,
      reviewerToken: REVIEWER,
      producerToken: PRODUCER,
      driveId: DRIVE_ID,
    }), /configured together/);
  });
});

it('lists more than 100 for both roles and pins identity scans to the configured Drive',async()=>{
 const {state,url}=await fixture();state.documentIds=Array.from({length:1205},(_,i)=>'id-'+i);
 for(const token of [READER,PRODUCER]){
  const response=await request(url,token,'getDocuments',{parentId:DRIVE_ID});assert.equal(response.status,200);const body:any=await response.json();assert.equal(body.result.structuredContent.documentIds.length,1205);
  assert.equal((await request(url,token,'getDocuments',{parentId:'other-drive'})).status,403);
 }
 assert.equal((await request(url,READER,'getReportIdentities',{parentId:DRIVE_ID})).status,403);
 assert.equal((await request(url,PRODUCER,'getReportIdentities',{parentId:'other-drive'})).status,403);
 assert.equal((await request(url,PRODUCER,'getReportIdentities',{parentId:DRIVE_ID})).status,200);
 state.failListings=true;assert.equal((await request(url,READER,'getDocuments',{parentId:DRIVE_ID})).status,502);
 assert.equal((await request(url,READER,'getDocument',{id:'id-1'})).status,403);
});

 it('reader metadata is complete, body-free and cannot authorize a removed document',async()=>{
 const {calls,state,url}=await fixture();
 const response=await request(url,READER,'getReportLibraryMetadata',{parentId:DRIVE_ID});assert.equal(response.status,200);
 const result:any=await response.json();assert.deepEqual(result.result.content,[]);assert.equal(result.result.structuredContent.reports[0].classification,'registered');
 assert.equal(calls.length,1);assert.ok(!JSON.stringify(result).includes('markdown'));
 assert.equal((await request(url,READER,'getReportLibraryMetadata',{parentId:DRIVE_ID,fields:['markdown']})).status,403);
 state.documentIds=[];
 assert.equal((await request(url,READER,'getDocument',{id:'11111111-1111-4111-8111-111111111111'})).status,403);
 assert.equal(calls.filter(body=>JSON.parse(body).params.name==='getDocument').length,0);
 });

it('preserves reader-only summary/detail routes and fails closed on invalid projections',async()=>{
 const {url,state,calls}=await fixture();
 const base=url.slice(0,-4);
 const get=(path:string,token:string)=>fetch(base+path,{headers:{authorization:'Bearer '+token}});
 for(const path of ['/v2/report-summaries','/v2/reports/11111111-1111-4111-8111-111111111111']){
  for(const token of [PRODUCER,REVIEWER,'invalid']) assert.equal((await get(path,token)).status,token==='invalid'?401:403);
  assert.equal(calls.length,0);
 }
 let response=await get('/v2/report-summaries',READER);assert.equal(response.status,200);
 const summary:any=await response.json();assert.equal(summary.complete,true);assert.equal(summary.membership.publicationSafe,false);
 response=await get('/v2/reports/11111111-1111-4111-8111-111111111111',READER);assert.equal(response.status,200);
 assert.equal((await response.json() as any).document.state.global.content.markdown,'selected body');
 state.badDetail=true;assert.equal((await get('/v2/reports/11111111-1111-4111-8111-111111111111',READER)).status,503);
 state.incompleteSummary=true;assert.equal((await get('/v2/report-summaries',READER)).status,503);
 assert.deepEqual(calls.map(v=>JSON.parse(v).params.name),['getReportSummaryPage','getReportDetailV2','getReportDetailV2','getReportSummaryPage']);
});

it('preserves exact producer publication lookup and refuses broader lookup scopes',async()=>{
 const {url,calls}=await fixture();
 const response=await request(url,PRODUCER,'lookupReportPublicationV1',{reportRef:'stable-ref'});
 assert.equal(response.status,200);assert.deepEqual((await response.json() as any).result.structuredContent.lookup,{reportRef:'stable-ref',found:false});
 for(const token of [READER,REVIEWER]) assert.equal((await request(url,token,'lookupReportPublicationV1',{reportRef:'stable-ref'})).status,403);
 for(const args of [{reportRef:''},{reportRef:' '},{reportRef:'a'.repeat(1001)},{reportRef:'stable-ref',driveId:'other'}]) assert.equal((await request(url,PRODUCER,'lookupReportPublicationV1',args)).status,403);
 assert.equal(calls.length,1);
});

it('preserves reviewer membership receipts, revision409 and post-body revalidation',async()=>{
 const {url,calls,state}=await fixture();
 let response=await request(url,REVIEWER,'getDocument',{id:'11111111-1111-4111-8111-111111111111'});
 assert.equal(response.status,200);const payload=(await response.json() as any).result.structuredContent;
 assert.equal(payload.document.state.global.revision,2);assert.equal(payload.membership.schemaVersion,'kapelle.report-review-membership.v1');assert.equal(payload.membership.driveId,DRIVE_ID);assert.equal(payload.membership.documentId,payload.document.header.id);
 response=await request(url,REVIEWER,'addActions',reviewAction('MARK_READ',{expectedRevision:1}));assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'revision_conflict'});
 assert.equal(calls.filter(v=>JSON.parse(v).params.name==='addActions').length,0);
 state.driftOnFetch=true;assert.equal((await request(url,REVIEWER,'addActions',reviewAction('MARK_READ'))).status,502);
 assert.equal(calls.filter(v=>JSON.parse(v).params.name==='addActions').length,0);
});

it('scale bridge C: one listing in flight, shared; a timed-out listing suspends listings (no retry) but never point reads',async()=>{
 const {calls,state,url}=await fixture({timeoutMs:300,listingSuspendMs:400});
 const MEMBER='11111111-1111-4111-8111-111111111111';
 const listings=()=>calls.filter(b=>JSON.parse(b).params.name==='getReportLibraryMetadata').length;
 // Coalescing: concurrent listings for reader and producer share ONE upstream query.
 state.listingDelayMs=100;
 const shared=await Promise.all([request(url,READER,'getReportLibraryMetadata',{parentId:DRIVE_ID}),request(url,READER,'getDocuments',{parentId:DRIVE_ID}),request(url,PRODUCER,'getReportIdentities',{parentId:DRIVE_ID})]);
 assert.deepEqual(shared.map(r=>r.status),[200,200,200]);assert.equal(listings(),1);
 // A listing past its deadline: 502 once, then listing_suspended WITHOUT reaching upstream; point reads still answer.
 state.listingDelayMs=1500;
 assert.equal((await request(url,READER,'getReportLibraryMetadata',{parentId:DRIVE_ID})).status,502);
 const before=listings();
 assert.equal((await request(url,READER,'getDocuments',{parentId:DRIVE_ID})).status,503);
 assert.equal((await request(url,PRODUCER,'getReportIdentities',{parentId:DRIVE_ID})).status,503);
 assert.equal(listings(),before);
 assert.equal((await request(url,READER,'getDocument',{id:MEMBER})).status,200);
 assert.equal((await request(url,PRODUCER,'getReportDocumentV1',{id:MEMBER})).status,200);
 assert.equal((await request(url,PRODUCER,'lookupReportPublicationV1',{reportRef:'report:x'})).status,200);
 // After the window a listing is admitted again; success resets the backoff.
 state.listingDelayMs=0;await new Promise(r=>setTimeout(r,1700));
 assert.equal((await request(url,READER,'getReportLibraryMetadata',{parentId:DRIVE_ID})).status,200);
 assert.equal((await request(url,READER,'getReportLibraryMetadata',{parentId:DRIVE_ID})).status,200);
});

it('scale bridge C: reader listing refreshes reuse a recent snapshot; producer listings are always fresh',async()=>{
 const {calls,state,url}=await fixture({readerListingReuseMs:300});
 const listings=()=>calls.filter(b=>JSON.parse(b).params.name==='getReportLibraryMetadata').length;
 for(let i=0;i<3;i++)assert.equal((await request(url,READER,'getReportLibraryMetadata',{parentId:DRIVE_ID})).status,200);
 assert.equal(listings(),1);
 assert.equal((await request(url,PRODUCER,'getReportIdentities',{parentId:DRIVE_ID})).status,200);assert.equal(listings(),2);
 state.documentIds=[...state.documentIds,'33333333-3333-4333-8333-333333333333'];
 assert.equal((await request(url,PRODUCER,'getReportIdentities',{parentId:DRIVE_ID})).status,200);assert.equal(listings(),3);
 await new Promise(r=>setTimeout(r,350));
 const fresh:any=await (await request(url,READER,'getReportLibraryMetadata',{parentId:DRIVE_ID})).json();
 assert.equal(listings(),4);assert.equal(fresh.result.structuredContent.totalCount,2);
});

it('model-admission fence: getRegistryDeploymentV1 is producer-only with exact empty arguments',async()=>{
 const {calls,url}=await fixture();
 assert.equal((await request(url,PRODUCER,'getRegistryDeploymentV1',{})).status,200);
 assert.equal((await request(url,PRODUCER,'getRegistryDeploymentV1',{id:'x'})).status,403);
 for(const token of [READER,REVIEWER])assert.equal((await request(url,token,'getRegistryDeploymentV1',{})).status,403);
 assert.equal(calls.filter(b=>JSON.parse(b).params.name==='getRegistryDeploymentV1').length,1);
});

it('model-admission fence at the write: a producer mutation is forwarded only for the RUNNING generation, key stripped',async()=>{
 const {calls,state,url}=await fixture();
 const gen=()=>`v1:${state.deployment.bootReleaseId}:${state.deployment.modelDigest}:${state.deployment.bootId}`;
 const mutations=()=>calls.map(b=>JSON.parse(b).params).filter(p=>['createDocument','addActions'].includes(p.name));
 const create={documentType:'kilgore/report',name:'intent',driveId:DRIVE_ID};
 // match -> forwarded once, without the generation key
 assert.equal((await request(url,PRODUCER,'createDocument',{...create,expectedRegistryGeneration:gen()})).status,200);
 assert.equal(mutations().length,1);assert.equal(Object.hasOwn(mutations()[0].arguments,'expectedRegistryGeneration'),false);
 const expected=gen();
 // other model / other release / restarted process / files changed under the running process -> 409, NOTHING forwarded
 for(const change of [(d:any)=>{d.modelDigest='e'.repeat(64);d.currentModelDigest=d.modelDigest;},(d:any)=>{d.bootReleaseId='rel-2';d.releaseId='rel-2';},(d:any)=>{d.bootId='99999999-2222-4333-8444-555555555555';},(d:any)=>{d.currentModelDigest='f'.repeat(64);},(d:any)=>{d.releaseId='rel-rolled';}]){
  const saved=structuredClone(state.deployment);change(state.deployment);
  for(const [tool,args] of [['createDocument',create],['addActions',{documentId:'11111111-1111-4111-8111-111111111111',actions:[]}]] as const){
   const r=await request(url,PRODUCER,tool,{...args,expectedRegistryGeneration:expected});assert.equal(r.status,409);assert.equal(((await r.json()) as any).error,'registry_generation_mismatch');
  }
  state.deployment=saved;
 }
 assert.equal(mutations().length,1);
 // a deployment change DURING the write: the write reached the Reactor but the result is not released (outcome never claimed)
 state.onMutation=()=>{state.deployment={...state.deployment,bootId:'88888888-2222-4333-8444-555555555555'};};
 const during=await request(url,PRODUCER,'addActions',{documentId:'11111111-1111-4111-8111-111111111111',actions:[],expectedRegistryGeneration:expected});
 assert.equal(during.status,502);assert.equal(((await during.json()) as any).error,'registry_generation_changed');assert.equal(mutations().length,2);
 state.onMutation=undefined;
 // malformed -> 403; absent -> unchanged (default) so producers that do not send it keep working
 assert.equal((await request(url,PRODUCER,'createDocument',{...create,expectedRegistryGeneration:'v0:x'})).status,403);
 assert.equal((await request(url,PRODUCER,'createDocument',create)).status,200);assert.equal(mutations().length,3);
});
it('model-admission fence at the write: strict mode refuses producer mutations without a generation',async()=>{
 const {calls,url}=await fixture({requireWriteGeneration:true});
 const r=await request(url,PRODUCER,'createDocument',{documentType:'kilgore/report',name:'intent',driveId:DRIVE_ID});
 assert.equal(r.status,403);assert.equal(((await r.json()) as any).error,'registry_generation_required');
 assert.equal(calls.filter(b=>['createDocument','addActions'].includes(JSON.parse(b).params.name)).length,0);
});
