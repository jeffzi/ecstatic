package ttscadapter_test

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/jeffzi/ecstatic/optimizer/internal/analysis"
	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/position"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
	"github.com/jeffzi/ecstatic/optimizer/internal/ttscadapter"
	"github.com/jeffzi/ecstatic/optimizer/internal/version"
)

// ---------------------------------------------------------------------------
// Shared fixtures and helpers
// ---------------------------------------------------------------------------

const (
	componentsFile = "app/components.ts"
	healthFile     = "app/health.ts"
	mainFile       = "app/main.ts"
)

const componentsSource = `import { component } from "../src/index.js";

export const Position = component("Position", { x: 0, y: 0 });
export const Velocity = component("Velocity", { dx: 0, dy: 0 });
`

const healthSource = `import { component } from "../src/index.js";

export const Health = component("Health", { hp: 0 });
`

// mainSource calls each over two storages whose shapes consult different files, and once with an async callback.
const mainSource = `import { archetype, each, type Storage } from "../src/index.js";
import { Position, Velocity } from "./components.js";
import { Health } from "./health.js";

const Mover = archetype([Position, Velocity]);
const Statue = archetype([Position, Health]);
declare const movers: Storage<typeof Mover>;
declare const statues: Storage<typeof Statue>;

each(movers, (e) => {
	e.Position.x += e.Velocity.dx;
});
each(statues, (e) => {
	e.Health.hp = 0;
});
each(movers, async (e) => {
	e.Position.y += e.Velocity.dy;
});
`

// asyncCall is the each call in mainSource that the async callback bails.
const asyncCall = "each(movers, async"

// noPlugins is a --plugins-json array with no plugin entry.
const noPlugins = "[]"

// mainProject is the runtime project with app/main.ts and the component files it imports.
func mainProject(t *testing.T) map[string]string {
	t.Helper()
	return project.Runtime(t, map[string]string{
		componentsFile: componentsSource,
		healthFile:     healthSource,
		mainFile:       mainSource,
	})
}

// writeMainProject writes mainProject to a new temporary directory and returns its resolved path.
func writeMainProject(t *testing.T) string {
	t.Helper()
	return project.Write(t, mainProject(t))
}

// absolute is the compiler's spelling of the slash-separated rel under dir.
func absolute(dir, rel string) string {
	return filepath.ToSlash(filepath.Join(dir, filepath.FromSlash(rel)))
}

// asyncCallPos is the position of the async each call in mainSource, in the main project at dir.
func asyncCallPos(t *testing.T, dir string) facts.Position {
	t.Helper()
	return position.Of(absolute(dir, mainFile), mainSource, position.Occurrence(t, mainSource, asyncCall, 0))
}

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

// diagnosticTail is the category code: message tail both diagnostic line grammars end with.
const diagnosticTail = `(error|warning|suggestion|message)\s+(?:TS)?(\d+):\s+(.+)$`

// fileDiagnosticLine is ttsc's grammar for a diagnostic line with a position: file:line:column - category code: message.
var fileDiagnosticLine = regexp.MustCompile(`^(.+):(\d+):(\d+)\s+-\s+` + diagnosticTail)

// globalDiagnosticLine is ttsc's grammar for a diagnostic line without a position: category code: message.
var globalDiagnosticLine = regexp.MustCompile(`^` + diagnosticTail)

// ansiEscape matches the terminal color sequences ttsc strips before parsing.
var ansiEscape = regexp.MustCompile("\x1b\\[[0-9;]*[A-Za-z]")

func runSidecar(argv []string) result {
	return captured(func(stdout, stderr io.Writer) int { return ttscadapter.Run(argv, stdout, stderr) })
}

// requireStatus fails the test now unless Run(subcommand) exited with want.
func requireStatus(t *testing.T, subcommand string, got result, want int) {
	t.Helper()
	if got.status != want {
		t.Fatalf("Run(%s) = %d, want %d; stderr = %q", subcommand, got.status, want, got.stderr)
	}
}

// atoi is the decimal number s, which the diagnostic grammar has already matched as digits.
func atoi(t *testing.T, s string) int {
	t.Helper()
	n, err := strconv.Atoi(s)
	if err != nil {
		t.Fatalf("strconv.Atoi(%q) error = %v, want nil", s, err)
	}
	return n
}

// parseDiagnosticLine is the diagnostic ttsc reads from line, with a relative file resolved against dir.
func parseDiagnosticLine(t *testing.T, dir, line string) (ttscadapter.Diagnostic, bool) {
	t.Helper()
	if m := fileDiagnosticLine.FindStringSubmatch(line); m != nil {
		file := m[1]
		if !filepath.IsAbs(file) {
			file = absolute(dir, file)
		}
		return ttscadapter.Diagnostic{
			File: file, Line: atoi(t, m[2]), Character: atoi(t, m[3]), Category: m[4], Code: atoi(t, m[5]),
			MessageText: m[6],
		}, true
	}
	if m := globalDiagnosticLine.FindStringSubmatch(line); m != nil {
		return ttscadapter.Diagnostic{Category: m[1], Code: atoi(t, m[2]), MessageText: m[3]}, true
	}
	return ttscadapter.Diagnostic{}, false
}

