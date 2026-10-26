/**
 * Every call the optimizer makes into the compiler process lives here: checker, symbol, type,
 * program, snapshot, parse, emit, and printer calls. The other optimizer modules read nodes, plain
 * values, and the flags this file re-exports, so a compiler API upgrade edits this file alone, save
 * a renamed flag, which fails the type check where it is read.
 */

import { setImmediate } from "node:timers/promises";

import type { Node, SourceFile } from "typescript/ast";
import { isIdentifier, isShorthandPropertyAssignment } from "typescript/ast/is";
import {
  API,
  type Checker,
  DiagnosticCategory,
  ElementFlags,
  formatDiagnostics,
  isIntersectionType,
  isStringLiteralType,
  isTupleType,
  isUnionType,
  type Project,
  SignatureKind,
  type Snapshot,
  type Symbol as CheckerSymbol,
  SymbolFlags,
  type Type,
  TypeFlags,
} from "typescript/async";

import { compilerFileName, nativeFileName } from "./file-names.js";

export type { API, Checker, CheckerSymbol, Snapshot, Type };
export { isStringLiteralType, SymbolFlags, TypeFlags };

// ---------------------------------------------------------------------------
// Compiler process
// ---------------------------------------------------------------------------

/** A compiler process and the client that owns it. */
export interface Compiler {
  readonly api: API;
  /**
   * Whether the process has exited, or its input failed and it was killed; every request in flight
   * then, or made since, has failed.
   */
  readonly exited: boolean;
  /** Ends the process at once, failing every request in flight. */
  kill(): void;
  /**
   * Lets every request in flight settle, then closes the client without sending another request,
   * so nothing is written to a process that may be dying. Closing the client ends the process's
   * input, which ends the process. A process that stops answering or never exits holds this until
   * {@link Compiler.kill}.
   *
   * @returns Resolves once the process has exited.
   * @throws When the client fails to close.
   */
  end(): Promise<void>;
}

/** The client the API keeps undeclared, which starts the process and sends every request. */
interface InternalClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  apiRequest(method: string, params: unknown): Promise<unknown>;
}

/** The client's connection to the process. */
interface InternalConnection {
  onClose(listener: () => void): unknown;
  dispose(): void;
}

/** The process the client spawned. */
interface InternalProcess {
  kill(signal: string): boolean;
  once(event: "exit", listener: () => void): unknown;
}

/** The process's input stream, which carries every request the connection writes. */
interface InternalInput {
  write(...args: unknown[]): unknown;
}

/** Every method of `T`, so a method added to an internal interface must be checked too. */
type MethodNames<T> = { readonly [K in keyof T]: true };

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function missingMethod(value: object, methods: object): string | undefined {
  return Object.keys(methods).find((name) => typeof Reflect.get(value, name) !== "function");
}

function holdsMethods<T>(value: unknown, methods: MethodNames<T>): value is T {
  return isObject(value) && missingMethod(value, methods) === undefined;
}

/**
 * Reads a member the compiler API keeps off its declared surface.
 *
 * @param owner - Object holding the member.
 * @param path - Dotted path from the API to the member, ending in the member's name.
 * @param methods - Every method the member must hold.
 * @returns The member.
 * @throws When the member or one of its methods is missing, as after a compiler API upgrade, naming
 *   the missing one by its path from the API.
 */
function internalMember<T>(owner: object, path: string, methods: MethodNames<T>): T {
  const value: unknown = Reflect.get(owner, path.slice(path.lastIndexOf(".") + 1));
  if (holdsMethods(value, methods)) return value;
  const method = isObject(value) ? missingMethod(value, methods) : undefined;
  const missing = method === undefined ? path : `${path}.${method}`;
  throw new Error(`the compiler API no longer holds the ${missing} this optimizer relies on`);
}

/**
 * Records every request `client` sends until it settles.
 *
 * @param client - Client whose requests are tracked from now on.
 * @returns A function resolving once no request is in flight, including any sent while it waits or
 *   started just before it was called.
 */
