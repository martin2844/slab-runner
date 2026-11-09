import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};

export function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

export interface GitFixture {
  directory: string;
  codeRoot: string;
  remotePath: string;
  remoteUrl: string;
  cleanup(): void;
}

/** A bare repository (served via file://) with a small `main` branch. */
export function createGitFixture(
  files: Record<string, string> = {
    "README.md": "# Fixture\n",
    "src/a.txt": "one\ntwo\nthree\n",
    ".gitignore": "node_modules/\n",
  },
): GitFixture {
  const directory = mkdtempSync(join(tmpdir(), "slab-runner-git-"));
  const source = join(directory, "source");
  mkdirSync(source);
  gitSync(source, "init", "--quiet", "-b", "main");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(source, name)), { recursive: true });
    writeFileSync(join(source, name), content);
  }
  gitSync(source, "add", "-A");
  gitSync(source, "commit", "--quiet", "-m", "Initial commit");
  const remotePath = join(directory, "remote.git");
  gitSync(directory, "clone", "--quiet", "--bare", source, remotePath);
  return {
    directory,
    codeRoot: join(directory, "code"),
    remotePath,
    remoteUrl: `file://${remotePath}`,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
