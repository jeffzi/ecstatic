import { beforeEach } from "vitest";

// A `#checked` test pins behavior only `DEBUG` builds have, which the `NDEBUG` define turns off.
// Vitest has no per-project name filter (`testNamePattern` is a root-only option), so the
// `unit-ndebug` project skips them here.
beforeEach((context) => {
  if (context.task.name.includes("#checked")) context.skip();
});
