/**
 * Every call the optimizer makes into the compiler process lives here: checker, symbol, type,
 * program, snapshot, parse, emit, and printer calls. The other optimizer modules read nodes and plain values,
 * so a compiler API upgrade edits this file alone.
 */

import { setImmediate } from "node:timers/promises";

import type { Node, SourceFile } from "typescript/ast";
import { isIdentifier, isShorthandPropertyAssignment } from "typescript/ast/is";
import {
  API,
  type Checker,
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

export type { API, Checker, CheckerSymbol, Snapshot, Type };

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
    const forget = (): void => {
      inFlight.delete(request);
    };
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
    const kill = (): void => {
      child.kill("SIGKILL");
    };
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
 * deadline is killed, so a process that stopped answering cannot hold the close forever.
 *
 * @param compiler - Compiler whose process ends.
 * @param timeoutMs - Milliseconds the process gets to answer the requests in flight and exit before
 *   it is killed.
 * @throws When the client fails to close.
 */
export async function closeCompiler(compiler: Compiler, timeoutMs: number): Promise<void> {
  const deadline = setTimeout(() => {
    compiler.kill();
  }, timeoutMs);
  try {
    await compiler.end();
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Loads the project `tsconfig` names into a new snapshot.
 *
 * @param api - Client of the compiler process.
 * @param tsconfig - Absolute path of the project's tsconfig.
 * @returns A snapshot holding the project, its program built.
 * @throws When the tsconfig cannot be read or has parse errors, with the compiler's diagnostic text.
 */
export async function loadProject(api: API, tsconfig: string): Promise<Snapshot> {
  // A snapshot asked to open an unreadable tsconfig loads no project and reports nothing;
  // parsing the config is what surfaces the read failure.
  const [snapshot] = await Promise.all([
    api.createSnapshot({ openProjects: [tsconfig] }),
    api.parseConfigFile(tsconfig),
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
  const project = snapshot.getConfiguredProject(tsconfig);
  if (project === undefined) throw new Error(`no project is loaded for ${tsconfig}`);
  return project;
}

/**
 * Derives a snapshot that reads `files` in place of the disk and re-reads `changed` from it. Earlier
 * layers carry forward, so `snapshot`'s served text stays served unless `files` replaces it.
 *
 * @param snapshot - Snapshot the update builds on.
 * @param files - Text to serve, keyed by absolute file name.
 * @param changed - Absolute names of files changed on disk since `snapshot`.
 * @returns The new snapshot, its programs rebuilt.
 */
export async function updateSnapshot(
  snapshot: Snapshot,
  files: Readonly<Record<string, string>>,
  changed: readonly string[],
): Promise<Snapshot> {
  return await snapshot.update({
    fileSystem: { kind: "layer", files: { ...files } },
    fileNotifications: { changed: [...changed] },
    // Without it the snapshot keeps the program built before the update.
    ensurePrograms: true,
  });
}

/**
 * The program's parse of `file`.
 *
 * @param project - Project whose program holds the file.
 * @param file - Absolute file name.
 * @returns The source file.
 * @throws When `file` is not part of the program.
 */
export async function projectSourceFile(project: Project, file: string): Promise<SourceFile> {
  const source = await project.program.getSourceFile(file);
  if (source === undefined) throw new Error(`${file} is not part of the project`);
  return source;
}

/**
 * Emits JavaScript for a project file whatever the project's emit settings.
 *
 * @param project - Project whose program holds the file.
 * @param file - Absolute file name.
 * @returns The emitted JavaScript text.
 * @throws When the file is not part of the program or emits no JavaScript.
 */
export async function emitJavaScript(project: Project, file: string): Promise<string> {
  const { outputFiles } = await project.program.getJavaScriptEmit([file]);
  const [javascript] = [...outputFiles]
    .filter(([name]) => !name.endsWith(".map"))
    .map(([, output]) => output.text);
  if (javascript === undefined) throw new Error(`no JavaScript was emitted for ${file}`);
  return javascript;
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
  const { sourceFile } = await api.createSourceFileFromFile(file);
  return sourceFile;
}

/**
 * Parses `text` outside any program. The compiler process releases the parse before this returns,
 * so the tree serves syntax reads, never checker queries.
 *
 * @param api - Client of the compiler process.
 * @param fileName - The name to parse `text` under, whose extension sets the script kind.
 * @param text - The text to parse.
 * @returns The parsed source file.
 */
export async function parseText(api: API, fileName: string, text: string): Promise<SourceFile> {
  const retained = await api.createSourceFile(fileName, text);
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
 */
export async function printTree(api: API, node: Node): Promise<string> {
  return await api.printer.printNode(node);
}

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
 */
export async function foreignValueFileName(
  checker: Checker,
  expr: Node,
): Promise<string | undefined> {
  const declaration = await valueDeclaration(await resolveSymbol(checker, expr));
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
 */
export async function refersToArguments(checker: Checker, name: Node): Promise<boolean> {
  const symbol = await valueSymbolAt(checker, name);
  return symbol !== undefined && (await checker.isArgumentsSymbol(symbol));
}

/**
 * The declaration of the value `symbol` names.
 *
 * @param symbol - Symbol to inspect; undefined gives undefined.
 * @returns The value declaration, or undefined when `symbol` declares no value.
 */
export async function valueDeclaration(
  symbol: CheckerSymbol | undefined,
): Promise<Node | undefined> {
  return await symbol?.valueDeclaration?.resolve();
}

/**
 * The display name of `symbol`.
 *
 * @param symbol - Symbol to name.
 * @returns Its name without escaping.
 */
export function symbolName(symbol: CheckerSymbol): string {
  return symbol.name;
}

/**
 * The file name of `file`, as spelled on disk.
 *
 * @param file - Source file to name.
 * @returns Its absolute file name.
 */
export function sourceFileName(file: SourceFile): string {
  return file.fileName;
}

/**
 * The file name of the source file holding `node`.
 *
 * @param node - Node to locate.
 * @returns The absolute name of its file, as spelled on disk.
 */
export function nodeFileName(node: Node): string {
  return sourceFileName(node.getSourceFile());
}

/**
 * The names of the files declaring `symbol`, one per declaration.
 *
 * @param symbol - Symbol to inspect; undefined declares nothing.
 * @returns The file names, in declaration order.
 * @throws When a declaration's source file is no longer available.
 */
export async function declarationFileNames(symbol: CheckerSymbol | undefined): Promise<string[]> {
  return await Promise.all(
    (symbol?.declarations ?? []).map(async (handle) => {
      const declaration = await handle.resolve();
      if (declaration === undefined) throw new Error(`a declaration in ${handle.path} is gone`);
      return nodeFileName(declaration);
    }),
  );
}

/**
 * The property of `type` named `name`.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to inspect.
 * @param name - Property name.
 * @returns The property, or undefined when `type` has none by that name.
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
 */
export async function typeOfSymbol(checker: Checker, symbol: CheckerSymbol): Promise<Type> {
  return await checker.getTypeOfSymbol(symbol);
}

/**
 * The symbol naming `type`.
 *
 * @param type - Type to inspect.
 * @returns The symbol, or undefined for a type no declaration names, such as a primitive.
 */
export async function typeSymbol(type: Type): Promise<CheckerSymbol | undefined> {
  return await type.getSymbol();
}

/**
 * Whether the property of `type` named `name` is a get or set accessor.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to inspect.
 * @param name - Property name.
 * @returns Whether the property exists and is an accessor.
 */
export async function isAccessorProperty(
  checker: Checker,
  type: Type,
  name: string,
): Promise<boolean> {
  return isAccessorSymbol(await propertyOfType(checker, type, name));
}

/**
 * Whether `symbol` is a get or set accessor.
 *
 * @param symbol - Symbol to inspect; undefined is no accessor.
 * @returns Whether `symbol` is an accessor.
 */
export function isAccessorSymbol(symbol: CheckerSymbol | undefined): boolean {
  return symbol !== undefined && (symbol.flags & SymbolFlags.Accessor) !== 0;
}

/**
 * Whether `symbol`, a type's symbol, names an object literal, a type literal, or no declaration at
 * all: an object type with no class or interface behind it.
 *
 * @param symbol - The type's symbol; undefined for a type no declaration names.
 * @returns Whether the type is anonymous.
 */
export function isAnonymousObjectSymbol(symbol: CheckerSymbol | undefined): boolean {
  return (
    symbol === undefined ||
    (symbol.flags & (SymbolFlags.ObjectLiteral | SymbolFlags.TypeLiteral)) !== 0
  );
}

/**
 * Whether `expr` is an identifier that refers to the global value named `name`, not to a local
 * binding that shadows it.
 *
 * @param checker - Checker of the program holding `expr`.
 * @param expr - Expression to test.
 * @param name - Name of the global value.
 * @returns Whether `expr` reads that global.
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
 * The static type of the value `node` evaluates to.
 *
 * @param checker - Checker of the program holding `node`.
 * @param node - Expression to type.
 * @returns The type; the checker's error type when it cannot be determined.
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
 */
export async function isArrayLike(checker: Checker, type: Type): Promise<boolean> {
  return await checker.isArrayLikeType(type);
}

/**
 * Whether `type` is `any` or `unknown`.
 *
 * @param type - Type to test.
 * @returns Whether it is `any` or `unknown`.
 */
export function isAnyOrUnknown(type: Type): boolean {
  return (type.flags & TypeFlags.AnyOrUnknown) !== 0;
}

/**
 * Whether `type` is `boolean` or a boolean literal.
 *
 * @param type - Type to test.
 * @returns Whether it is boolean.
 */
export function isBooleanType(type: Type): boolean {
  return (type.flags & TypeFlags.BooleanLike) !== 0;
}

/**
 * Whether `type` is `number` or a number literal.
 *
 * @param type - Type to test.
 * @returns Whether it is a number.
 */
export function isNumberType(type: Type): boolean {
  return (type.flags & TypeFlags.NumberLike) !== 0;
}

/**
 * The value of a single string literal type.
 *
 * @param type - Type to read; undefined has no value.
 * @returns The literal's value, or undefined for any other type, a union of literals included.
 */
export function stringLiteralValue(type: Type | undefined): string | undefined {
  return type !== undefined && isStringLiteralType(type) ? type.value : undefined;
}

/**
 * The members of a union type.
 *
 * @param type - Type to split.
 * @returns The members, or undefined when `type` is not a union.
 */
export async function unionMembers(type: Type): Promise<readonly Type[] | undefined> {
  return isUnionType(type) ? await type.getTypes() : undefined;
}

/**
 * The members of an intersection type.
 *
 * @param type - Type to split.
 * @returns The members, or undefined when `type` is not an intersection.
 */
export async function intersectionMembers(type: Type): Promise<readonly Type[] | undefined> {
  return isIntersectionType(type) ? await type.getTypes() : undefined;
}

/**
 * The identity of `type` within its program, the same for every object that stands for it.
 *
 * @param type - Type to identify.
 * @returns Its ID.
 */
export function typeId(type: Type): number {
  return type.id;
}

/**
 * Whether `type` is a primitive, such as `number` or a string literal, or `never`.
 *
 * @param type - Type to test; a union or intersection tests as neither.
 * @returns Whether every value of `type` is a primitive.
 */
export function isPrimitiveOrNever(type: Type): boolean {
  return (type.flags & (TypeFlags.Primitive | TypeFlags.Never)) !== 0;
}

/**
 * Whether `type` is `null`, `undefined`, or `void`.
 *
 * @param type - Type to test; a union tests as none of them.
 * @returns Whether `type` holds only `null` or `undefined`.
 */
export function isNullishOrVoid(type: Type): boolean {
  return (type.flags & (TypeFlags.Nullable | TypeFlags.Void)) !== 0;
}

/**
 * Whether values of `type` can be called.
 *
 * @param checker - Checker that produced `type`.
 * @param type - Type to test.
 * @returns Whether `type` has a call signature.
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

/** How the compiler API spells the name of a property keyed by a unique symbol: `__@iterator@12`. */
const SYMBOL_KEY_PREFIX = "__@";

/**
 * Whether `symbol` is a property keyed by a symbol value, such as `[Symbol.iterator]`, rather than
 * by a name. Such a key has no string the runtime could enumerate.
 *
 * @param symbol - Property to test.
 * @returns Whether its key is a symbol.
 */
export function isSymbolKeyed(symbol: CheckerSymbol): boolean {
  return symbol.name.startsWith(SYMBOL_KEY_PREFIX);
}