// reported is the diagnostics ttsc parses from a sidecar's stderr, each message cut to its first line.
func reported(t *testing.T, dir, stderr string) []ttscadapter.Diagnostic {
	t.Helper()
	var diagnostics []ttscadapter.Diagnostic
	for line := range strings.Lines(ansiEscape.ReplaceAllString(stderr, "")) {
		if d, ok := parseDiagnosticLine(t, dir, strings.TrimRight(line, "\r\n")); ok {
			diagnostics = append(diagnostics, d)
		}
	}
	return diagnostics
}

const (
	fruitSource = "export const banana = 1;\n"
	splitSource = "import { banana } from \"./fruit.js\";\nexport const split = banana + 1;\n"
)

// codeNotAssignable is reported for the string-to-number assignment in brokenSource.
const codeNotAssignable = 2322

// failsFirstWrite fails its first write and accepts every later one, so a caller that ignores the failure goes on
// writing.
type failsFirstWrite struct {
	writes int
}

func (w *failsFirstWrite) Write(p []byte) (int, error) {
	w.writes++
	if w.writes == 1 {
		return 0, errWrite
	}
	return len(p), nil
}

// assertRejected fails t unless got is a diagnostics exit that wrote nothing to stdout.
func assertRejected(t *testing.T, argv []string, got result) {
	t.Helper()
	if got.status != statusDiagnostics {
		t.Errorf("Run(%q) = %d, want %d", argv, got.status, statusDiagnostics)
	}
	if got.stdout != "" {
		t.Errorf("stdout = %q, want empty", got.stdout)
	}
}

// assertUsage fails t unless stderr is the error line wantError followed by usage text that begins
// with the usage line and names every subcommand and every flag.
func assertUsage(t *testing.T, stderr, wantError string) {
	t.Helper()
	const usageLine = "usage: ecstatic-optimizer <subcommand> [flags]\n"
	errorLine, usageText, _ := strings.Cut(stderr, "\n\n")
	if errorLine != wantError {
		t.Errorf("error line = %q, want %q", errorLine, wantError)
	}
	if !strings.HasPrefix(usageText, usageLine) {
		t.Errorf("usage text = %q, want it to begin with %q", usageText, usageLine)
	}
	assertStderrContains(t, usageText,
		"transform", "check", "build", "version",
		"--cwd", "--tsconfig", "--plugins-json", "--outDir", "--emit",
	)
}

// assertStderrContains fails t for each fragment that stderr does not contain.
func assertStderrContains(t *testing.T, stderr string, fragments ...string) {
	t.Helper()
	for _, fragment := range fragments {
		if !strings.Contains(stderr, fragment) {
			t.Errorf("stderr = %q, want it to contain %q", stderr, fragment)
		}
	}
}

// checkOutcome is what a check is expected to do: the diagnostics it reports on stderr and the status it exits with.
type checkOutcome struct {
	diagnostics []ttscadapter.Diagnostic
	status      int
}

// assertCheckReported fails t unless a check exited with want.status and reported exactly want.diagnostics on stderr.
func assertCheckReported(t *testing.T, dir string, got result, want checkOutcome) {
	t.Helper()
	if got.status != want.status {
		t.Errorf("Run(check) = %d, want %d; stderr = %q", got.status, want.status, got.stderr)
	}
	if diff := cmp.Diff(want.diagnostics, reported(t, dir, got.stderr)); diff != "" {
		t.Errorf("reported diagnostics mismatch (-want +got):\n%s\nstderr = %q", diff, got.stderr)
	}
}

// loadFailure is what stderr says when the Program for tsconfig.json fails to load.
const loadFailure = "cannot load the program for tsconfig.json"

// ---------------------------------------------------------------------------
// Run and usage
// ---------------------------------------------------------------------------

func TestRun_WhenVersion_PrintsTheVersion(t *testing.T) {
	t.Parallel()

	got := runSidecar([]string{"version"})

	if got.status != statusOK {
		t.Errorf("Run(version) = %d, want %d", got.status, statusOK)
	}
	if want := version.Version + "\n"; got.stdout != want {
		t.Errorf("stdout = %q, want %q", got.stdout, want)
	}
	if got.stderr != "" {
		t.Errorf("stderr = %q, want empty", got.stderr)
	}
}

func TestRun_WhenNoArguments_ExitsTwoWithUsage(t *testing.T) {
	t.Parallel()
	const wantError = "ecstatic: usage error: missing subcommand; want one of transform, check, build, version"

	got := runSidecar(nil)

	assertRejected(t, nil, got)
	assertUsage(t, got.stderr, wantError)
}

func TestRun_WhenOptionsInvalid_ExitsTwoWithUsageBeforeLoading(t *testing.T) {
	t.Parallel()
	pluginsJSON := `[{"config":{"transform":"ecstatic/optimizer","speed":true},"name":"ecstatic"}]`
	const wantError = `ecstatic: usage error: unknown ecstatic/optimizer option "speed"; valid keys: ` + validKeys
	argv := sidecarArgv("transform", t.TempDir(), pluginsJSON)

	got := runSidecar(argv)

	assertRejected(t, argv, got)
	assertUsage(t, got.stderr, wantError)
}

