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

/** Thrown by a request to a session that is closed or whose compiler process exited. */
export class SessionEndedError extends Error {}

/** The project as one update of a session left it. */
export interface ProjectView {
  /**
   * The program's type checker. A query through it rejects as the view's other requests do when the
   * session is closed or its compiler process exited.
   */
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
   * The error a failed compiler call should reject with when the session has ended. It covers
   * calls on any object the checker handed out, not only those made through the checker itself.
   *
   * @param error - What the failed call threw.
   * @returns `error` itself when it is already a {@link SessionEndedError}; else, when the session
   *   is closed or its compiler process exited, a {@link SessionEndedError} naming the session,
   *   carrying `error` as its cause when the process exited; else `undefined`.
   */
  endedError(error: unknown): SessionEndedError | undefined;
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
      // A close failing after the load failed is a symptom; the load error names the cause.
      await closeCompiler(compiler, closeTimeoutMs).catch(() => {});
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
      checker: this.#guarded(project.checker),
      sourceFile: async (file) =>
        await this.#query(async () => await projectSourceFile(project, file)),
      emit: async (file) => await this.#query(async () => await emitJavaScript(project, file)),
      sourceFileNames: async () => await this.#query(async () => await programFileNames(project)),
      endedError: (error) =>
        error instanceof SessionEndedError
          ? error
          : (this.#closedError() ?? this.#exitedError(error)),
    };
  }

  /**
   * `checker` with every method call refused once this session is closed, and every rejection
   * named after this session once its compiler process exited.
   *
   * @param checker - The checker of one of this session's snapshots.
   * @returns The guarded checker.
   */
  #guarded(checker: Checker): Checker {
    return new Proxy(checker, {
      get: (target, key) => {
        const member: unknown = Reflect.get(target, key);
        if (typeof member !== "function") return member;
        return (...args: unknown[]): unknown => {
          // Every checker method answers with a promise, so a closed session's refusal is one too.
          const closed = this.#closedError();
          if (closed !== undefined) return Promise.reject(closed);
          const result: unknown = Reflect.apply(member, target, args);
          return result instanceof Promise ? this.#named(result) : result;
        };
      },
    });
  }

  /**
   * Runs `request`, naming this session when it is closed or its compiler process exited.
   *
   * @param request - The compiler request to run.
   * @returns What `request` resolves to.
   * @throws {@link SessionEndedError} when the session is closed or its compiler process exited;
   *   otherwise whatever `request` throws.
   */
  async #query<T>(request: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    return await this.#named(request());
  }

  /** Refuses a request with a {@link SessionEndedError} once this session is closed. */
  #assertOpen(): void {
    const closed = this.#closedError();
    if (closed !== undefined) throw closed;
  }

  /**
   * Awaits `pending`, naming this session when its compiler process exited.
   *
   * @param pending - A request already sent to the compiler process.
   * @returns What `pending` resolves to.
   * @throws {@link SessionEndedError} when the compiler process exited, carrying the request's
   *   error as its cause; otherwise whatever `pending` rejects with.
   */
  async #named<T>(pending: Promise<T>): Promise<T> {
    try {
      return await pending;
    } catch (error) {
      throw this.#exitedError(error) ?? error;
    }
  }

  /**
   * The error a request rejects with once this session is closed.
   *
   * @returns The error naming this session, or `undefined` while the session is open.
   */
  #closedError(): SessionEndedError | undefined {
    if (this.#closing === undefined) return undefined;
    return new SessionEndedError(`the session on ${this.tsconfig} is closed`);
  }

  /**
   * The error a request rejects with once this session's compiler process exited.
   *
   * @param cause - What the request threw.
   * @returns The error naming this session and carrying `cause`, or `undefined` while the process
   *   runs.
   */
  #exitedError(cause: unknown): SessionEndedError | undefined {
    if (!this.#compiler.exited) return undefined;
    return new SessionEndedError(`the compiler process of the session on ${this.tsconfig} exited`, {
      cause,
    });
  }
}
