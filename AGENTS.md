# ecstatic

Archetype-based ECS in TypeScript.

## Design docs — read before designing or implementing anything

- `docs/pillars.md` — the design pillars; most "missing" features are deliberate rejections recorded
  there. `docs/events.md`, `docs/cookbook.md`, `docs/design/` elaborate.

## Migration context

This project is a ground-up TypeScript port of **ecstatic**, a TypeScript→Lua ECS (same design
lineage, different runtime premises — V8 instead of Lua interpreters). `docs/` is standalone by
design — never add references to Lua, TSTL, or "the port" there.

## Commands

Package manager is **npm** (`package-lock.json`). `npm test`, `npm run test:go`, and `npm run check`
also need Go ≥ 1.26 (`optimizer/go.mod`).

- `npm run build` — compile the core with `tsc -p tsconfig.build.json` (no Node types), then the
  Node-only `src/plugin/` modules with `tsc -p tsconfig.build-plugin.json`
- `npm test` — `vitest run --coverage` over the `types`, `unit`, and `fixtures` projects, plus
  `unit-optimized` and `unit-ndebug` (the unit tests through the optimizer, the second under
  `NDEBUG`) and `fixtures-ndebug` (the fixtures under `NDEBUG`). The first optimized run builds the
  Go plugin, about a minute cold. Coverage thresholds fail the run, and untested `src/` files count
  against them. Then `npm run test:go`, which runs second because vitest empties `coverage/` when it
  starts
- `npm run test:vitest` — the vitest projects of `npm test` with coverage, without the Go tests; CI
  runs the Go tests in a job of their own
- `npm run test:types` — type-only tests (`tests/types/*.test-d.ts`)
- `npm run test:go` — `go test` over the `optimizer/` module with a coverage profile at
  `coverage/go.out`, then `scripts/check-go-coverage.ts`, which fails naming each package under 95%
  statement coverage (files named `main.go` are left out).
- `npm run examples` — build, then run each `examples/*.ts` with tsx
- `npm run check` — run before committing.
  - It runs every pre-commit hook over all tracked and untracked files (lint, markdown, formatting,
    workflow lint/audit, type-aware lint, spelling, types, and for `optimizer/**/*.go` formatting,
    `go vet`, and golangci-lint, plus a `go mod tidy -diff` check of `optimizer/tools`), plus dead
    code and publish hygiene (`publint` + `@arethetypeswrong/cli`); then the build, examples, and
    benchmarks type checks, the version sync check, and the allocation gate.
  - The lint, markdown, and formatting hooks rewrite files in place; Go files are formatted by
    `golangci-lint fmt`.
  - golangci-lint v2 runs through `go tool`, pinned in `optimizer/tools/go.mod`, once with
    `optimizer/.golangci.yml` and again with `optimizer/.golangci.tests.yml` (the `_test.go`
    file-length cap); `npm run lint:go` runs both passes alone.
  - Run `npm test` before `check` after editing `src/`: the dead-code hook scores complexity against
    the coverage `npm test` writes and refuses to run when a `src/` file is newer than that report.
    The dead-code hook runs in `check` and `pre-push` (right after `npm test`), never at pre-commit.
- `npm run check:type` — type-check the build, examples, and benchmarks tsconfigs
- `npm run check:version` — fail when `src/version.ts` or `optimizer/internal/version/version.go` is
  out of sync with `package.json`; `npm version` regenerates and stages both
- `npm run check:alloc` — build, then run the allocation gate (`benchmarks/alloc/gate.ts`)
- `npm run fix` — auto-fix lint, markdown, and formatting, then remove unused exports, dependencies,
  and enum members (`fallow fix`). Deletes code — review the diff before committing.
- `npm run check:security` — surface security candidates (`fallow security`). Candidates need
  verification; they are not confirmed vulnerabilities. Not part of `check`.
- `npm run check:package` — publish hygiene alone (`publint` + `@arethetypeswrong/cli`).

## Git hygiene

- Never run `git commit --no-verify`, `git commit -n`, or anything else that skips the lefthook
  hooks — the hooks are the gate, not an obstacle.
- Fix a failing check at its source. Never weaken a test to make it pass. A test whose assertion is
  right but whose input is wrong (a sample value that collides with a fixture, a typo, a bad import)
  is a test bug: fix the input and say so in one line.

## Linter and type-checker configuration

Treat lint and type-check config as fixed. Never add to an ignore list, disable a rule, lower a
severity, or exclude a file to get a check passing — fix the code instead. A suppression is
warranted only when the finding is a genuine false positive or the rule cannot apply (e.g. a
generated file, a documented upstream bug); then suppress at the narrowest scope — an inline
directive with a reason — not in the shared config. When the same inline directive keeps recurring
for the same rule, that is a signal the rule may deserve a config-level ignore — propose it to the
user and wait for explicit approval; never promote a suppression into config on your own.

## Doc comments

TSDoc. None is required on private functions, parameterless void functions, or non-function symbols.
A one-line doc comment is complete on its own — no `@param`, `@returns`, or `@throws` tags — when
the signature says the rest. When a function needs more than one line (a side effect, an invariant,
a precondition, what `undefined` means, or behavior the name does not convey), use a multi-line doc
comment with tags: `@param` for every parameter, however obvious its name, `@returns`, and `@throws`
for every error thrown or propagated. Parameters, return values, and errors are described only in
their tags, never in prose. A function you edit gets its doc comment brought to this shape even if
you did not write it; deadlines and reviewer preference do not change that. Tests: no doc comments
on test cases, the title carries the intent; shared helpers get a one-line summary.

## Spelling (cspell)

Treat a cspell failure as a prompt to reword, not to grow the dictionary. Prefer plain words in
prose and identifiers. A word earns a `cspell.json` entry only when it comes from outside the
project and cannot be renamed — command names, API identifiers, file formats, proper nouns, domain
vocabulary (e.g. `taskkill`, `unref`, `tsbuildinfo`). In tests, never invent gibberish that needs a
suppression — any real word works for an unknown command, a bogus flag, or filler data, so pick one
(`banana`, not an invented pseudo-word). `// cspell:disable-line` is reserved for fixtures where the
gibberish itself is the behavior under test, never a dictionary entry.
