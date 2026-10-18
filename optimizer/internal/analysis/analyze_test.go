package analysis_test

import (
	"slices"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	"github.com/microsoft/typescript-go/shim/ast"

	"github.com/jeffzi/ecstatic/optimizer/internal/analysis"
	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/nodes"
	"github.com/jeffzi/ecstatic/optimizer/internal/position"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
)

func TestAnalyze_WhenCallsAppearInDifferentExpressionPositions_RecordsStatementContext(t *testing.T) {
	t.Parallel()
	files := installedMain(`import { each } from "ecstatic";
declare const s: any;
declare const x: boolean;
each(s, () => {});
const viaArrow = (v: any) => each(v, () => {});
x && each(s, () => {});
function viaReturn() {
	return each(s, () => {});
}
`)
	want := []facts.StmtContext{
		facts.ContextExpressionStatement,
		facts.ContextArrowBody,
		facts.ContextOtherExpression,
		facts.ContextOtherExpression,
	}

	sites := analyzeFixture(t, files, mainFile)

	got := siteValues(sites, func(s facts.Site) facts.StmtContext { return s.Context })
	if !slices.Equal(got, want) {
		t.Errorf("Analyze() contexts = %v, want %v", got, want)
	}
}

func TestAnalyze_RecordsArgCountMismatchesForIterationOps(t *testing.T) {
	t.Parallel()
	const eachArity = "each takes two or three arguments"
	tests := []struct {
		name string
		call string
		// typeError is why tsc rejects call; empty when call type-checks.
		typeError string
		want      []facts.Reason
	}{
		{name: "each with too few arguments", call: "each(s)", typeError: eachArity, want: []facts.Reason{facts.ReasonArgCount}},
		{name: "query with three arguments", call: "query(s, [], () => {})"},
		{name: "other op with any count", call: "has(1)", typeError: "has takes two arguments"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			directive := ""
			if tt.typeError != "" {
				directive = "// @ts-expect-error -- " + tt.typeError + "\n"
			}
			files := installedMain(`import { each, query, has } from "ecstatic";
declare const s: any;
` + directive + tt.call + ";\n")

			sites := analyzeFixture(t, files, mainFile)

			if len(sites) != 1 {
				t.Fatalf("Analyze(%s) sites = %d, want 1", tt.call, len(sites))
			}
			if got := sites[0].Reasons; !slices.Equal(got, tt.want) {
				t.Errorf("Analyze(%s) reasons = %v, want %v", tt.call, got, tt.want)
			}
		})
	}
}

// siteSummary is the part of a Site the nesting test compares.
type siteSummary struct {
	Nested []siteSummary
	Op     facts.Op
}

// summarize reduces sites to their op and nesting.
func summarize(sites []facts.Site) []siteSummary {
	out := make([]siteSummary, 0, len(sites))
	for _, s := range sites {
		out = append(out, siteSummary{Op: s.Op, Nested: summarize(s.Nested)})
	}
	return out
}

const nestedSource = `import { each, query, has, spawn, get } from "ecstatic";
declare const s: any;
each(s, (e) => {
	has(e, s);
	each(s, (f) => {
		get(f, s);
	});
	const shown = spawn(s);
	// @ts-expect-error -- each takes two or three arguments; this site records ARG_COUNT
	each(s);
});
query(s, [], (e) => has(e, s));
`

// nestedSourceCallStarts lists the start offsets of nestedSource's calls depth-first, each before the calls nested in it.
func nestedSourceCallStarts(t *testing.T) []int {
	t.Helper()
	return []int{
		position.Occurrence(t, nestedSource, "each(s, (e) =>", 0),
		position.Occurrence(t, nestedSource, "has(e, s)", 0),
		position.Occurrence(t, nestedSource, "each(s, (f) =>", 0),
		position.Occurrence(t, nestedSource, "get(f, s)", 0),
		position.Occurrence(t, nestedSource, "spawn(s)", 0),
		position.Occurrence(t, nestedSource, "each(s);", 0),
		position.Occurrence(t, nestedSource, "query(s, [], (e) =>", 0),
		position.Occurrence(t, nestedSource, "has(e, s)", 1),
	}
}

