/**
 * The options the ecstatic Vite plugin takes, and the keys it accepts at runtime. The published
 * `ecstatic/vite` entry exports the options type alone; the key list stays internal.
 */

/** Options of the ecstatic Vite plugin. */
export interface EcstaticOptions {
  /** The tsconfig whose program the plugin rewrites, resolved from Vite's root; `tsconfig.json` when absent. */
  readonly project?: string;
  /** Whether a call that cannot be optimized fails the module's transform; `false` when absent. */
  readonly strict?: boolean;
}

/**
 * The option keys the plugin accepts. Typed by {@link EcstaticOptions}, so a key the interface gains
 * or drops is a type error here until the two agree.
 */
export const OPTION_KEYS: Readonly<Record<keyof EcstaticOptions, true>> = {
  project: true,
  strict: true,
};
