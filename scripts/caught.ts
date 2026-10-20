/**
 * Turn a caught value into text for an error message.
 *
 * @param error - The caught value.
 * @returns The message of `error` when it is an `Error`, otherwise `error` as a string.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Tell a missing-path failure apart from other filesystem and spawn errors.
 *
 * @param error - The caught value.
 * @returns Whether `error` is a Node system error with code `ENOENT`.
 */
export function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * Tell a Node system error, as thrown by `node:fs` calls, apart from other thrown values.
 *
 * @param error - The caught value.
 * @returns Whether `error` is an `Error` carrying a string `code`, such as `ENOENT` or `EACCES`.
 */
export function isSystemError(error: unknown): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
