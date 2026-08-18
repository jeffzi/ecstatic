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

Package manager is **npm** (`package-lock.json`).

- `npm run build` — compile with `tsc -p tsconfig.build.json`
- `npm test` — `vitest run --coverage` (types + unit projects); coverage thresholds fail the run,
  and untested `src/` files count against them
- `npm run test:types` — type-only tests (`tests/types/*.test-d.ts`)
- `npm run examples` — build, then run each `examples/*.ts` with tsx
- `npm run check` — all static checks: lint, markdown, formatting, workflow lint/audit, type-aware
  lint, dead code, spelling, types. Run before committing.
- `npm run fix` — auto-fix: lint, markdown, formatting
- `npm run fix:quality` — remove unused exports, dependencies, and enum members (`fallow fix`).
  Deletes code — review the diff before committing.
- `npm run check:security` — surface security candidates (`fallow security`). Candidates need
  verification; they are not confirmed vulnerabilities. Not part of `check`.
- `npm run check:package` — publish hygiene (`publint` + `@arethetypeswrong/cli`) for packages that
  ship to npm. Not part of `check`.
