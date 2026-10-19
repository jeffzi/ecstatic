package ttscadapter_test

import (
	"errors"
	"maps"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/jeffzi/ecstatic/optimizer/internal/analysis"
	"github.com/jeffzi/ecstatic/optimizer/internal/emit"
	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
	"github.com/jeffzi/ecstatic/optimizer/internal/position"
	"github.com/jeffzi/ecstatic/optimizer/internal/printed"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
	"github.com/jeffzi/ecstatic/optimizer/internal/ttscadapter"
)

// panicking analyzes like analyzeProgram, except that analyzing the file named target panics with value.
func panicking(target string, value any) analyzer {
	return func(prog *driver.Program, file *ast.SourceFile, roots *analysis.PackageRoots) []facts.Site {
		if file.FileName() == target {
			panic(value)
		}
		return analyzeProgram(prog, file, roots)
	}
}

// panicDetail is what the panicking analyzer panics with.
const panicDetail = "banana split"

// internalSighting is one INTERNAL report of a call: where it is and what it says.
type internalSighting struct {
	message string
	line    int
	column  int
}

// internalStderrLine is the grammar of the stderr line a non-strict run writes for an INTERNAL report.
var internalStderrLine = regexp.MustCompile(`^.+:(\d+):(\d+): (.+)$`)

// internalReports is every INTERNAL report of got: its diagnostics under strict, its stderr lines otherwise. It fails
// t when the other channel carries one too: under strict no INTERNAL line reaches stderr, and without strict no
// INTERNAL report is a diagnostic.
func internalReports(t *testing.T, got result, strict bool) []internalSighting {
	t.Helper()
	diagnosed, written := internalDiagnostics(t, got), internalLines(t, got)
	reports, other, otherChannel := written, diagnosed, "diagnostics"
	if strict {
		reports, other, otherChannel = diagnosed, written, "stderr lines"
	}
	if len(other) > 0 {
		t.Errorf("INTERNAL %s = %+v, want none when strict is %t", otherChannel, other, strict)
	}
	return reports
}

// internalDiagnostics is every INTERNAL diagnostic of the envelope got wrote.
func internalDiagnostics(t *testing.T, got result) []internalSighting {
	t.Helper()
	var reports []internalSighting
	for _, d := range decodeEnvelope(t, got.stdout).Diagnostics {
		if d.Code == facts.ReasonInternal.Info().Code {
			reports = append(reports, internalSighting{message: d.MessageText, line: d.Line, column: d.Character})
		}
	}
	return reports
}

// internalLines is every INTERNAL line got wrote to stderr, failing t on a line of any other grammar.
func internalLines(t *testing.T, got result) []internalSighting {
	t.Helper()
	var reports []internalSighting
	for line := range strings.Lines(got.stderr) {
		m := internalStderrLine.FindStringSubmatch(strings.TrimRight(line, "\n"))
		if m == nil {
			t.Fatalf("stderr line %q, want file:line:column: message", line)
		}
		reports = append(reports, internalSighting{message: m[3], line: atoi(t, m[1]), column: atoi(t, m[2])})
	}
	return reports
}

// assertInternalReports fails t unless got reports INTERNAL at exactly the calls at want, in order, each with a
// message message matches.
func assertInternalReports(t *testing.T, got []internalSighting, want []facts.Position, message *regexp.Regexp) {
	t.Helper()
	var wantReports []internalSighting
	for _, pos := range want {
		wantReports = append(wantReports, internalSighting{line: pos.Line, column: pos.Column})
	}
	ignoreMessage := cmpopts.IgnoreFields(internalSighting{}, "message")
	if diff := cmp.Diff(wantReports, got, cmp.AllowUnexported(internalSighting{}), ignoreMessage); diff != "" {
		t.Errorf("INTERNAL reports mismatch (-want +got):\n%s", diff)
	}
	for _, r := range got {
		if !message.MatchString(r.message) {
			t.Errorf("INTERNAL report at %d:%d = %q, want it to match /%s/", r.line, r.column, r.message, message)
		}
	}
}

// internalMessage matches the message of a call's INTERNAL report, ending with suffix and hint, whose detail
// matches detail.
func internalMessage(suffix, hint, detail string) *regexp.Regexp {
	const hole = "\x00"
	before, after, _ := strings.Cut(callMessage("each", internalText(hole), suffix, hint), hole)
	return regexp.MustCompile("^" + regexp.QuoteMeta(before) + detail + regexp.QuoteMeta(after) + "$")
}

