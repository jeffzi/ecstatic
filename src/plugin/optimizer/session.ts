/**
 * A project session: one compiler process with one project loaded, serving module text from the
 * caller in place of the disk's.
 */

import type { Node, SourceFile } from "typescript/ast";

import {
  type Checker,
  closeCompiler,
  type Compiler,
  configuredProject,
  emitJavaScript,
  loadProject,
  parseFile,
  parseText,
  printTree,
  programErrors,
  programFileNames,
  projectSourceFile,
  type Snapshot,
  startCompiler,
  updateSnapshot,
} from "./compiler.js";

/** How to start and end a session's compiler process. */
export interface SessionOptions {
  /** Compiler executable; the one bundled with `typescript` when absent. */
  readonly executable?: string;
  /**
   * Milliseconds {@link Session.close} lets the process answer the requests in flight and exit
   * before killing it; 5000 when absent.
   */
  readonly closeTimeoutMs?: number;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5000;

/** The project as one update of a session left it. */
export interface ProjectView {
  readonly checker: Checker;
  /**
   * The program's parse of a project file.
   *
   * @param file - Absolute file name.
   * @returns The source file, holding the served text when the session serves one.
   * @throws When the file is not part of the program, or the session is closed or its process exited.
   */
  sourceFile(file: string): Promise<SourceFile>;
  /**
   * Emits JavaScript for a project file whatever the project's emit settings.
   *
   * @param file - Absolute file name.
   * @returns The JavaScript emitted from the served text when the session serves one.
   * @throws When the file is not part of the program, or the session is closed or its process exited.
   */
  emit(file: string): Promise<string>;
  /**
   * The names of every file the program holds, declaration files included.
   *
   * @returns The absolute file names, in the platform's spelling.
   * @throws When the session is closed or its compiler process exited.
   */
  sourceFileNames(): Promise<readonly string[]>;
  /**
   * The type-check errors of the program: its option, global, syntax, and semantic errors.
   *
   * @returns The errors as the compiler formats them; empty when the program has none.
   * @throws When the session is closed or its compiler process exited.
   */
  errors(): Promise<string>;
}

/** One compiler process with one project loaded. */
export interface Session {
  /** Absolute path of the project's tsconfig. */
  readonly tsconfig: string;
  /**
   * Serves `files` in place of the disk's text, and treats `removed` as missing, on top of every
   * earlier update. Concurrent updates apply in call order.
   *
   * @param files - Text to serve, keyed by absolute file name.
   * @param removed - Absolute names of files to treat as missing from here on, served or not,
   *   until a later update serves them again.
   * @returns The project with this update and every earlier one applied.
   * @throws When the session is closed or its compiler process exited.
   */
  update(
    files?: Readonly<Record<string, string>>,
    removed?: readonly string[],
  ): Promise<ProjectView>;
  /**
   * Records files changed on disk, re-read at the next {@link Session.update}. A file the session
   * serves keeps its served text.
   *
   * @param files - Absolute names of the files changed on disk.
   */
  notifyChanged(files: readonly string[]): void;
  /**
   * Parses a file outside the project's program.
   *
   * @param file - Absolute file name.
   * @returns The parsed source file.
   * @throws When the file cannot be read, naming it, or the session is closed or its process exited.
   */
  parse(file: string): Promise<SourceFile>;
  /**
   * Parses text outside the project's program, for syntax reads only.
   *
   * @param fileName - The name to parse `text` under, whose extension sets the script kind.
   * @param text - The text to parse.
   * @returns The parsed source file.
   * @throws When the session is closed or its compiler process exited.
   */
  parseText(fileName: string, text: string): Promise<SourceFile>;
  /**
   * Prints a syntax tree, nodes built by the factory and nodes of a parse alike, without comments.
   *
   * @param node - Root of the tree to print.
   * @returns The printed text, its lines ending with `\n`.
   * @throws When the session is closed or its compiler process exited.
   */
  print(node: Node): Promise<string>;
  /**
   * Ends the compiler process, killing it when it has not finished by the session's close deadline.
   * Closing again does nothing.
   *
   * @throws When the client fails to close.
   */
  close(): Promise<void>;
}

/**
 * Starts a compiler process and loads the project `tsconfig` names.
 *
 * @param tsconfig - Absolute path of the project's tsconfig.
 * @param options - How to start the compiler process.
 * @returns The open session.
 * @throws When the compiler process cannot start, or the tsconfig cannot be read or parsed; the error
 *   names the tsconfig and the cause.
 */
export async function openSession(
  tsconfig: string,
  options: SessionOptions = {},
): Promise<Session> {
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  try {
    const compiler = await startCompiler(options.executable);
    try {
      return new ProjectSession(
        tsconfig,
        compiler,
        await loadProject(compiler.api, tsconfig),
        closeTimeoutMs,
      );
    } catch (error) {
      await closeCompiler(compiler, closeTimeoutMs);
      throw error;
    }
  } catch (error) {
    throw new Error(`cannot open a session on ${tsconfig}: ${String(error)}`, { cause: error });
  }
}

class ProjectSession implements Session {
  readonly tsconfig: string;
  /** The latest update; each update builds on the one before it. */
  #latest: Promise<Snapshot>;
  readonly #changed: string[] = [];
  #closing: Promise<void> | undefined;
  readonly #compiler: Compiler;
  readonly #closeTimeoutMs: number;

