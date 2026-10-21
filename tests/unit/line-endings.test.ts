import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const ROOT = resolve(import.meta.dirname, "../..");

/** The index states of a file with no line endings to check: binary, or holding no line break. */
const NO_ENDINGS: ReadonlySet<string> = new Set(["i/-text", "i/none"]);

/** The lines of `git ls-files --eol` output whose file is stored, or set to check out, with endings other than LF. */
function notLfLines(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line !== "")
    .filter((line) => {
      const [info = ""] = line.split("\t");
      const [index = ""] = info.split(/\s+/u);
      if (NO_ENDINGS.has(index)) return false;
      return index !== "i/lf" || !info.includes("eol=lf");
    });
}

describe("notLfLines", () => {
  it.each([
    { name: "stored with CRLF", line: "i/crlf  w/crlf  attr/text=auto eol=lf \tbanana.ts" },
    {
      name: "stored with mixed endings",
      line: "i/mixed w/mixed attr/text=auto eol=lf \tbanana.ts",
    },
    {
      name: "set to check out without LF",
      line: "i/lf    w/lf    attr/text=auto      \tbanana.ts",
    },
    {
      name: "set to CRLF, LF named only in its path",
      line: "i/lf    w/lf    attr/text eol=crlf \teol=lf.ts",
    },
  ])("lists a file $name", ({ line }) => {
    expect(notLfLines(`${line}\n`)).toStrictEqual([line]);
  });

  it.each([
    { name: "stored with LF", line: "i/lf    w/lf    attr/text=auto eol=lf \tbanana.ts" },
    { name: "binary", line: "i/-text w/-text attr/text=auto eol=lf \tbanana.png" },
    { name: "without a line break", line: "i/none  w/none  attr/text=auto eol=lf \tbanana.txt" },
  ])("passes a file $name", ({ line }) => {
    expect(notLfLines(`${line}\n`)).toStrictEqual([]);
  });
});

it("stores and checks out every tracked text file with LF endings", async () => {
  const { stdout } = await execFileAsync("git", ["ls-files", "--eol"], {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
  });

  const notLf = notLfLines(stdout);

  expect(notLf).toStrictEqual([]);
});
