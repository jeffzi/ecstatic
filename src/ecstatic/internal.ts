/**
 * Runtime entry point for code the optimizer generates, imported as
 * `ecstatic/internal`.
 *
 * Private: this is not public API and carries no semver guarantee. It is versioned with the
 * optimizer that ships in the same package, so the generated code and the functions it
 * calls always come from one release. Application code imports `ecstatic` instead.
 */

export { throwInvalidEachArguments } from "./entity/each.js";
export { disableOne, enableOne } from "./entity/optional.js";
export { isArray, resolveFilterMasks } from "./filter.js";
export { matcherFor } from "./matcher.js";
export { assertFilterMember, assertShape } from "./shape-guard.js";
