/**
 * Decides, for every ecstatic call site analysis reported, how the optimizer treats it. It reads
 * facts only, so the decisions never depend on the compiler.
 */

import {
  type ArchShape,
  type Callback,
  type EscapeKind,
  type FilterElement,
  type FilterForm,
  iterates,
  type NodeID,
  type Op,
  type Position,
  type Reason,
  type Return,
  type Site,
  type SpawnTarget,
  type ViewEscape,
} from "./facts.js";
import { type FoldedFilter, foldFilter } from "./fold.js";

/** A call site that keeps its runtime call, with the reason it does. */
export interface Bail {
  /**
   * The thrown value's message for an `INTERNAL` bail, and the line, column, and use of the first
   * escaping reference for a `VIEW_ESCAPES` bail; absent for every other reason.
   */
  readonly detail?: string;
  readonly pos: Position;
  readonly call: NodeID;
  readonly op: Op;
  readonly reason: Reason;
}

/**
 * The message of a thrown value, as an `INTERNAL` bail's detail carries it.
 *
 * @param error - The thrown value.
 * @returns An error's own message, or the value as a string.
 */
export function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * How an inlined loop reads the storage's arrays. `hoisted` reads each touched column, and the mask
 * and entity arrays, into locals once per call: the body has no hazard point, so no array is
 * replaced while the loop runs. `realloc-safe` reads every array through the storage's component
 * records on each access: a hazard point in the body may grow the storage, which replaces its
 * arrays.
 */
export type Mode = "hoisted" | "realloc-safe";

/** A literal filter of an inlined `each` call, folded against the call's one shape. */
export interface FoldedPlannedFilter {
  /**
   * The filter's elements, the `all` axis, then `any`, then `none`, each in element order: parallel
   * to `fold.present`. The emitter evaluates them in source order, which an object filter's key
   * order can make differ from this one.
   */
  readonly elements: readonly FilterElement[];
  readonly fold: FoldedFilter;
}

/** The forms of a non-literal filter an inlined loop can tell apart at runtime, as `each` does. */
export type RuntimeFilterForm = Exclude<FilterForm, "unsupported">;

/**
 * A non-literal filter of an inlined `each` call, which the loop resolves at runtime on every call,
 * caching the resolution in its call site's slot.
 */
export interface RuntimePlannedFilter {
  /** The filter expression, evaluated once per call. */
  readonly node: NodeID;
  readonly form: RuntimeFilterForm;
}

/** The filter of an inlined `each` call: folded at build time, or resolved at runtime. */
export type PlannedFilter = FoldedPlannedFilter | RuntimePlannedFilter;

/** An `each` call site whose runtime call becomes an inlined loop over its one storage's columns. */
export interface EachInlining {
  /** The storage's archetype shape, which the loop is compiled against. */
  readonly shape: ArchShape;
  /** The callback's own return statements, each of which ends the row as a callback return does. */
  readonly continues: readonly Return[];
  /**
   * The declarations of the callback's own `var` statements and `for` heads, whose names the row
   * binds afresh, as each call of the callback does.
   */
  readonly varToLet: readonly NodeID[];
  /**
   * The spawn targets in the body that claim a shape other than the iterated one, each guarded
   * against its claimed shape where the spawn runs: a target that is the iterated storage under a
   * lying cast would grow it, replacing the columns a `hoisted` loop holds. Empty in
   * `realloc-safe` mode, whose loop reads every array afresh after a spawn.
   */
  readonly spawnTargets: readonly SpawnTarget[];
  /** The call's filter; absent on a call without a filter argument. */
  readonly filter?: PlannedFilter;
  readonly pos: Position;
  readonly call: NodeID;
  readonly mode: Mode;
}

/** The plan of one file: the sites that keep their runtime call, and the sites that are rewritten. */
export interface PlanResult {
  readonly bails: readonly Bail[];
  readonly rewrites: readonly EachInlining[];
}

const ESCAPE_USES: { readonly [K in Exclude<EscapeKind, "target">]: string } = {
  view: "the view as a value",
  computed: "a computed access",
  "slot-value": "a slot as a value",
  key: "a key outside the shape",
  "slot-assign": "an assignment to a slot",
  chain: "an optional chain past a field",
  nested: "a reference from a nested function",
  "nested-loop": "a reference from a nested callback that keeps its runtime call",
  destructure: "a destructuring form that does not lower",
  "field-call": "a field called as a method",
  "boolean-arithmetic": "arithmetic on a boolean field",
  eval: "a direct eval",
};

/** The outcome of a site that keeps its runtime call, before its call and position are attached. */
interface Verdict {
  readonly reason: Reason;
  readonly detail?: string;
}