func TestAnalyze_WhenCallbackHoldsEcstaticCalls_ReportsThemAsNestedSites(t *testing.T) {
	t.Parallel()
	program := loadProgram(t, installedMain(nestedSource))
	file := program.file(t, mainFile)
	starts := nestedSourceCallStarts(t)
	wantPositions := positionsIn(file.FileName(), nestedSource, starts)
	want := []siteSummary{
		{
			Op: facts.OpEach,
			Nested: []siteSummary{
				{Op: facts.OpHas},
				{Op: facts.OpEach, Nested: []siteSummary{{Op: facts.OpGet}}},
				{Op: facts.OpSpawn},
				{Op: facts.OpEach},
			},
		},
		{Op: facts.OpQuery, Nested: []siteSummary{{Op: facts.OpHas}}},
	}

	sites, table := program.analyze(t, mainFile)

	if diff := cmp.Diff(want, summarize(sites), cmpopts.EquateEmpty()); diff != "" {
		t.Errorf("Analyze() sites mismatch (-want +got):\n%s", diff)
	}
	flat := flatten(sites)
	calls := siteValues(flat, func(s facts.Site) facts.NodeID { return s.Call })
	checkCallExpressions(t, table, calls)
	if got := nodeOffsets(t, table, file, calls); !slices.Equal(got, starts) {
		t.Errorf("start offsets of the site calls = %v, want %v", got, starts)
	}
	got := siteValues(flat, func(s facts.Site) facts.Position { return s.Pos })
	if diff := cmp.Diff(wantPositions, got); diff != "" {
		t.Errorf("site positions mismatch (-want +got):\n%s", diff)
	}
}

// checkCallExpressions fails the test for each of ids that table does not map to a call expression.
func checkCallExpressions(t *testing.T, table *nodes.Table, ids []facts.NodeID) {
	t.Helper()
	for _, id := range ids {
		if node, ok := table.Node(id); !ok || node.Kind != ast.KindCallExpression {
			t.Errorf("table.Node(%d) = %v, %t, want a call expression", id, node, ok)
		}
	}
}

// positionsIn returns the positions of offsets, byte offsets into source, in source, a file named file.
func positionsIn(file, source string, offsets []int) []facts.Position {
	positions := make([]facts.Position, 0, len(offsets))
	for _, offset := range offsets {
		positions = append(positions, position.Of(file, source, offset))
	}
	return positions
}

// wideSource calls has after text that is longer in UTF-8 bytes than in UTF-16 code units: é is one BMP code unit, 🚀 two.
const wideSource = `import { has } from "ecstatic";
declare const s: any;
const label = "é🚀"; has(s, s);
`

func TestAnalyze_WhenCallFollowsNonASCIITextOnItsLine_CountsItsColumnInUTF16CodeUnits(t *testing.T) {
	t.Parallel()
	program := loadProgram(t, installedMain(wideSource))
	want := positionsIn(program.file(t, mainFile).FileName(), wideSource, []int{position.Occurrence(t, wideSource, "has(s, s)", 0)})

	sites, _ := program.analyze(t, mainFile)

	got := siteValues(sites, func(s facts.Site) facts.Position { return s.Pos })
	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("site positions mismatch (-want +got):\n%s", diff)
	}
}

func TestAnalyze_WhenRunTwiceWithOneRootCache_ReturnsEqualSites(t *testing.T) {
	t.Parallel()
	program := shapeProject(t, []shapeCase{{source: eachOver("Storage<Ship>")}})
	file := program.file(t, caseFile(0))
	roots := analysis.NewPackageRoots()
	first, _ := analysis.Analyze(program.program.Checker, file, roots)
	if site := eachSite(t, first); len(site.Shapes) == 0 || len(site.DeclarationFiles) == 0 {
		t.Fatalf("first Analyze() each site = %+v, want a resolved shape with declaration files", site)
	}

	second, _ := analysis.Analyze(program.program.Checker, file, roots)

	if diff := cmp.Diff(first, second); diff != "" {
		t.Errorf("second Analyze() mismatch (-first +second):\n%s", diff)
	}
}