func TestReportFailure_WhenDiagnosticsFailedAlongsideAnotherFailure_ReportsTheOtherWithItsStatus(t *testing.T) {
	t.Parallel()
	closeFailed := errors.New("banana")
	closeWriteFailed := fmt.Errorf("close output: %w", ttscadapter.ErrIO)
	tests := []struct {
		joined     error
		name       string
		wantStderr string
		wantStatus int
	}{
		{
			name:       "close failure",
			joined:     errors.Join(ttscadapter.ErrReported, closeFailed),
			wantStderr: "ecstatic: banana\n",
			wantStatus: statusFailure,
		},
		{
			name:       "close write failure",
			joined:     errors.Join(ttscadapter.ErrReported, closeWriteFailed),
			wantStderr: "ecstatic: close output: write failed\n",
			wantStatus: statusIO,
		},
		{
			name:       "close failure around a nested diagnostics error",
			joined:     errors.Join(errors.Join(ttscadapter.ErrReported, nil), closeFailed),
			wantStderr: "ecstatic: banana\n",
			wantStatus: statusFailure,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var stderr bytes.Buffer

			status := ttscadapter.ReportFailure(tt.joined, &stderr)

			if status != tt.wantStatus {
				t.Errorf("ReportFailure(%v) = %d, want %d", tt.joined, status, tt.wantStatus)
			}
			if stderr.String() != tt.wantStderr {
				t.Errorf("ReportFailure(%v) stderr = %q, want %q", tt.joined, stderr.String(), tt.wantStderr)
			}
		})
	}
}

func TestRun_WhenCwdIsOmitted_ReportsUnderTheAbsolutePathOfTheWorkingDirectory(t *testing.T) {
	dir := writeMainProject(t)
	t.Chdir(dir)
	argv := []string{"transform", "--tsconfig=tsconfig.json", "--plugins-json=" + lenientPlugins}
	want := []ttscadapter.Diagnostic{diagnosticAt(asyncCallPos(t, dir), asyncWarningReport())}

	got := runSidecar(argv)

	requireStatus(t, "transform", got, statusOK)
	if diff := cmp.Diff(want, decodeEnvelope(t, got.stdout).Diagnostics); diff != "" {
		t.Errorf("diagnostics mismatch (-want +got):\n%s", diff)
	}
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

// brokenSource assigns a string to a number, a TypeScript error at line 1, column 14.
const brokenSource = "export const count: number = \"banana\";\n"

// typeErrorMessage is TypeScript's message for the error in brokenSource.
const typeErrorMessage = "Type 'string' is not assignable to type 'number'."

func assertAbsent(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !errors.Is(err, fs.ErrNotExist) {
		t.Errorf("os.Stat(%q) error = %v, want it not to exist", path, err)
	}
}

// reportedAsyncAt is the diagnostic ttsc parses from stderr for the async each call in mainSource reporting r, in
// the main project at dir.
func reportedAsyncAt(t *testing.T, dir string, r report) ttscadapter.Diagnostic {
	t.Helper()
	d := diagnosticAt(asyncCallPos(t, dir), r)
	// A stderr diagnostic line carries no offset.
	d.Start = 0
	return d
}

// checkCase is a check over mainProject with files added or replaced, and the outcome it is expected to have.
type checkCase struct {
	files   map[string]string
	want    func(t *testing.T, dir string) checkOutcome
	name    string
	plugins string
}

// checkCases covers a type error, a lenient warning on an emitting tsconfig, and a strict error.
func checkCases() []checkCase {
	return []checkCase{
		{
			name:    "type error is reported before the plugin diagnostics",
			files:   map[string]string{"app/broken.ts": brokenSource},
			plugins: lenientPlugins,
			want: func(t *testing.T, dir string) checkOutcome {
				t.Helper()
				typeError := ttscadapter.Diagnostic{
					File: absolute(dir, "app/broken.ts"), Category: categoryError, Code: codeNotAssignable, Line: 1,
					Character: 14, MessageText: typeErrorMessage,
				}
				return checkOutcome{
					status:      statusDiagnostics,
					diagnostics: []ttscadapter.Diagnostic{typeError, reportedAsyncAt(t, dir, asyncWarningReport())},
				}
			},
		},
		{
			name: "only a plugin warning on an emitting tsconfig passes",
			files: map[string]string{
				"tsconfig.json": strings.Replace(project.RuntimeTsconfig, `"noEmit": true`, `"outDir": "out"`, 1),
			},
			plugins: lenientPlugins,
			want: func(t *testing.T, dir string) checkOutcome {
				t.Helper()
				return checkOutcome{
					status:      statusOK,
					diagnostics: []ttscadapter.Diagnostic{reportedAsyncAt(t, dir, asyncWarningReport())},
				}
			},
		},
		{
			name:    "strict plugin error exits two",
			plugins: strictPlugins,
			want: func(t *testing.T, dir string) checkOutcome {
				t.Helper()
				return checkOutcome{
					status:      statusDiagnostics,
					diagnostics: []ttscadapter.Diagnostic{reportedAsyncAt(t, dir, asyncStrictReport())},
				}
			},
		},
	}
}

func TestRun_WhenCheck(t *testing.T) {
	t.Parallel()
	for _, tt := range checkCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			files := mainProject(t)
			maps.Copy(files, tt.files)
			dir := project.Write(t, files)
			want := tt.want(t, dir)

			got := runSidecar(sidecarArgv("check", dir, tt.plugins))

			assertCheckReported(t, dir, got, want)
			assertAbsent(t, outputDir(dir))
		})
	}
}

