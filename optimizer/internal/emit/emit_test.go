package emit_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/core"
	"github.com/microsoft/typescript-go/shim/parser"
	"github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/jeffzi/ecstatic/optimizer/internal/analysis"
	"github.com/jeffzi/ecstatic/optimizer/internal/emit"
	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
	"github.com/jeffzi/ecstatic/optimizer/internal/printed"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
)

// repositoryRoot is the ecstatic repository, three levels above the package directory go test runs in.
const repositoryRoot = "../../.."

// packageJSON makes the test project an ecstatic package root whose entry points are its own runtime sources, so
// emitted code importing ecstatic/internal runs against them.
const packageJSON = `{
	"name": "ecstatic",
	"type": "module",
	"exports": {".": "./src/index.ts", "./internal": "./src/internal.ts"}
}`

const schemaSource = `import { archetype, component, createWorld, ref, register, relation, spawn, u8 } from "../src/index.js";

export const Position = component("Position", { x: 0, y: 0 });
export const Velocity = component("Velocity", { dx: 0, dy: 0 });
export const Label = component("Label", { text: "" });
export const Pair = component("A,B", { n: 0 });
export const Flags = component("Flags", { on: false });
export const Shield = component("Shield", { hp: 0, up: false, level: u8(0) });
export const Stunned = component("Stunned");
export const Boost = component("Boost");
export const Tether = relation("Tether", { slack: 0 });
export const Leash = relation("Leash", { length: 0 });
export const Mark = component("Mark", { first: ref<number>(), second: ref<number>() });
export const Scale = component("Scale", { x: 1, y: 1 });

export const Mover = archetype([Position, Velocity]);
export const Statue = archetype([Position, Label]);
export const Paired = archetype([Pair, Position]);
export const Guarded = archetype([Position, Flags, Stunned], [Shield, Boost]);
export const Tethered = archetype([Position, Tether], [Leash]);
export const Marked = archetype([Position], [Mark]);
export const Pinned = archetype([Mark]);
export const Sized = archetype([Position, Scale]);

// guarded registers a Guarded storage holding a row with every optional enabled, then a row with none.
export function guarded() {
    const storage = register(createWorld(), Guarded);
    const ids = [
        spawn(storage, { Position: { x: 1, y: 0 }, Flags: { on: true }, Shield: { hp: 5, up: true, level: 2 }, Boost: true }),
        spawn(storage, { Position: { x: 2, y: 0 } }),
    ];
    return { storage, ids };
}

// marked registers a Marked storage holding a row whose Mark is enabled with both fields unset, then a row without it.
export function marked() {
    const storage = register(createWorld(), Marked);
    const ids = [spawn(storage, { Position: { x: 1, y: 0 }, Mark: {} }), spawn(storage, { Position: { x: 2, y: 0 } })];
    return { storage, ids };
}
`

// casePrelude opens every case file but the preamble's: the runtime API and the schema.
const casePrelude = `import { createWorld, disable, each, enable, get, has, register, spawn, spawnMany, type Storage } from "../../src/index.js";
import { Flags, Label, Leash, Mark, Mover, Pair, Paired, Pinned, Position, Scale, Shield, Sized, Statue, Tether, Tethered, Velocity, guarded, marked } from "../schema.js";
`

// namedMode is a mode a test forces on every inlining of a case file, with the name its t.Run takes.
type namedMode struct {
	name string
	mode plan.Mode
}

// allModes lists every mode of an inlined loop.
func allModes() []namedMode {
	return []namedMode{{name: "hoisted", mode: plan.ModeHoisted}, {name: "realloc-safe", mode: plan.ModeReallocSafe}}
}

// testProject is a loaded Program over the runtime sources, the schema, and the case files.
type testProject struct {
	program *driver.Program
	dir     string
}

// caseFile is the slash-separated path of the ith case file.
func caseFile(i int) string {
	return fmt.Sprintf("app/case/case%d.ts", i)
}

