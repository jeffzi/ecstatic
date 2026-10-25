import { type CallExpression, getTouchingPropertyName, type SourceFile } from "typescript/ast";
import { isCallExpression, isIdentifier } from "typescript/ast/is";

import {
  inlineCallback,
  prepareCallback,
} from "../../../../src/plugin/optimizer/analysis/callback.js";
import { PackageRoots } from "../../../../src/plugin/optimizer/analysis/roots.js";
import { resolveShapes } from "../../../../src/plugin/optimizer/analysis/shape.js";
import { sourceFileName } from "../../../../src/plugin/optimizer/compiler.js";
import {
  type Callback,
  type NodeID,
  opByName,
  type Position,
  type Site,
} from "../../../../src/plugin/optimizer/facts.js";
import { NodeTable } from "../../../../src/plugin/optimizer/nodes.js";
import { nodePosition } from "../../../../src/plugin/optimizer/position.js";
import type { ProjectView, Session } from "../../../../src/plugin/optimizer/session.js";
import { locate } from "../locate.js";
import {
  caseFiles,
  openProject,
  projectPath,
  removeProjects,
  runtimeProject,
  SHARED_ARCHETYPE_FILES,
} from "../project.js";

/** Opens every loose case file: the iteration ops and a storage of no resolvable shape. */
export const LOOSE_HEADER = `import { each, query } from "../../src/ecstatic/index.js";
declare const s: any;
`;

/**
 * Opens every view case file: the runtime API, the shared archetypes and components, and the
 * values and storages the cases use. Enemy holds Position and Velocity, and optionally Shield and
 * the tag Stunned; Linked holds Position and the relation ChildOf; marked holds Position and the
 * tag Stunned.
 */
export const VIEW_PRELUDE = `import { archetype, component, createWorld, each, getStorage, register, spawn, type Storage, type World } from "../../src/ecstatic/index.js";
import type { ArchetypeDescriptor, ComponentDescriptor } from "../../src/ecstatic/archetype.js";
import { Enemy, Hull, Linked, Ship } from "../archetypes.js";
import { Position } from "../position.js";
import { Velocity } from "../components.js";
import { Shield, Stunned } from "../components.js";

declare function visit(value: unknown): void;
const xs: number[] = [];
const enemies = register(createWorld(), Enemy);
const linked = register(createWorld(), Linked);
const marked = register(createWorld(), archetype([Position, Stunned]));
`;

/** Declares the sink that loose case bodies pass values to. */
export const REGISTER_DECL = "declare function register(value: unknown): void;\n";

/** Declares the decorator factory that class cases decorate with. */
export const MARK_DECL =
  "declare function mark(value: unknown): (target: unknown, context: unknown) => void;\n";

/** Returns at the body root, under a loop or switch, under a label or try, and in nested functions. */
export const RETURNS_SOURCE = `each(s, (e: any) => {
	if (e > 0) return;
	for (const k of [1]) {
		if (k) return k;
	}
	switch (e) {
		case 1:
			return;
	}
	block: {
		return 2;
	}
	try {
		return;
	} finally {
		e.done = true;
	}
	const f = () => {
		return 1;
	};
	while (e) {
		const g = function () {
			return 3;
		};
	}
	do {
		return;
	} while (e);
	for (;;) return;
	for (const k in e) return;
});`;

/** The callback's own returns in {@link RETURNS_SOURCE}, in source order. */
export const OWN_RETURNS: readonly { mark: string; nth: number; nested: boolean }[] = [
  { mark: "return;", nth: 0, nested: false },
  { mark: "return k;", nth: 0, nested: true },
  { mark: "return;", nth: 1, nested: true },
  { mark: "return 2;", nth: 0, nested: false },
  { mark: "return;", nth: 2, nested: false },
  { mark: "return;", nth: 3, nested: true },
  { mark: "return;", nth: 4, nested: true },
  { mark: "return;", nth: 5, nested: true },
];

/** `var` declarations inside and outside nested functions and static blocks. */
export const VARS_SOURCE = `each(s, (e: any) => {
	var a = 1, b;
	for (var i = 0; i < 1; i++) {}
	{
		var c;
	}
	let d = 0;
	function inner() {
		var hidden;
	}
	const nested = () => {
		var arrowLocal;
	};
	const expression = function () {
		var expressionLocal;
	};
	class Local {
		static {
			var blockLocal;
		}
	}
});`;

/** The marks of the callback's own `var` declarations in {@link VARS_SOURCE}. */
export const OWN_VAR_MARKS: readonly string[] = ["a = 1", "b;", "i = 0", "c;"];

/** Direct and indirect `eval` calls, bare and behind wrappers. */
export const EVAL_SOURCE = `each(s, (e: any) => {
	eval("e");
	(() => eval("1"))();
	const indirect = eval;
	indirect("2");
	globalThis.eval("3");
	eval?.("4");
	(eval)("5");
	eval!("6");
	(eval as any)("7");
	(eval satisfies unknown as typeof eval)("8");
	(<any>eval)("9");
	(0, eval)("10");
	(eval)?.("11");
});`;

/** The marks of the direct `eval` calls in {@link EVAL_SOURCE}. */
export const DIRECT_EVAL_MARKS: readonly string[] = [
  `eval("e")`,
  `eval("1")`,
  `(eval)("5")`,
  `eval!("6")`,
  `(eval as any)("7")`,
  `(eval satisfies`,
  `(<any>eval)("9")`,
];

/** A loop call located in its case file. */
export interface Located {
  readonly file: SourceFile;
  readonly call: CallExpression;
  /** Where the case source starts in the file. */
  readonly start: number;
}

