# optimizer — Go sidecar module

Rules for the Go module under `optimizer/`. Commands, git hygiene, lint configuration, and spelling
are in the repository root `AGENTS.md` and apply here unchanged.

The module builds against `../node_modules/ttsc`: `go.work` resolves the ttsc module and the
TypeScript-go shim modules from there, so run `npm ci` at the repository root before any `go`
command in this module. `go mod tidy` cannot run in this module, because the ttsc shim modules
resolve only through `go.work`; only `tools/` is tidied (`go -C tools mod tidy`).

The module is the ttsc (`github.com/samchon/ttsc`) sidecar that compiles ecstatic's query calls into
inline loops. The ttsc driver is `github.com/samchon/ttsc/packages/ttsc/driver`; the checker shim is
`github.com/microsoft/typescript-go/shim/checker`.

## Commands

Run these from `optimizer/`.

- `go test -race ./internal/<pkg>/` — one package's tests, with the race detector `npm run test:go`
  runs.
- `go test ./... -update` — rewrites each `tests/optimizer/fixtures/**/expected.ts.golden` from the
  current output; review the diff.
- `npm run lint:go` — lint, the same command the commit hook runs (from the repository root).
- `go tool golangci-lint fmt` — format, with the formatters the lint config enables.

## Packages

`ttscadapter` loads the program and calls `analysis`, which reports the ecstatic calls as `facts`;
`plan` decides each site's outcome from them, and `ttscadapter` reports the bails as diagnostics.
The import-boundary rules and the checks that enforce them are under Project facts, Seam tests.

- The module root (`main.go`) — the ttsc sidecar's entry point; calls `ttscadapter.Run`.
- `internal/ttscadapter` — the ttsc sidecar protocol: arguments, program loading,
  check/build/transform, and diagnostics.
- `internal/analysis` — recognizes ecstatic calls in a type-checked file and reports them as facts.
- `internal/facts` — the facts `analysis` produces and `plan` consumes; standard library only.
- `internal/plan` — decides each site's outcome from the facts.
- `internal/nodes` — the AST node table that maps node IDs back to AST nodes.
- `internal/version` — the release version, kept in sync with `package.json` by `npm version`.
- `internal/importcheck` — the package-boundary rules.
- `internal/golden` — registers the `-update` flag that `go test ./... -update` passes to every test
  binary. Only test files import it; Seam tests names the check that requires it of every package
  with tests.
- `internal/project` — writes the TypeScript projects tests load, including the repository's runtime
  sources. Only test files import it.
- `internal/fatal` — records the message a `testing.TB` helper fails with, so a test can check how a
  helper fails. Only test files import it.
- `internal/position` — locates text in a TypeScript source and gives its position as `analysis`
  reports it, columns in UTF-16 code units. Only test files import it.

## Module layout

- A single command keeps `package main` in the module root. Move commands to `cmd/<name>/main.go`
  only when the module ships several commands or also exports importable packages.
- Supporting packages live under `internal/` until another module needs them.
- Never add a directory that holds no `.go` files except `cmd/`, `internal/`, and `tools/` (the
  module that pins golangci-lint and govulncheck for `go tool`).
- `main()` parses flags, builds dependencies, and calls one testable entry point — nothing else.
- No `context.Context`. The sidecar is a one-shot process. Its only post-analysis side effect is the
  output-write loop in `emit` (`internal/ttscadapter/run.go`), and a ctx can't make that safer than
  Go's default exit-on-SIGINT. The ttsc driver APIs (`LoadProgram`, `EmitWithPluginTransformers`)
  take no ctx. Revisit if the sidecar gains a long-lived mode.

## Package and file layout

The Go linter caps a file's code lines (revive `file-length-limit`; the test-file lint config for
`_test.go` files) and a function's lines and statements (the function-length linter). The cap marks
a file that holds more than one concern; it is not a budget. These rules decide where code lives. A
reason that is not written here does not move code and does not keep it apart: apply the rules as
written and report the reason in one line, so it can become a rule. A reason becomes a rule by
becoming checkable: a blocker under rule 4, or a fact under Project facts. The numbers the rules
refer to are listed under Project facts.

Code is placed at two levels: a file inside its package, and a package inside the project. A file's
**users** are the other files of its package that refer to a name it declares. A package's **users**
are the project packages that import it. `_test.go` files and package `main` are never users. To
**fold** a file is to move all of it into another file of its package and delete it; to fold a
package is to move its files into another package and delete its directory.

**Registration is not use.** A file that only registers another file's code (adds its command to the
root command, lists its handler in a table) and never otherwise calls it is neither its user nor its
home. A file that nothing but its registrar refers to is a file of its own at any size; one that
other files also use is placed by those users alone. The same holds between packages.

1. **New code goes in the file that uses it**, with the types, errors and constants it declares. One
   user: that file. No new file until rule 2 or rule 6 calls for one, and no new package until rule
   2 calls for one. That the new code is a concern of its own, or that sibling concerns have files
   of their own, calls for nothing.