// loadProject writes the runtime, the schema, and cases, keyed by slash-separated path, and loads them as one
// Program, failing when a case does not compile.
func loadProject(t *testing.T, cases map[string]string) *testProject {
	t.Helper()
	files := project.Runtime(t, map[string]string{"package.json": packageJSON, "app/schema.ts": schemaSource})
	maps.Copy(files, cases)
	dir := project.Write(t, files)
	program, diagnostics, err := driver.LoadProgram(dir, "tsconfig.json", driver.LoadProgramOptions{ForceNoEmit: true})
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
	p := &testProject{program: program, dir: dir}
	var sources []*ast.SourceFile
	for _, rel := range slices.Sorted(maps.Keys(cases)) {
		sources = append(sources, p.file(t, rel))
	}
	for _, d := range program.DiagnosticsForFiles(sources) {
		if d.IsError() {
			t.Errorf("case does not compile: %s", d.String())
		}
	}
	if t.Failed() {
		t.FailNow()
	}
	return p
}

// file returns the program's source file at the slash-separated rel.
func (p *testProject) file(t *testing.T, rel string) *ast.SourceFile {
	t.Helper()
	file := p.program.SourceFile(filepath.Join(p.dir, filepath.FromSlash(rel)))
	if file == nil {
		t.Fatalf("source file %s not in the program", rel)
	}
	return file
}

// viewUses maps the call of every site in sites, at any depth, to the view uses of its callback.
func viewUses(sites []facts.Site) map[facts.NodeID][]facts.ViewUse {
	uses := map[facts.NodeID][]facts.ViewUse{}
	for _, s := range sites {
		if s.Callback != nil {
			uses[s.Call] = s.Callback.ViewUses
		}
		maps.Copy(uses, viewUses(s.Nested))
	}
	return uses
}

// rewritten is a case file after every planned inlining was emitted, printed as the transform prints it.
type rewritten struct {
	text string
	// whole is the rewritten file as SourceFile returns it, printed whole.
	whole    string
	rewrites []plan.EachInlining
	// applied names the catalog rules the file's loops applied.
	applied []string
}

// rewrite analyzes and plans the case file at rel, emits the loop of every site the plan rewrites with debug as
// the file's DEBUG source, and prints the result. A nonzero mode replaces the plan's mode on every inlining.
func (p *testProject) rewrite(t *testing.T, rel string, debug *emit.Debug, mode plan.Mode) rewritten {
	t.Helper()
	return p.rewriteWith(t, rel, debug, func(out *emit.File, inlining plan.EachInlining, uses []facts.ViewUse) {
		if mode != 0 {
			inlining.Mode = mode
		}
		out.Inline(inlining, uses)
	})
}

// inliner emits one planned inlining into the file out, with uses the view uses of its callback.
type inliner = func(out *emit.File, inlining plan.EachInlining, uses []facts.ViewUse)

// rewriteWith is rewrite with inline emitting each planned inlining, in plan order.
func (p *testProject) rewriteWith(t *testing.T, rel string, debug *emit.Debug, inline inliner) rewritten {
	t.Helper()
	file := p.file(t, rel)
	sites, table := analysis.Analyze(p.program.Checker, file, analysis.NewPackageRoots())
	result := plan.Plan(sites)
	if len(result.Rewrites) == 0 {
		t.Fatalf("Plan(%s) rewrites no site; bails = %+v", rel, result.Bails)
	}
	uses := viewUses(sites)
	ctx := printer.NewEmitContext()
	out := emit.NewFile(ctx, file, table, debug)
	for _, inlining := range result.Rewrites {
		inline(out, inlining, uses[inlining.Call])
	}
	text, _ := out.Print()
	whole := printer.EmitSourceFile(printer.NewPrinter(printer.PrinterOptions{}, printer.PrintHandlers{}, ctx), out.SourceFile())
	applied := make([]string, 0, len(out.Applied()))
	for _, r := range out.Applied() {
		applied = append(applied, r.Name())
	}
	return rewritten{text: text, whole: whole, rewrites: result.Rewrites, applied: applied}
}

// debugOf extracts the DEBUG initializer of the runtime the project holds.
func (p *testProject) debugOf(t *testing.T) *emit.Debug {
	t.Helper()
	debug, err := emit.LoadDebug(p.dir)
	if err != nil {
		t.Fatalf("LoadDebug(%s) error = %v, want nil", p.dir, err)
	}
	return debug
}

