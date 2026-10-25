/** Finds and watches this test process's child processes, such as the compiler a session starts. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, vi } from "vitest";

const execFileAsync = promisify(execFile);

/** DIAG: last seen description of each child process. */
export const DIAG = new Map<number, string>();

/** DIAG: describes `ids`. */
export function describeChildren(ids: Iterable<number>): string {
  return [...ids]
    .map((pid) => `${pid} alive=${isAlive(pid)} :: ${DIAG.get(pid) ?? "?"}`)
    .join(" || ");
}

/** The process IDs of this process's live children. */
export async function childProcessIds(): Promise<number[]> {
  const { stdout } =
    process.platform === "win32"
      ? await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId) ${process.pid} $($_.Name) $($_.CreationDate.ToString('HH:mm:ss.fff')) $($_.CommandLine)" }`,
        ])
      : await execFileAsync("ps", ["-A", "-o", "pid=,ppid="]);
  for (const line of stdout.split(/\r?\n/)) {
    const [pid] = line.trim().split(/\s+/);
    if (pid !== undefined && pid !== "") DIAG.set(Number(pid), line.trim());
  }
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/).map(Number))
    .flatMap(([pid, parent]) => (pid !== undefined && parent === process.pid ? [pid] : []))
    .filter(isAlive);
}

/** The process IDs of this process's live children, as a set. */
export async function runningProcesses(): Promise<Set<number>> {
  return new Set(await childProcessIds());
}

/** The live children of this process that were not in `before`. */
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