function trackRequests(client: InternalClient): () => Promise<void> {
  const inFlight = new Set<Promise<unknown>>();
  const send = client.apiRequest.bind(client);
  Reflect.set(client, "apiRequest", async (method: string, params: unknown) => {
    const request = send(method, params);
    inFlight.add(request);
    const forget = (): boolean => inFlight.delete(request);
    void request.then(forget, forget);
    return await request;
  });
  return async () => {
    do {
      await Promise.allSettled(inFlight);
      // A request started before this call, or chained on one that just settled, reaches the client
      // only once the microtasks queued ahead of it have run; an immediate runs after all of them.
      await setImmediate();
    } while (inFlight.size > 0);
  };
}

/**
 * Turns every failed write to `input` into a call to `onFailure`, reporting the write as done to
 * the writer. The connection rejects a request whose write fails, then rethrows the write error from
 * a promise no caller holds — an unhandled rejection that ends a host process in Node's default
 * mode. A process can die between a request's call and its write, which is batched for later, so
 * the failure must instead reach the request through `onFailure` disposing the connection.
 *
 * @param input - The process's input stream.
 * @param onFailure - Called before the writer hears of the write; must reject the requests waiting
 *   on the connection.
 */
function absorbWriteFailures(input: InternalInput, onFailure: () => void): void {
  const write = input.write.bind(input);
  Reflect.set(input, "write", (...args: unknown[]): unknown => {
    const callback = args.at(-1);
    if (typeof callback === "function") {
      args[args.length - 1] = (error: unknown): void => {
        if (error !== undefined && error !== null) onFailure();
        Reflect.apply(callback, undefined, []);
      };
    }
    return write(...args);
  });
}

/**
 * Starts a compiler process and ties the client to its lifetime. The connection only notes that the
 * process exited; it rejects requests still waiting for an answer once disposed, so the exit
 * disposes it, and neither a request in flight nor {@link closeCompiler} waits forever. The
 * process's exit event arrives even when the connection's close never does, as after the client
 * disposed the connection itself. A write to the process's input that fails, as when the process
 * died before the write, kills the process and is handled as its exit. A start that fails closes
 * the API it created; a failure of that close is dropped so the start error stays the one reported.
 *
 * @param executable - Compiler executable; the one bundled with `typescript` when undefined.
 * @returns The compiler, owning the process until {@link closeCompiler}.
 * @throws When the process cannot start, naming the executable, or the compiler API no longer holds
 *   the client, connection, process, or process input this module relies on, or one of their
 *   methods, naming the missing member by its path from the API.
 */
export async function startCompiler(executable: string | undefined): Promise<Compiler> {
  const api = new API({ tsserverPath: executable });
  try {
    const client = internalMember<InternalClient>(api, "client", {
      connect: true,
      close: true,
      apiRequest: true,
    });
    await client.connect();
    // Watched before any I/O callback runs, so the close cannot fire unobserved.
    const connection = internalMember<InternalConnection>(client, "client.connection", {
      onClose: true,
      dispose: true,
    });
    // Held here because the client forgets its process once closing begins.
    const child = internalMember<InternalProcess>(client, "client.process", {
      kill: true,
      once: true,
    });
    const kill = (): boolean => child.kill("SIGKILL");
    let exited = false;
    const markExited = (): void => {
      exited = true;
      connection.dispose();
    };
    connection.onClose(markExited);
    const input = internalMember<InternalInput>(child, "client.process.stdin", { write: true });
    absorbWriteFailures(input, () => {
      // A process that can take no more input is ended, so `exited` holds to its name.
      kill();
      markExited();
    });
    // Registered before any I/O callback runs, so the exit cannot fire unobserved.
    const exit = new Promise<void>((resolve) => {
      child.once("exit", () => {
        markExited();
        resolve();
      });
    });
    const settled = trackRequests(client);
    return {
      api,
      get exited() {
        return exited;
      },
      kill,
      async end() {
        await settled();
        await client.close();
        await exit;
      },
    };
  } catch (error) {
    // The close reaches the same internals the start failed on, so its own failure is a symptom;
    // the start error names the cause.
    await api.close().catch(() => {});
    throw error;
  }
}

