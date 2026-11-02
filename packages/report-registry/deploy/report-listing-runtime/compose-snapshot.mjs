import {createHash} from 'node:crypto';

export const MCP_PREIMAGE_SHA256='94e885d8046482570d13346e686f87e0468d231a9f2aefc6d2833f18c30495c3';
export function composeSnapshotMcp(installed) {
 if(createHash('sha256').update(installed).digest('hex')!==MCP_PREIMAGE_SHA256)throw Error('SNAPSHOT_MCP_PREIMAGE_MISMATCH');
 const marker='\tconst tools = {\n';
 const source=installed.toString();
 if(source.split(marker).length!==2)throw Error('SNAPSHOT_MCP_MATCH_INVALID');
 const tool=`\t\tgetReportLibraryMetadata: {
 name: "getReportLibraryMetadata",
 description: "Fresh complete metadata for the configured Report Drive; no content bodies.",
 inputSchema: {parentId: z.literal("00000000-0000-4000-8000-000000000001")},
 callback: async (params) => {
  try { return {structuredContent: await kapelleReadReportSnapshot(client,params.parentId),content:[]}; }
  catch(error) {return {isError:true,content:[{type:"text",text:"Report metadata unavailable"}]};}
 }
},\n`;
 return Buffer.from('import {readReportSnapshot as kapelleReadReportSnapshot} from "./report-snapshot.mjs";\n'+source.replace(marker,marker+tool));
}
