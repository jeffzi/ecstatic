package ttscadapter

import (
	"io"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/jeffzi/ecstatic/optimizer/internal/analysis"
	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
)

// RunAnalyzing runs as Run does, with analyze standing in for the analysis of
// each file of the loaded Program, so a test can make one file's analysis panic.
func RunAnalyzing(
	argv []string,
	stdout, stderr io.Writer,
	analyze analyzer,
) int {
	p := defaultPluginRun()
	p.analyze = analyze
	return runPlugin(argv, streams{stdout: stdout, stderr: stderr}, p)
}

// ErrReported is the error a subcommand returns once its diagnostics reported an error.
var ErrReported = errReported

// ErrIO is the error a failed write of the sidecar's output wraps.
var ErrIO = errIO

// ErrUsage is the error an invocation the sidecar cannot run wraps.
var ErrUsage = errUsage

// Args is a parsed sidecar invocation.
type Args = sidecarArgs

// Options are the plugin's options, read from its tsconfig plugin entry.
type Options = pluginOptions

// Diagnostic is one diagnostic in ttsc's public ITtscCompilerDiagnostic shape.
type Diagnostic = diagnostic

// The subcommands the sidecar accepts.
const (
	SubcommandTransform = subcommandTransform
	SubcommandCheck     = subcommandCheck
	SubcommandBuild     = subcommandBuild
	SubcommandVersion   = subcommandVersion
)

// ParseArgs parses argv, the arguments after the program name.
func ParseArgs(argv []string) (Args, error) {
	return parseArgs(argv)
}

// ParseOptions reads the ecstatic entry's options from pluginsJSON, the --plugins-json array.
func ParseOptions(pluginsJSON string) (Options, error) {
	return parseOptions(pluginsJSON)
}

// BailDiagnostics turns the bails that opts reports into diagnostics.
func BailDiagnostics(bails []plan.Bail, opts Options, stderr io.Writer) ([]Diagnostic, error) {
	return bailDiagnostics(bails, opts, stderr)
}

// ReportFailure reports err, the error a subcommand returned, to stderr as Run does and returns
// Run's exit status for it.
func ReportFailure(err error, stderr io.Writer) int {
	return reportFailure(err, stderr)
}

// Analyzer is the analysis of one file of a loaded Program.
type Analyzer = analyzer

// AnalyzeProgram is the analysis Run applies to each file by default.
func AnalyzeProgram(prog *driver.Program, file *ast.SourceFile, roots *analysis.PackageRoots) []facts.Site {
	return analyzeProgram(prog, file, roots)
}

// RunTransforming runs as Run does, with transform standing in for the plugin's
// emit-time transform of each project file, so a test can observe what it receives.
func RunTransforming(argv []string, stdout, stderr io.Writer, transform driver.PluginTransform) int {
	p := defaultPluginRun()
	p.emitTransform = transform
	return runPlugin(argv, streams{stdout: stdout, stderr: stderr}, p)
}
