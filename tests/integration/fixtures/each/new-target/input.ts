// rewrite-applies: new-target
import { archetype, component, createWorld, each, register, spawn, type Storage } from "ecstatic";

const Plot = component("FieldPlot", { x: 0 });
const Field = archetype([Plot]);

/** Walks a storage from its constructor with an arrow callback that reads the constructor's `new.target`. */
class Census {
  readonly seen: unknown[] = [];

  /**
   * Records each row's plot with the class `new` was called on.
   *
   * @param storage - The storage to walk.
   */
  constructor(storage: Storage<typeof Field>) {
    each(storage, (e) => {
      this.seen.push(e.FieldPlot.x, new.target.name);
    });
  }
}

/** A subclass, which `new.target` names when it is the class constructed. */
class Survey extends Census {}

/**
 * Constructs the class and its subclass over one storage, so the callback's `new.target` is each in turn.
 *
 * @returns What each constructor's callback recorded.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), Field);
  spawn(storage, { FieldPlot: { x: 1 } });
  spawn(storage, { FieldPlot: { x: 2 } });
  return [new Census(storage).seen, new Survey(storage).seen];
}
