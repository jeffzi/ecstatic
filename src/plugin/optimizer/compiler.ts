/**
 * Every call the optimizer makes into the compiler process lives here: checker, symbol, type,
 * program, snapshot, parse, and emit calls. The other optimizer modules read nodes and plain values,
 * so a compiler API upgrade edits this file alone.
 */

import type { Node, SourceFile } from "typescript/ast";
import { isIdentifier, isShorthandPropertyAssignment } from "typescript/ast/is";
import {
  API,
  type Checker,
  formatDiagnostics,
  type Project,
  type Snapshot,
  type Symbol as CheckerSymbol,
  SymbolFlags,
  type Type,
} from "typescript/async";

export type { API, Checker, CheckerSymbol, Snapshot, Type };

/** A compiler process and the client that owns it. */
export interface Compiler {
  readonly api: API;
  /** Whether the process has exited; every request in flight then, or made since, has failed. */
  readonly exited: boolean;
  /** Ends the process at once, failing every request in flight. */
  kill(): void;
}

/** The client the API keeps undeclared, which starts the process. */
interface InternalClient {
  connect(): Promise<void>;
}

/** The client's connection to the process. */
interface InternalConnection {
  onClose(listener: () => void): unknown;
  dispose(): void;
}

/** The process the client spawned. */
interface InternalProcess {
  kill(signal: string): boolean;
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    names.every((name) => typeof Reflect.get(value, name) === "function")
  );
}

function isInternalClient(value: unknown): value is InternalClient {
  return hasMethods(value, ["connect"]);
}

function isInternalConnection(value: unknown): value is InternalConnection {
  return hasMethods(value, ["onClose", "dispose"]);
}

function isInternalProcess(value: unknown): value is InternalProcess {
  return hasMethods(value, ["kill"]);
}

/**
 * Reads a member the compiler API keeps off its declared surface.
 *
 * @param owner - Object holding the member.
 * @param name - Member name.
 * @param isShape - Checks the member has the shape this module relies on.
 * @returns The member.
 * @throws When the member is missing or has another shape, as after a compiler API upgrade.
 */
function internalMember<T>(
  owner: object,
  name: string,
  isShape: (value: unknown) => value is T,
): T {
  const value: unknown = Reflect.get(owner, name);
  if (!isShape(value)) {
    throw new Error(`the compiler API no longer holds the ${name} this optimizer relies on`);
  }
  return value;
}

/**
 * Starts a compiler process and ties the client to its lifetime. The connection only notes that the
 * process exited; it rejects requests still waiting for an answer once disposed, so the exit
 * disposes it, and neither a request in flight nor {@link closeCompiler} waits forever.
 *
 * @param executable - Compiler executable; the one bundled with `typescript` when undefined.
 * @returns The compiler, owning the process until {@link closeCompiler}.
 * @throws When the process cannot start, naming the executable, or the compiler API no longer holds
 *   the client, process, or connection this module relies on.
 */
export async function startCompiler(executable: string | undefined): Promise<Compiler> {
  const api = new API({ tsserverPath: executable });
  try {
    const client = internalMember(api, "client", isInternalClient);
    await client.connect();
    // Watched before any I/O callback runs, so the close cannot fire unobserved.
    const connection = internalMember(client, "connection", isInternalConnection);
    // Held here because the client forgets its process once closing begins.
    const child = internalMember(client, "process", isInternalProcess);
    let exited = false;
    connection.onClose(() => {
      exited = true;
      connection.dispose();
    });
    return {
      api,
      get exited() {
        return exited;
      },
      kill() {
        child.kill("SIGKILL");
      },
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}

/**
 * Ends the compiler process. A process that has not finished releasing remote objects by the
 * deadline is killed, so a process that stopped answering cannot hold the close forever. Releasing
 * fails once the process has exited; that failure is ignored since the process holds nothing left
 * to release.
 *
 * @param compiler - Compiler whose process ends.
 * @param timeoutMs - Milliseconds the process gets to release its remote objects before it is killed.
 * @throws Any failure to close while the process is still running.
 */
export async function closeCompiler(compiler: Compiler, timeoutMs: number): Promise<void> {
  // oxlint-disable-next-line no-restricted-globals -- the plugin is built for Node alone (tsconfig.build-plugin.json), outside the platform-neutral library build
  const deadline = setTimeout(() => {
    compiler.kill();
  }, timeoutMs);
  try {
    await compiler.api.close();
  } catch (error) {
    if (!compiler.exited) throw error;
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
