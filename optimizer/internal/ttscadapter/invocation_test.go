package ttscadapter_test

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jeffzi/ecstatic/optimizer/internal/analysis"
	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/ttscadapter"
	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

const (
	strictPlugins  = `[{"config":{"transform":"ecstatic/optimizer","strict":true},"name":"ecstatic","stage":"transform"}]`
	lenientPlugins = `[{"config":{"transform":"ecstatic/optimizer"},"name":"ecstatic","stage":"transform"}]`
)

// noPlugins is a --plugins-json array with no plugin entry.
const noPlugins = "[]"

// analyzer analyzes one file of a loaded Program, as Run does for each file.
type analyzer = ttscadapter.Analyzer

// envelope is the transform envelope as ttsc decodes it.
type envelope struct {
	TypeScript           map[string]string          `json:"typescript"`
	SourceMaps           map[string]json.RawMessage `json:"sourceMaps"`
	Dependencies         map[string][]string        `json:"dependencies"`
	HostInputHashes      map[string]*string         `json:"hostInputHashes"`
	HostInputRealpaths   map[string]*string         `json:"hostInputRealpaths"`
	Graph                json.RawMessage            `json:"graph"`
	HostInputs           []string                   `json:"hostInputs"`
	DependenciesComplete json.RawMessage            `json:"dependenciesComplete"`
	Diagnostics          []ttscadapter.Diagnostic   `json:"diagnostics"`
}

// result is what one Run reported: its exit status and both streams.
type result struct {
	stdout string
	stderr string
	status int
}

// decodeEnvelope is the transform envelope stdout holds, failing the test now when it does not decode.
func decodeEnvelope(t *testing.T, stdout string) envelope {
	t.Helper()
	var got envelope
	if err := json.Unmarshal([]byte(stdout), &got); err != nil {
		t.Fatalf("json.Unmarshal(stdout) error = %v, want nil; stdout = %q", err, stdout)
	}
	return got
}

// decodedJSON is v encoded and decoded again as generic JSON, for comparison by value.
func decodedJSON(t *testing.T, v any) any {
	t.Helper()
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("json.Marshal(%T) error = %v, want nil", v, err)
	}
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("json.Unmarshal(%s) error = %v, want nil", data, err)
	}
	return decoded
}

// analyzeProgram analyzes file with the Program's checker, as Run does by default.
func analyzeProgram(prog *driver.Program, file *ast.SourceFile, roots *analysis.PackageRoots) []facts.Site {
	return ttscadapter.AnalyzeProgram(prog, file, roots)
}

// Mirror run.go's exit constants, which this external test package cannot reach; keep the values equal.
const (
	statusOK          = 0
	statusFailure     = 1
	statusDiagnostics = 2
	statusIO          = 3
)

// sidecarArgv is the argv ttsc passes to run subcommand over the project at dir with pluginsJSON, then extra.
func sidecarArgv(subcommand, dir, pluginsJSON string, extra ...string) []string {
	argv := []string{subcommand, "--tsconfig=tsconfig.json", "--plugins-json=" + pluginsJSON, "--cwd=" + dir}
	return append(argv, extra...)
}

// captured runs run with fresh stdout and stderr buffers and returns what it wrote and its status.
func captured(run func(stdout, stderr io.Writer) int) result {
	var stdout, stderr bytes.Buffer
	status := run(&stdout, &stderr)
	return result{stdout: stdout.String(), stderr: stderr.String(), status: status}
}

// runArgv runs argv, analyzing each file with analyze.
func runArgv(argv []string, analyze analyzer) result {
	return captured(func(stdout, stderr io.Writer) int { return ttscadapter.RunAnalyzing(argv, stdout, stderr, analyze) })
}

// runSidecar runs argv as the sidecar does.
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

// runTransform runs the transform subcommand over the project at dir with pluginsJSON.
func runTransform(dir, pluginsJSON string) result {
	return runSidecar(sidecarArgv("transform", dir, pluginsJSON))
}

// runWithTransform runs argv with transform standing in for the plugin's emit-time transform.
func runWithTransform(argv []string, transform driver.PluginTransform) result {
	return captured(func(stdout, stderr io.Writer) int {
		return ttscadapter.RunTransforming(argv, stdout, stderr, transform)
	})
}

// runInlining runs argv, emitting each planned rewrite with inline.
func runInlining(argv []string, inline ttscadapter.Inliner) result {
	return captured(func(stdout, stderr io.Writer) int { return ttscadapter.RunInlining(argv, stdout, stderr, inline) })
}

// runResolving runs argv, resolving the physical path of each src/debug.ts it copies DEBUG from with resolve.
func runResolving(argv []string, resolve func(path string) (string, error)) result {
	return captured(func(stdout, stderr io.Writer) int { return ttscadapter.RunResolving(argv, stdout, stderr, resolve) })
}

const (
	categoryError   = "error"
	categoryWarning = "warning"
)

// absolute is the compiler's spelling of the slash-separated rel under dir.
func absolute(dir, rel string) string {
	return filepath.ToSlash(filepath.Join(dir, filepath.FromSlash(rel)))
}

// resolvedDir is the absolute, slash-separated path of the directory rel names relative to this package, as the
// compiler spells file names.
func resolvedDir(t *testing.T, rel string) string {
	t.Helper()
	abs, err := filepath.Abs(rel)
	if err != nil {
		t.Fatalf("filepath.Abs(%q) error = %v, want nil", rel, err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		t.Fatalf("filepath.EvalSymlinks(%q) error = %v, want nil", abs, err)
	}
	return filepath.ToSlash(resolved)
}

// lineOf is the 1-based line of offset in text.
func lineOf(text string, offset int) int {
	return strings.Count(text[:offset], "\n") + 1
}

// fileText is the text of the file at path.
func fileText(t *testing.T, path string) string {
	t.Helper()
	content, err := fs.ReadFile(os.DirFS(filepath.Dir(path)), filepath.Base(path))
	if err != nil {
		t.Fatalf("read %q error = %v, want nil", path, err)
	}
	return string(content)
}

// failingWriter stands in for a closed output stream.
type failingWriter struct{}

var errWrite = errors.New("stream closed")

func (failingWriter) Write([]byte) (int, error) { return 0, errWrite }