func TestRun_WhenAWriteFails_ExitsThree(t *testing.T) {
	t.Parallel()
	buffer := func() io.Writer { return &bytes.Buffer{} }
	closed := func() io.Writer { return failingWriter{} }
	failingOnce := func() io.Writer { return &failsFirstWrite{} }
	panickingOnComponents := func(dir string) analyzer { return panicking(absolute(dir, componentsFile), panicDetail) }
	byDefault := func(string) analyzer { return analyzeProgram }
	tests := []struct {
		stdout     func() io.Writer
		stderr     func() io.Writer
		analyze    func(dir string) analyzer
		name       string
		subcommand string
	}{
		{
			name: "version to a closed stdout", subcommand: "version",
			stdout: closed, stderr: buffer, analyze: byDefault,
		},
		{
			name: "usage to a closed stderr", subcommand: "banana",
			stdout: buffer, stderr: closed, analyze: byDefault,
		},
		{
			name: "check plugin diagnostic to a closed stderr", subcommand: "check",
			stdout: buffer, stderr: closed, analyze: byDefault,
		},
		{
			name: "check internal report to a stderr that fails once", subcommand: "check",
			stdout: buffer, stderr: failingOnce, analyze: panickingOnComponents,
		},
		{
			name: "transform envelope to a closed stdout", subcommand: "transform",
			stdout: closed, stderr: buffer, analyze: byDefault,
		},
		{
			name: "transform internal report to a closed stderr", subcommand: "transform",
			stdout: buffer, stderr: closed, analyze: panickingOnComponents,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			dir := writeMainProject(t)
			argv := sidecarArgv(tt.subcommand, dir, lenientPlugins)
			stdout, stderr := tt.stdout(), tt.stderr()

			status := ttscadapter.RunAnalyzing(argv, stdout, stderr, tt.analyze(dir))

			if status != statusIO {
				t.Errorf("Run(%s) = %d, want %d", tt.subcommand, status, statusIO)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

// makerSource exports a class expression with a private member, which declaration emit rejects.
const makerSource = "export const makeFruit = () => class { private secret = 1; };\n"

// codePrivateInAnonymousClass is TypeScript's declaration-emit error for the private member in makerSource.
const codePrivateInAnonymousClass = 4094

// declarationProject is fruitProject emitting declarations, plus a file whose declaration cannot be emitted.
func declarationProject() map[string]string {
	files := withCompilerOptions(fruitProject(false), `"declaration":true`)
	files["src/maker.ts"] = makerSource
	return files
}

// declarationOnlyProject is fruitProject emitting declarations only.
func declarationOnlyProject() map[string]string {
	return withCompilerOptions(fruitProject(false), `"declaration":true,"emitDeclarationOnly":true`)
}

// withCompilerOptions is files, a fruitProject, with options, a comma-separated list of compiler options, added to
// its tsconfig.json.
func withCompilerOptions(files map[string]string, options string) map[string]string {
	files["tsconfig.json"] = strings.Replace(files["tsconfig.json"], `"types":[]`, `"types":[],`+options, 1)
	return files
}

// fruitProject compiles src/ to ES modules, with noEmit set as given.
func fruitProject(noEmit bool) map[string]string {
	return map[string]string{
		"tsconfig.json": fmt.Sprintf(`{"compilerOptions":{"target":"es2024","module":"nodenext","rootDir":"src",`+
			`"strict":true,"noEmit":%t,"types":[]},"include":["src"]}`, noEmit),
		"package.json": `{"type": "module"}`,
		"src/fruit.ts": fruitSource,
		"src/main.ts":  splitSource,
	}
}

// buildArgv is the argv ttsc passes to build the project at dir with pluginsJSON into outDir.
func buildArgv(dir, pluginsJSON, outDir string) []string {
	return sidecarArgv("build", dir, pluginsJSON, "--outDir="+outDir)
}

// outputDir is the directory the tests build the project at dir into.
func outputDir(dir string) string {
	return filepath.Join(dir, "out")
}

// typedFruitSource declares an interface and annotates a constant, both of which TypeScript's emit strips.
const typedFruitSource = "export interface Fruit {\n  name: string;\n}\nexport const banana: number = 1;\n"

// sighting is what a recording transform saw of one file: its name and whether it still declared an interface.
type sighting struct {
	file         string
	hasInterface bool
}

// recordingTransform is a transform that appends each file it sees to seen and leaves the file unchanged.
func recordingTransform(seen *[]sighting) driver.PluginTransform {
	isInterface := func(n *ast.Node) bool { return n.Kind == ast.KindInterfaceDeclaration }
	return func(_ *printer.EmitContext, file *ast.SourceFile) *ast.SourceFile {
		*seen = append(*seen, sighting{file: file.FileName(), hasInterface: slices.ContainsFunc(file.Statements.Nodes, isInterface)})
		return file
	}
}

// runWithTransform runs argv with transform standing in for the plugin's emit-time transform.
func runWithTransform(argv []string, transform driver.PluginTransform) result {
	return captured(func(stdout, stderr io.Writer) int {
		return ttscadapter.RunTransforming(argv, stdout, stderr, transform)
	})
}

func TestRun_WhenBuild_RunsThePluginTransformFirstOnEachProjectFile(t *testing.T) {
	t.Parallel()
	files := fruitProject(false)
	files["src/fruit.ts"] = typedFruitSource
	dir := project.Write(t, files)
	var seen []sighting
	want := []sighting{
		{file: absolute(dir, "src/fruit.ts"), hasInterface: true},
		{file: absolute(dir, "src/main.ts"), hasInterface: false},
	}

	got := runWithTransform(buildArgv(dir, lenientPlugins, outputDir(dir)), recordingTransform(&seen))

	requireStatus(t, "build", got, statusOK)
	byFile := cmpopts.SortSlices(func(a, b sighting) bool { return a.file < b.file })
	if diff := cmp.Diff(want, seen, cmp.AllowUnexported(sighting{}), byFile); diff != "" {
		t.Errorf("transform sightings mismatch (-want +got):\n%s", diff)
	}
}

func TestRun_WhenBuild_EmitsTheProjectIntoOutDir(t *testing.T) {
	t.Parallel()
	tests := []struct {
		files map[string]string
		name  string
		flags []string
	}{
		{name: "emitting tsconfig", files: fruitProject(false)},
		{name: "noEmit tsconfig is emitted anyway", files: fruitProject(true)},
		{name: "emitDeclarationOnly tsconfig is emitted as JavaScript under --emit", files: declarationOnlyProject(), flags: []string{"--emit"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			dir := project.Write(t, tt.files)
			out := outputDir(dir)
			want := map[string]string{"fruit.js": fruitSource, "main.js": splitSource}

			got := runSidecar(append(buildArgv(dir, lenientPlugins, out), tt.flags...))

			requireStatus(t, "build", got, statusOK)
			for name, text := range want {
				if emitted := fileText(t, filepath.Join(out, name)); emitted != text {
					t.Errorf("out/%s = %q, want %q", name, emitted, text)
				}
			}
		})
	}
}

type buildErrorCase struct {
	files    func() map[string]string
	name     string
	wantCode int
}

// buildErrorCases pairs projects that report an error with the error code build must report.
func buildErrorCases() []buildErrorCase {
	return []buildErrorCase{
		{
			name: "type error",
			files: func() map[string]string {
				files := fruitProject(false)
				files["src/broken.ts"] = brokenSource
				return files
			},
			wantCode: codeNotAssignable,
		},
		{
			name:     "declaration emit error",
			files:    declarationProject,
			wantCode: codePrivateInAnonymousClass,
		},
	}
}

func TestRun_WhenBuildReportsAnError_ExitsTwoWithoutOutput(t *testing.T) {
	t.Parallel()
	for _, tt := range buildErrorCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			dir := project.Write(t, tt.files())
			out := outputDir(dir)

			got := runSidecar(buildArgv(dir, lenientPlugins, out))

			if got.status != statusDiagnostics {
				t.Errorf("Run(build) = %d, want %d; stderr = %q", got.status, statusDiagnostics, got.stderr)
			}
			isWanted := func(d ttscadapter.Diagnostic) bool { return d.Code == tt.wantCode && d.Category == categoryError }
			if !slices.ContainsFunc(reported(t, dir, got.stderr), isWanted) {
				t.Errorf("stderr = %q, want an error diagnostic with code %d", got.stderr, tt.wantCode)
			}
			assertAbsent(t, out)
		})
	}
}

func TestRun_WhenBuildCannotWriteItsOutput_ExitsThree(t *testing.T) {
	t.Parallel()
	files := fruitProject(false)
	files["blocker"] = "banana"
	dir := project.Write(t, files)

	got := runSidecar(buildArgv(dir, lenientPlugins, filepath.Join(dir, "blocker/out")))

	requireStatus(t, "build", got, statusIO)
}

func TestRun_WhenTsconfigIsMissing_ExitsTwoNamingIt(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	argv := sidecarArgv("transform", dir, noPlugins)

	got := runSidecar(argv)

	assertRejected(t, argv, got)
	assertStderrContains(t, got.stderr, loadFailure)
}

func TestRun_WhenTsconfigHasErrors_ExitsTwoWithItsDiagnostics(t *testing.T) {
	t.Parallel()
	dir := project.Write(t, map[string]string{
		"tsconfig.json": `{"compilerOptions":{"banana":true},"include":["src"]}`,
		"src/main.ts":   fruitSource,
	})
	argv := sidecarArgv("transform", dir, noPlugins)

	got := runSidecar(argv)

	assertRejected(t, argv, got)
	assertStderrContains(t, got.stderr, "TS5023", "'banana'")
}

func TestRun_WhenSemanticConfigPathIsRelative_ExitsTwoAsALoadFailure(t *testing.T) {
	dir := project.Write(t, map[string]string{
		"tsconfig.json": `{"include":["src"]}`,
		"src/main.ts":   fruitSource,
	})
	const semanticConfigPath = "banana/tsconfig.json"
	t.Setenv(driver.SemanticConfigPathEnv, semanticConfigPath)
	argv := sidecarArgv("transform", dir, noPlugins)

	got := runSidecar(argv)

	assertRejected(t, argv, got)
	assertStderrContains(t, got.stderr, loadFailure)
}

// ---------------------------------------------------------------------------
// Transform and analysis
// ---------------------------------------------------------------------------

// packageRootProject is the runtime project with an async each call in src/extra.ts and dist/extra.ts, which
// analysis leaves unreported, and in app/main.ts, which it reports.
func packageRootProject(t *testing.T) map[string]string {
	t.Helper()
	return project.Runtime(t, map[string]string{
		"src/extra.ts":  packageRootCall("./index.js"),
		"dist/extra.ts": packageRootCall("../src/index.js"),
		mainFile:        packageRootCall("../src/index.js"),
	})
}

func runTransform(dir, pluginsJSON string) result {
	return runSidecar(sidecarArgv("transform", dir, pluginsJSON))
}

// sourceTexts is files restricted to the non-declaration TypeScript files, keyed like the envelope.
func sourceTexts(files map[string]string) map[string]string {
	texts := map[string]string{}
	for name, text := range files {
		if strings.HasSuffix(name, ".ts") && !strings.HasSuffix(name, ".d.ts") {
			texts[name] = text
		}
	}
	return texts
}

// diagnosticFiles is the file of each of diagnostics, in order.
func diagnosticFiles(diagnostics []ttscadapter.Diagnostic) []string {
	var files []string
	for _, d := range diagnostics {
		files = append(files, d.File)
	}
	return files
}

// loadedGraph is the transform graph ttsc computes for the project at dir, as decoded JSON.
func loadedGraph(t *testing.T, dir string) any {
	t.Helper()
	prog, _, err := driver.LoadProgram(dir, "tsconfig.json", driver.LoadProgramOptions{})
	if err != nil {
		t.Fatalf("driver.LoadProgram(%q) error = %v, want nil", dir, err)
	}
	t.Cleanup(func() {
		if err := prog.Close(); err != nil {
			t.Errorf("Program.Close() error = %v, want nil", err)
		}
	})
	return decodedJSON(t, driver.NewTransformGraph(prog, dir))
}

func TestRun_WhenTransform_WritesTheProjectEnvelope(t *testing.T) {
	t.Parallel()
	files := mainProject(t)
	dir := project.Write(t, files)
	wantDependencies := map[string][]string{
		mainFile: {componentsFile, healthFile, "src/archetype.ts", "src/component.ts", "src/world.ts"},
	}
	wantDiagnostics := []ttscadapter.Diagnostic{diagnosticAt(asyncCallPos(t, dir), asyncWarningReport())}
	wantGraph := loadedGraph(t, dir)

	got := runTransform(dir, lenientPlugins)

	requireStatus(t, "transform", got, statusOK)
	env := decodeEnvelope(t, got.stdout)
	if diff := cmp.Diff(sourceTexts(files), env.TypeScript); diff != "" {
		t.Errorf("typescript mismatch, want every project source verbatim (-want +got):\n%s", diff)
	}
	if len(env.SourceMaps) != 0 {
		t.Errorf("sourceMaps = %v, want empty", env.SourceMaps)
	}
	if diff := cmp.Diff(wantDependencies, env.Dependencies); diff != "" {
		t.Errorf("dependencies mismatch (-want +got):\n%s", diff)
	}
	if env.DependenciesComplete != nil {
		t.Errorf("dependenciesComplete = %s, want absent", env.DependenciesComplete)
	}
	if diff := cmp.Diff(wantDiagnostics, env.Diagnostics); diff != "" {
		t.Errorf("diagnostics mismatch (-want +got):\n%s", diff)
	}
	if diff := cmp.Diff(wantGraph, decodedJSON(t, env.Graph)); diff != "" {
		t.Errorf("graph mismatch with ttsc's transform graph (-want +got):\n%s", diff)
	}
}

func TestRun_WhenTransform_KeepsOnlySourceFilesUnderCwd(t *testing.T) {
	t.Parallel()
	parent := project.Write(t, map[string]string{
		"project/tsconfig.json":    `{"compilerOptions":{"noEmit":true,"types":[]},"include":["src", "../outside"]}`,
		"project/src/main.ts":      splitSource,
		"project/src/fruit.ts":     fruitSource,
		"project/src/ambient.d.ts": "declare const orchard: number;\n",
		"outside/extra.ts":         "export const cherry = 2;\n",
	})
	want := map[string]string{
		"src/main.ts":  splitSource,
		"src/fruit.ts": fruitSource,
	}

	got := runTransform(filepath.Join(parent, "project"), noPlugins)

	requireStatus(t, "transform", got, statusOK)
	if diff := cmp.Diff(want, decodeEnvelope(t, got.stdout).TypeScript); diff != "" {
		t.Errorf("typescript mismatch (-want +got):\n%s", diff)
	}
}

func TestRun_WhenTransformRunsTwice_WritesIdenticalEnvelopes(t *testing.T) {
	t.Parallel()
	dir := writeMainProject(t)
	first := runTransform(dir, lenientPlugins)

	second := runTransform(dir, lenientPlugins)

	if first.status != statusOK || second.status != statusOK {
		t.Fatalf("Run(transform) = %d then %d, want %d both times", first.status, second.status, statusOK)
	}
	if first.stdout != second.stdout {
		t.Errorf("second envelope differs from the first:\n%s\nwant:\n%s", second.stdout, first.stdout)
	}
}

// packageRootCall is an each call that bails as async, importing the runtime from importPath.
func packageRootCall(importPath string) string {
	return `import { archetype, component, each, type Storage } from "` + importPath + `";

const Spot = component("Spot", { x: 0 });
const Marker = archetype([Spot]);
declare const markers: Storage<typeof Marker>;

each(markers, async (e) => {
	e.Spot.x = 1;
});
`
}

func TestRun_WhenFileIsInsideThePackageRoot_LeavesItUnreported(t *testing.T) {
	t.Parallel()
	files := packageRootProject(t)
	dir := project.Write(t, files)
	want := []string{absolute(dir, mainFile)}

	got := runTransform(dir, strictPlugins)

	if got.status != statusDiagnostics {
		t.Fatalf("Run(transform) = %d, want %d for the strict diagnostic in app/main.ts; stderr = %q",
			got.status, statusDiagnostics, got.stderr)
	}
	env := decodeEnvelope(t, got.stdout)
	if diff := cmp.Diff(want, diagnosticFiles(env.Diagnostics)); diff != "" {
		t.Errorf("diagnostic files mismatch (-want +got):\n%s", diff)
	}
	for _, rel := range []string{"src/extra.ts", "dist/extra.ts"} {
		if env.TypeScript[rel] != files[rel] {
			t.Errorf("typescript[%s] = %q, want its original text %q", rel, env.TypeScript[rel], files[rel])
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

func diagnosticsIn(diagnostics []ttscadapter.Diagnostic, path string) []ttscadapter.Diagnostic {
	var inFile []ttscadapter.Diagnostic
	for _, d := range diagnostics {
		if d.File == path {
			inFile = append(inFile, d)
		}
	}
	return inFile
}

func TestRun_WhenAnalyzingAFilePanicsUnderStrict_ReportsInternalForTheUnchangedFile(t *testing.T) {
	t.Parallel()
	dir := writeMainProject(t)
	componentsPath := absolute(dir, componentsFile)
	want := []ttscadapter.Diagnostic{{
		File: componentsPath, Category: categoryError, Code: facts.ReasonInternal.Info().Code,
		MessageText: fileInternalMessage(componentsPath, strictMode),
	}}
	ignorePosition := cmpopts.IgnoreFields(ttscadapter.Diagnostic{}, "Start", "Line", "Character")

	got := runArgv(sidecarArgv("transform", dir, strictPlugins), panicking(componentsPath, errors.New(panicDetail)))

	requireStatus(t, "transform", got, statusDiagnostics)
	env := decodeEnvelope(t, got.stdout)
	assertComponentsKeptAndMainReported(t, dir, env)
	internal := diagnosticsIn(env.Diagnostics, componentsPath)
	if diff := cmp.Diff(want, internal, ignorePosition); diff != "" {
		t.Errorf("diagnostics for app/components.ts mismatch (-want +got):\n%s", diff)
	}
	if got.stderr != "" {
		t.Errorf("stderr = %q, want empty", got.stderr)
	}
}

func TestRun_WhenAnalyzingAFilePanicsWithoutStrict_WritesOneStderrLineForTheUnchangedFile(t *testing.T) {
	t.Parallel()
	dir := writeMainProject(t)
	componentsPath := absolute(dir, componentsFile)
	wantStderr := fileInternalMessage(componentsPath, "") + "\n"

	got := runArgv(sidecarArgv("transform", dir, lenientPlugins), panicking(componentsPath, errors.New(panicDetail)))

	requireStatus(t, "transform", got, statusOK)
	env := decodeEnvelope(t, got.stdout)
	assertComponentsKeptAndMainReported(t, dir, env)
	if internal := diagnosticsIn(env.Diagnostics, componentsPath); len(internal) != 0 {
		t.Errorf("diagnostics for app/components.ts = %+v, want none", internal)
	}
	if got.stderr != wantStderr {
		t.Errorf("stderr = %q, want %q", got.stderr, wantStderr)
	}
}

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

// validKeys is how a usage error about the ecstatic entry lists the keys it accepts.
const validKeys = "enabled, strict, transform"

type parseOptionsCase struct {
	name        string
	pluginsJSON string
	want        ttscadapter.Options
}

// parseOptionsCases lists the plugin arrays ParseOptions accepts and the options each yields.
func parseOptionsCases() []parseOptionsCase {
	return []parseOptionsCase{
		{
			name:        "strict omitted defaults to off",
			pluginsJSON: lenientPlugins,
			want:        ttscadapter.Options{Strict: false},
		},
		{
			name:        "strict on",
			pluginsJSON: strictPlugins,
			want:        ttscadapter.Options{Strict: true},
		},
		{
			name: "strict off with enabled set",
			pluginsJSON: `[{"config":{"transform":"ecstatic/optimizer","strict":false,"enabled":true},` +
				`"name":"ecstatic","stage":"transform"}]`,
			want: ttscadapter.Options{Strict: false},
		},
		{
			name: "descriptor named by path",
			pluginsJSON: `[{"config":{"transform":"./node_modules/ecstatic/dist/plugin/optimizer.js","strict":true},` +
				`"name":"ecstatic","stage":"transform"}]`,
			want: ttscadapter.Options{Strict: true},
		},
		{
			name: "other plugins keep their own keys",
			pluginsJSON: `[{"config":{"transform":"banana/lib/transform","banana":1},"name":"banana","stage":"transform"},` +
				`{"config":{"transform":"./plugins/optimizer.ts","banana":1},"name":"other","stage":"transform"},` +
				`{"config":{"transform":"ecstatic/ttsc","banana":1},"name":"ecstatic","stage":"transform"},` +
				`{"config":null,"name":"empty","stage":"transform"},` +
				`{"config":{"transform":"ecstatic/optimizer","strict":true},"name":"ecstatic","stage":"transform"}]`,
			want: ttscadapter.Options{Strict: true},
		},
		{
			name:        "no ecstatic entry",
			pluginsJSON: `[]`,
			want:        ttscadapter.Options{Strict: false},
		},
		{
			name: "disabled entry leaves the defaults",
			pluginsJSON: `[{"config":{"transform":"ecstatic/optimizer","strict":true,"enabled":false},` +
				`"name":"ecstatic","stage":"transform"}]`,
			want: ttscadapter.Options{Strict: false},
		},
		{
			name: "disabled entry beside an enabled one is not a duplicate",
			pluginsJSON: `[{"config":{"transform":"ecstatic/optimizer","enabled":false},"name":"ecstatic","stage":"transform"},` +
				`{"config":{"transform":"ecstatic/optimizer","strict":true},"name":"ecstatic","stage":"transform"}]`,
			want: ttscadapter.Options{Strict: true},
		},
	}
}

func TestParseOptions(t *testing.T) {
	t.Parallel()
	for _, tt := range parseOptionsCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := ttscadapter.ParseOptions(tt.pluginsJSON)
			if err != nil {
				t.Fatalf("ParseOptions(%s) error = %v, want nil", tt.pluginsJSON, err)
			}

			if got != tt.want {
				t.Errorf("ParseOptions(%s) = %+v, want %+v", tt.pluginsJSON, got, tt.want)
			}
		})
	}
}

func TestParseOptions_RejectsUsageErrorsListingValidKeys(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name        string
		pluginsJSON string
		want        string
	}{
		{
			name:        "misspelled key",
			pluginsJSON: `[{"config":{"transform":"ecstatic/optimizer","strict":true,"speed":true},"name":"ecstatic"}]`,
			want:        `unknown ecstatic/optimizer option "speed"`,
		},
		{
			name:        "strict as a string",
			pluginsJSON: `[{"config":{"transform":"ecstatic/optimizer","strict":"yes"},"name":"ecstatic"}]`,
			want:        "option strict must be a boolean",
		},
		{
			name:        "strict as null",
			pluginsJSON: `[{"config":{"transform":"ecstatic/optimizer","strict":null},"name":"ecstatic"}]`,
			want:        "option strict must be a boolean",
		},
		{
			name:        "malformed JSON",
			pluginsJSON: `[{"config":`,
			want:        "--plugins-json is not a JSON array of plugin entries",
		},
		{
			name:        "not an array",
			pluginsJSON: `{"config":{"transform":"ecstatic/optimizer"}}`,
			want:        "--plugins-json is not a JSON array of plugin entries",
		},
		{
			name: "two ecstatic entries",
			pluginsJSON: `[{"config":{"transform":"ecstatic/optimizer"},"name":"ecstatic"},` +
				`{"config":{"transform":"../ecstatic/src/plugin/optimizer.ts","strict":true},"name":"ecstatic"}]`,
			want: "more than one ecstatic/optimizer plugin entry",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			_, err := ttscadapter.ParseOptions(tt.pluginsJSON)

			if !errors.Is(err, ttscadapter.ErrUsage) {
				t.Fatalf("ParseOptions(%s) error = %v, want ErrUsage", tt.pluginsJSON, err)
			}
			if !strings.Contains(err.Error(), validKeys) {
				t.Errorf("ParseOptions(%s) error = %q, want it to list %q", tt.pluginsJSON, err, validKeys)
			}
			if !strings.Contains(err.Error(), tt.want) {
				t.Errorf("ParseOptions(%s) error = %q, want it to contain %q", tt.pluginsJSON, err, tt.want)
			}
		})
	}
}