/**
 * Ends the compiler process. The process's remote objects are never released: it holds nothing
 * worth releasing at its end, and a release written to a process that died meanwhile fails where no
 * caller can catch it. A process that has not answered the requests in flight and exited by the
 * deadline is killed, so a process that stopped answering cannot hold the close forever. A client
 * that fails to close also gets its process killed, so no process outlives a failed close.
 *
 * @param compiler - Compiler whose process ends.
 * @param timeoutMs - Milliseconds the process gets to answer the requests in flight and exit before
 *   it is killed.
 * @throws When the client fails to close, with the close error, once the process is killed.
 */
export async function closeCompiler(compiler: Compiler, timeoutMs: number): Promise<void> {
  const deadline = setTimeout(() => {
    compiler.kill();
  }, timeoutMs);
  try {
    await compiler.end();
  } catch (error) {
    compiler.kill();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

// ---------------------------------------------------------------------------
// Project snapshots and files
// ---------------------------------------------------------------------------

/**
 * Loads the project `tsconfig` names into a new snapshot.
 *
 * @param api - Client of the compiler process.
 * @param tsconfig - Absolute path of the project's tsconfig.
 * @returns A snapshot holding the project, its program built.
 * @throws When the tsconfig cannot be read or has parse errors, with the compiler's diagnostic text;
 *   or when the compiler process has exited.
 */
export async function loadProject(api: API, tsconfig: string): Promise<Snapshot> {
  // A snapshot asked to open an unreadable tsconfig loads no project and reports nothing;
  // parsing the config is what surfaces the read failure.
  const config = compilerFileName(tsconfig);
  const [snapshot] = await Promise.all([
    api.createSnapshot({ openProjects: [config] }),
    api.parseConfigFile(config),
  ]);
  const { program } = configuredProject(snapshot, tsconfig);
  const diagnostics = await program.getConfigFileParsingDiagnostics();
  if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics, program));
  return snapshot;
}

/**
 * The project `tsconfig` names in `snapshot`.
 *
 * @param snapshot - Snapshot the project was loaded into.
 * @param tsconfig - Absolute path of the project's tsconfig.
 * @returns The project.
 * @throws When the snapshot holds no project for `tsconfig`.
 */
export function configuredProject(snapshot: Snapshot, tsconfig: string): Project {
  const project = snapshot.getConfiguredProject(compilerFileName(tsconfig));
  if (project === undefined) throw new Error(`no project is loaded for ${tsconfig}`);
  return project;
}

/**
 * Derives a snapshot that reads `files` in place of the disk, treats `removed` as missing, and
 * re-reads `changed` from the disk. Earlier layers carry forward, so `snapshot`'s served text stays
 * served unless `files` replaces it or `removed` names it.
 *
 * @param snapshot - Snapshot the update builds on.
 * @param files - Text to serve, keyed by absolute file name.
 * @param changed - Absolute names of files changed on disk since `snapshot`.
 * @param removed - Absolute names of files to treat as missing, whatever the disk holds.
 * @returns The new snapshot, its programs rebuilt.
 * @throws When the compiler process has exited.
 */
export async function updateSnapshot(
  snapshot: Snapshot,
  files: Readonly<Record<string, string>>,
  changed: readonly string[],
  removed: readonly string[],
): Promise<Snapshot> {
  const served: Record<string, string> = {};
  for (const [name, text] of Object.entries(files)) served[compilerFileName(name)] = text;
  return await snapshot.update({
    fileSystem: {
      kind: "layer",
      files: served,
      removedPaths: removed.map((name) => compilerFileName(name)),
    },
    fileNotifications: { changed: changed.map((name) => compilerFileName(name)) },
    // Without it the snapshot keeps the program built before the update.
    ensurePrograms: true,
  });
}

