# Chat draft editing: pattern references (Package P)

Decision #77 provenance. **No code or fixture bytes were copied** from either project and no pinned revision was read; the
semantics below were reimplemented in `draft-edits.ts` and its tests (`tests/draft-edits.test.ts`).

| Project (license) | Pattern used | Into | Adapt notes |
|---|---|---|---|
| Aider, https://github.com/Aider-AI/aider (Apache-2.0) | Search/replace edit format: the search text must match exactly; a missing or ambiguous match refuses the edit | `applyDraftEdits` `replace_text` | Typed field targets (title, section heading/body, agenda fields) instead of file text; exactly ONE occurrence; Aider's fuzzy fallback is NOT adopted; no whitespace folding, no regex |
| Codex, https://github.com/openai/codex (Apache-2.0) | apply-patch: a patch applies to its exact parent or not at all | `edit_draft_artifact` (parent version + sha256; all edits or none) | The parent is a saved draft version (row + content hash); a concurrent save makes the edit stale inside the write transaction |

If a later change copies code or fixtures from either repository, pin the revision here, keep its license notice, and record the
copied paths and sha256s in this table.