/**
 * The first reason a callback cannot be transplanted.
 *
 * @param callback - Callback of an iteration call, `undefined` when it is not written inline.
 * @returns The reason, or the callback itself when it can be transplanted.
 */
function callbackVerdict(callback: Callback | undefined): Reason | Callback {
  if (callback === undefined) return "CALLBACK_NOT_INLINE";
  if (callback.async) return "CALLBACK_ASYNC";
  if (callback.generator) return "CALLBACK_GENERATOR";
  if (
    callback.firstParam === "other" ||
    callback.params > 1 ||
    callback.paramRedeclarations.length > 0
  ) {
    return "CALLBACK_PARAMS";
  }
  if (callback.functionLocal.length > 0) return "CALLBACK_FUNCTION_BINDINGS";
  return callback;
}

/**
 * The first reason that applies to a site, in this order: argument count, statement context, the
 * callback of an iteration op, the first reason analysis recorded on the site, and the call form
 * having no rewrite: every op but `each`, and `each` over an array literal.
 *
 * @param site - Site to decide.
 * @returns The reason, or the callback of an `each` over one storage, filtered or not, whose view
 *   escapes and nesting are still to be checked.
 */
function siteReason(site: Site): Reason | Callback {
  if (site.reasons.includes("ARG_COUNT")) return "ARG_COUNT";
  if (site.context === "other-expression") return "NOT_STATEMENT";
  const recorded = site.reasons[0];
  if (!iterates(site.op)) return recorded ?? "OP_NOT_REWRITTEN";
  const callback = callbackVerdict(site.callback);
  if (typeof callback === "string") return callback;
  if (recorded !== undefined) return recorded;
  if (site.op !== "each" || site.arrayLiteral) return "OP_NOT_REWRITTEN";
  return callback;
}

/**
 * @param site - Eligible `each` site.
 * @param callback - The site's callback.
 * @returns The inlining over the site's one shape, its literal filter folded against that shape
 *   and any other filter carried for the loop to resolve at runtime.
 * @throws {Error} When the site does not hold exactly one shape: analysis records a reason on every
 *   `each` site whose storage does not resolve, so an eligible site without one is an analysis bug;
 *   or when its filter's form is unsupported, which keeps an eligible site's runtime call.
 */
function eachInlining(site: Site, callback: Callback): EachInlining {
  const shape = site.shapes.length === 1 ? site.shapes[0] : undefined;
  if (shape === undefined) {
    throw new Error(`eligible each site has ${site.shapes.length} shapes, want 1`);
  }
  const hoisted = callback.hazards.length === 0;
  const inlining: EachInlining = {
    call: site.call,
    pos: site.pos,
    shape,
    mode: hoisted ? "hoisted" : "realloc-safe",
    continues: callback.returns,
    varToLet: callback.varDecls,
    spawnTargets: hoisted ? callback.spawnTargets : [],
  };
  const filter = site.filter;
  if (filter === undefined) return inlining;
  if (filter.kind === "literal") {
    const elements = [...filter.all, ...filter.any, ...filter.none];
    return { ...inlining, filter: { elements, fold: foldFilter(filter, shape) } };
  }
  if (filter.form === "unsupported")
    throw new Error("eligible each site has an unsupported filter");
  return { ...inlining, filter: { node: filter.node, form: filter.form } };
}

/**
 * Whether a site's filter keeps its call a runtime call: a filter argument analysis did not report,
 * or one whose type does not pin it to a component array or a filter object, which the runtime
 * tells apart from a callback by `typeof` and an inlined loop could not.
 *
 * @param site - Site to check.
 * @returns `true` for a filtered site whose filter is neither literal nor of a runtime form.
 */
function keptFilter(site: Site): boolean {
  if (!site.filtered) return false;
  const { filter } = site;
  return filter === undefined || (filter.kind === "non-literal" && filter.form === "unsupported");
}

class Planner {
  readonly bails: Bail[] = [];
  readonly rewrites: EachInlining[] = [];
  /** The call of every site decided so far that is rewritten. */
  readonly #inlined = new Set<NodeID>();

  /**
   * Appends the outcomes of sites and of their nested sites, in post-order by source offset.
   *
   * @param sites - Sites of one level: the file's top level, or the nested sites of one callback.
   */
  appendSites(sites: readonly Site[]): void {
    for (const site of sites.toSorted((a, b) => a.pos.offset - b.pos.offset)) {
      const outcome = this.#planSite(site);
      if ("reason" in outcome) {
        this.bails.push(outcome);
      } else {
        this.#inlined.add(site.call);
        this.rewrites.push(outcome);
      }
    }
  }

