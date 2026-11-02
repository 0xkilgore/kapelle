import "server-only";

export type ReportReadCaller = "unspecified" | "library-cache" | "snapshot-refresh" | "inbox-result-verification" | "document-result-discovery" | "selected-reports";
type Tool = "getDocument" | "getDocuments";
const callers: readonly string[] = ["unspecified", "library-cache", "snapshot-refresh", "inbox-result-verification", "document-result-discovery", "selected-reports"];

/** Diagnostic summary only. Never include identifiers, URLs, credentials, bodies, or exception text. */
export function reportReadTrace(caller: ReportReadCaller) {
  const enabled = process.env.KAPELLE_REPORT_READ_TRACE === "1";
  const started = performance.now();
  const queries = {
    getDocument: { count: 0, completed: 0, failed: 0, totalMs: 0, maxMs: 0 },
    getDocuments: { count: 0, completed: 0, failed: 0, totalMs: 0, maxMs: 0 },
  };
  let bytes = 0, closed = false;
  return {
    bytes(count: number) { if (enabled) bytes += count; },
    async measure<T>(tool: Tool, run: () => Promise<T>): Promise<T> {
      if (!enabled) return run();
      const at = performance.now();
      const row = queries[tool];
      row.count++;
      try { return await run(); }
      catch (error) { row.failed++; throw error; }
      finally { row.completed++; const ms = performance.now() - at; row.totalMs += ms; row.maxMs = Math.max(row.maxMs, ms); }
    },
    close(success: boolean) {
      if (!enabled || closed) return;
      closed = true;
      // Diagnostics must not change authority outcomes if the logging sink fails.
      try {
        console.info(JSON.stringify({event: "kapelle.report-read.v1", completedAt: new Date().toISOString(), pid: process.pid, caller: callers.includes(caller) ? caller : "unspecified", outcome: success ? "success" : "failed", durationMs: performance.now() - started, bytes, queries}));
      } catch { /* Best-effort diagnostics. */ }
    },
  };
}
