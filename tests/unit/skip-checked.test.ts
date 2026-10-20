import { afterAll, beforeEach, expect, it } from "vitest";

import { skipChecked } from "../skip-checked.js";

let untaggedRan = false;

beforeEach(skipChecked);

afterAll(() => {
  if (!untaggedRan) throw new Error("the untagged test was skipped");
});

it("skips a test whose title carries #checked", () => {
  expect.unreachable("a #checked test ran");
});

it("runs a test without the tag", () => {
  untaggedRan = true;

  expect(untaggedRan).toBe(true);
});
