/**
 * Non-`Error` thrown values are stringified, so a thrown string or object still yields a usable
 * message.
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