// write writes text to the slash-separated rel under the project.
func (p *testProject) write(t *testing.T, rel, text string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(p.dir, filepath.FromSlash(rel)), []byte(text), 0o600); err != nil {
		t.Fatalf("write %s: %v", rel, err)
	}
}

// writeRewrites writes the rewrite of each of the first n case files under every mode in modes, with debug as the
// DEBUG source, to its emittedFile.
func (p *testProject) writeRewrites(t *testing.T, n int, debug *emit.Debug, modes []namedMode) {
	t.Helper()
	for i := range n {
		for _, m := range modes {
			p.write(t, emittedFile(caseFile(i), m.name), p.rewrite(t, caseFile(i), debug, m.mode).text)
		}
	}
}

// tsx is the repository's tsx binary.
func tsx(t *testing.T) string {
	t.Helper()
	bin, err := filepath.Abs(filepath.Join(repositoryRoot, "node_modules", ".bin", "tsx"))
	if err != nil {
		t.Fatalf("filepath.Abs(tsx) error = %v, want nil", err)
	}
	return bin
}

// run imports the module at the slash-separated rel with tsx, with globalThis.NDEBUG set when ndebug, and returns
// the JSON its scenario export's result encodes to.
func (p *testProject) run(t *testing.T, rel string, ndebug bool) string {
	t.Helper()
	runner := strings.TrimSuffix(rel, ".ts") + fmt.Sprintf(".ndebug-%t.run.mjs", ndebug)
	var setup string
	if ndebug {
		setup = "globalThis.NDEBUG = true;\n"
	}
	p.write(t, runner, setup+fmt.Sprintf("const { scenario } = await import(%q);\nconsole.log(JSON.stringify(scenario()));\n",
		"./"+path.Base(rel)))
	cmd := exec.CommandContext(t.Context(), tsx(t), filepath.FromSlash(runner)) //nolint:gosec // runs the repository's own tsx on a file the test wrote
	cmd.Dir = p.dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("tsx %s: %v\n%s", runner, err, stderr.String())
	}
	return strings.TrimSpace(stdout.String())
}

// emittedFile is the slash-separated path the rewrite of the case file at rel under mode is written to.
func emittedFile(rel, mode string) string {
	return strings.TrimSuffix(rel, ".ts") + "." + mode + ".ts"
}

type runCase struct {
	name   string
	source string
	// want is the JSON the scenario's result encodes to, on the runtime and in every mode.
	want string
}