/**
 * The names of every file the project's program holds, declaration files included.
 *
 * @param project - The project whose program to list.
 * @returns The absolute file names, in the platform's spelling.
 * @throws When the compiler process has exited.
 */
export async function programFileNames(project: Project): Promise<readonly string[]> {
  return (await project.program.getSourceFileNames()).map((name) => nativeFileName(name));
}

/**
 * The program's parse of `file`.
 *
 * @param project - Project whose program holds the file.
 * @param file - Absolute file name.
 * @returns The source file.
 * @throws When `file` is not part of the program, or the compiler process has exited.
 */
export async function projectSourceFile(project: Project, file: string): Promise<SourceFile> {
  const source = await project.program.getSourceFile(compilerFileName(file));
  if (source === undefined) throw new Error(`${file} is not part of the project`);
  return source;
}

/**
 * Emits JavaScript for a project file whatever the project's emit settings.
 *
 * @param project - Project whose program holds the file.
 * @param file - Absolute file name.
 * @returns The emitted JavaScript text.
 * @throws When the file is not part of the program or emits no JavaScript, or the compiler process
 *   has exited.
 */
export async function emitJavaScript(project: Project, file: string): Promise<string> {
  const { outputFiles } = await project.program.getJavaScriptEmit([compilerFileName(file)]);
  const [javascript] = [...outputFiles]
    .filter(([name]) => !name.endsWith(".map"))
    .map(([, output]) => output.text);
  if (javascript === undefined) throw new Error(`no JavaScript was emitted for ${file}`);
  return javascript;
}

/** A diagnostic's `category` is a plain number; this is the one that marks an error. */
const ERROR_CATEGORY: number = DiagnosticCategory.Error;

/**
 * The type-check errors of the project's program: its option, global, syntax, and semantic errors.
 *
 * @param project - Project whose program to check.
 * @returns The errors as the compiler formats them; empty when the program has none.
 * @throws When the compiler process has exited.
 */
export async function programErrors(project: Project): Promise<string> {
  const { program } = project;
  const found = await Promise.all([
    program.getProgramDiagnostics(),
    program.getGlobalDiagnostics(),
    program.getSyntacticDiagnostics(),
    program.getSemanticDiagnostics(),
  ]);
  const errors = found.flat().filter(({ category }) => category === ERROR_CATEGORY);
  return errors.length === 0 ? "" : formatDiagnostics(errors, program);
}

/**
 * Parses a file from disk outside any program. The parse stays available until the process ends.
 *
 * @param api - Client of the compiler process.
 * @param file - Absolute file name.
 * @returns The parsed source file.
 * @throws When the file cannot be read, naming it.
 */
export async function parseFile(api: API, file: string): Promise<SourceFile> {
  try {
    const { sourceFile } = await api.createSourceFileFromFile(compilerFileName(file));
    return sourceFile;
  } catch (error) {
    // The compiler names the file in its own spelling, which differs from `file`'s on Windows.
    throw new Error(`cannot parse ${file}: ${String(error)}`, { cause: error });
  }
}

/**
 * Parses `text` outside any program. The compiler process releases the parse before this returns,
 * so the tree serves syntax reads, never checker queries.
 *
 * @param api - Client of the compiler process.
 * @param fileName - The name to parse `text` under, whose extension sets the script kind.
 * @param text - The text to parse.
 * @returns The parsed source file.
 * @throws When the compiler process has exited.
 */
export async function parseText(api: API, fileName: string, text: string): Promise<SourceFile> {
  const retained = await api.createSourceFile(compilerFileName(fileName), text);
  await retained.dispose();
  return retained.sourceFile;
}

/**
 * Prints a syntax tree, nodes built by the factory and nodes of a parse alike. The printer is sent
 * the tree alone, without source text, so no comment of a parsed node is printed.
 *
 * @param api - Client of the compiler process.
 * @param node - Root of the tree to print.
 * @returns The printed text, its lines ending with `\n`.
 * @throws When the compiler process has exited.
 */
