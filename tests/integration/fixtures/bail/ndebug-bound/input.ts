import { createWorld, each, get, register, spawn } from "ecstatic";

import { Mover, Position } from "../../schema.js";

/**
 * Moves every row once under each form of an `NDEBUG` declaration in scope at the call: a block's
 * `const` and `let`, and an enclosing function's `var`, parameter, function, and class.
 *
 * @returns The `forms` each declaration produced, in call order, and `xs`, each row's `Position.x`
 *   after every pass.
 */
export function scenario(): unknown {
  const world = createWorld();
  const movers = register(world, Mover);
  const ids = [
    spawn(movers, { Position: { x: 1, y: 0 } }),
    spawn(movers, { Position: { x: 2, y: 0 } }),
  ];
  const forms: string[] = [];

  {
    const NDEBUG = "const";
    // expect-diagnostic: warning 99921 NDEBUG_BOUND 5
    each(movers, (e) => {
      e.Position.x += 1;
    });
    forms.push(NDEBUG);
  }

  {
    let NDEBUG = "let";
    // expect-diagnostic: warning 99921 NDEBUG_BOUND 5
    each(movers, (e) => {
      e.Position.x += 2;
    });
    NDEBUG = NDEBUG.toUpperCase();
    forms.push(NDEBUG);
  }

  function viaVar(): void {
    // oxlint-disable-next-line no-var -- a `var` declaration of NDEBUG is the behavior under test
    var NDEBUG = "var";
    // expect-diagnostic: warning 99921 NDEBUG_BOUND 5
    each(movers, (e) => {
      e.Position.x += 4;
    });
    forms.push(NDEBUG);
  }

  function viaParameter(NDEBUG: string): void {
    // expect-diagnostic: warning 99921 NDEBUG_BOUND 5
    each(movers, (e) => {
      e.Position.x += 8;
    });
    forms.push(NDEBUG);
  }

  function viaFunction(): void {
    function NDEBUG(): string {
      return "function";
    }
    // expect-diagnostic: warning 99921 NDEBUG_BOUND 5
    each(movers, (e) => {
      e.Position.x += 16;
    });
    forms.push(NDEBUG());
  }

  function viaClass(): void {
    class NDEBUG {
      readonly form = "class";
    }
    // expect-diagnostic: warning 99921 NDEBUG_BOUND 5
    each(movers, (e) => {
      e.Position.x += 32;
    });
    forms.push(new NDEBUG().form);
  }

  viaVar();
  viaParameter("parameter");
  viaFunction();
  viaClass();

  return { forms, xs: ids.map((id) => get(movers, id, Position.x)) };
}