// fieldAccessCases holds scenarios whose body reads and writes fields and id.
func fieldAccessCases() []runCase {
	return []runCase{
		{
			name: "rows run from the last to the first, reading and writing fields and id",
			source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    const ids = [
        spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 2, dy: 0 } }),
        spawn(movers, { Position: { x: 5, y: 0 }, Velocity: { dx: -1, dy: 0 } }),
        spawn(movers, { Position: { x: 10, y: 0 }, Velocity: { dx: 3, dy: 0 } }),
    ];
    const order: number[] = [];
    each(movers, (e) => {
        order.push(ids.indexOf(e.id));
        e.Position.x = e.Position.x + e.Velocity.dx;
    });
    return { order, xs: ids.map((id) => get(movers, id, Position.x)) };
}
`,
			want: `{"order":[2,1,0],"xs":[3,4,13]}`,
		},
		{
			name: "a plain-array field is read and written like a numeric one",
			source: `export function scenario(): unknown {
    const statues = register(createWorld(), Statue);
    const ids = [
        spawn(statues, { Position: { x: 1, y: 0 }, Label: { text: "a" } }),
        spawn(statues, { Position: { x: 2, y: 0 }, Label: { text: "b" } }),
    ];
    each(statues, (e) => {
        e.Label.text = e.Label.text + e.Position.x;
    });
    return ids.map((id) => get(statues, id, Label.text));
}
`,
			want: `["a1","b2"]`,
		},
	}
}

// storageArgumentCases holds scenarios over how the storage argument is evaluated and what it holds.
func storageArgumentCases() []runCase {
	return []runCase{
		{
			name: "the storage argument is evaluated once, before any row, even when the body reassigns it",
			source: `export function scenario(): unknown {
    const a = register(createWorld(), Mover);
    const b = register(createWorld(), Mover);
    spawn(a, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(a, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(b, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(b, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(b, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    let current = a;
    let rows = 0;
    each(current, () => {
        current = b;
        rows += 1;
    });
    let calls = 0;
    const pick = (): typeof a => {
        calls += 1;
        return a;
    };
    each(pick(), () => {
        calls += 10;
    });
    return { rows, calls };
}
`,
			want: `{"rows":2,"calls":21}`,
		},
		{
			name: "an empty storage runs no row",
			source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    let rows = 0;
    each(movers, (e) => {
        rows += 1;
        e.Position.x = 1;
    });
    return { rows };
}
`,
			want: `{"rows":0}`,
		},
	}
}

// bodyEffectCases holds scenarios whose body throws or grows the storage.
func bodyEffectCases() []runCase {
	return []runCase{
		{
			name: "a throw from the body leaves the loop",
			source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    let rows = 0;
    try {
        each(movers, () => {
            rows += 1;
            if (rows === 2) {
                throw new RangeError("stop");
            }
        });
    } catch (error) {
        return { rows, thrown: error instanceof RangeError };
    }
    return { rows, thrown: false };
}
`,
			want: `{"rows":2,"thrown":true}`,
		},
		{
			name: "rows the body spawns are not visited",
			source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 0, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    let rows = 0;
    each(movers, () => {
        rows += 1;
        spawnMany(movers, 20);
    });
    return { rows };
}
`,
			want: `{"rows":2}`,
		},
	}
}

// namingCases holds scenarios over the names the rewrite reads and generates.
func namingCases() []runCase {
	return []runCase{
		{
			name: "generated names never shadow a name the body reads",
			source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    const ids = [spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 2, dy: 0 } })];
    const storage = "storage", n = 10, i = 20, entities = 30, x = 40, dx = 50;
    const seen: unknown[] = [];
    each(movers, (e) => {
        e.Position.x = e.Velocity.dx + n + i + entities + x + dx;
        seen.push(storage, get(movers, e.id, Position.x), get(movers, e.id, Velocity.dx));
    });
    return { seen, xs: ids.map((id) => get(movers, id, Position.x)) };
}
`,
			want: `{"seen":["storage",152,2],"xs":[152]}`,
		},
		{
			name: "two loops in one function over components sharing a field name keep every column apart",
			source: `export function scenario(): unknown {
    const sized = register(createWorld(), Sized);
    const ids = [
        spawn(sized, { Position: { x: 1, y: 0 }, Scale: { x: 10, y: 0 } }),
        spawn(sized, { Position: { x: 2, y: 0 }, Scale: { x: 20, y: 0 } }),
    ];
    const i = 100, x = 1000;
    each(sized, (e) => {
        e.Position.x = e.Position.x + e.Scale.x + i;
    });
    each(sized, (e) => {
        e.Scale.x = e.Scale.x + e.Position.x + x;
    });
    return ids.map((id) => [get(sized, id, Position.x), get(sized, id, Scale.x)]);
}
`,
			want: `[[111,1121],[122,1142]]`,
		},
	}
}

// callPositionCases holds scenarios over where the each call stands.
func callPositionCases() []runCase {
	return []runCase{
		{
			name: "a call that is the expression body of an arrow function runs on every call of the arrow",
			source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    const seen: unknown[] = [];
    const run = (): void => each(movers, (e) => {
        seen.push(e.Position.x);
    });
    seen.push(typeof run());
    run();
    return seen;
}
`,
			want: `[2,1,"undefined",2,1]`,
		},
		{
			name: "an indented call keeps the text of the multi-line literals in its body",
			source: `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } });
    const seen: string[] = [];
    if (movers.n > 0) {
        each(movers, (e) => {
            seen.push(` + "`x ${e.Position.x}\n  indented \"${'a\\\nb'}\" ${`\n`}\nend`" + `);
        });
    }
    return seen;
}
`,
			want: `["x 1\n  indented \"ab\" \n\nend"]`,
		},
	}
}