export async function printTree(api: API, node: Node): Promise<string> {
  return await api.printer.printNode(node);
}

// ---------------------------------------------------------------------------
// Symbols and declarations
// ---------------------------------------------------------------------------

/**
 * The symbol `name` reads. The name of a shorthand property (`{ visit }`) both declares a property
 * and reads a variable; the checker's symbol at that location is the property, so the variable is
 * asked for separately.
 *
 * @param checker - Checker of the program holding `name`.
 * @param name - Identifier to look up.
 * @returns The symbol read, or undefined when `name` refers to nothing.
 */
async function valueSymbolAt(checker: Checker, name: Node): Promise<CheckerSymbol | undefined> {
  const { parent } = name;
  if (isShorthandPropertyAssignment(parent) && parent.name === name) {
    return await checker.getShorthandAssignmentValueSymbol(parent);
  }
  return await checker.getSymbolAtLocation(name);
}

/**
 * The symbol `name` refers to, following import and export aliases to the declaring symbol.
 *
 * @param checker - Checker of the program holding `name`.
 * @param name - Identifier to resolve.
 * @returns The declaring symbol, or undefined when `name` refers to nothing.
 * @throws When the compiler process has exited.
 */
export async function resolveSymbol(
  checker: Checker,
  name: Node,
): Promise<CheckerSymbol | undefined> {
  const symbol = await valueSymbolAt(checker, name);
  if (symbol === undefined || (symbol.flags & SymbolFlags.Alias) === 0) return symbol;
  return await checker.getAliasedSymbol(symbol);
}

/**
 * The name of the file declaring the value `expr` refers to, following import aliases.
 *
 * @param checker - Checker of the program holding `expr`.
 * @param expr - Identifier to resolve.
 * @returns The declaring file's name, or undefined when `expr` names no value or one declared in its
 *   own file.
 * @throws When the compiler process has exited.
 */
export async function foreignValueFileName(
  checker: Checker,
  expr: Node,
): Promise<string | undefined> {
  const declaration = await (await resolveSymbol(checker, expr))?.valueDeclaration?.resolve();
  if (declaration === undefined) return undefined;
  const file = nodeFileName(declaration);
  return file === nodeFileName(expr) ? undefined : file;
}

/**
 * Whether `name` reads a function's implicit `arguments` object, not a property or binding named
 * arguments.
 *
 * @param checker - Checker of the program holding `name`.
 * @param name - Identifier to test.
 * @returns Whether `name` refers to the `arguments` object.
 * @throws When the compiler process has exited.
 */
export async function refersToArguments(checker: Checker, name: Node): Promise<boolean> {
  const symbol = await valueSymbolAt(checker, name);
  return symbol !== undefined && (await checker.isArgumentsSymbol(symbol));
}

/**
 * The declarations of `symbol`. Unlike its value declaration, these exist for a property of a
 * mapped type: the mapped property keeps the declarations of the property it maps.
 *
 * @param symbol - Symbol to inspect; undefined declares nothing.
 * @returns The declarations in declaration order; none for a property mapped over a literal key.
 * @throws When a declaration's source file is no longer available, or the compiler process has
 *   exited.
 */
export async function declarationsOf(symbol: CheckerSymbol | undefined): Promise<Node[]> {
  return await Promise.all(
    (symbol?.declarations ?? []).map(async (handle) => {
      const declaration = await handle.resolve();
      if (declaration === undefined) throw new Error(`a declaration in ${handle.path} is gone`);
      return declaration;
    }),
  );
}

/**
 * The file name of `file`, in the platform's spelling.
 *
 * @param file - Source file to name.
 * @returns Its absolute file name.
 */
export function sourceFileName(file: SourceFile): string {
  return nativeFileName(file.fileName);
}

