'use client';
import {useEffect,useRef} from 'react';
/** One current-phase action surface. Reserve its measured height for page/focus clearance. */
export function TaskActionBar({title,detail,error,children}:{title:string;detail?:string;error?:string;children:React.ReactNode}){
 const ref=useRef<HTMLElement>(null);
 useEffect(()=>{
  const node=ref.current!;
  const measure=()=>{const value=`${node.getBoundingClientRect().height+24}px`;document.documentElement.style.setProperty('--task-action-clearance',value);document.documentElement.style.scrollPaddingBottom=value;};
  const viewport=()=>{const v=window.visualViewport;node.style.bottom=`${v?Math.max(0,window.innerHeight-v.height-v.offsetTop):0}px`;measure();};
  const observer=new ResizeObserver(measure);observer.observe(node);viewport();
  window.visualViewport?.addEventListener('resize',viewport);window.visualViewport?.addEventListener('scroll',viewport);
  return()=>{observer.disconnect();window.visualViewport?.removeEventListener('resize',viewport);window.visualViewport?.removeEventListener('scroll',viewport);document.documentElement.style.removeProperty('--task-action-clearance');document.documentElement.style.removeProperty('scroll-padding-bottom');};
 },[]);
 return <aside ref={ref} aria-label="Current task actions" className="fixed inset-x-0 bottom-0 z-50 border-t-2 border-ink bg-paper px-4 pt-3 shadow-[0_-4px_16px_#00000010]" style={{paddingBottom:'max(12px, env(safe-area-inset-bottom))'}}>
  <div className="mx-auto max-w-[880px]"><p className="text-sm font-semibold" data-testid="task-phase">{title}</p>{detail&&<p className="mt-1 text-xs text-graphite">{detail}</p>}
   {error&&<p role="alert" className="mt-2 max-h-24 overflow-auto text-sm">{error}</p>}
   <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">{children}</div>
  </div>
 </aside>;
}