/** The analysis of one inline callback, with the table its node IDs index. */
export interface Summarized {
  readonly callback: Callback;
  readonly site: Site;
  readonly table: NodeTable;
}

/** The first `each` or `query` call at or after `from` in `file`. */
function loopCallIn(file: SourceFile, from: number): CallExpression {
  const callee = /\b(?:each|query)\(/g;
  callee.lastIndex = from;
  const found = callee.exec(file.text);
  const call = found === null ? undefined : getTouchingPropertyName(file, found.index).parent;
  if (call === undefined || !isCallExpression(call)) {
    throw new Error(`${file.fileName} holds no loop call after offset ${from}`);
  }
  return call;
}

/**
 * One project holding a case file per source: the loose sources after {@link LOOSE_HEADER}, the
 * view sources after {@link VIEW_PRELUDE}, beside the runtime and the shared components and
 * archetypes. A test file opens it once and analyzes every case through its one session.
 */
export class CallbackProject {
  readonly #loose: readonly string[];
  readonly #viewed: readonly string[];
  readonly #roots = new PackageRoots();
  #root = "";
  #session: Session | undefined;
  #view: ProjectView | undefined;

  /**
   * Creates a project holding one case file per source.
   *
   * @param loose - The case sources written after {@link LOOSE_HEADER}, in the loose case files.
   * @param viewed - The case sources written after {@link VIEW_PRELUDE}, in the view case files.
   */
  constructor(loose: readonly string[], viewed: readonly string[]) {
    this.#loose = loose;
    this.#viewed = viewed;
  }

  /** The project directory. */
  get root(): string {
    return this.#root;
  }

  /** Writes the project and opens its session. */
  async open(): Promise<void> {
    const { root, session, view } = await openProject(
      runtimeProject({
        ...SHARED_ARCHETYPE_FILES,
        ...caseFiles("app/case/loose", this.#loose, LOOSE_HEADER),
        ...caseFiles("app/case/view", this.#viewed, VIEW_PRELUDE),
      }),
    );
    this.#root = root;
    this.#session = session;
    this.#view = view;
  }

  /** Closes the session and deletes the project. */
  async close(): Promise<void> {
    await this.#session?.close();
    removeProjects();
  }

  /** The first loop call of the case file holding `source`, written after the loose header. */
  async looseCall(source: string): Promise<Located> {
    return this.#locate(`loose${this.#loose.indexOf(source)}.ts`, LOOSE_HEADER.length);
  }

  /** The first loop call of the case file holding `source`, written after the view prelude. */
  async viewCall(source: string): Promise<Located> {
    return this.#locate(`view${this.#viewed.indexOf(source)}.ts`, VIEW_PRELUDE.length);
  }

  /**
   * Summarizes an inline callback as its site sees it: with the shapes its storages resolve to, and
   * no declaration file listed yet.
   *
   * @param located - The case file and its first loop call.
   * @param mark - The text that precedes the loop call whose callback to summarize, taking its first
   *   occurrence in the case source; omitted, the first loop call is used.
   * @returns The callback summary with its site and node table.
   * @throws Error when the loop call has no inline callback, or `mark` is followed by no loop call.
   */
  async summarize(located: Located, mark?: string): Promise<Summarized> {
    const { file } = located;
    const call = mark === undefined ? located.call : loopCallIn(file, markOffset(located, mark));
    const op = isIdentifier(call.expression) ? opByName(call.expression.text) : undefined;
    const fn = op === undefined ? undefined : inlineCallback(call, op);
    const [storages] = call.arguments;
    if (op === undefined || fn === undefined || storages === undefined) {
      throw new Error(`${file.fileName} holds no loop call with an inline callback`);
    }
    const view = this.#opened();
    const { shapes } = op === "each" ? await resolveShapes(view.checker, storages) : { shapes: [] };
    const table = new NodeTable();
    const site: Site = {
      callback: undefined,
      reasons: [],
      nested: [],
      shapes,
      declarationFiles: [],
      root: this.#root,
      pos: nodePosition(file, call),
      call: table.register(call),
      op,
      context: "expression-statement",
      filtered: false,
      arrayLiteral: false,
    };
    const scope = { checker: view.checker, roots: this.#roots, table, file };
    const callback = (await prepareCallback(scope, site, fn))();
    return { callback, site, table };
  }

  async #locate(name: string, start: number): Promise<Located> {
    const file = await this.#opened().sourceFile(projectPath(this.#root, `app/case/${name}`));
    return { file, call: loopCallIn(file, start), start };
  }

  #opened(): ProjectView {
    if (this.#view === undefined) throw new Error("the callback project is not open");
    return this.#view;
  }
}

/** The position in its file of the `nth` (from 0) occurrence of `mark` in the case source. */
export function caseOccurrence({ file, start }: Located, mark: string, nth = 0): Position {
  let skipped = 0;
  for (
    let at = file.text.indexOf(mark);
    at >= 0 && at < start;
    at = file.text.indexOf(mark, at + 1)
  ) {
    skipped++;
  }
  return locate(sourceFileName(file), file.text, mark, skipped + nth);
}

/** The offset in its file of the `nth` (from 0) occurrence of `mark` in the case source. */
export function markOffset(located: Located, mark: string, nth = 0): number {
  return caseOccurrence(located, mark, nth).offset;
}

/** The start offset of the node `id` names in `table`. */
export function nodeOffset(table: NodeTable, id: NodeID): number {
  const node = table.node(id);
  if (node === undefined) throw new Error(`node ${id} is not registered`);
  return node.getStart();
}
