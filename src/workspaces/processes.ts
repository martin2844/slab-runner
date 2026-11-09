import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { sep } from "node:path";

const PROC = "/proc";
const MAX_PASSES = 5;

function parentPid(pid: number): number | null {
  try {
    const stat = readFileSync(`${PROC}/${pid}/stat`, "utf8");
    // Field 2 (comm) may contain spaces and parentheses; fields after the last
    // ")" are well-formed: state, ppid, ...
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number.parseInt(rest[1] ?? "", 10);
    return Number.isFinite(ppid) ? ppid : null;
  } catch {
    return null;
  }
}

/** The runner itself and all of its ancestors. */
function protectedPids(): Set<number> {
  const pids = new Set<number>();
  let pid: number | null = process.pid;
  while (pid && pid > 0 && !pids.has(pid)) {
    pids.add(pid);
    pid = parentPid(pid);
  }
  return pids;
}

function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`);
}

/**
 * SIGKILL every process whose working directory is inside `directory`, except
 * the runner itself, its ancestors and its direct children (runner-owned git
 * and setup commands). Linux only: a no-op where `/proc` does not exist.
 * Returns the number of processes signalled.
 */
export function killProcessesIn(directory: string): number {
  if (process.platform !== "linux" || !existsSync(`${PROC}/self`)) return 0;
  let target: string;
  try {
    target = realpathSync(directory);
  } catch {
    target = directory;
  }
  const keep = protectedPids();
  let killed = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let found = 0;
    let entries: string[];
    try {
      entries = readdirSync(PROC);
    } catch {
      return killed;
    }
    for (const name of entries) {
      if (!/^\d+$/.test(name)) continue;
      const pid = Number.parseInt(name, 10);
      if (keep.has(pid)) continue;
      let cwd: string;
      try {
        cwd = readlinkSync(`${PROC}/${pid}/cwd`);
      } catch {
        continue; // exited, zombie or not ours
      }
      if (cwd.endsWith(" (deleted)")) cwd = cwd.slice(0, -" (deleted)".length);
      if (!isInside(cwd, target) && !isInside(cwd, directory)) continue;
      if (parentPid(pid) === process.pid) continue;
      try {
        process.kill(pid, "SIGKILL");
        found++;
      } catch {
        // Already gone or not permitted.
      }
    }
    killed += found;
    if (found === 0) break;
  }
  return killed;
}
