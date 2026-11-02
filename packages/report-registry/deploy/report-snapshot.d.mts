import type {PublicationMetadata} from '../src/publication-metadata.ts';
export type ReportMetadataRow = {
 documentId:string; name:string; classification:'pending'|'registered';
 reportRef:string; title:string; projectRef:string|null; familyRef:string|null; sourceRef:string|null;
 revision:number; producer:{kind:'AGENT'|'HUMAN'|'IMPORT'|'SERVICE';id:string;label:string|null}|null;
 lifecycle:'DRAFT'|'FINAL'|'SUPERSEDED'|'WITHDRAWN'; updatedAt:string|null;
 supersedesRef:string|null; supersededByRef:string|null;
 content:{storage:'INLINE_MARKDOWN'|'BLOB';contentHash:string;byteSize:number}|null;
 publication:PublicationMetadata|null;
};
export type ReportDriveSnapshot = {
 schemaVersion:'kapelle.report-drive-snapshot.v1';driveId:string;branch:'main';complete:true;
 documentIds:string[];totalCount:number;hasMore:false;nextCursor:null;
 reports:ReportMetadataRow[];snapshotDigest:string;
};
export const REPORT_DRIVE_ID:string;
export const SNAPSHOT_SCHEMA:'kapelle.report-drive-snapshot.v1';
export const SNAPSHOT_MAX_BYTES:number;
export const SNAPSHOT_TIMEOUT_MS:number;
export const SNAPSHOT_SQL:string;
export function classifyReport(row:unknown):'pending'|'registered';
export function validateReportSnapshot(value:unknown,driveId:string):ReportDriveSnapshot;
export function readReportSnapshot(client:unknown,parentId:string):Promise<ReportDriveSnapshot>;
