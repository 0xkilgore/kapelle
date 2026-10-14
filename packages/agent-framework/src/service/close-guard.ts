/** Retry failed cleanup, attempt every step, and retain exclusion on any failure. */
export function guardedClose(steps: Array<() => void | Promise<void>>, release: () => void) {
  const completed = new Set<number>();
  let released = false;
  let running: Promise<void> | undefined;
  return function close(): Promise<void> {
    if (released) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const errors: unknown[] = [];
      for (let i = 0; i < steps.length; i++) {
        if (completed.has(i)) continue;
        try { await steps[i](); completed.add(i); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'runtime_cleanup_incomplete_lock_retained');
      release();
      released = true;
    })().finally(() => { running = undefined; });
    return running;
  };
}
