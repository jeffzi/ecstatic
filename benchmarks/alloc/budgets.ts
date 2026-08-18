/**
 * Pure logic of the allocation gate: the per-op byte budgets, the comparison of
 * a measurement run against them, and the rendering of the verdict report.
 *
 * Nothing here measures anything or touches the process — that shell lives in
 * the gate entry point. Keeping the decisions separate from the measurement is
 * what makes them testable.
 */

/**
 * Bytes allocated per operation that each gated op is allowed.
 *
 * A budget of `0` means the op must not allocate at all on a warm world. A
 * non-zero budget pins an allocation the gate measured at the time the
 * budget was written; its comment names the cause when it is known and calls
 * it a baseline otherwise. Budgets ratchet down only: an op that measures
 * under its budget by more than `EPSILON_BYTES` fails as slack, and the fix
 * is to lower the budget in the same commit. Never raise one to silence a
 * regression.
 */
export const ALLOC_BUDGETS: Readonly<Record<string, number>> = {
  each_all: 0,
  each_filtered: 0,
  query_hot: 0,
  get_1field: 0,
  get_2field: 0,
  set_1field: 0,
  // `set(storage, id, Comp, record)` walks the record with `Object.entries`,
  // which allocates the entries array and one pair per field.
  set_record: 192,
  has: 0,
  has_any: 0,
  alive: 0,
  enable: 0,
  disable: 0,
  enable_data: 0,
  // Baseline: a spawn/despawn pair on a one-component archetype with one
  // optional; source not yet isolated.
  spawn_despawn: 48,
  // `spawnMany` without `out` returns a fresh id array — inherent to the call.
  spawn_despawn_many: 45,
  // Baseline: `spawnMany`/`despawnMany` with a caller-owned id array; source
  // not yet isolated.
  spawn_despawn_many_out: 32,
  resource_get: 0,
  resource_set: 0,
  resource_reset: 0,
  // `link` inserts the source into the target's reverse-map bucket, a `Map`
  // entry per link; `unlink` deletes it, so the pair pays the insert.
  rel_link: 86,
  rel_link_with_data: 86,
  rel_unlink: 86,
  rel_get_target: 0,
  rel_count_sources: 0,
  rel_has_sources: 0,
  // Iterating a reverse-map bucket destructures `Map` entries, one pair per
  // source; `getSources` skips the callback but not the entries.
  rel_query_sources: 80,
  rel_get_sources: 64,
  // Baseline: a spawn/despawn pair on an archetype with a required relation
  // (reverse-map insert plus the spawn path); source not yet isolated.
  rel_spawn_despawn: 134,
};

/**
 * Half-width of the band around a budget that still counts as `ok`.
 *
 * One tagged-pointer slot: on a warm world an allocation-free op reads a zero
 * delta, so the band only has to absorb single-slot noise. Widening it hides
 * real regressions.
 */
export const EPSILON_BYTES = 8;

/** How one op's measurement compares to its budget. */
export type AllocVerdict = "ok" | "over" | "slack" | "unbudgeted" | "unmeasured";

/** One op's place in the gate: what it measured, what it may spend, and the call. */
export interface AllocResult {
  name: string;
  measured: number | undefined;
  budget: number | undefined;
  verdict: AllocVerdict;
}

function bandVerdict(measured: number, budget: number, epsilon: number): AllocVerdict {
  if (measured > budget + epsilon) {
    return "over";
  }

  if (measured < budget - epsilon) {
    return "slack";
  }

  return "ok";
}

function budgetedResult(
  name: string,
  budget: number,
  measured: number | undefined,
  epsilon: number,
): AllocResult {
  return {
    name,
    measured,
    budget,
    verdict: measured === undefined ? "unmeasured" : bandVerdict(measured, budget, epsilon),
  };
}

/**
 * Judge a measurement run against a budget table.
 *
 * Returns one result per op in the union of both key sets: the budgeted ops in
 * budget-table order first, then the measured-but-unbudgeted ops in measurement
 * order. A measurement exactly `epsilon` away from its budget on either side is
 * still `ok`.
 *
 * `measurements` and `budgets` are both in bytes per operation.
 */
export function evaluateAlloc(
  measurements: Readonly<Record<string, number>>,
  budgets: Readonly<Record<string, number>>,
  epsilon: number,
): AllocResult[] {
  const results: AllocResult[] = [];

  for (const [name, budget] of Object.entries(budgets)) {
    results.push(budgetedResult(name, budget, measurements[name], epsilon));
  }

  for (const [name, measured] of Object.entries(measurements)) {
    if (!Object.hasOwn(budgets, name)) {
      results.push({ name, measured, budget: undefined, verdict: "unbudgeted" });
    }
  }

  return results;
}

/** Whether every op landed inside its budget band — an empty run passes. */
export function allocGatePasses(results: readonly AllocResult[]): boolean {
  return results.every((result) => result.verdict === "ok");
}

const MISSING = "-";

function cell(value: number | undefined): string {
  return value === undefined ? MISSING : String(value);
}

function columnWidth(cells: readonly string[]): number {
  return Math.max(0, ...cells.map((text) => text.length));
}

/**
 * Render the results as one line per op — name, measured bytes/op, budget,
 * verdict — closed by a line stating the gate outcome and, on failure, naming
 * every non-`ok` op.
 *
 * The returned string carries no trailing newline; the caller prints it.
 */
export function formatAllocReport(results: readonly AllocResult[]): string {
  const nameWidth = columnWidth(results.map((result) => result.name));
  const measuredWidth = columnWidth(results.map((result) => cell(result.measured)));
  const budgetWidth = columnWidth(results.map((result) => cell(result.budget)));

  const lines = results.map((result) => {
    const name = result.name.padEnd(nameWidth);
    const measured = cell(result.measured).padStart(measuredWidth);
    const budget = cell(result.budget).padStart(budgetWidth);

    return `${name}  ${measured}  ${budget}  ${result.verdict}`;
  });

  const failing = results.filter((result) => result.verdict !== "ok");
  const closing =
    failing.length === 0
      ? "alloc gate: pass"
      : `alloc gate: FAIL — ${failing.map((result) => result.name).join(", ")}`;

  return [...lines, closing].join("\n");
}
