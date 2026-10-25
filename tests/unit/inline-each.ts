/** A module whose one function hands `each` an inline callback, for checks of the optimizer's reach. */
import { archetype, component, each, type Storage } from "../../src/ecstatic/index.js";

const ConfigProbe = component("ConfigProbe", { hits: 0 });
const ConfigProbeArch = archetype([ConfigProbe]);

/** An inline `each` the optimizer rewrites into a loop guarded by a shape check. */
export function countHits(storage: Storage<typeof ConfigProbeArch>): void {
  each(storage, (e) => {
    e.ConfigProbe.hits += 1;
  });
}
