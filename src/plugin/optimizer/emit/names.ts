/**
 * Generated names for the bindings and labels a rewrite adds to a file.
 *
 * The 7.1 factory has no `createUniqueName` or `createTempVariable`, so this module reproduces the
 * scheme tsgo's printer applies to an optimistic unique name: the base name when it is free,
 * otherwise the base followed by `_1`, `_2`, and so on, taking the first that is free. A name is
 * free when no identifier in the file spells it and no earlier generated name took it.
 *
 * @module
 */

import { isIdentifier, type Node } from "typescript/ast";

/** Hands out names that collide with no identifier of one file and with no name it handed out before. */
export class NameGenerator {
  readonly #taken: Set<string>;

  /**
   * @param file - The file the names are added to, every identifier under it taken; or a generator
   *   whose taken names this one starts from and then takes names apart from, so a caller can drop
   *   the names it hands out by dropping it.
   */
  constructor(file: Node | NameGenerator) {
    this.#taken = file instanceof NameGenerator ? new Set(file.#taken) : identifierTexts(file);
  }

  /**
   * Takes the first free name for `base`.
   *
   * @param base - The name to take when free, and the stem of the numbered names tried after it.
   * @returns `base` when free, otherwise the first free `base_1`, `base_2`, and so on. A base that
   *   already ends in `_` takes the number directly (`row_` gives `row_1`), as tsgo's does.
   */
  unique(base: string): string {
    let name = base;
    if (this.#taken.has(name)) {
      const stem = base.endsWith("_") ? base : `${base}_`;
      let suffix = 1;
      do {
        name = `${stem}${suffix}`;
        suffix += 1;
      } while (this.#taken.has(name));
    }
    this.#taken.add(name);
    return name;
  }
}

/**
 * The text of every identifier under `root`.
 *
 * @param root - The node whose subtree is searched, `root` included.
 * @returns The identifier texts. The walk keeps its own stack, so a deeply nested file cannot
 *   overflow the call stack.
 */
function identifierTexts(root: Node): Set<string> {
  const texts = new Set<string>();
  const pending: Node[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (isIdentifier(node)) {
      texts.add(node.text);
    }
    node.forEachChild((child) => {
      pending.push(child);
    });
  }
  return texts;
}