// internalMode is a run of the plugin under one strict setting, with the status it exits with and the message
// ending its INTERNAL reports carry.
type internalMode struct {
	name    string
	plugins string
	suffix  string
	hint    string
	status  int
	strict  bool
}

// internalModes lists a strict run, which reports INTERNAL as an error diagnostic, and a non-strict run, which
// writes one stderr line per report.
func internalModes() []internalMode {
	return []internalMode{
		{
			name: "strict", plugins: strictPlugins, suffix: strictMode, hint: facts.ReasonInternal.Info().Hint,
			status: statusDiagnostics, strict: true,
		},
		{name: "without strict", plugins: lenientPlugins, status: statusOK},
	}
}

// errResolve is what the failing resolver of the debug copy tests fails with.
var errResolve = errors.New("banana peel")

// debugCopyFailure is a way the DEBUG copy of the main project cannot be taken: an edit to its files, or a resolver
// of the physical path of its src/debug.ts that fails, with the detail its INTERNAL reports carry.
type debugCopyFailure struct {
	edit    func(files map[string]string)
	resolve func(path string) (string, error)
	name    string
	detail  string
}

// debugCopyFailures lists src/debug.ts failing to load and failing to resolve after it was read.
func debugCopyFailures() []debugCopyFailure {
	return []debugCopyFailure{
		{
			name: "src/debug.ts missing", edit: func(files map[string]string) { delete(files, debugFile) },
			detail: `read the DEBUG gate: .*debug\.ts.*`,
		},
		{
			name:    "src/debug.ts unresolvable after its read",
			resolve: func(string) (string, error) { return "", errResolve },
			detail:  `resolve .*debug\.ts: ` + regexp.QuoteMeta(errResolve.Error()),
		},
	}
}

func TestRun_WhenTheDebugCopyCannotBeTaken_KeepsEveryCallAndReportsInternalAtEachRewrite(t *testing.T) {
	t.Parallel()
	for _, failure := range debugCopyFailures() {
		for _, mode := range internalModes() {
			t.Run(failure.name+", "+mode.name, func(t *testing.T) {
				t.Parallel()
				files := mainProject(t)
				if failure.edit != nil {
					failure.edit(files)
				}
				dir := project.Write(t, files)
				want := []facts.Position{callPos(t, dir, moversCall), callPos(t, dir, statuesCall)}
				argv := sidecarArgv("transform", dir, mode.plugins)

				got := runResolving(argv, failure.resolve)

				requireStatus(t, "transform", got, mode.status)
				if text := decodeEnvelope(t, got.stdout).TypeScript[mainFile]; text != mainSource {
					t.Errorf("typescript[%s] = %q, want its original text", mainFile, text)
				}
				message := internalMessage(mode.suffix, mode.hint, failure.detail)
				assertInternalReports(t, internalReports(t, got, mode.strict), want, message)
			})
		}
	}
}

// panickingAt emits each planned rewrite as Run does, except that emitting the rewrite of the call at target
// panics with value.
func panickingAt(target facts.Position, value any) ttscadapter.Inliner {
	return func(file *emit.File, rewrite plan.EachInlining, uses []facts.ViewUse) {
		if rewrite.Pos == target {
			panic(value)
		}
		file.Inline(rewrite, uses)
	}
}

func TestRun_WhenEmittingOneSitePanics_KeepsItsCallAndRewritesTheOtherSites(t *testing.T) {
	t.Parallel()
	for _, mode := range internalModes() {
		t.Run(mode.name, func(t *testing.T) {
			t.Parallel()
			dir := writeMainProject(t)
			target := callPos(t, dir, moversCall)
			argv := sidecarArgv("transform", dir, mode.plugins)
			inline := panickingAt(target, errors.New(panicDetail))

			got := runInlining(argv, inline)

			requireStatus(t, "transform", got, mode.status)
			assertCalls(t, decodeEnvelope(t, got.stdout).TypeScript[mainFile], []string{moversCall, asyncCall}, []string{statuesCall})
			message := internalMessage(mode.suffix, mode.hint, regexp.QuoteMeta(panicDetail))
			assertInternalReports(t, internalReports(t, got, mode.strict), []facts.Position{target}, message)
		})
	}
}

// twoShapesAt analyzes like analyzeProgram, except that the site of the call at target holds its shape twice, which
// planning the site panics on: an eligible each site holds exactly one shape.
func twoShapesAt(target facts.Position) analyzer {
	return func(prog *driver.Program, file *ast.SourceFile, roots *analysis.PackageRoots) []facts.Site {
		sites := analyzeProgram(prog, file, roots)
		for i := range sites {
			if sites[i].Pos == target {
				sites[i].Shapes = append(sites[i].Shapes, sites[i].Shapes...)
			}
		}
		return sites
	}
}

