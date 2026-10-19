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
	"github.com/microsoft/typescript-go/shim/parser"
	"github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/jeffzi/ecstatic/optimizer/internal/printed"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
	"github.com/jeffzi/ecstatic/optimizer/internal/ttscadapter"
	"github.com/jeffzi/ecstatic/optimizer/internal/version"
)

// diagnosticTail is the category code: message tail both diagnostic line grammars end with.
const diagnosticTail = `(error|warning|suggestion|message)\s+(?:TS)?(\d+):\s+(.+)$`

// fileDiagnosticLine is ttsc's grammar for a diagnostic line with a position: file:line:column - category code: message.
var fileDiagnosticLine = regexp.MustCompile(`^(.+):(\d+):(\d+)\s+-\s+` + diagnosticTail)

// globalDiagnosticLine is ttsc's grammar for a diagnostic line without a position: category code: message.
var globalDiagnosticLine = regexp.MustCompile(`^` + diagnosticTail)

// ansiEscape matches the terminal color sequences ttsc strips before parsing.
var ansiEscape = regexp.MustCompile("\x1b\\[[0-9;]*[A-Za-z]")

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
		{
			name:       "close failure joined under a wrapper",
			joined:     fmt.Errorf("emit: %w", errors.Join(ttscadapter.ErrReported, closeFailed)),
			wantStderr: "ecstatic: emit: diagnostics reported an error\nbanana\n",
			wantStatus: statusFailure,
		},
		{
			name:       "close failure wrapped beside a diagnostics error",
			joined:     fmt.Errorf("emit: %w; %w", closeFailed, ttscadapter.ErrReported),
			wantStderr: "ecstatic: emit: banana; diagnostics reported an error\n",
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

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

// codeNotAssignable is reported for the string-to-number assignment in brokenSource.
const codeNotAssignable = 2322

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

// brokenSource assigns a string to a number, a TypeScript error at line 1, column 14.
const brokenSource = "export const count: number = \"banana\";\n"

// typeErrorMessage is TypeScript's message for the error in brokenSource.
const typeErrorMessage = "Type 'string' is not assignable to type 'number'."

// assertAbsent fails t unless nothing exists at path.
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

func TestRun_WhenCheck_ReportsOnStderrWithoutWriting(t *testing.T) {
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

// emittedTree is every file under out, keyed by slash-separated path relative to it.
func emittedTree(t *testing.T, out string) map[string]string {
	t.Helper()
	tree := map[string]string{}
	outputs := os.DirFS(out)
	err := fs.WalkDir(outputs, ".", func(rel string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		content, err := fs.ReadFile(outputs, rel)
		tree[rel] = string(content)
		return err
	})
	if err != nil {
		t.Fatalf("walk %s: %v", out, err)
	}
	return tree
}

func TestRun_WhenBuild_GuardsEachLoopWithItsOwnShapeKey(t *testing.T) {
	t.Parallel()
	dir := writeMainProject(t)
	out := outputDir(dir)

	got := runSidecar(buildArgv(dir, lenientPlugins, out))

	requireStatus(t, "build", got, statusOK)
	text := fileText(t, filepath.Join(out, "app", "main.js"))
	assertCalls(t, text, []string{asyncCall}, []string{moversCall, statuesCall})
	var keys []string
	for _, k := range printed.ShapeKeys(text) {
		keys = append(keys, k.Name)
	}
	guards := printed.Guards(text)
	if len(keys) != 2 || !slices.Equal(guards, keys) {
		t.Errorf("out/app/main.js declares shape keys %q guarded as %q, want one per loop, each guarding its loop:\n%s",
			keys, guards, text)
	}
}

func TestRun_WhenBuildUnderStrictHasNoStrictBail_ExitsZeroWithTheInlinedLoops(t *testing.T) {
	t.Parallel()
	dir := project.Write(t, runtimeProject(t, inlinedSource))
	out := outputDir(dir)

	got := runSidecar(buildArgv(dir, strictPlugins, out))

	requireStatus(t, "build", got, statusOK)
	assertCalls(t, fileText(t, filepath.Join(out, "app", "main.js")), nil, []string{moversCall, statuesCall})
}

// parsedFrom is a transform that returns the file named name parsed from text, as ttsc compiles a file of a transform
// envelope, and every other file unchanged.
func parsedFrom(name, text string) driver.PluginTransform {
	return func(_ *printer.EmitContext, file *ast.SourceFile) *ast.SourceFile {
		if file.FileName() != name {
			return file
		}
		return parser.ParseSourceFile(file.ParseOptions(), text, file.ScriptKind)
	}
}

func TestRun_WhenBuild_EmitsTheJavaScriptOfTheTransformRewrite(t *testing.T) {
	t.Parallel()
	dir := writeMainProject(t)
	transformed := runTransform(dir, lenientPlugins)
	requireStatus(t, "transform", transformed, statusOK)
	rewrite := decodeEnvelope(t, transformed.stdout).TypeScript[mainFile]
	compiledOut := filepath.Join(dir, "compiled")
	compiled := runWithTransform(buildArgv(dir, lenientPlugins, compiledOut), parsedFrom(absolute(dir, mainFile), rewrite))
	requireStatus(t, "build", compiled, statusOK)
	out := outputDir(dir)

	got := runSidecar(buildArgv(dir, lenientPlugins, out))

	requireStatus(t, "build", got, statusOK)
	if diff := cmp.Diff(emittedTree(t, compiledOut), emittedTree(t, out)); diff != "" {
		t.Errorf("build output mismatch with the transform's rewrite compiled (-transform +build):\n%s", diff)
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
