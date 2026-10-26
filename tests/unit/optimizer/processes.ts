/** Finds and watches the compiler processes this test process starts, such as the one a session opens. */
import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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

/**
 * Suspends `pid` with SIGSTOP and waits until none of its threads can run.
 *
 * Linux stops a process one thread at a time: the signal goes to one thread, which stops the
 * others once it is scheduled. On a loaded machine the other threads go on running meanwhile, long
 * enough to answer a request sent right after the signal. Linux is therefore asked about every
 * thread; other platforms suspend the whole process at once and report it stopped.
 *
 * @param pid - The process to suspend.
 * @throws When `pid` cannot be signalled, such as when no such process exists.
 * @throws When the process has not stopped within the default `vi.waitFor` timeout.
 */
export async function suspend(pid: number): Promise<void> {
  process.kill(pid, "SIGSTOP");
  await vi.waitFor(() => {
    expect(isStopped(pid)).toBe(true);
  });
}

/** The stopped state code, in both the `ps` stat column and `/proc` stat. */
const STOPPED_STATE = "T";

function isStopped(pid: number): boolean {
  if (process.platform !== "linux") return processState(pid)?.startsWith(STOPPED_STATE) === true;
  const tasks = `/proc/${pid}/task`;
  return readdirSync(tasks).every((thread) => {
    const stat = readFileSync(join(tasks, thread, "stat"), "utf8");
    // The state follows the command name, which is in parentheses and may itself hold any byte.
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith(STOPPED_STATE);
  });
}

/**
 * Reads the `ps` state code of a process.
 *
 * @param pid - The process to look up.
 * @returns The state code, or `undefined` once the process is gone.
 */
export function processState(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

/** Waits until `pid` is no longer running. */
export async function waitUntilDead(pid: number): Promise<void> {
  await vi.waitFor(() => {
    expect(isAlive(pid)).toBe(false);
  });
}