2. **Shared code goes to its home.**
   - When two or more files of one package use it, the first of these that applies:
     - It is a rule about one type (a method, a constructor, a predicate, a conversion): the file
       that declares the type.
     - Otherwise: an existing file you have read that already owns that concern, or a file of its
       own, named for what it does, whatever its size.
   - When two or more packages use it, the first of these that applies:
     - One of its users is already imported by every other user, and uses the code itself: that
       package is the home, because nobody loads the code without loading it.
     - It is a rule about one project type and every user already imports the package that declares
       the type: beside the type. Code that merely mentions the type does not qualify.
     - Otherwise: an existing package you have read that already owns that concern, or a package of
       its own, named for what it provides, whatever its size.
3. **A file that has a home folds into it.** A file with one user folds into that user, and a
   package with one user folds into that user. When several could fold into the same target and not
   all fit, fold the smallest first and stop before the first that does not fit. A file or package
   with no users (the package's entry point, `main`) stands.
4. **Only four things block a fold**, and each one can be checked:
   - **Size.** The target would land above the fold limit, summing the code lines of everything that
     goes into it. The fold limit sits below the cap so that a fold is not undone by the next edit.
     A file may grow past the fold limit afterwards; only the cap forces a move.
   - **Standing.** The file, or the package as a whole, holds at least the stand floor of code lines
     and its name says what everything in it does (rule 5). Below the floor, or under a name that
     fits only because it is wide, it folds.
   - **Build.** The file carries a build constraint its target does not (a `//go:build` line, an
     operating-system or architecture suffix in its name), or it is generated.
   - **Seam.** A seam test would fail after the fold. A seam without a test is a preference: write
     the test first if the property matters.

   None of these block a fold: "it is a distinct concern", "it is pure logic", "it is easier to test
   alone", "a reviewer asked to keep it apart", "it is one of several alike", "reusable later",
   "keeps the user small", "matches the existing small files". Small files and packages already in
   the tree are debt, not precedent: report one that has a home and no block, and fold it when
   asked.

5. **Never pool.** Merging two files when neither uses the other is pooling, whatever the file count
   gained. A file's or package's name says what everything in it does. A name that fits only because
   it is wide (`helpers`, `util`, `common`, `shared`, `core`, `misc`, `support`) marks a pool, and
   so does a name for the kind of declaration inside (`types`, `errors`, `constants`, `interfaces`,
   `models`): a declaration lives with the code it belongs to, under rules 1 and 2. A pool already
   in the tree is debt, not precedent: add nothing to it, whatever the package's existing layout
   suggests, and report it. Asked to consolidate, take each pool apart by rules 1 and 2, apply rule
   3 until nothing more folds, and report every other file with the block or the lack of a home that
   keeps it.
6. **At the cap, move one whole concern**: the code least tied to the rest that changes together for
   one reason. The code just added is never the concern that moves. It goes to a new file of the
   same package named for what it does, or to an existing file you have read that already owns that
   concern. The file must land at or below the fold limit; if it does not, pick a different, larger
   concern. When no single concern is large enough, move a second whole concern as well, to a file
   of its own. Never move just enough to pass, never top up the move with unrelated code, and never
   compress code to fit. A file carved out stands for as long as folding it back would exceed the
   fold limit.
7. **Tests follow the code.** The tests of `x.go` live in `x_test.go`. When code moves, its tests
   move to the test file of its new home in the same change. A `_test.go` file has its own cap and
   fold limit, and rules 5 and 6 apply to it unchanged.

### Project facts

- **Cap:** 600 code lines per file, 1000 per `_test.go` file; 60 lines and 40 statements per
  function.
- **Fold limit:** 540 code lines; 900 for a `_test.go` file.
- **Stand floor:** 120 code lines.
- **Seam tests:** a fold or a move that breaks either is blocked.
  - The import-boundary test (`boundary_test.go`, rules in `internal/importcheck`). It enforces four
    rules: `internal/facts` and `internal/plan` depend on no TypeScript-go or ttsc package;
    `internal/nodes` does not depend on the checker shim; only `internal/analysis` imports the
    checker shim; only `internal/ttscadapter` imports the ttsc driver. It also fails when a package
    the rules name (`facts`, `plan`, `nodes`, `analysis`, `ttscadapter`) no longer exists, so
    folding or renaming one is blocked, and when a package with tests does not import
    `internal/golden`.
  - The symbol-accessor tests (`internal/analysis/symbols_test.go`). Within `internal/analysis`,
    only `symbols.go` reads a field or method of `*ast.Symbol`, calls a method of
    `*checker.Checker`, `*checker.Type`, or `*ast.SourceFile` that takes or returns an
    `*ast.Symbol`, or calls `SourceFile.FileName`, so a compiler upgrade that renames one edits that
    file alone.

## Doc comments

Go doc comments (`//` before declarations). None required on unexported functions. A one-line doc
comment is complete on its own when the name says the rest — the comment always starts with the
declared name: `// FuncName does X.` Package comments use `// Package name does X.`; for
`package main` the comment starts with the program name instead: `// Name does X.` A function you
edit gets its doc comment brought to this shape even if you did not write it. Tests: no doc comments
on test functions; the name carries the intent.
