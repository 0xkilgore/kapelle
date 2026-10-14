import type {TaskSourcePacket} from '../_lib/taskSourcePacket';

/** Render only after the caller verifies this packet against the current Task. */
export function TaskSuppliedSources({packet}:{packet:TaskSourcePacket}){
  return <section aria-label="Supplied source contents" className="mt-5 border-t border-rule pt-4">
    <h3 className="text-lg font-semibold">Supplied sources</h3>
    <p className="mt-2 text-sm">These saved contents are included with the work. Changes to the original documents are not included automatically.</p>
    {packet.sources.map(({document,reference,capturedAt})=><details key={document.id} className="mt-3 border border-rule p-3">
      <summary className="min-h-11 cursor-pointer break-words text-sm font-semibold">{document.title} · Version {document.version}</summary>
      <p className="mt-2 break-words text-xs text-graphite">Reference: {reference}</p>
      <p className="mt-1 text-xs text-graphite">Captured: <time dateTime={capturedAt}>{capturedAt}</time></p>
      <div className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">{document.content}</div>
    </details>)}
  </section>;
}