  /**
   * Plans the sites nested in one site, then decides the site itself.
   *
   * @param site - Site to plan.
   * @returns The site's inlining when it is eligible, and otherwise its bail: an `INTERNAL` one
   *   carrying the thrown value's message when reading its nested sites or deciding it throws.
   */
  #planSite(site: Site): Bail | EachInlining {
    const placement = { call: site.call, op: site.op, pos: site.pos };
    try {
      this.appendSites(site.nested);
      const verdict = this.#verdict(site);
      return "reason" in verdict ? { ...placement, ...verdict } : eachInlining(site, verdict);
    } catch (error) {
      return { ...placement, reason: "INTERNAL", detail: thrownMessage(error) };
    }
  }

  /**
   * Why a site keeps its runtime call.
   *
   * @param site - Site to decide.
   * @returns The verdict, or the callback of an eligible `each` site.
   */
  #verdict(site: Site): Verdict | Callback {
    const reason = siteReason(site);
    if (typeof reason === "string") return { reason };
    const escape = this.#escapeVerdict(site, reason);
    if (escape !== undefined) return escape;
    // Inlining an each that holds an inlined each would need loop composition.
    if (keptFilter(site) || this.#holdsInlined(site.nested)) {
      return { reason: "OP_NOT_REWRITTEN" };
    }
    // Checked last so it is reported only on a call that would otherwise be inlined.
    if (reason.ndebugBound) return { reason: "NDEBUG_BOUND" };
    return reason;
  }

  /**
   * The verdict of the first escaping reference of a callback, in source order. A reference from
   * the callback of an inlined nested call is a use of the view, not an escape.
   *
   * @param site - Site whose callback is checked.
   * @param callback - The site's callback.
   * @returns `UNSUPPORTED_ASSIGNMENT` for a field written as a pattern or `for…of` target,
   *   `VIEW_ESCAPES` naming the reference's line, column, and use for any other, and `undefined`
   *   when no reference escapes.
   */
  #escapeVerdict(site: Site, callback: Callback): Verdict | undefined {
    let first: ViewEscape | undefined;
    for (const escape of callback.escapes) {
      if (escape.kind === "nested-loop" && this.#inlinedChild(site, escape.loop)) continue;
      if (first === undefined || escape.pos.offset < first.pos.offset) first = escape;
    }
    if (first === undefined) return undefined;
    if (first.kind === "target") return { reason: "UNSUPPORTED_ASSIGNMENT" };
    const { line, column } = first.pos;
    return {
      reason: "VIEW_ESCAPES",
      detail: `line ${line}, column ${column}: ${ESCAPE_USES[first.kind]}`,
    };
  }

  /**
   * Whether a loop is an inlined site nested directly in a site. A site that holds an inlined site
   * keeps its runtime call, so a deeper loop always sits inside a call that is not inlined, and a
   * reference from it escapes.
   *
   * @param site - Enclosing site.
   * @param loop - Call of the innermost nested iteration call holding a reference.
   * @returns Whether a reference from that loop's callback lowers.
   */
  #inlinedChild(site: Site, loop: NodeID): boolean {
    return this.#inlined.has(loop) && site.nested.some((nested) => nested.call === loop);
  }

  /**
   * Whether any of sites, at any depth, is inlined.
   *
   * @param sites - Sites to search.
   * @returns `true` when one of them or of their nested sites is rewritten.
   */
  #holdsInlined(sites: readonly Site[]): boolean {
    return sites.some((site) => this.#inlined.has(site.call) || this.#holdsInlined(site.nested));
  }
}

/**
 * Decides the sites of one file, nested sites included: an eligible `each` site gets an inlining,
 * every other site a bail.
 *
 * An enclosing site is decided only once every site inside its callback is, because whether a
 * reference to its view from a nested callback escapes depends on whether that callback is inlined.
 *
 * A throw while planning one site, reading its nested sites included, makes that site an `INTERNAL`
 * bail carrying the thrown message; every other site is planned as usual.
 *
 * @param sites - The file's top-level sites.
 * @returns The file's bails and rewrites, each in post-order: the sites of one level, the file's top
 *   level or the nested sites of one callback, in ascending source offset, each preceded by its own
 *   nested sites.
 * @throws Whatever reading a site's call, op, or position throws: a site that cannot be placed
 *   cannot carry a bail.
 */
export function plan(sites: readonly Site[]): PlanResult {
  const planner = new Planner();
  planner.appendSites(sites);
  return { bails: planner.bails, rewrites: planner.rewrites };
}