// loopFrameCases holds scenarios whose each call the rewrite must run as the runtime does.
func loopFrameCases() []runCase {
	return slices.Concat(fieldAccessCases(), storageArgumentCases(), bodyEffectCases(), namingCases(), callPositionCases())
}

// scenarioRun is one run of a case file: the name its t.Run takes, what its failure calls the run, the file it runs,
// and its NDEBUG setting.
type scenarioRun struct {
	name   string
	what   string
	rel    string
	ndebug bool
}

// scenarioRuns lists the runs of the ith case file under each NDEBUG setting in settings: on the runtime, then
// through its rewrite in each of modes.
func scenarioRuns(i int, modes []namedMode, settings []bool) []scenarioRun {
	runs := make([]scenarioRun, 0, len(settings)*(len(modes)+1))
	for _, ndebug := range settings {
		runs = append(runs, scenarioRun{name: fmt.Sprintf("runtime, NDEBUG %t", ndebug), what: "runtime", rel: caseFile(i), ndebug: ndebug})
		for _, m := range modes {
			name := fmt.Sprintf("%s, NDEBUG %t", m.name, ndebug)
			runs = append(runs, scenarioRun{name: name, what: "rewritten", rel: emittedFile(caseFile(i), m.name), ndebug: ndebug})
		}
	}
	return runs
}

// checkScenarios runs every case on the runtime and through its rewrite in every mode, once for each NDEBUG setting
// in settings, and fails each run whose result is not the case's want.
func checkScenarios(t *testing.T, cases []runCase, settings []bool) {
	t.Helper()
	checkScenariosIn(t, cases, allModes(), settings)
}

// checkScenariosIn runs every case on the runtime and through its rewrite in each of modes, once for each NDEBUG
// setting in settings, and fails each run whose result is not the case's want.
func checkScenariosIn(t *testing.T, cases []runCase, modes []namedMode, settings []bool) {
	t.Helper()
	sources := map[string]string{}
	for i, c := range cases {
		sources[caseFile(i)] = casePrelude + c.source
	}
	p := loadProject(t, sources)
	p.writeRewrites(t, len(cases), p.debugOf(t), modes)
	for i, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			for _, r := range scenarioRuns(i, modes, settings) {
				t.Run(r.name, func(t *testing.T) {
					t.Parallel()

					got := p.run(t, r.rel, r.ndebug)

					if got != tt.want {
						t.Errorf("%s scenario = %s, want %s", r.what, got, tt.want)
					}
				})
			}
		})
	}
}

func TestFile_Inline_RunsTheBodyAsTheRuntimeCallDoes(t *testing.T) {
	t.Parallel()

	checkScenarios(t, loopFrameCases(), []bool{false})
}

// growthSource writes every row's x after its first visited row has grown the storage past its capacity.
const growthSource = `export function scenario(): unknown {
    const movers = register(createWorld(), Mover);
    const ids = [
        spawn(movers, { Position: { x: 1, y: 0 }, Velocity: { dx: 0, dy: 0 } }),
        spawn(movers, { Position: { x: 2, y: 0 }, Velocity: { dx: 0, dy: 0 } }),
    ];
    each(movers, (e) => {
        if (e.Position.x === 2) {
            spawnMany(movers, 20);
        }
        e.Position.x = e.Position.x * 10;
    });
    return ids.map((id) => get(movers, id, Position.x));
}
`

func TestFile_Inline_WhenTheBodyGrowsTheStorage_WritesTheColumnsTheModeHolds(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		want string
		mode plan.Mode
	}{
		{name: "realloc-safe mode writes the columns growth put in place", mode: plan.ModeReallocSafe, want: "[10,20]"},
		{name: "hoisted mode writes the columns it read before the loop", mode: plan.ModeHoisted, want: "[1,2]"},
	}
	p := loadProject(t, map[string]string{caseFile(0): casePrelude + growthSource})
	debug := p.debugOf(t)
	for i, tt := range tests {
		rel := emittedFile(caseFile(0), fmt.Sprint(i))
		p.write(t, rel, p.rewrite(t, caseFile(0), debug, tt.mode).text)
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := p.run(t, rel, false)

			if got != tt.want {
				t.Errorf("rewritten scenario = %s, want %s", got, tt.want)
			}
		})
	}
}

