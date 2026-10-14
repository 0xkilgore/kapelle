import type { Server } from 'node:http';
/** Stop accepting work; abort workers; drain requests; then close durable stores.
 * A timeout retains stores/locks and the underlying drain promise for a later retry. */
export function createServiceStop(servers:Server[],abort:()=>void,close:()=>Promise<void>,timeoutMs:number) {
 let drain:Promise<void>|undefined,running:Promise<void>|undefined,closed=false;
 return function stop():Promise<void>{
  if(closed)return Promise.resolve();if(running)return running;
  running=(async()=>{
   // Close listeners synchronously before aborting; no fresh request may start work.
   if(!drain)drain=Promise.all(servers.map(s=>new Promise<void>((resolve,reject)=>{
    if(!s.listening){resolve();return;}s.close(error=>error?reject(error):resolve());s.closeIdleConnections();
   }))).then(()=>{});
   abort();
   for(const server of servers)server.closeIdleConnections();
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{await Promise.race([drain,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('service_drain_timeout_locks_retained')),timeoutMs);})]);}
   finally{clearTimeout(timer);}
   await close();closed=true;
  })().finally(()=>{running=undefined;});return running;
 };
}

/** Dependency-ordered close: never close an authority under an active worker,
 * and never re-close an already closed worker when a later store needs retry. */
export function closeStoresInOrder(steps:Array<()=>void|Promise<void>>) {
 let next=0;
 return async()=>{while(next<steps.length){await steps[next]();next++;}};
}
