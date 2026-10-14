import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { assert } from "../validation.js";
import { bytesHash, type PublicationManifest } from "./manifest.js";
const exec = promisify(execFile);
/** Read-only exact source proof. repoRef selects a server-owned root; no client commands. */
export function gitSourceReader(roots: Readonly<Record<string, string>>) {
  return async (source: PublicationManifest["source"]) => {
    const configured = roots[source.repoRef];
    assert(configured, "Source repository is not bound");
    const root = await realpath(configured);
    const git = async (...args: string[]) =>
      (
        await exec("git", ["--no-optional-locks", "-C", root, ...args], {
          encoding: "buffer",
          maxBuffer: 22_000_000,
          timeout: 10_000,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
          },
        })
      ).stdout;
    const clean = async () => {
      assert(
        (await git("rev-parse", "HEAD")).toString().trim() === source.commit &&
          (await git("rev-parse", "HEAD^{tree}")).toString().trim() === source.tree,
        "Source commit or tree changed",
      );
      assert(
        !(await git("status", "--porcelain=v1", "--untracked-files=all")).length,
        "Source worktree is not clean",
      );
    };
    await clean();
    for (const file of [...source.files, source.lockfile]) {
      const path = resolve(root, file.path),
        actual = await realpath(path),
        rel = relative(root, actual);
      assert(
        rel && !rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel) && actual === path,
        "Source path escaped repository or used a symlink",
      );
      const stat = await lstat(path);
      assert(
        stat.isFile() && !stat.isSymbolicLink() && stat.size === file.bytes,
        "Source file size changed",
      );
      const working = await readFile(path),
        committed = await git("show", `${source.commit}:${file.path}`);
      assert(
        working.length === file.bytes &&
          committed.length === file.bytes &&
          bytesHash(working) === file.hash &&
          bytesHash(committed) === file.hash,
        "Source file bytes changed",
      );
    }
    await clean();
  };
}
