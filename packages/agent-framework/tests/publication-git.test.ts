import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { gitSourceReader } from "../src/publication/git-source.js";
import { bytesHash } from "../src/publication/manifest.js";
const exec = promisify(execFile);
describe("Exact Git source reader", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "publication-git-"));
    const git = async (...args: string[]) =>
      (
        await exec("git", [
          "-C",
          root,
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Synthetic Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          ...args,
        ])
      ).stdout.trim();
    await git("init", "--quiet");
    await writeFile(join(root, "page.txt"), "source");
    await writeFile(join(root, "lock.json"), "lock");
    await git("add", ".");
    await git("commit", "--quiet", "-m", "Synthetic source");
    const source = {
      repoRef: "repo:synthetic",
      commit: await git("rev-parse", "HEAD"),
      tree: await git("rev-parse", "HEAD^{tree}"),
      files: [{ path: "page.txt", hash: bytesHash("source"), bytes: 6 }],
      lockfile: { path: "lock.json", hash: bytesHash("lock"), bytes: 4 },
    };
    return {
      root,
      source,
      git,
      read: gitSourceReader({ "repo:synthetic": root }),
      close: () => rm(root, { recursive: true, force: true }),
    };
  }
  it("matches committed and checked-out bytes and denies dirt, wrong hashes and unknown roots", async () => {
    const f = await fixture();
    try {
      await f.read(f.source);
      await expect(f.read({ ...f.source, repoRef: "unbound" })).rejects.toThrow(/not bound/);
      await expect(f.read({ ...f.source, tree: "c".repeat(40) })).rejects.toThrow(/tree/);
      await expect(
        f.read({ ...f.source, files: [{ ...f.source.files[0], hash: bytesHash("wrong") }] }),
      ).rejects.toThrow(/bytes/);
      await writeFile(join(f.root, "page.txt"), "edited");
      await expect(f.read(f.source)).rejects.toThrow(/not clean/);
    } finally {
      await f.close();
    }
  });
  it("rejects committed symlinks instead of reading outside the server-bound repository", async () => {
    const f = await fixture();
    try {
      await rm(join(f.root, "page.txt"));
      await symlink("lock.json", join(f.root, "page.txt"));
      await f.git("add", ".");
      await f.git("commit", "--quiet", "-m", "Synthetic symlink");
      f.source.commit = await f.git("rev-parse", "HEAD");
      f.source.tree = await f.git("rev-parse", "HEAD^{tree}");
      await expect(f.read(f.source)).rejects.toThrow(/symlink/);
    } finally {
      await f.close();
    }
  });
});
