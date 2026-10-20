/**
 * The project one plugin instance rewrites: its session, the program files a module id can name,
 * and the text Vite handed the session.
 */
import { readFile } from "node:fs/promises";

import { fileKey } from "./file-key.js";
import { createRewriter, type Rewriter, type RewrittenModule } from "./optimizer/rewrite.js";
import { openSession, type Session } from "./optimizer/session.js";

/** A declaration file name: `.d.ts`, `.d.mts`, `.d.cts`, or `.d.<extension>.ts`. */
const DECLARATION_FILE = /\.d(?:\.[^./\\]+)?\.[cm]?ts$/u;

/** How a file on disk changed, as Vite's `watchChange` hook reports it. */
export type ChangeEvent = "create" | "update" | "delete";

/** The project a plugin instance serves module text to and rewrites modules of. */
export class ServedProject {
  readonly #session: Session;
  readonly #rewriter: Rewriter;
  /** The program's non-declaration files, keyed by {@link fileKey}. */
  readonly #rewritable: ReadonlyMap<string, string>;
  /** Every file name the session gave, keyed by {@link fileKey}. */
  readonly #names = new Map<string, string>();
  /** The {@link fileKey} of every file whose text the session serves. */
  readonly #served = new Set<string>();
  /** Disk text of served files changed on disk, served with the next rewrite. */
  #pending: Record<string, string> = {};
  /** Served files deleted from disk, treated as missing from the next rewrite on. */
  readonly #removed = new Set<string>();

  /**
   * @param session - The open session; the project owns it from here on.
   * @param programFiles - Every file the program holds, declaration files included.
   */
  constructor(session: Session, programFiles: readonly string[]) {
    this.#session = session;
    this.#rewriter = createRewriter(session);
    for (const name of programFiles) this.#names.set(fileKey(name), name);
    this.#rewritable = new Map(
      programFiles
        .filter((name) => !DECLARATION_FILE.test(name))
        .map((name) => [fileKey(name), name]),
    );
  }

  /** How many files of the program the plugin may rewrite. */
  get rewritableCount(): number {
    return this.#rewritable.size;
  }

  /**
   * The program file a module id names.
   *
   * @param id - The module's id, as Vite names it.
   * @returns The file's name as the session gives it, or undefined when the program holds no such
   *   source file or only a declaration file.
   */
  programFile(id: string): string | undefined {
    return this.#rewritable.get(fileKey(id));
  }

  /**
   * Serves `code` as the text of `file`, then rewrites it.
   *
   * @param file - The program file's name, as {@link programFile} gives it.
   * @param code - The text Vite hands the plugin.
   * @returns The rewritten module.
   * @throws When the session is closed, its compiler process exited, or the rewrite fails.
   */
  async rewrite(file: string, code: string): Promise<RewrittenModule> {
    const files = { ...this.#pending, [file]: code };
    this.#removed.delete(file);
    const removed = [...this.#removed];
    this.#removed.clear();
    this.#pending = {};
    this.#served.add(fileKey(file));
    const view = await this.#session.update(files, removed);
    const rewritten = await this.#rewriter.rewrite(view, file);
    for (const name of rewritten.consulted) this.#names.set(fileKey(name), name);
    return rewritten;
  }

  /**
   * Makes the next rewrite see a file's change on disk. A file whose text the session serves gets
   * its disk text served, or is treated as missing once deleted, since a served file keeps its
   * served text whatever the disk holds.
   *
   * @param id - The changed file, as Vite names it.
   * @param event - How the file changed.
   * @throws When a changed file the session serves cannot be read.
   */
  async changed(id: string, event: ChangeEvent): Promise<void> {
    const key = fileKey(id);
    const name = this.#names.get(key) ?? id;
    if (!this.#served.has(key)) {
      this.#session.notifyChanged([name]);
    } else if (event === "delete") {
      delete this.#pending[name];
      this.#removed.add(name);
    } else {
      this.#pending[name] = await readFile(name, "utf8");
      this.#removed.delete(name);
    }
  }

  /** Ends the session's compiler process; closing again does nothing. */
  async close(): Promise<void> {
    await this.#session.close();
  }
}

/**
 * Opens a session on `tsconfig` and lists the program files the plugin may rewrite.
 *
 * @param tsconfig - Absolute path of the project's tsconfig.
 * @returns The open project.
 * @throws When the session cannot open, naming the tsconfig and the cause, or the program's files
 *   cannot be listed, after closing the session.
 */
export async function openProject(tsconfig: string): Promise<ServedProject> {
  const session = await openSession(tsconfig);
  try {
    const view = await session.update();
    return new ServedProject(session, await view.sourceFileNames());
  } catch (error) {
    await session.close();
    throw error;
  }
}
