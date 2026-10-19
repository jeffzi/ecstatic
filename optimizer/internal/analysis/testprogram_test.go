package analysis_test

import (
	"fmt"
	"maps"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/scanner"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/jeffzi/ecstatic/optimizer/internal/analysis"
	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/fatal"
	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
	"github.com/jeffzi/ecstatic/optimizer/internal/nodes"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
)

// fixture lists a test project's files by slash-separated path relative to its root.
type fixture map[string]string

const tsconfig = `{
	"compilerOptions": {
		"strict": true,
		"target": "es2022",
		"module": "esnext",
		"moduleResolution": "bundler",
		"noEmit": true,
		"skipLibCheck": true,
		"types": []
	},
	"include": ["**/*.ts"]
}`

const iterationDeclarations = `export interface Storage { readonly size: number }
export declare function each(storage: Storage, callback: (entity: number) => void): void;
export declare function each(storage: Storage, filter: unknown, callback: (entity: number) => void): void;
export declare function query(world: unknown, filter: unknown, callback: (entity: number) => void): void;
`

const entityDeclarations = `export declare function has(entity: number, component: unknown): boolean;
export declare function spawn(world: unknown, ...components: unknown[]): number;
export declare function get(entity: number, component: unknown): unknown;
export declare function banana(): void;
`

const indexDeclarations = `export { each, query } from "./iteration.js";
export type { Storage } from "./iteration.js";
export { has, spawn, get, banana } from "./entity.js";
`

const (
	tsconfigFile      = "tsconfig.json"
	modulePackageJSON = `{"name": "ecstatic", "type": "module"}`
)

// otherPackage is an unrelated dependency that exports a function named like an ecstatic op.
func otherPackage() fixture {
	const dir = "node_modules/other"
	return fixture{
		dir + "/package.json": `{"name": "other", "types": "index.d.ts"}`,
		dir + "/index.d.ts":   "export declare function each(storage: unknown, callback: () => void): void;\n",
	}
}

// installedEcstatic is ecstatic installed as a dependency, plus an unrelated package.
func installedEcstatic() fixture {
	return fixture{
		tsconfigFile:                                tsconfig,
		"node_modules/ecstatic/package.json":        `{"name": "ecstatic", "types": "dist/index.d.ts"}`,
		"node_modules/ecstatic/dist/index.d.ts":     indexDeclarations,
		"node_modules/ecstatic/dist/iteration.d.ts": iterationDeclarations,
		"node_modules/ecstatic/dist/entity.d.ts":    entityDeclarations,
	}.with(otherPackage())
}

// repositoryEcstatic is the ecstatic repository itself: runtime sources in src/ at the root.
func repositoryEcstatic() fixture {
	return fixture{
		tsconfigFile:   tsconfig,
		"package.json": modulePackageJSON,
		"src/index.ts": "export { each } from \"./iteration.js\";\n",
		"src/iteration.ts": `export function each(storage: unknown, callback: (entity: number) => void): void {
	callback(storage === undefined ? 0 : 1);
}
`,
	}.with(otherPackage())
}

// with returns a copy of f extended with extra.
func (f fixture) with(extra fixture) fixture {
	out := maps.Clone(f)
	maps.Copy(out, extra)
	return out
}

// treePath returns the OS path of the slash-separated rel under dir.
func treePath(dir, rel string) string {
	return filepath.Join(dir, filepath.FromSlash(rel))
}

// testProgram is a Program loaded from a fixture written to a temp dir.
type testProgram struct {
	program *driver.Program
	dir     string
}

