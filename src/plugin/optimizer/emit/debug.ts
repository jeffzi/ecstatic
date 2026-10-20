/** The `DEBUG` gate of an ecstatic package root, which every rewritten file copies. */

import { join } from "node:path";

import type { Expression } from "typescript/ast";
import { isIdentifier, isVariableStatement } from "typescript/ast/is";

import type { Session } from "../session.js";

/** The `DEBUG` initializer of one ecstatic package root. */
export interface Debug {
  /** Absolute path of the runtime's `src/ecstatic/debug.ts` the initializer was taken from. */
  readonly path: string;
  readonly initializer: Expression;
}

/**
 * The runtime's `DEBUG` module of an ecstatic package root.
 *
 * @param root - Directory of the ecstatic package root.
 * @returns Absolute path of the root's `src/ecstatic/debug.ts`.
 */
export function debugPath(root: string): string {
  return join(root, "src", "ecstatic", "debug.ts");
}

/**
 * Takes the initializer of the top-level `DEBUG` declaration in `root`'s `src/ecstatic/debug.ts`.
 *
 * @param session - Session that parses the file, which lies outside its program.
 * @param root - Directory of the ecstatic package root.
 * @returns The file's path and the initializer.
 * @throws When the file cannot be read, naming it; when it declares no top-level `DEBUG` with an
 *   initializer, naming it; or when the session is closed or its process exited.
 */
export async function loadDebug(session: Pick<Session, "parse">, root: string): Promise<Debug> {
  const path = debugPath(root);
  const file = await session.parse(path);
  for (const statement of file.statements) {
    if (!isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const { name, initializer } = declaration;
      if (isIdentifier(name) && name.text === "DEBUG" && initializer !== undefined) {
        return { path, initializer };
      }
    }
  }
  throw new Error(`${path}: no top-level DEBUG declaration with an initializer`);
}
