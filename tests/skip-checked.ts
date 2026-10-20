import { beforeEach, type TestContext } from "vitest";

/** Skips the running test when its title carries `#checked`. */
export function skipChecked(context: TestContext): void {
  if (context.task.name.includes("#checked")) context.skip();
}

// A `#checked` test pins behavior only `DEBUG` builds have, which the `NDEBUG` define turns off.
// Vitest has no per-project name filter (`testNamePattern` is a root-only option), so the
// `unit-ndebug` project skips them here.
beforeEach(skipChecked);
