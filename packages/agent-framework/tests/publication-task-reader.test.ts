import { createServer } from "node:http";
import { once } from "node:events";
import { describe, it, expect } from "vitest";
import { PublicationTaskReader } from "../src/publication/task-reader.js";
function fixture() {
  const state = {
    id: "task",
    schemaVersion: 1,
    revision: 1,
    ownerId: "native-owner",
    projectId: "project",
    title: "Existing commitment",
    bodyMarkdown: "Exact completion criteria",
    sourceRef: "kapelle:report:report",
    status: "OPEN",
  };
  const reader = new PublicationTaskReader(
    {
      origin: "http://127.0.0.1:4261",
      token: () => "synthetic-task-read-token-0123456789",
      authorityRef: "task-authority",
      taskId: "task",
      nativeOwnerId: "native-owner",
      frameworkOwnerId: "framework-owner",
      scopeRef: "scope",
      projectId: "project",
      reportId: "report",
    },
    async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:4261/v1/tasks/task");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      return Response.json(state);
    },
  );
  return { state, reader };
}
describe("Trusted existing Task commitment reader", () => {
  it("preserves explicit owner mapping and hashes commitment independently of unrelated revision", async () => {
    const f = fixture(),
      a = await f.reader.read();
    f.state.revision++;
    expect((await f.reader.read()).commitmentHash).toBe(a.commitmentHash);
    expect(a.nativeOwnerId).toBe("native-owner");
    expect(a.ownerId).toBe("framework-owner");
  });
  it.each(["ownerId", "projectId", "sourceRef", "id"] as const)(
    "rejects changed %s",
    async (field) => {
      const f = fixture();
      f.state[field] = "wrong";
      await expect(f.reader.read()).rejects.toThrow(/differs/);
    },
  );
  it.each(["body", "done", "mapping"])("rejects %s changes for publication", async (fault) => {
    const f = fixture(),
      first = await f.reader.read();
    const input = {
      managerTaskRef: "manager-existing",
      authorityRef: first.authorityRef,
      authorityTaskRef: first.taskRef,
      commitmentHash: first.commitmentHash,
    };
    if (fault === "body") f.state.bodyMarkdown = "Changed commitment";
    if (fault === "done") f.state.status = "DONE";
    if (fault === "mapping") input.managerTaskRef = "different";
    await expect(f.reader.publicationTask("manager-existing")(input)).rejects.toThrow(/commitment/);
  });
});


it("reads an actual private HTTP endpoint and refuses completion or changed output after initial admission", async () => {
  const f = fixture(); let requests = 0; let writes = 0;
  const token = "synthetic-task-reader-00000000000000000000";
  const server = createServer((req, res) => {
    requests++;
    if (req.method !== "GET") writes++;
    if (req.method !== "GET" || req.url !== "/v1/tasks/task" || req.headers.authorization !== "Bearer " + token) {
      res.writeHead(403).end(); return;
    }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(f.state));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const reader = new PublicationTaskReader({ origin: `http://127.0.0.1:${(server.address() as any).port}`,
      token: () => token, authorityRef: "task-authority", taskId: "task", nativeOwnerId: "native-owner",
      frameworkOwnerId: "framework-owner", scopeRef: "scope", projectId: "project", reportId: "report" });
    const original = await reader.read();
    const expected = { managerTaskRef: "manager-existing", authorityRef: original.authorityRef,
      authorityTaskRef: original.taskRef, commitmentHash: original.commitmentHash };
    await reader.publicationTask("manager-existing")(expected);
    f.state.status = "DONE"; f.state.revision++;
    await expect(reader.publicationTask("manager-existing")(expected)).rejects.toThrow(/inactive/);
    f.state.status = "OPEN"; f.state.bodyMarkdown = "New completion criteria";
    await expect(reader.publicationTask("manager-existing")(expected)).rejects.toThrow(/commitment/);
    f.state.bodyMarkdown = "Exact completion criteria"; f.state.sourceRef = "kapelle:report:new-output";
    await expect(reader.publicationTask("manager-existing")(expected)).rejects.toThrow(/report link/);
    expect(requests).toBe(5); expect(writes).toBe(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
