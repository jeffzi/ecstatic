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