// modeSource is a hazard-free body that reads two columns, the entity array, and the presence mask, and writes a
// column.
const modeSource = `const { storage } = guarded();
each(storage, (e) => {
    e.Position.x = e.Position.y + e.id;
    if (e.Shield) {
        e.Position.y = 1;
    }
});
`

func TestFile_Inline_ReadsTheStorageArraysAsTheModeSays(t *testing.T) {
	t.Parallel()
	hoists := []string{`\.x[,;]`, `\.y[,;]`, `\.entities[,;]`, `\.mask[,;]`}
	indexes := []string{`\.x\[`, `\.y\[`, `\.entities\[`, `\.mask\[`}
	tests := []struct {
		name string
		// before must match the text ahead of the row loop, and loop the loop itself; neither matches its Not list.
		before, beforeNot, loop, loopNot []string
		mode                             plan.Mode
	}{
		{
			name:    "hoisted mode reads each column, the entity array, and the mask into locals before the loop",
			mode:    plan.ModeHoisted,
			before:  hoists,
			loop:    []string{`\w+\[i\w*\] = \w+\[i\w*\] \+ \w+\[i\w*\]`},
			loopNot: indexes,
		},
		{
			name:      "realloc-safe mode reads every column, the entity array, and the mask through their owner on each access",
			mode:      plan.ModeReallocSafe,
			beforeNot: hoists,
			loop:      indexes,
		},
	}
	p := loadProject(t, map[string]string{caseFile(0): casePrelude + modeSource})
	debug := p.debugOf(t)
	// The rows run one at a time: they rewrite one program, whose checker is not safe for concurrent use.
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			text := p.rewrite(t, caseFile(0), debug, tt.mode).text

			before, loop, found := strings.Cut(text, printed.RowLoop)
			if !found {
				t.Fatalf("rewritten text has no %q:\n%s", printed.RowLoop, text)
			}
			ahead := outputPart{where: "before the loop", text: before}
			inside := outputPart{where: "in the loop", text: loop}
			assertMatches(t, ahead, tt.before, true)
			assertMatches(t, ahead, tt.beforeNot, false)
			assertMatches(t, inside, tt.loop, true)
			assertMatches(t, inside, tt.loopNot, false)
		})
	}
}

// namesSource declares the names a generated name could take, then runs two loops in one function over components
// that share a field name.
const namesSource = `export function scenario(): unknown {
    const sized = register(createWorld(), Sized);
    const storage = 1, n = 2, i = 3, x = 4, entities = 5;
    let total = storage + n + i + x + entities;
    each(sized, (e) => {
        total += e.Position.x + e.Scale.x + e.id;
    });
    each(sized, (e) => {
        e.Scale.x = e.Position.x;
    });
    return total;
}
`

func TestFile_Inline_PrintsGeneratedNamesThatCollideWithNoOtherName(t *testing.T) {
	t.Parallel()
	userNames := []string{"sized", "storage", "n", "i", "x", "entities", "total"}
	p := loadProject(t, map[string]string{caseFile(0): casePrelude + namesSource})
	debug := p.debugOf(t)
	// The rows run one at a time: they rewrite one program, whose checker is not safe for concurrent use.
	for _, m := range allModes() {
		t.Run(m.name, func(t *testing.T) {
			text := p.rewrite(t, caseFile(0), debug, m.mode).text

			if got := strings.Count(text, printed.RowLoop); got != 2 {
				t.Fatalf("rewritten text holds %d row loops, want 2:\n%s", got, text)
			}
			printed.AssertDeclaredOnce(t, text, userNames)
		})
	}
}

// outputPart is the text of one part of the rewritten output, with where naming the part.
type outputPart struct {
	where string
	text  string
}

// assertMatches fails t for each pattern whose match against the text of part is not want.
func assertMatches(t *testing.T, part outputPart, patterns []string, want bool) {
	t.Helper()
	for _, pattern := range patterns {
		if got := regexp.MustCompile(pattern).MatchString(part.text); got != want {
			t.Errorf("%s, /%s/ matches = %t, want %t:\n%s", part.where, pattern, got, want, part.text)
		}
	}
}

