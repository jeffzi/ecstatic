import { describe, expect, it } from "vitest";

import type { Session } from "../../../src/plugin/optimizer/session.js";
import { ServedProject } from "../../../src/plugin/served-project.js";

/** A program module as a Windows session names it. */
const NATIVE_MODULE = "C:\\work\\app\\main.ts";

/** A declaration file as a Windows session names it. */
const NATIVE_DECLARATION = "C:\\work\\app\\types.d.ts";

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

describe("ServedProject", () => {
  describe("over a session that names its files the Windows way", () => {
    it.each([
      { vite: "c:/work/app/main.ts", expected: NATIVE_MODULE },
      { vite: "C:/work/app/main.ts", expected: NATIVE_MODULE },
      { vite: "c:/work/app/types.d.ts", expected: undefined },
      { vite: "c:/work/app/other.ts", expected: undefined },
    ])("matches the Vite id $vite to the program file $expected", ({ vite, expected }) => {
      const project = new ServedProject(recordingSession([]), [NATIVE_MODULE, NATIVE_DECLARATION]);

      const file = project.programFile(vite);

      expect(file).toBe(expected);
    });

    it("tells the session of a change under the file's own name", async () => {
      const notified: string[][] = [];
      const project = new ServedProject(recordingSession(notified), [NATIVE_MODULE]);

      await project.changed("c:/work/app/main.ts", "delete");

      expect(notified).toStrictEqual([[NATIVE_MODULE]]);
    });
  });
});