type recognitionCase struct {
	files fixture
	name  string
	file  string
	want  []facts.Op
}

// mainCase is a case whose calls are written in app/main.ts of an installed ecstatic.
func mainCase(name, source string, want ...facts.Op) recognitionCase {
	return recognitionCase{
		name:  name,
		files: installedMain(source),
		file:  mainFile,
		want:  want,
	}
}

// reexportCase is a case whose app/main.ts calls each through app/reexport.ts, which holds the reexport statement.
func reexportCase(name, reexport, source string) recognitionCase {
	return recognitionCase{
		name:  name,
		files: installedEcstatic().with(fixture{"app/reexport.ts": reexport + "\n", mainFile: source}),
		file:  mainFile,
		want:  []facts.Op{facts.OpEach},
	}
}

// recognitionCases holds one ecstatic call per way a callee can resolve to an op.
func recognitionCases() []recognitionCase {
	return []recognitionCase{
		mainCase("named import", `import { each } from "ecstatic";
declare const s: any;
each(s, () => {});
`, facts.OpEach),
		mainCase("import alias", `import { each as e } from "ecstatic";
declare const s: any;
e(s, () => {});
`, facts.OpEach),
		mainCase("namespace import", `import * as ecs from "ecstatic";
declare const s: any;
ecs.each(s, () => {});
`, facts.OpEach),
		reexportCase("re-export through a user module", `export { each as forEach } from "ecstatic";`, `import { forEach } from "./reexport.js";
declare const s: any;
forEach(s, () => {});
`),
		reexportCase("star re-export through a user module", `export * from "ecstatic";`, `import { each } from "./reexport.js";
declare const s: any;
each(s, () => {});
`),
		reexportCase("namespace re-export through a user module", `export * as ecs from "ecstatic";`, `import { ecs } from "./reexport.js";
declare const s: any;
ecs.each(s, () => {});
`),
		{
			name: "relative import of the repository sources",
			files: repositoryEcstatic().with(fixture{"tests/each.test.ts": `import { each } from "../src/index.js";
each(1, () => {});
`}),
			file: "tests/each.test.ts",
			want: []facts.Op{facts.OpEach},
		},
	}
}

func TestAnalyze_RecognizesEcstaticCalls(t *testing.T) {
	t.Parallel()
	for _, tt := range recognitionCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := siteOps(analyzeFixture(t, tt.files, tt.file))

			if !slices.Equal(got, tt.want) {
				t.Errorf("Analyze(%s) ops = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

const otherEachSource = `import { each } from "other";
each(1, () => {});
`

func TestAnalyze_IgnoresCallsNotResolvingToAnEcstaticOp(t *testing.T) {
	t.Parallel()
	tests := []struct {
		files fixture
		name  string
	}{
		{
			name: "exported function with no op",
			files: installedMain(`import { banana } from "ecstatic";
banana();
`),
		},
		{
			name:  "same-named function from another package",
			files: installedMain(otherEachSource),
		},
		{
			name:  "same-named function from a package installed inside the repository",
			files: repositoryEcstatic().with(fixture{mainFile: otherEachSource}),
		},
		{
			name: "variable alias",
			files: installedMain(`import { each } from "ecstatic";
declare const s: any;
const myEach = each;
myEach(s, () => {});
`),
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := analyzeFixture(t, tt.files, mainFile)

			if len(got) != 0 {
				t.Errorf("Analyze(%s) ops = %v, want none", tt.name, siteOps(got))
			}
		})
	}
}

const (
	ecstaticManifest = `{"name": "ecstatic"}`
	otherManifest    = `{"name": "other"}`
)

func TestPackageRoots_Root_FindsTheNearestEcstaticAncestor(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		files fixture
		file  string
		want  string
	}{
		{
			name:  "package.json beside the file's directory",
			files: fixture{"package.json": ecstaticManifest, "src/each.ts": ""},
			file:  "src/each.ts",
			want:  ".",
		},
		{
			name:  "nearest of two ecstatic packages",
			files: fixture{"package.json": ecstaticManifest, "inner/package.json": ecstaticManifest, "inner/dist/index.d.ts": ""},
			file:  "inner/dist/index.d.ts",
			want:  "inner",
		},
		{
			name:  "past a package with another name",
			files: fixture{"package.json": ecstaticManifest, "sub/package.json": otherManifest, "sub/a.ts": ""},
			file:  "sub/a.ts",
			want:  ".",
		},
		{
			name:  "past a package.json that is not valid JSON",
			files: fixture{"package.json": ecstaticManifest, "sub/package.json": "{", "sub/a.ts": ""},
			file:  "sub/a.ts",
			want:  ".",
		},
		{
			name:  "past a package.json whose name is not a string",
			files: fixture{"package.json": ecstaticManifest, "sub/package.json": `{"name": 5}`, "sub/a.ts": ""},
			file:  "sub/a.ts",
			want:  ".",
		},
		{
			name:  "past an unreadable package.json",
			files: fixture{"package.json": ecstaticManifest, "sub/package.json/keep": "", "sub/a.ts": ""},
			file:  "sub/a.ts",
			want:  ".",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			dir := project.Write(t, tt.files)
			roots := analysis.NewPackageRoots()
			want := treePath(dir, tt.want)

			got, ok := roots.Root(treePath(dir, tt.file))

			if !ok || got != want {
				t.Errorf("Root(%s) = %q, %t, want %q, true", tt.file, got, ok, want)
			}
		})
	}
}