// guardSource casts an empty storage to a shape it does not have, in a file that declares the names the preamble
// would otherwise take.
const guardSource = `const ecstatic_internal = 0;
const DEBUG = false;
const shapeKey = "banana";

export function scenario(): unknown {
    const statues = register(createWorld(), Statue);
    const movers = statues as unknown as Storage<typeof Mover>;
    let rows = ecstatic_internal;
    try {
        each(movers, () => {
            rows += 1;
        });
    } catch (error) {
        return error instanceof Error ? error.message : "thrown";
    }
    return DEBUG ? shapeKey : "returned";
}
`

func TestFile_Inline_GuardsTheCompiledShapeBeforeAnyRow(t *testing.T) {
	t.Parallel()
	p := loadProject(t, map[string]string{caseFile(0): casePrelude + guardSource})
	out := p.rewrite(t, caseFile(0), p.debugOf(t), 0)
	rel := emittedFile(caseFile(0), "guarded")
	p.write(t, rel, out.text)
	tests := []struct {
		name   string
		prefix string
		ndebug bool
	}{
		{name: "with DEBUG on, an empty storage throws naming the compiled shape", prefix: "ecstatic: shape guard expected " + out.rewrites[0].Shape.Key() + ", got "},
		{name: "with NDEBUG set, an empty storage returns as the runtime does", ndebug: true, prefix: "returned"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			encoded := p.run(t, rel, tt.ndebug)

			var got string
			if err := json.Unmarshal([]byte(encoded), &got); err != nil {
				t.Fatalf("scenario result %s is not a JSON string: %v", encoded, err)
			}
			if !strings.HasPrefix(got, tt.prefix) {
				t.Errorf("rewritten scenario = %q, want prefix %q", got, tt.prefix)
			}
		})
	}
}

// preambleSource opens with a directive prologue and holds three each calls over two shapes, all rewritten.
const preambleSource = `"use strict";
import { createWorld, each, register } from "../../src/index.js";
import { Mover, Statue } from "../schema.js";
const movers = register(createWorld(), Mover);
const statues = register(createWorld(), Statue);
const others = register(createWorld(), Mover);
each(movers, (e) => {
    e.Position.x = 1;
});
each(statues, (e) => {
    e.Position.x = 2;
});
each(others, (e) => {
    e.Position.x = 3;
});
`

func TestFile_Inline_AddsTheFilePreambleOnce(t *testing.T) {
	t.Parallel()
	p := loadProject(t, map[string]string{caseFile(0): preambleSource})

	out := p.rewrite(t, caseFile(0), p.debugOf(t), 0)

	lines := strings.Split(out.text, "\n")
	if got := strings.Count(out.text, `from "ecstatic/internal"`); got != 1 {
		t.Errorf("imports of ecstatic/internal = %d, want 1:\n%s", got, out.text)
	}
	if got := len(slices.DeleteFunc(slices.Clone(lines), func(l string) bool { return !strings.Contains(l, "NDEBUG") })); got != 1 {
		t.Errorf("lines naming NDEBUG = %d, want 1, the one DEBUG copy:\n%s", got, out.text)
	}
	keyNames := map[string]string{}
	for _, k := range printed.ShapeKeys(out.text) {
		keyNames[k.Key] = k.Name
	}
	var wantGuards []string
	for _, inlining := range out.rewrites {
		wantGuards = append(wantGuards, keyNames[inlining.Shape.Key()])
	}
	gotGuards := printed.Guards(out.text)
	if len(keyNames) != 2 || slices.Contains(wantGuards, "") || !slices.Equal(gotGuards, wantGuards) {
		t.Errorf("shape-key constants %v guarded as %v, want one constant per distinct shape, guards %v:\n%s",
			keyNames, gotGuards, wantGuards, out.text)
	}
}

