import {reportInspection} from './detail.mjs';
/** Fresh fixed-Drive reviewer preflight, never a summary-derived grant or lease. */
export function reviewScopeReader(database,sql,driveId){
 const {inspect,transaction}=reportInspection(database,sql,driveId);
 return async(id,signal=new AbortController().signal)=>{
  if(typeof id!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)||id===driveId)throw Error('REPORT_REVIEW_SCOPE_UNAVAILABLE');
  signal.throwIfAborted();const a=await transaction(trx=>inspect(trx,id,'review'));signal.throwIfAborted();
  const b=await transaction(trx=>inspect(trx,id,false));signal.throwIfAborted();
  if(a.stamp!==b.stamp)throw Error('REPORT_REVIEW_SCOPE_UNAVAILABLE');
  return {schemaVersion:'kapelle.report-review-scope.v1',driveId,documentId:id,lifecycle:a.lifecycle,revision:a.revision,checkedAt:new Date().toISOString()};
 };
}