func TestPackageRoots_Root_WhenNoAncestorIsEcstatic_ReportsNoRoot(t *testing.T) {
	t.Parallel()
	dir := project.Write(t, fixture{"package.json": otherManifest, "src/a.ts": ""})
	roots := analysis.NewPackageRoots()

	got, ok := roots.Root(treePath(dir, "src/a.ts"))

	if ok {
		t.Errorf("Root(src/a.ts) = %q, true, want no root", got)
	}
}

func TestPackageRoots_Root_WhenDirectoriesAlreadyLooked_ReturnsEachFilesNearestRoot(t *testing.T) {
	t.Parallel()
	dir := project.Write(t, fixture{
		"package.json":          ecstaticManifest,
		"inner/package.json":    ecstaticManifest,
		"inner/dist/index.d.ts": "",
		"inner/a.ts":            "",
		"sub/package.json":      otherManifest,
		"sub/a.ts":              "",
		"sub/b.ts":              "",
		"a.ts":                  "",
	})
	roots := analysis.NewPackageRoots()
	roots.Root(treePath(dir, "inner/dist/index.d.ts"))
	roots.Root(treePath(dir, "sub/a.ts"))
	want := map[string]string{
		"inner/dist/index.d.ts": treePath(dir, "inner"),
		"inner/a.ts":            treePath(dir, "inner"),
		"sub/b.ts":              treePath(dir, "."),
		"a.ts":                  treePath(dir, "."),
	}

	got := map[string]string{}
	for file := range want {
		got[file], _ = roots.Root(treePath(dir, file))
	}

	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Root() after looking up inner/dist and sub mismatch (-want +got):\n%s", diff)
	}
}

// runtimeCall is a runtime module calling each imported from specifier.
func runtimeCall(specifier string) string {
	return "import { each } from \"" + specifier + "\";\neach(1, async (e) => {});\n"
}

func TestAnalyze_SkipsFilesInsideTheRuntime(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		file   string
		source string
	}{
		{name: "source directory", file: "src/system.ts", source: runtimeCall("./iteration.js")},
		{name: "distribution directory", file: "dist/system.ts", source: runtimeCall("./iteration.js")},
		{name: "subdirectory of the source directory", file: "src/entity/system.ts", source: runtimeCall("../iteration.js")},
		{name: "subdirectory of the distribution directory", file: "dist/entity/system.ts", source: runtimeCall("../iteration.js")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			files := repositoryEcstatic().with(fixture{
				tt.file:             tt.source,
				"dist/iteration.ts": "export { each } from \"../src/iteration.js\";\n",
			})

			got := analyzeFixture(t, files, tt.file)

			if len(got) != 0 {
				t.Errorf("Analyze(%s) ops = %v, want none", tt.file, siteOps(got))
			}
		})
	}
}
