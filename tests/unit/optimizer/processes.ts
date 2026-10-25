/** Finds and watches the compiler processes this test process starts, such as the one a session opens. */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

import { expect, vi } from "vitest";

const execFileAsync = promisify(execFile);

/** The compiler's executable name, without the `.exe` it carries on Windows. */
const COMPILER_NAME = "tsc";

/** One line of a process listing: the process ID, its parent's ID, then its executable. */
const LISTING_LINE = /^(\d+)\s+(\d+)\s+(.+)$/u;

/**
 * The process IDs of this process's live compiler children.
 *
 * Only compiler processes count: a listing this process runs is also its child while it runs, so
 * an overlapping listing, such as one a timed-out test left running, would otherwise count as a
 * compiler.
 *
 * @returns The IDs, in listing order.
 * @throws When the process listing command fails.
 */
export async function childProcessIds(): Promise<number[]> {
  const { stdout } =
    process.platform === "win32"
      ? await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId) ${process.pid} $($_.Name)" }`,
        ])
      : await execFileAsync("ps", ["-A", "-o", "pid=,ppid=,comm="]);
  return stdout
    .split(/\r?\n/u)
    .flatMap((line) => {
      const [, pid, parent, command] = LISTING_LINE.exec(line.trim()) ?? [];
      return Number(parent) === process.pid && command !== undefined && isCompiler(command)
        ? [Number(pid)]
        : [];
    })
    .filter(isAlive);
}

function isCompiler(command: string): boolean {
  return basename(command, ".exe") === COMPILER_NAME;
}

/** The process IDs of this process's live compiler children, as a set. */
export async function runningProcesses(): Promise<Set<number>> {
  return new Set(await childProcessIds());
}

/** The live compiler children of this process that were not in `before`. */
export async function processesStartedSince(before: ReadonlySet<number>): Promise<number[]> {
  return (await childProcessIds()).filter((pid) => !before.has(pid));
}

/** Whether `pid` is running; a process owned by another user answers EPERM and still counts. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

/** Waits until `pid` is no longer running. */
export async function waitUntilDead(pid: number): Promise<void> {
  await vi.waitFor(() => {
    expect(isAlive(pid)).toBe(false);
  });
}