/**
 * The file name of the source file holding `node`.
 *
 * @param node - Node to locate.
 * @returns The absolute name of its file, in the platform's spelling.
 */
export function nodeFileName(node: Node): string {
  return sourceFileName(node.getSourceFile());
}

/**
 * The names of the files declaring `symbol`, one per declaration.
 *
 * @param symbol - Symbol to inspect; undefined declares nothing.
 * @returns The file names, in declaration order.
 * @throws When a declaration's source file is no longer available, or the compiler process has
 *   exited.
 */
export async function declarationFileNames(symbol: CheckerSymbol | undefined): Promise<string[]> {
  return (await declarationsOf(symbol)).map(nodeFileName);
}

// ---------------------------------------------------------------------------
// Type inspection
// ---------------------------------------------------------------------------

/**
 * The property of `type` named `name`.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to inspect.
 * @param name - Property name.
 * @returns The property, or undefined when `type` has none by that name.
 * @throws When the compiler process has exited.
 */
export async function propertyOfType(
  checker: Checker,
  type: Type,
  name: string,
): Promise<CheckerSymbol | undefined> {
  return await checker.getPropertyOfType(type, name);
}

/**
 * The properties of `type`, in declaration order.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to inspect.
 * @returns The property symbols.
 * @throws When the compiler process has exited.
 */
export async function propertiesOfType(
  checker: Checker,
  type: Type,
): Promise<readonly CheckerSymbol[]> {
  return await checker.getPropertiesOfType(type);
}

/**
 * The type of the value `symbol` declares.
 *
 * @param checker - Checker that produced `symbol`.
 * @param symbol - Symbol to inspect.
 * @returns The type; the checker's error type when it cannot be determined.
 * @throws When the compiler process has exited.
 */
export async function typeOfSymbol(checker: Checker, symbol: CheckerSymbol): Promise<Type> {
  return await checker.getTypeOfSymbol(symbol);
}

/**
 * The symbol naming `type`.
 *
 * @param type - Type to inspect.
 * @returns The symbol, or undefined for a type no declaration names, such as a primitive.
 * @throws When the compiler process has exited.
 */
export async function typeSymbol(type: Type): Promise<CheckerSymbol | undefined> {
  return await type.getSymbol();
}

/**
 * Whether `expr` is an identifier that refers to the global value named `name`, not to a local
 * binding that shadows it.
 *
 * @param checker - Checker of the program holding `expr`.
 * @param expr - Expression to test.
 * @param name - Name of the global value.
 * @returns Whether `expr` reads that global.
 * @throws When the compiler process has exited.
 */
export async function isGlobalValue(checker: Checker, expr: Node, name: string): Promise<boolean> {
  if (!isIdentifier(expr) || expr.text !== name) return false;
  // Without a location the lookup starts at the globals, so no local binding can shadow them.
  const [global, resolved] = await Promise.all([
    checker.resolveName(name, SymbolFlags.Value),
    resolveSymbol(checker, expr),
  ]);
  return global !== undefined && resolved === global;
}

/**
 * The value `name` would read at `location`: a declaration in scope there, an import included and
 * not followed, or a global.
 *
 * @param checker - Checker of the program holding `location`.
 * @param location - Node whose scope the lookup starts from.
 * @param name - Name to look up.
 * @returns The declaring symbol, or undefined when `name` reads nothing at `location`.
 * @throws When the compiler process has exited.
 */
export async function resolveValueAt(
  checker: Checker,
  location: Node,
  name: string,
): Promise<CheckerSymbol | undefined> {
  return await checker.resolveName(name, SymbolFlags.Value, location);
}

/**
 * The static type of the value `node` evaluates to.
 *
 * @param checker - Checker of the program holding `node`.
 * @param node - Expression to type.
 * @returns The type; the checker's error type when it cannot be determined.
 * @throws When the compiler process has exited.
 */
export async function typeAtLocation(checker: Checker, node: Node): Promise<Type> {
  return await checker.getTypeAtLocation(node);
}

