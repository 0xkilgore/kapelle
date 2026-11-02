import 'server-only';
import {readNativeTaskDocument} from './nativeTaskDetail';
import {isPrivateProject} from './privateScope';
import {TaskHostError} from './taskHost';

/** Finances admission: is this Task in a private project? Read from the Task Authority itself (never from a cached view or the
 *  request). Unknown fails closed for scoped clients: an unreadable Task is treated as not available. */
export async function taskIsPrivate(taskId:string,fetchImpl:typeof fetch=fetch):Promise<boolean>{
 const r=await readNativeTaskDocument(taskId,fetchImpl);
 if(r.kind==='unavailable')throw new TaskHostError('The task host or saved request is not available.',503);
 return r.kind==='ok'&&isPrivateProject(r.task.projectId);
}
/** For scoped chat-client tokens: a private-project Task answers exactly like a missing one (404, same text). */
export async function assertScopedTaskNotPrivate(taskId:string,fetchImpl:typeof fetch=fetch){
 if(await taskIsPrivate(taskId,fetchImpl))throw new TaskHostError('The task host or saved request is not available.',404);
}