// loadProgram writes files to a temp dir and loads them as one Program.
func loadProgram(t testing.TB, files fixture) *testProgram {
	t.Helper()
	dir := project.Write(t, files)

	program, diagnostics, err := driver.LoadProgram(dir, tsconfigFile, driver.LoadProgramOptions{ForceNoEmit: true})
	if err != nil {
		t.Fatalf("LoadProgram(%s) error = %v, want nil", dir, err)
	}
	t.Cleanup(func() {
		if err := program.Close(); err != nil {
			t.Errorf("close program: %v", err)
		}
	})
	if len(diagnostics) > 0 {
		t.Fatalf("LoadProgram(%s) diagnostics = %v, want none", dir, diagnostics)
	}
	loaded := &testProgram{program: program, dir: dir}
	if errs := loaded.fixtureErrors(files); len(errs) > 0 {
		t.Fatalf("fixture does not compile:\n%s", strings.Join(errs, "\n"))
	}
	return loaded
}

// fixtureErrors lists the syntactic and semantic errors in the program's files that files wrote,
// as "path:line:column: message" with the path relative to the fixture root.
func (p *testProgram) fixtureErrors(files fixture) []string {
	sources := make([]*ast.SourceFile, 0, len(files))
	for _, rel := range slices.Sorted(maps.Keys(files)) {
		if file := p.program.SourceFile(treePath(p.dir, rel)); file != nil {
			sources = append(sources, file)
		}
	}
	var errs []string
	for _, d := range p.program.DiagnosticsForFiles(sources) {
		if !d.IsError() {
			continue
		}
		if rel, err := filepath.Rel(p.dir, d.File); d.File != "" && err == nil {
			d.File = filepath.ToSlash(rel)
		}
		errs = append(errs, d.String())
	}
	return errs
}

// file returns the program's source file at rel.
func (p *testProgram) file(t *testing.T, rel string) *ast.SourceFile {
	t.Helper()
	file := p.program.SourceFile(treePath(p.dir, rel))
	if file == nil {
		t.Fatalf("source file %s not in the program", rel)
	}
	return file
}

// analyze runs Analyze over the file at rel.
func (p *testProgram) analyze(t *testing.T, rel string) ([]facts.Site, *nodes.Table) {
	t.Helper()
	return analysis.Analyze(p.program.Checker, p.file(t, rel), analysis.NewPackageRoots())
}

// analyzeFixture loads files as a Program and analyzes the file at rel.
func analyzeFixture(t *testing.T, files fixture, rel string) []facts.Site {
	t.Helper()
	sites, _ := loadProgram(t, files).analyze(t, rel)
	return sites
}

// nodeOffsets maps ids, node IDs of table, to the offsets in file their nodes start at, leading trivia excluded.
func nodeOffsets(t *testing.T, table *nodes.Table, file *ast.SourceFile, ids []facts.NodeID) []int {
	t.Helper()
	offsets := make([]int, 0, len(ids))
	for _, id := range ids {
		node, ok := table.Node(id)
		if !ok {
			t.Fatalf("table.Node(%d) = _, false, want a node", id)
		}
		offsets = append(offsets, scanner.GetTokenPosOfNode(node, file, false))
	}
	return offsets
}

// siteOps lists the Op of each site, in order.
func siteOps(sites []facts.Site) []facts.Op {
	return valuesOf(sites, func(s facts.Site) facts.Op { return s.Op })
}

// valuesOf lists value of each of items, in order.
func valuesOf[S, T any](items []S, value func(S) T) []T {
	values := make([]T, 0, len(items))
	for _, item := range items {
		values = append(values, value(item))
	}
	return values
}

const mainFile = "app/main.ts"

// installedMain is an installed ecstatic plus source written to app/main.ts.
func installedMain(source string) fixture {
	return installedEcstatic().with(fixture{mainFile: source})
}

// flatten lists sites depth-first, each before its nested sites.
func flatten(sites []facts.Site) []facts.Site {
	var out []facts.Site
	for _, s := range sites {
		out = append(out, s)
		out = append(out, flatten(s.Nested)...)
	}
	return out
}

const positionSource = `import { component } from "../src/index.js";

export const Position = component("Position", { x: 0, y: 0 });
`

