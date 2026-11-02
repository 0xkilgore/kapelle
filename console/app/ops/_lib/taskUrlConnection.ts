export type TaskUrlMutation =
  | {kind:'connect-url';url:string}
  | {kind:'remove-url';refId:string};
export const isTaskUrlKind=(kind:unknown):kind is TaskUrlMutation['kind']=>kind==='connect-url'||kind==='remove-url';
export function taskDocumentUrl(value:unknown):string|null {
  if(typeof value!=='string'||!value||value.length>2000||!/^https?:\/\//i.test(value)||/[\u0000-\u0020\u007f\p{Cf}]/u.test(value))return null;
  try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&url.hostname&&!url.username&&!url.password&&url.href.length<=2000?url.href:null;}catch{return null;}
}
export function parseTaskUrlMutation(value:Record<string,unknown>):TaskUrlMutation|null {
  if(!isTaskUrlKind(value.kind))return null;
  const keys=['taskId','expectedRevision','operationId','capability','retryCapability','kind',...(value.kind==='connect-url'?[]:['refId']),...(value.kind==='remove-url'?[]:['url'])];
  if(Object.keys(value).some(key=>!keys.includes(key)))return null;
  const refId=value.refId;
  if(value.kind!=='connect-url'&&(typeof refId!=='string'||!/^web\/url:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(refId)))return null;
  if(value.kind==='remove-url')return {kind:value.kind,refId:refId as string};
  const url=taskDocumentUrl(value.url);
  return url?{kind:'connect-url',url}:null;
}
export function taskUrlCommands(mutation:TaskUrlMutation,operationId:string){
  if(mutation.kind==='connect-url')return [{type:'ADD_EXTERNAL_REF',input:{id:'web/url:'+operationId,authority:'web/url',opaqueId:mutation.url,deepLink:mutation.url}}];
  return [{type:'REMOVE_EXTERNAL_REF',input:{id:mutation.refId}}];
}