/**
 * The type whose properties `type` exposes: a type parameter's constraint, a primitive's wrapper.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to resolve.
 * @returns The apparent type.
 * @throws When the compiler process has exited.
 */
export async function apparentType(checker: Checker, type: Type): Promise<Type> {
  return await checker.getApparentType(type);
}

/**
 * `type` without `null` and `undefined`.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to narrow.
 * @returns The narrowed type.
 * @throws When the compiler process has exited.
 */
export async function nonNullableType(checker: Checker, type: Type): Promise<Type> {
  return await checker.getNonNullableType(type);
}

/**
 * The primitive a literal type widens to, as `number` for `42`.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to widen; a non-literal type comes back unchanged.
 * @returns The widened type.
 * @throws When the compiler process has exited.
 */
export async function baseTypeOfLiteral(checker: Checker, type: Type): Promise<Type> {
  return await checker.getBaseTypeOfLiteralType(type);
}

/**
 * Whether `type` is array-like: an array, a tuple, or a type assignable to a readonly array.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to test.
 * @returns Whether `type` is array-like.
 * @throws When the compiler process has exited.
 */
export async function isArrayLike(checker: Checker, type: Type): Promise<boolean> {
  return await checker.isArrayLikeType(type);
}

/**
 * Whether a value of `type` can be an array, as one typed `object`, `{}` or `Object` can: the
 * global `Array` type is assignable to it.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to test.
 * @returns Whether an array is assignable to `type`; `true` when the program has no global `Array`.
 * @throws When the compiler process has exited.
 */
export async function admitsArray(checker: Checker, type: Type): Promise<boolean> {
  const array = await checker.resolveName("Array", SymbolFlags.Type);
  if (array === undefined) return true;
  return await checker.isTypeAssignableTo(await checker.getDeclaredTypeOfSymbol(array), type);
}

/**
 * The members of a union type.
 *
 * @param type - Type to split.
 * @returns The members, or undefined when `type` is not a union.
 * @throws When the compiler process has exited.
 */
export async function unionMembers(type: Type): Promise<readonly Type[] | undefined> {
  return isUnionType(type) ? await type.getTypes() : undefined;
}

/**
 * The members of an intersection type.
 *
 * @param type - Type to split.
 * @returns The members, or undefined when `type` is not an intersection.
 * @throws When the compiler process has exited.
 */
export async function intersectionMembers(type: Type): Promise<readonly Type[] | undefined> {
  return isIntersectionType(type) ? await type.getTypes() : undefined;
}

/**
 * Whether values of `type` can be called.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to test.
 * @returns Whether `type` has a call signature.
 * @throws When the compiler process has exited.
 */
export async function hasCallSignatures(checker: Checker, type: Type): Promise<boolean> {
  return (await checker.getSignaturesOfType(type, SignatureKind.Call)).length > 0;
}

/**
 * Whether `type` is an array or a tuple, readonly ones included.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to test.
 * @returns Whether `type` is an array or tuple type.
 * @throws When the compiler process has exited.
 */
export async function isArrayOrTuple(checker: Checker, type: Type): Promise<boolean> {
  return isTupleType(type) || (await checker.isArrayType(type));
}

/**
 * The element types of a tuple whose every element is required. An optional, rest, or variadic
 * element leaves the tuple's length open.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to read.
 * @returns The element types in order, or undefined when `type` is not a tuple or has an element
 *   that is not required.
 * @throws When the compiler process has exited.
 */
export async function requiredTupleElements(
  checker: Checker,
  type: Type,
): Promise<readonly Type[] | undefined> {
  if (!isTupleType(type)) return undefined;
  const [target, typeArguments] = await Promise.all([
    type.getTarget(),
    checker.getTypeArguments(type),
  ]);
  const flags = target.elementFlags;
  if (flags.some((flag) => flag !== ElementFlags.Required)) return undefined;
  // A tuple reference's type arguments may end with its `this` type.
  return typeArguments.slice(0, flags.length);
}