func TestFile_SourceFile_HoldsTheRewritePrintSplices(t *testing.T) {
	t.Parallel()
	p := loadProject(t, map[string]string{caseFile(0): preambleSource})
	out := p.rewrite(t, caseFile(0), p.debugOf(t), 0)
	spliced := parser.ParseSourceFile(ast.SourceFileParseOptions{FileName: filepath.ToSlash(filepath.Join(p.dir, "spliced.ts"))},
		out.text, core.ScriptKindTS)

	reprinted := printer.EmitSourceFile(printer.NewPrinter(printer.PrinterOptions{}, printer.PrintHandlers{}, nil), spliced)

	if reprinted != out.whole {
		t.Errorf("Print() text reprinted =\n%s\nwant SourceFile() printed whole =\n%s", reprinted, out.whole)
	}
}

func TestFile_Inline_CopiesTheDebugInitializerOfTheRuntimeRoot(t *testing.T) {
	t.Parallel()
	root := project.Write(t, map[string]string{"src/debug.ts": `declare const NDEBUG: unknown;

/** Whether the checks run. */
export const DEBUG: boolean = typeof NDEBUG !== "string";
`})
	debug, err := emit.LoadDebug(root)
	if err != nil {
		t.Fatalf("LoadDebug(%s) error = %v, want nil", root, err)
	}
	p := loadProject(t, map[string]string{caseFile(0): preambleSource})

	out := p.rewrite(t, caseFile(0), debug, 0)

	copyLine := regexp.MustCompile(`(?m)^const DEBUG\w* = typeof NDEBUG !== "string";$`)
	if !copyLine.MatchString(out.text) {
		t.Errorf("rewritten text has no line matching /%s/:\n%s", copyLine, out.text)
	}
}

// committedPanic is what Inline panics with when inlinePanicking makes it fail.
const committedPanic = "banana split"

// inlineSkipping emits every planned inlining except those at the indexes of skipped, in plan order.
func inlineSkipping(skipped ...int) inliner {
	index := -1
	return func(out *emit.File, inlining plan.EachInlining, uses []facts.ViewUse) {
		index++
		if !slices.Contains(skipped, index) {
			out.Inline(inlining, uses)
		}
	}
}

// inlinePanicking emits every planned inlining, except that Inline panics on those at the indexes of failing, in
// plan order, once their loop is built and before the file records it. It recovers each panic, failing t unless Inline
// propagated it.
func inlinePanicking(t *testing.T, failing ...int) inliner {
	index := -1
	return func(out *emit.File, inlining plan.EachInlining, uses []facts.ViewUse) {
		index++
		if !slices.Contains(failing, index) {
			out.Inline(inlining, uses)
			return
		}
		out.SetBeforeCommit(func(plan.EachInlining) { panic(committedPanic) })
		defer out.SetBeforeCommit(nil)
		defer func() {
			if recovered := recover(); recovered != committedPanic {
				t.Errorf("Inline(inlining %d) recovered %v, want the panic %q", index, recovered, committedPanic)
			}
		}()
		out.Inline(inlining, uses)
	}
}

func TestFile_Inline_WhenItPanicsOnceTheLoopIsBuilt_LeavesTheFileAsItWas(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		failing []int
	}{
		{name: "the first site, whose loop allocated the preamble names", failing: []int{0}},
		{name: "the one site of its shape, whose loop added its shape key", failing: []int{1}},
		{name: "every site, so no loop is left to need the preamble", failing: []int{0, 1, 2}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			p := loadProject(t, map[string]string{caseFile(0): preambleSource})
			debug := p.debugOf(t)
			want := p.rewriteWith(t, caseFile(0), debug, inlineSkipping(tt.failing...))

			got := p.rewriteWith(t, caseFile(0), debug, inlinePanicking(t, tt.failing...))

			if got.text != want.text {
				t.Errorf("Print() text =\n%s\nwant the text without the failed sites =\n%s", got.text, want.text)
			}
			if got.whole != want.whole {
				t.Errorf("SourceFile() printed =\n%s\nwant the file without the failed sites =\n%s", got.whole, want.whole)
			}
			if !slices.Equal(got.applied, want.applied) {
				t.Errorf("Applied() = %q, want %q, the rules of the other sites alone", got.applied, want.applied)
			}
		})
	}
}