func TestRun_WhenPlanningOneSitePanics_KeepsItsCallAndRewritesTheOtherSites(t *testing.T) {
	t.Parallel()
	for _, mode := range internalModes() {
		t.Run(mode.name, func(t *testing.T) {
			t.Parallel()
			dir := writeMainProject(t)
			target := callPos(t, dir, moversCall)

			got := runArgv(sidecarArgv("transform", dir, mode.plugins), twoShapesAt(target))

			requireStatus(t, "transform", got, mode.status)
			assertCalls(t, decodeEnvelope(t, got.stdout).TypeScript[mainFile], []string{moversCall, asyncCall}, []string{statuesCall})
			message := internalMessage(mode.suffix, mode.hint, ".*shapes.*")
			assertInternalReports(t, internalReports(t, got, mode.strict), []facts.Position{target}, message)
		})
	}
}

// vendorRoot is the second ecstatic package root of twoRootsProject, beside the project's own.
const vendorRoot = "vendor/ecstatic"

// twoRootsPrelude imports and declares a storage over the project's runtime and one over the runtime copied under
// vendorRoot.
const twoRootsPrelude = `import { archetype, component, each, type Storage } from "../src/index.js";
import {
	archetype as vendorArchetype,
	component as vendorComponent,
	each as vendorEach,
	type Storage as VendorStorage,
} from "../vendor/ecstatic/src/index.js";

const Spot = component("Spot", { x: 0 });
const Marker = archetype([Spot]);
declare const markers: Storage<typeof Marker>;
const Pin = vendorComponent("Pin", { y: 0 });
const Flag = vendorArchetype([Pin]);
declare const flags: VendorStorage<typeof Flag>;

`

// The each statements of a twoRootsProject file: over the project's runtime, and over the runtime under vendorRoot.
const (
	markersEach = "each(markers, (e) => {\n\te.Spot.x += 1;\n});\n"
	flagsEach   = "vendorEach(flags, (e) => {\n\te.Pin.y += 1;\n});\n"
)

const (
	markersCall = "each(markers"
	flagsCall   = "vendorEach(flags"
)

// vendorDebugMark ends the src/debug.ts of the runtime under vendorRoot, so its text differs from the project's own.
const vendorDebugMark = "// The vendored copy.\n"

// twoRootsProject is the runtime project with app/main.ts set to source and a copy of the runtime, its package.json
// included, under vendorRoot, whose src/debug.ts ends with vendorDebugMark.
func twoRootsProject(t *testing.T, source string) map[string]string {
	t.Helper()
	files := project.Runtime(t, map[string]string{mainFile: source})
	for rel, text := range maps.Clone(files) {
		if strings.HasPrefix(rel, "src/") || rel == "package.json" {
			files[vendorRoot+"/"+rel] = text
		}
	}
	files[vendorRoot+"/"+debugFile] += vendorDebugMark
	return files
}

// twoRootsCase is a twoRootsProject file whose first rewrite resolves to the package root at the slash-separated
// copied, relative to the project ("" for the project's own), with the call it rewrites and the call it keeps.
type twoRootsCase struct {
	name      string
	source    string
	rewritten string
	kept      string
	copied    string
	other     string
}

// twoRootsCases lists a twoRootsProject file whose first rewrite is the project's own call, then one whose first is the
// vendored call.
func twoRootsCases() []twoRootsCase {
	return []twoRootsCase{
		{
			name: "the project's call first", source: twoRootsPrelude + markersEach + flagsEach,
			rewritten: markersCall, kept: flagsCall, copied: "", other: vendorRoot,
		},
		{
			name: "the vendored call first", source: twoRootsPrelude + flagsEach + markersEach,
			rewritten: flagsCall, kept: markersCall, copied: vendorRoot, other: "",
		},
	}
}

