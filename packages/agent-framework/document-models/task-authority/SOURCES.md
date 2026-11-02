# kilgore/task (task-authority v1) — lifted model

- **Source:** owner repository (Task Authority), `task-authority-package/generated/task-authority/` at commit
  `41f90f34` ("Validate shared runtime profile before opening Task stores or listeners"), the commit the live Task
  Authority serves (ops/live-task-authority-20261015). Owner code; direct lift per decision #77.
- **Copied verbatim** (no edits): `index.ts`, `task-authority.json`, `upgrades/`, `v1/` (generated + reducers + tests).
- **Why:** lean runtime step 4 (Fable step-4 ruling): Tasks live inside each org runtime's SQLite authority behind the
  Framework command boundary. Only CREATE_TASK (on passkey-authorized adopt), UPDATE_BODY, ADD_COMMENT, COMPLETE_TASK,
  REOPEN_TASK and ARCHIVE_TASK are admitted (`src/org/task-model.ts`); every other operation is refused there.
- **Pin:** model version 1; reducer digest `sha256:7bf9e804ff312aa791d338b2222d3a247b6c3a8fce3c169386b3b55ac06fe475`
  over `src/reducers/{content,context,lifecycle}.ts`, `src/utils.ts`, `gen/reducer.ts` (see `orgTaskReducerDigest()`).
  Any change to these files must re-pin the digest and re-run the export/replay parity suite.
- The personal stack's Task Authority is unchanged and is never configured for, or reachable from, an org runtime.
