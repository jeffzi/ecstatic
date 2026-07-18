# ecstatic

Archetype-based ECS in TypeScript.

## Design docs — read before designing or implementing anything

- `docs/pillars.md` — the design pillars; most "missing" features are deliberate rejections
  recorded there. `docs/events.md`, `docs/cookbook.md`, `docs/design/` elaborate.

## Migration context

This project is a ground-up TypeScript port of **ecstatic**, a TypeScript→Lua ECS (same design
lineage, different runtime premises — V8 instead of Lua interpreters). `docs/` is standalone by
design — never add references to Lua, TSTL, or "the port" there.

## Commands

Package manager is **npm** (`package-lock.json`).

```shell
npm test           # vitest (types + unit) with coverage
npm run test:types # type-only tests (tests/types/*.test-d.ts)
npm run build      # tsc build
npm run check      # biome + markdownlint + tsc + fallow + spelling + typelint
```
