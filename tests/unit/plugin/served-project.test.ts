import { sep } from "node:path";

import { describe, expect, it } from "vitest";

import type { Session } from "../../../src/plugin/optimizer/session.js";
import { ServedProject } from "../../../src/plugin/served-project.js";

/** A program module as a Windows session names it. */
const NATIVE_MODULE = "C:\\work\\app\\main.ts";

/** A declaration file as a Windows session names it. */
const NATIVE_DECLARATION = "C:\\work\\app\\types.d.ts";

/** Passed to ServedProject so the Windows key rules run on every host platform. */
const WINDOWS_SEPARATOR = "\\";

/** A session that answers no request and records every change it is told of. */
function recordingSession(notified: string[][]): Session {
  const unanswered = (): Promise<never> => Promise.reject(new Error("banana: no compiler"));
  return {
    tsconfig: "C:\\work\\tsconfig.json",
    update: unanswered,
    notifyChanged: (files) => {
      notified.push([...files]);
    },
    parse: unanswered,
    parseText: unanswered,
    print: unanswered,
    close: async () => {},
  };
}

/** A program module whose name holds a backslash, which only a Windows host reads as a separator. */
const BACKSLASH_MODULE = "/work/app/a\\b.ts";

describe("ServedProject", () => {
  describe("when given no separator", () => {
    it("keys its files by the host platform's separator", () => {
      const project = new ServedProject(recordingSession([]), [BACKSLASH_MODULE]);

      const file = project.programFile("/work/app/a/b.ts");

      expect(file).toBe(sep === "\\" ? BACKSLASH_MODULE : undefined);
    });
  });

  describe("over a session that names its files the Windows way", () => {
    it.each([
      { vite: "c:/work/app/main.ts", expected: NATIVE_MODULE },
      { vite: "C:/work/app/main.ts", expected: NATIVE_MODULE },
      { vite: "c:/work/app/types.d.ts", expected: undefined },
      { vite: "c:/work/app/other.ts", expected: undefined },
    ])("matches the Vite id $vite to the program file $expected", ({ vite, expected }) => {
      const project = new ServedProject(
        recordingSession([]),
        [NATIVE_MODULE, NATIVE_DECLARATION],
        WINDOWS_SEPARATOR,
      );

      const file = project.programFile(vite);

      expect(file).toBe(expected);
    });

    it("tells the session of a change under the file's own name", async () => {
      const notified: string[][] = [];
      const project = new ServedProject(
        recordingSession(notified),
        [NATIVE_MODULE],
        WINDOWS_SEPARATOR,
      );

      await project.changed("c:/work/app/main.ts", "delete");

      expect(notified).toStrictEqual([[NATIVE_MODULE]]);
    });
  });
});
