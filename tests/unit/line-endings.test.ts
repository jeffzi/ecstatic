import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const ROOT = resolve(import.meta.dirname, "../..");

it("checks out every tracked text file with LF endings", async () => {
  const { stdout } = await execFileAsync("git", ["ls-files", "--eol"], {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });

  const notLf = stdout
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("i/-text"))
    .filter((line) => !(line.split("\t")[0] ?? "").includes("eol=lf"));

  expect(notLf).toStrictEqual([]);
});
