import {z} from 'zod';
import {assert} from '../validation.js';
import type {TaskWorker} from './worker.js';
import type {TaskReportRequest,TaskReportReceipt} from './worker-contract.js';
const id=z.string().min(1).max(200);
export const savedWorkSubjectSchema=z.object({subjectId:id,ownerId:id,scopeRef:id}).strict();
export type SavedWorkSubject=z.infer<typeof savedWorkSubjectSchema>;
const admissionSchema=savedWorkSubjectSchema.extend({dispatchId:z.uuid(),authorizationRef:id}).strict();
export type SavedWorkAccess={
 subject:SavedWorkSubject;
 /** Host-authenticated subject and actual Dispatch read ACL. No caller-provided
  * boolean, inferred owner grant, provider identity or production fallback. */
 authorizeDispatchRead:(selection:Readonly<SavedWorkSubject>&{dispatchId:string})=>Promise<z.infer<typeof admissionSchema>|null>;
};
export type SavedTaskResultWork=Readonly<{request:Readonly<TaskReportRequest>;nativeResult:Readonly<Omit<TaskReportReceipt,'publicationId'>>|null}>;
export async function authorizeSavedWork(access:SavedWorkAccess,dispatchId:string,ownerId:string,scopeRef:string){
 const subject=savedWorkSubjectSchema.parse(access.subject);
 assert(subject.ownerId===ownerId&&subject.scopeRef===scopeRef,'saved_work_scope_denied');
 const admitted=admissionSchema.parse(await access.authorizeDispatchRead(Object.freeze({...subject,dispatchId})));
 assert(admitted.subjectId===subject.subjectId&&admitted.ownerId===ownerId&&admitted.scopeRef===scopeRef&&admitted.dispatchId===dispatchId,'saved_work_read_denied');
 return admitted;
}
/** Bind this projection to an already owned worker in its service. Never open a
 * writer, create a store or accept subject/configuration from a browser on GET. */
export function createTaskSavedWorkLoader(worker:TaskWorker,access:SavedWorkAccess){
 const bound={subject:Object.freeze(savedWorkSubjectSchema.parse(access.subject)),authorizeDispatchRead:access.authorizeDispatchRead};
 return Object.freeze({loadSavedWork:(dispatchId:string)=>worker.readWithRecovery(dispatchId,()=>worker.readSavedWork(dispatchId,bound))});
}