const componentsSource = `import { component, f32, ref, relation } from "../src/index.js";

export const Velocity = component("Velocity", { dx: f32(0), dy: 0 });
export const Shield = component("Shield", { hp: 0, active: true, label: "", owner: ref<number>() });
export const Stunned = component("Stunned");
export const Boost = component("Boost", {});
export const ChildOf = relation("ChildOf", { order: 0, pinned: false });
`

const archetypesSource = `import { Archetype, archetype } from "../src/index.js";
import { Boost, ChildOf, Shield, Stunned, Velocity } from "./components.js";
import { Position } from "./position.js";

export const Enemy = archetype([Position, Velocity], [Shield, Stunned]);
export class Ship extends Archetype([Position], [Shield, Stunned, Boost]) {}
export class Hull extends Archetype([Position], [Shield, Stunned, Boost]) {}
export const Linked = archetype([Position, ChildOf]);
`

const storagesSource = `import { createWorld, register } from "../src/index.js";
import { Enemy } from "./archetypes.js";

export const enemies = register(createWorld(), Enemy);
`

// casePrelude opens every case file: the runtime API and the shared archetypes and components.
const casePrelude = `import { archetype, component, createWorld, each, getStorage, register, type Storage, type World } from "../../src/index.js";
import type { ArchetypeDescriptor, ComponentDescriptor } from "../../src/archetype.js";
import { Enemy, Hull, Linked, Ship } from "../archetypes.js";
import { Position } from "../position.js";
import { Velocity } from "../components.js";
`

// caseFile is the slash-separated path of the ith case file.
func caseFile(i int) string {
	return fmt.Sprintf("app/case/case%d.ts", i)
}

// caseStart is the offset in a case file opened by prelude at which its case source starts.
func caseStart(prelude string) int {
	return len(casePrelude) + len(prelude)
}

// caseProject is the real runtime plus shared components, archetypes, and storages, and one case file per source,
// each opened by casePrelude and prelude.
func caseProject(t *testing.T, prelude string, sources []string) *testProgram {
	t.Helper()
	files := project.Runtime(t, fixture{
		"app/position.ts":   positionSource,
		"app/components.ts": componentsSource,
		"app/archetypes.ts": archetypesSource,
		"app/storages.ts":   storagesSource,
	})
	for i, source := range sources {
		files[caseFile(i)] = casePrelude + prelude + source
	}
	return loadProgram(t, files)
}

// runCases runs run over each of cases, the ith written to caseFile(i), as a nested test named by name. The nested
// tests run one at a time: the cases share one program, and its checker is not safe for concurrent use.
func runCases[C any](t *testing.T, cases []C, name func(C) string, run func(t *testing.T, i int, c C)) {
	t.Helper()
	for i, c := range cases {
		t.Run(name(c), func(t *testing.T) { run(t, i, c) })
	}
}

func TestLoadProgram_WhenAFixtureFileHasAnError_FailsNamingFileAndLine(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		source string
		wantAt string
	}{
		{name: "type error", source: "export const x: number = \"a\";\n", wantAt: "src/main.ts:1:"},
		{name: "syntax error", source: "export const x = 1;\nexport const = 2;\n", wantAt: "src/main.ts:2:"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			recorder := &fatal.Recorder{TB: t}

			got := recorder.Run(func(tb testing.TB) { loadProgram(tb, fixture{tsconfigFile: tsconfig, "src/main.ts": tt.source}) })

			wantPrefix := "fixture does not compile:\n" + tt.wantAt
			if !strings.HasPrefix(got, wantPrefix) {
				t.Errorf("loadProgram(%q) fatal = %q, want prefix %q", tt.source, got, wantPrefix)
			}
		})
	}
}

// firstEachSite returns the first top-level each site of sites.
func firstEachSite(t *testing.T, sites []facts.Site) facts.Site {
	t.Helper()
	for _, s := range sites {
		if s.Op == facts.OpEach {
			return s
		}
	}
	t.Fatal("no top-level each site")
	return facts.Site{}
}
