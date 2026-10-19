// rewrite-applies: required-tag
// rewrite-applies: optional-tag
// rewrite-applies: presence-optional
import { archetype, component, createWorld, disable, each, register, spawn } from "ecstatic";

const Flag = component("BannerFlag", { size: 0 });
const Raised = component("BannerRaised");
const Torn = component("BannerTorn");

/**
 * Reads a required and an optional tag as values and tests the optional one, on a row where it is enabled, then
 * again after disabling it in the same callback, and on a row where it never was.
 *
 * @returns The tag values and test results, row by row.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Flag, Raised], [Torn]));
  spawn(storage, { BannerFlag: { size: 1 }, BannerTorn: true });
  spawn(storage, { BannerFlag: { size: 2 } });
  const trace: unknown[] = [];

  each(storage, (e) => {
    const torn = e.BannerTorn;
    trace.push(e.BannerRaised, torn ?? "none", e.BannerTorn === true);
    if (e.BannerTorn) {
      disable(storage, e.id, Torn);
      trace.push(e.BannerTorn, torn);
    }
  });

  return trace;
}
