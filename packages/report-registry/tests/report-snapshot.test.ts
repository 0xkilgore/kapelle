import assert from 'node:assert/strict';
import {test} from 'node:test';
import {classifyReport,validateReportSnapshot,readReportSnapshot,REPORT_DRIVE_ID} from '../deploy/report-snapshot.mjs';
const pending=()=>({documentId:'doc',name:'intent',classification:'pending',reportRef:'',title:'',revision:0,producer:null,content:null,publication:null,lifecycle:'DRAFT',updatedAt:null,projectRef:null,familyRef:null,sourceRef:null,supersedesRef:null,supersededByRef:null});
const snapshot=()=>({schemaVersion:'kapelle.report-drive-snapshot.v1',driveId:REPORT_DRIVE_ID,branch:'main',complete:true,documentIds:['doc'],totalCount:1,hasMore:false,nextCursor:null,snapshotDigest:'a'.repeat(64),reports:[pending()]});
test('unregistered intents remain explicit; malformed mixtures never become pending',()=>{
 assert.equal(classifyReport(pending()),'pending');
 for(const patch of [{revision:1},{title:'partial'},{sourceRef:'partial'},{content:{}},{publication:{}},{markdown:'leak'}])assert.throws(()=>classifyReport({...pending(),...patch}),/INCOMPLETE/);
});
test('metadata envelope refuses partial, duplicate, unsorted, wrong-scope and mismatched rows',()=>{
 assert.equal(validateReportSnapshot(snapshot(),REPORT_DRIVE_ID).totalCount,1);
 for(const patch of [{complete:false},{hasMore:true},{nextCursor:'500'},{branch:'other'},{driveId:'other'},{totalCount:2},{documentIds:['doc','doc']},{documentIds:['z','a']},{reports:[]},{snapshotDigest:'bad'}])assert.throws(()=>validateReportSnapshot({...snapshot(),...patch},REPORT_DRIVE_ID),/INCOMPLETE/);
});
test('body-bearing content and publication extras are rejected',()=>{
 const registered={...pending(),classification:'registered',reportRef:'report:1',title:'Report',revision:1,producer:{kind:'IMPORT',id:'importer',label:null},lifecycle:'FINAL',updatedAt:'2026-09-25T00:00:00.000Z',content:{storage:'INLINE_MARKDOWN',contentHash:'a'.repeat(64),byteSize:100}};
 assert.equal(classifyReport(registered),'registered');
 assert.throws(()=>classifyReport({...registered,content:{...registered.content,markdown:'private'}}),/INCOMPLETE/);
 assert.throws(()=>classifyReport({...registered,producer:{...registered.producer,credentials:'private'}}),/INCOMPLETE/);
});
test('native entry point rejects wrong Drive before touching the owning connection',async()=>{
 let calls=0;const client={documentView:{_db:{executeQuery(){calls++;throw Error('unexpected');}}}};
 await assert.rejects(readReportSnapshot(client,'other'),/SCOPE/);assert.equal(calls,0);
});
test('metadata byte limit remains two million bytes',()=>{
 const value=snapshot();value.reports[0].name='x'.repeat(2_000_000);
 assert.throws(()=>validateReportSnapshot(value,REPORT_DRIVE_ID),/BYTE_BOUND/);
});
