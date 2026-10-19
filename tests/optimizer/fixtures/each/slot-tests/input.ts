// rewrite-applies: presence-optional
// rewrite-applies: presence-required
// rewrite-applies: compare-null-strict-equal
// rewrite-applies: compare-null-strict-not-equal
// rewrite-applies: coalesce-optional
// rewrite-applies: coalesce-required
// rewrite-applies: optional-chain-read
import { archetype, component, createWorld, each, register, spawn } from "ecstatic";

const Spot = component("ProbeSpot", { x: 0 });
const Guard = component("ProbeGuard", { hp: 0 });

/**
 * Tests slots for presence, compares them with `undefined` and `null`, negated forms included, coalesces them in
 * tests, and reads a field through an optional chain, on a row whose optional is enabled and on one where it is not.
 *
 * @returns What each test and read gave, row by row.
 */
export function scenario(): unknown {
  const storage = register(createWorld(), archetype([Spot], [Guard]));
  spawn(storage, { ProbeSpot: { x: 1 }, ProbeGuard: { hp: 4 } });
  spawn(storage, { ProbeSpot: { x: 2 } });
  const trace: unknown[] = [];

  // fallow-ignore-next-line complexity -- the callback packs the forms under test into one body
  each(storage, (e) => {
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- testing an optional slot is the lowering under test
    trace.push(e.ProbeGuard ? 1 : 0, !e.ProbeGuard);
    trace.push(
      e.ProbeGuard === undefined,
      e.ProbeGuard !== undefined,
      !(e.ProbeGuard === undefined),
    );
    trace.push(e.ProbeGuard == null, e.ProbeGuard != null);
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- comparing a slot with null is the lowering under test
    trace.push(e.ProbeGuard === null, e.ProbeGuard !== null);
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- comparing a slot with null is the lowering under test
    trace.push(e.ProbeSpot === null, e.ProbeSpot !== null);
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- comparing a required slot is the lowering under test
    trace.push(e.ProbeSpot === undefined, e.ProbeSpot != null);
    // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/strict-boolean-expressions -- testing a required slot is the lowering under test
    trace.push(!e.ProbeSpot, e.ProbeSpot ? 1 : 0);
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- an optional slot in a test position is the lowering under test
    if (e.ProbeGuard && e.ProbeGuard.hp > 0) trace.push("guarded");
    let fallbacks = 0;
    // oxlint-disable-next-line typescript/strict-boolean-expressions -- coalescing an optional slot in a test is the lowering under test
    if (e.ProbeGuard ?? ((fallbacks += 1), false)) trace.push("guard");
    // oxlint-disable-next-line typescript/no-unnecessary-condition, typescript/strict-boolean-expressions -- coalescing a required slot in a test is the lowering under test
    if (e.ProbeSpot ?? ((fallbacks += 10), false)) trace.push("spot");
    trace.push(fallbacks, e.ProbeGuard?.hp);
  });

  return trace;
}