func TestRun_WhenASiteResolvesToAnotherPackageRoot_KeepsItsCallAndRewritesTheOtherSites(t *testing.T) {
	t.Parallel()
	for _, tt := range twoRootsCases() {
		for _, mode := range internalModes() {
			t.Run(tt.name+", "+mode.name, func(t *testing.T) {
				t.Parallel()
				files := twoRootsProject(t, tt.source)
				dir := project.Write(t, files)
				copiedRoot, otherRoot := filepath.Join(dir, filepath.FromSlash(tt.copied)), filepath.Join(dir, filepath.FromSlash(tt.other))
				keptPos := position.Of(absolute(dir, mainFile), tt.source, position.Occurrence(t, tt.source, tt.kept, 0))
				message := internalMessage(mode.suffix, mode.hint, regexp.QuoteMeta("the call resolves to the ecstatic package root "+
					otherRoot+", not "+copiedRoot+", which the file's DEBUG copy comes from"))
				copiedDebug := filepath.ToSlash(filepath.Join(tt.copied, debugFile))

				got := runTransform(dir, mode.plugins)

				requireStatus(t, "transform", got, mode.status)
				env := decodeEnvelope(t, got.stdout)
				text := env.TypeScript[mainFile]
				if !strings.Contains(text, printed.RowLoop) || strings.Contains(text, tt.rewritten) {
					t.Errorf("typescript[%s] = %q, want the call %q inlined", mainFile, text, tt.rewritten)
				}
				if !strings.Contains(text, tt.kept) {
					t.Errorf("typescript[%s] = %q, want it to keep the call %q", mainFile, text, tt.kept)
				}
				assertHostInputs(t, env, map[string]string{filepath.Join(copiedRoot, filepath.FromSlash(debugFile)): files[copiedDebug]})
				assertInternalReports(t, internalReports(t, got, mode.strict), []facts.Position{keptPos}, message)
			})
		}
	}
}

// fileInternalMessage is the INTERNAL report for the file at path whose analysis panicked, ending with suffix.
func fileInternalMessage(path, suffix string) string {
	return withHint("ecstatic: "+path+" could not be analyzed ("+internalText(panicDetail)+"). "+
		"Its calls compile to the runtime calls"+suffix+".", facts.ReasonInternal.Info().Hint)
}

// assertComponentsKeptAndMainReported fails t unless app/components.ts kept its text and app/main.ts was still
// analyzed and reported.
func assertComponentsKeptAndMainReported(t *testing.T, dir string, env envelope) {
	t.Helper()
	if env.TypeScript[componentsFile] != componentsSource {
		t.Errorf("typescript[%s] = %q, want its original text", componentsFile, env.TypeScript[componentsFile])
	}
	mainPath := absolute(dir, mainFile)
	if !slices.ContainsFunc(env.Diagnostics, func(d ttscadapter.Diagnostic) bool { return d.File == mainPath }) {
		t.Errorf("diagnostics = %+v, want app/main.ts still analyzed and reported", env.Diagnostics)
	}
}

// diagnosticsIn is the diagnostics of diagnostics whose file is path, in order.
func diagnosticsIn(diagnostics []ttscadapter.Diagnostic, path string) []ttscadapter.Diagnostic {
	var inFile []ttscadapter.Diagnostic
	for _, d := range diagnostics {
		if d.File == path {
			inFile = append(inFile, d)
		}
	}
	return inFile
}

// fileInternalReport is how a run in mode reports the INTERNAL bail of the file at path whose analysis panicked: the
// diagnostics it reports for the file and what it writes to stderr.
func fileInternalReport(path string, mode internalMode) ([]ttscadapter.Diagnostic, string) {
	message := fileInternalMessage(path, mode.suffix)
	if !mode.strict {
		return nil, message + "\n"
	}
	return []ttscadapter.Diagnostic{{
		File: path, Category: categoryError, Code: facts.ReasonInternal.Info().Code, MessageText: message,
	}}, ""
}

func TestRun_WhenAnalyzingAFilePanics_ReportsInternalForTheUnchangedFile(t *testing.T) {
	t.Parallel()
	ignorePosition := cmpopts.IgnoreFields(ttscadapter.Diagnostic{}, "Start", "Line", "Character")
	for _, mode := range internalModes() {
		t.Run(mode.name, func(t *testing.T) {
			t.Parallel()
			dir := writeMainProject(t)
			componentsPath := absolute(dir, componentsFile)
			wantDiagnostics, wantStderr := fileInternalReport(componentsPath, mode)

			got := runArgv(sidecarArgv("transform", dir, mode.plugins), panicking(componentsPath, errors.New(panicDetail)))

			requireStatus(t, "transform", got, mode.status)
			env := decodeEnvelope(t, got.stdout)
			assertComponentsKeptAndMainReported(t, dir, env)
			internal := diagnosticsIn(env.Diagnostics, componentsPath)
			if diff := cmp.Diff(wantDiagnostics, internal, ignorePosition, cmpopts.EquateEmpty()); diff != "" {
				t.Errorf("diagnostics for app/components.ts mismatch (-want +got):\n%s", diff)
			}
			if got.stderr != wantStderr {
				t.Errorf("stderr = %q, want %q", got.stderr, wantStderr)
			}
		})
	}
}
