/** Narrow replacement for Reactor 6.2.1's outgoing relationship read.
 * Pages relationships once, then hydrates only that page. Never pages the
 * resulting IDs a second time, and retains the indexer's continuation cursor.
 */
export async function outgoingPage(this: any, sourceIdentifier: string, relationshipType: string, view: any, paging: any, signal: AbortSignal | undefined) {
  const limit = paging?.limit ?? 100;
  const cursor = paging?.cursor || '0';
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000 || !/^(0|[1-9][0-9]*)$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw Error('RELATIONSHIP_PAGING_INVALID');
  const sourceId = await this.documentView.resolveIdOrSlug(sourceIdentifier, view, undefined, signal);
  const page = await this.documentIndexer.getOutgoing(sourceId, [relationshipType], {cursor, limit}, undefined, signal);
  const targetIds = page.results.map((rel: any) => rel.targetId);
  if (new Set(targetIds).size !== targetIds.length || targetIds.length > limit) throw Error('RELATIONSHIP_PAGE_INVALID');
  const hydrated = targetIds.length ? await this.reactor.find({ids:targetIds}, view, {cursor:'0',limit}, undefined, signal) : {results:[]};
  if (hydrated.results.length !== targetIds.length || hydrated.results.some((doc: any, i: number) => doc.header.id !== targetIds[i])) throw Error('RELATIONSHIP_PAGE_DRIFT');
  return {
    results: hydrated.results, options:{cursor,limit}, nextCursor:page.nextCursor,
    ...(page.nextCursor ? {next:() => outgoingPage.call(this, sourceIdentifier, relationshipType, view, {cursor:page.nextCursor,limit}, signal)} : {}),
  };
}
