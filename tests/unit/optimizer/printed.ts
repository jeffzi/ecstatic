/** Recognizes what a rewrite adds to a file in its printed text, and the names the file declares. */

/** The namespace import of the internal entry a rewritten file's preamble opens with. */
export const NAMESPACE_IMPORT = /^import \* as [\w$]+ from "ecstatic\/internal";$/mu;

/** Opens the row loop of an inlined each. */
export const ROW_LOOP = "for (let ";

/** A namespace import or a variable declaration, capturing the name it binds. */
const DECLARED_NAME =
  /(?:\bimport \* as |\b(?:const|let|var)\s+|,\s+)([A-Za-z_$][\w$]*)(?: =| from)/gu;

/** A label of a loop, capturing its name. */
const LOOP_LABEL = /\b([A-Za-z_$][\w$]*):\s*(?:for|while|do)\b/gu;

/** How many times `text` declares each name it declares, as a namespace import, a variable, or a loop label. */
export function declarationCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [, name = ""] of [...text.matchAll(DECLARED_NAME), ...text.matchAll(LOOP_LABEL)]) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}
