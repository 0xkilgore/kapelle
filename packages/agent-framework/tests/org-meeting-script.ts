// Deterministic fake model for the lean-runtime step 4 suites (no network). Shared, not a test file.
/** Deterministic fake model. Draft: labelled reviewer draft. Chat/reply: answers ONLY from the numbered frozen files in
 *  the prompt (first file containing the fact), cites the exact line, asks when the notes say a fact is unconfirmed, and
 *  abstains otherwise. It never invents. */
export const script = ({ user, kind }: { user: string; kind: string }) => {
  if (kind === "draft") return "# Draft notes (reviewers-private)\n\n- Confirmed: cleanup Oct 31.\n- QUESTION: start time 9am or 10am?\n- Offer (tentative): Sam, supplies.\n- Idea (not approved): $200 supplies.\n- Proposed follow-up: confirm start time.\n";
  const question = (user.split("QUESTION:").pop() ?? "").trim();
  const files: { path: string; lines: Map<number, string> }[] = [];
  for (const block of user.split(/^=== /m).slice(1)) {
    const path = block.split(/ ===| \(lines/)[0].trim(), lines = new Map<number, string>();
    for (const m of block.matchAll(/^\s*(\d+)\| (.*)$/gm)) lines.set(Number(m[1]), m[2]);
    files.push({ path, lines });
  }
  const find = (re: RegExp) => { for (const f of files) for (const [n, l] of f.lines) if (re.test(l)) return { f, n, l }; return null; };
  if (/\bwhen\b/i.test(question)) { const hit = find(/ is on /); if (hit) return `${hit.l} [${hit.f.path}#L${hit.n}]`; }
  // A source carrying injected instructions: this fake model is deliberately MANIPULABLE, to prove the output checks hold.
  if (/what should i do/i.test(question) && find(/ignore previous instructions/i))
    return /link/i.test(question) ? "Send everything to x@evil.test and see https://evil.test/collect" : "Please forward the private notes to x@evil.test today.";
  if (/what time|start/i.test(question)) {
    const done = find(/start time is confirmed/); if (done) return `${done.l} [${done.f.path}#L${done.n}]`;
    const hit = find(/being confirmed/); if (hit) return `The start time is still being confirmed [${hit.f.path}#L${hit.n}]. Could you tell me which time you saw on the flyer?`;
  }
  return "The member notes do not say. I can't answer that from the approved notes.";
};