  constructor(tsconfig: string, compiler: Compiler, snapshot: Snapshot, closeTimeoutMs: number) {
    this.tsconfig = tsconfig;
    this.#compiler = compiler;
    this.#latest = Promise.resolve(snapshot);
    this.#closeTimeoutMs = closeTimeoutMs;
  }

  async update(
    files: Readonly<Record<string, string>> = {},
    removed: readonly string[] = [],
  ): Promise<ProjectView> {
    return await this.#query(async () => {
      const changed = this.#changed.splice(0);
      // A failed update stays the latest, so every later update reports the same failure rather
      // than building on a snapshot that missed these changes.
      const updated = this.#latest.then(
        async (snapshot) => await updateSnapshot(snapshot, files, changed, removed),
      );
      this.#latest = updated;
      return this.#view(await updated);
    });
  }

  notifyChanged(files: readonly string[]): void {
    this.#changed.push(...files);
  }

  async parse(file: string): Promise<SourceFile> {
    return await this.#query(async () => await parseFile(this.#compiler.api, file));
  }

  async parseText(fileName: string, text: string): Promise<SourceFile> {
    return await this.#query(async () => await parseText(this.#compiler.api, fileName, text));
  }

  async print(node: Node): Promise<string> {
    return await this.#query(async () => await printTree(this.#compiler.api, node));
  }

  async close(): Promise<void> {
    await (this.#closing ??= closeCompiler(this.#compiler, this.#closeTimeoutMs));
  }

  #view(snapshot: Snapshot): ProjectView {
    const project = configuredProject(snapshot, this.tsconfig);
    return {
      checker: project.checker,
      sourceFile: async (file) =>
        await this.#query(async () => await projectSourceFile(project, file)),
      emit: async (file) => await this.#query(async () => await emitJavaScript(project, file)),
      sourceFileNames: async () => await this.#query(async () => await programFileNames(project)),
      errors: async () => await this.#query(async () => await programErrors(project)),
    };
  }

  /**
   * Runs `request`, naming this session when it is closed or its compiler process exited.
   *
   * @param request - The compiler request to run.
   * @returns What `request` resolves to.
   * @throws When the session is closed or its compiler process exited, or whatever `request` throws.
   */
  async #query<T>(request: () => Promise<T>): Promise<T> {
    if (this.#closing !== undefined) throw new Error(`the session on ${this.tsconfig} is closed`);
    try {
      return await request();
    } catch (error) {
      if (!this.#compiler.exited) throw error;
      throw new Error(`the compiler process of the session on ${this.tsconfig} exited`, {
        cause: error,
      });
    }
  }
}
