// rewrite-applies: mode-hoisted
// rewrite-applies: read-required-field
// rewrite-applies: write-required-field
import { archetype, component, createWorld, each, get, ref, register, spawn } from "ecstatic";

const Note = component("ScrollNote", { text: "", page: 0 });
const Seal = component("ScrollSeal", { owner: ref<string>() });

/**
 * Reads and writes fields stored in plain arrays, a string and a `ref()` field, beside a numeric one, in a body
 * that makes no call.
 *
 * @returns Each row's fields after the loop.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Note, Seal]));
  const ids = [
    spawn(storage, { ScrollNote: { text: "a", page: 1 }, ScrollSeal: { owner: "ann" } }),
    spawn(storage, { ScrollNote: { text: "b", page: 2 } }),
  ];

  each(storage, (e) => {
    e.ScrollNote.text = e.ScrollNote.text + e.ScrollNote.page;
    e.ScrollNote.text += "!";
    e.ScrollSeal.owner ??= e.ScrollNote.text;
  });

  return ids.map((id) => [get(storage, id, Note.text), get(storage, id, Seal.owner)]);
}
