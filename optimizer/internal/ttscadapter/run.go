package ttscadapter

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/compiler"
	"github.com/microsoft/typescript-go/shim/printer"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
	"github.com/jeffzi/ecstatic/optimizer/internal/version"
)

// Exit statuses. The ttsc protocol defines 0 as success, 2 as a diagnostic failure, and any other
// non-zero status as a runtime failure; within that, 3 is this plugin's status for an I/O failure.
const (
	exitOK          = 0
	exitFailure     = 1
	exitDiagnostics = 2
	exitIO          = 3
)

// errIO marks a failed write or emit: an output the command could not deliver. The command exits 3
// on it.
var errIO = errors.New("write failed")

// errReported marks a command whose diagnostics, already delivered, include an error. The command
// exits 2 on it and writes nothing more, unless another failure is joined with it.
var errReported = errors.New("diagnostics reported an error")

type streams struct {
	stdout io.Writer
	stderr io.Writer
}

// ---------------------------------------------------------------------------
// Usage text
// ---------------------------------------------------------------------------

// Widths of the usage text's left-hand columns: the subcommand names and the flag syntaxes.
const (
	subcommandColumn = 12
	flagColumn       = 25
)

// usage is the text that follows a usage error on stderr: every subcommand and flag the sidecar
// reads, with what each does.
func usage() string {
	var b strings.Builder
	b.WriteString("usage: ecstatic-optimizer <subcommand> [flags]\n\nsubcommands:\n")
	for _, u := range subcommandUsages() {
		fmt.Fprintf(&b, "  %-*s%s\n", subcommandColumn, u.subcommand, u.summary)
	}
	b.WriteString("\nflags:\n")
	for _, f := range cliFlags() {
		fmt.Fprintf(&b, "  %-*s%s\n", flagColumn, flagSyntax(f), f.summary)
	}
	return b.String()
}

// flagSyntax is f as the usage text shows it: its name, followed by "=" and its placeholder when it
// takes a value.
func flagSyntax(f cliFlag) string {
	if f.placeholder == "" {
		return f.name
	}
	return f.name + "=" + f.placeholder
}

// ---------------------------------------------------------------------------
// Run and failure reporting
// ---------------------------------------------------------------------------

// Run runs the sidecar for argv, the arguments after the program name, and returns its exit
// status.
//
// version writes version.Version to stdout. transform, check, and build first validate the plugin
// options in --plugins-json, then load the Program that --cwd and --tsconfig name. A relative --cwd
// is resolved against the working directory and an empty one names it, as ttsc's own host does, so
// every file the plugin reports carries an absolute path. transform then writes the project
// envelope to stdout, its diagnostics included. check writes the Program's TypeScript diagnostics
// and then the plugin's to stderr, and writes no file. build reports as check does, then emits the
// project into --outDir, writing nothing when any diagnostic is an error.
//
// Status 2 is a usage error, a Program that failed to load, or a diagnostic that is an error. A
// usage error is written to stderr followed by the usage text. A tsconfig with errors writes its
// diagnostics to stderr the way ttsc's own commands do, and any other load failure writes its
// reason. Status 3 is a failed write to stdout, stderr, or an output file, or a failed emit; its
// reason goes to stderr when stderr still accepts it. Status 1 is any other failure, such as an
// envelope that cannot be encoded; its reason goes to stderr. When a diagnostic is an error and
// another failure also occurs, such as closing the Program, that failure is reported as it would be
// alone and its status of 1 or 3 is returned instead of 2.
func Run(argv []string, stdout, stderr io.Writer) int {
	return runPlugin(argv, streams{stdout: stdout, stderr: stderr}, pluginRun{})
}

// runPlugin runs as Run does, with plugin's seams in place of the defaults.
func runPlugin(argv []string, out streams, plugin pluginRun) int {
	err := run(argv, out, plugin)
	if err == nil {
		return exitOK
	}
	return reportFailure(err, out.stderr)
}

// reportFailure writes the report of err, a failed run, to stderr and returns the exit status for
// it.
//
// errReported writes nothing more, since its diagnostics are already delivered, and exits 2. Any
// other failure joined with it is reported as it would be alone, and its status wins over 2.
//
// It returns 3 when the write to stderr fails, and otherwise the status failureReport gives err.
func reportFailure(err error, stderr io.Writer) int {
	err = withoutReported(err)
	if err == nil {
		return exitDiagnostics
	}
	report, status := failureReport(err)
	if write(stderr, "stderr", report) != nil {
		return exitIO
	}
	return status
}

// withoutReported is err with errReported dropped from the errors that errors.Join joined into it,
// through joins nested in joins, or nil when nothing else is left. Every other error is returned as
// it is, including one that wraps errReported with %w, alone or beside other errors: a multi-%w
// error also unwraps to a list, but rebuilding it would lose its message, and its own message and
// whatever it wraps beside errReported are still to be reported.
func withoutReported(err error) error {
	if !errors.Is(err, errReported) {
		return err
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		if reflect.TypeOf(err) != reflect.TypeOf(errors.Join(errReported)) {
			return err
		}
		var kept []error
		for _, e := range joined.Unwrap() {
			kept = append(kept, withoutReported(e))
		}
		return errors.Join(kept...)
	}
	// errors.Is matched an error that wraps nothing, so err is errReported itself.
	if errors.Unwrap(err) == nil {
		return nil
	}
	return err
}

// run runs the subcommand argv names with plugin's seams, filling in its project directory and
// options from argv.
func run(argv []string, out streams, plugin pluginRun) (err error) {
	args, err := parseArgs(argv)
	if err != nil {
		return err
	}
	if args.Subcommand == subcommandVersion {
		return write(out.stdout, "stdout", version.Version+"\n")
	}
	opts, err := parseOptions(args.PluginsJSON)
	if err != nil {
		return err
	}
	args.Cwd, err = resolveCwd(args.Cwd)
	if err != nil {
		return err
	}
	prog, err := loadProgram(args, false)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := prog.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close the program for %s: %w", args.Tsconfig, closeErr))
		}
	}()
	plugin.cwd = args.Cwd
	plugin.opts = opts
	switch args.Subcommand {
	case subcommandTransform:
		return plugin.transform(prog, out)
	case subcommandCheck:
		return plugin.check(prog, out.stderr)
	case subcommandBuild:
		return plugin.build(prog, args, out)
	default:
		panic(fmt.Sprintf("subcommand %q passed parseArgs but run has no case for it", args.Subcommand))
	}
}

// resolveCwd is cwd as ttsc's own host resolves it: absolute and cleaned, against the working
// directory when relative, and the working directory itself when empty. The error wraps errLoad.
func resolveCwd(cwd string) (string, error) {
	abs, err := filepath.Abs(cwd)
	if err != nil {
		return "", fmt.Errorf("%w: resolve --cwd %s: %w", errLoad, cwd, err)
	}
	return abs, nil
}

// failureReport is what stderr says about err, and the status it exits with.
func failureReport(err error) (string, int) {
	// Before the errLoad case: a *loadDiagnosticsError also wraps errLoad, and its diagnostics
	// replace the one-line reason.
	if loadErr, ok := errors.AsType[*loadDiagnosticsError](err); ok {
		return loadErr.report(), exitDiagnostics
	}
	line := fmt.Sprintf(messagePrefix+"%v\n", err)
	switch {
	case errors.Is(err, errUsage):
		return line + "\n" + usage(), exitDiagnostics
	case errors.Is(err, errIO):
		return line, exitIO
	case errors.Is(err, errLoad):
		return line, exitDiagnostics
	default:
		return line, exitFailure
	}
}

// write writes text to w, the stream named stream, and wraps errIO with that name when the write fails.
func write(w io.Writer, stream, text string) error {
	if _, err := io.WriteString(w, text); err != nil {
		return fmt.Errorf("%w: write %s: %w", errIO, stream, err)
	}
	return nil
}

// errLoad marks a Program the driver could not load: a missing tsconfig, or a driver failure
// before the tsconfig was parsed. The command exits 2 on it.
var errLoad = errors.New("cannot load the program")

// loadDiagnosticsError reports a Program that did not load because its tsconfig has errors. It
// wraps errLoad.
type loadDiagnosticsError struct {
	cwd         string
	diagnostics []driver.Diagnostic
}

func (e *loadDiagnosticsError) Error() string {
	return fmt.Sprintf("%v: the tsconfig has %d error(s)", errLoad, driver.CountErrors(e.diagnostics))
}

func (e *loadDiagnosticsError) Unwrap() error {
	return errLoad
}

// report renders the diagnostics the way ttsc's own commands write them to stderr, which is the
// text ttsc parses a failed sidecar's diagnostics from.
func (e *loadDiagnosticsError) report() string {
	return renderDiagnostics(e.diagnostics, e.cwd)
}

// loadProgram loads the Program that args.Tsconfig, resolved against args.Cwd, describes, with
// args.OutDir as its output directory when set and, when forceEmit is true, with noEmit cleared.
// The caller closes it.
//
// When ttsc type-checks through a generated wrapper tsconfig, it names the user's tsconfig in
// driver.SemanticConfigPathEnv, and its own commands load with it as the semantic config; the
// driver does not read the variable itself, so the sidecar passes it on to type-check the project
// as ttsc does. A tsconfig with errors fails with a *loadDiagnosticsError carrying them; that
// error and any other failure wrap errLoad.
func loadProgram(args sidecarArgs, forceEmit bool) (*driver.Program, error) {
	prog, diagnostics, err := driver.LoadProgram(args.Cwd, args.Tsconfig, driver.LoadProgramOptions{
		ForceEmit:          forceEmit,
		OutDir:             args.OutDir,
		SemanticConfigPath: os.Getenv(driver.SemanticConfigPathEnv),
	})
	if err != nil {
		return nil, fmt.Errorf("%w for %s: %w", errLoad, args.Tsconfig, err)
	}
	if len(diagnostics) > 0 {
		return nil, &loadDiagnosticsError{cwd: args.Cwd, diagnostics: diagnostics}
	}
	return prog, nil
}

// ---------------------------------------------------------------------------
// Plugin options
// ---------------------------------------------------------------------------

// descriptorSubpath is the package subpath a tsconfig names the descriptor by; it must match the
// `./optimizer` subpath in package.json `exports`.
const descriptorSubpath = "ecstatic/optimizer"

// descriptorName is the `name` the descriptor in src/plugin/optimizer.ts declares, which ttsc reports
// beside every entry it loaded from that descriptor.
const descriptorName = "ecstatic"

const (
	keyEnabled   = "enabled"
	keyStrict    = "strict"
	keyTransform = "transform"
)

// validKeys lists the keys the ecstatic entry accepts, as usage errors name them; it must name
// every key entryOptions accepts.
const validKeys = keyEnabled + ", " + keyStrict + ", " + keyTransform

// pluginOptions are the plugin's options, read from its tsconfig plugin entry.
type pluginOptions struct {
	// Strict reports every strict-category bail as an error; off by default.
	Strict bool
}

// parseOptions reads the ecstatic entry's options from pluginsJSON, the --plugins-json array.
// Each element decodes as ttsc's own projection of a tsconfig plugin entry, driver.PluginEntry,
// whose Config holds the entry as the tsconfig wrote it.
//
// The ecstatic entry is the one the descriptor rule of src/plugin/plugin-entry.ts accepts, as far
// as the sidecar can see it: its `enabled` is not false, and its `transform` is either the
// `ecstatic/optimizer` subpath or a relative or absolute path that ttsc loaded the ecstatic descriptor
// from (the entry's name is the descriptor's). The sidecar cannot resolve the path itself: ttsc
// resolves it against the tsconfig that declared it, which may be an `extends` base the sidecar
// never sees. Other plugins' entries are skipped whatever keys they hold, and no ecstatic entry
// yields the defaults.
//
// The error wraps errUsage when pluginsJSON is not a JSON array of entries, when more than one
// entry is the ecstatic one, or when that entry holds a key other than strict, transform, and
// enabled, or a strict that is not a boolean; every one of these errors lists the valid keys.
func parseOptions(pluginsJSON string) (pluginOptions, error) {
	var entries []driver.PluginEntry
	if err := json.Unmarshal([]byte(pluginsJSON), &entries); err != nil {
		return pluginOptions{}, optionsError("--plugins-json is not a JSON array of plugin entries: %w", err)
	}
	var found *driver.PluginEntry
	for i := range entries {
		if !isEcstaticEntry(entries[i]) {
			continue
		}
		if found != nil {
			return pluginOptions{}, optionsError("more than one %s plugin entry; keep one", descriptorSubpath)
		}
		found = &entries[i]
	}
	if found == nil {
		return pluginOptions{}, nil
	}
	return entryOptions(found.Config)
}

func isEcstaticEntry(entry driver.PluginEntry) bool {
	if enabled, ok := entry.Config[keyEnabled].(bool); ok && !enabled {
		return false
	}
	transform, ok := entry.Config[keyTransform].(string)
	if !ok {
		return false
	}
	return transform == descriptorSubpath || (isPathSpecifier(transform) && entry.Name == descriptorName)
}

// isPathSpecifier reports whether transform names a file rather than a package: what ttsc's
// isRelativePluginSpecifier accepts, plus absolute paths. Keep it in step with ttsc, or the
// name check in isEcstaticEntry skips an entry ttsc loads by path.
func isPathSpecifier(transform string) bool {
	return transform == "." || transform == ".." ||
		strings.HasPrefix(transform, "./") || strings.HasPrefix(transform, "../") ||
		strings.HasPrefix(transform, `.\`) || strings.HasPrefix(transform, `..\`) ||
		filepath.IsAbs(transform)
}

func entryOptions(config map[string]any) (pluginOptions, error) {
	var opts pluginOptions
	for _, key := range slices.Sorted(maps.Keys(config)) {
		switch key {
		case keyTransform, keyEnabled:
		case keyStrict:
			strict, ok := config[key].(bool)
			if !ok {
				return pluginOptions{}, optionsError("%s option %s must be a boolean, got %v", descriptorSubpath, keyStrict, config[key])
			}
			opts.Strict = strict
		default:
			return pluginOptions{}, optionsError("unknown %s option %q", descriptorSubpath, key)
		}
	}
	return opts, nil
}

// optionsError is a usage error for format and a that wraps errUsage and lists the valid keys.
func optionsError(format string, a ...any) error {
	return fmt.Errorf("%w: %w; valid keys: %s", errUsage, fmt.Errorf(format, a...), validKeys)
}

// ---------------------------------------------------------------------------
// Analysis and transform
// ---------------------------------------------------------------------------

// envelope is the transform envelope ttsc reads from stdout (transformResult in ttsc's
// utility/host.go). DependenciesComplete is never declared: omitting it keeps ttsc's host-owned
// dependency bound. HostInputs lists, by absolute path, every runtime source a rewrite copied from;
// HostInputHashes holds the SHA-256 of the text each was copied from, and HostInputPhysical the
// physical path it was read through, the two witnesses ttsc requires of every host input before it
// reuses a transform.
type envelope struct {
	Graph             *driver.TransformGraph     `json:"graph,omitempty"`
	Dependencies      map[string][]string        `json:"dependencies,omitempty"`
	HostInputHashes   map[string]*string         `json:"hostInputHashes,omitempty"`
	HostInputPhysical map[string]*string         `json:"hostInputRealpaths,omitempty"`
	SourceMaps        map[string]json.RawMessage `json:"sourceMaps,omitempty"`
	TypeScript        map[string]string          `json:"typescript"`
	HostInputs        []string                   `json:"hostInputs,omitempty"`
	Diagnostics       []diagnostic               `json:"diagnostics,omitempty"`
}

// pluginRun runs the plugin over one project. analyze, inline, physical, and emitTransform are the
// seams a test replaces: analyze to make one file's analysis panic (see analyzer), inline to make
// one site's emit panic (see inliner), physical to make resolving a src/debug.ts fail after it was
// read (see physicalResolver), and emitTransform to observe what build hands the plugin's
// transform. A nil analyze analyzes with analysis.Analyze, a nil physical resolves with
// filepath.EvalSymlinks, and a nil emitTransform rewrites each project file as rewriteTransform
// does.
type pluginRun struct {
	analyze       analyzer
	inline        inliner
	physical      physicalResolver
	emitTransform driver.PluginTransform
	cwd           string
	opts          pluginOptions
}

// projectFile is one project file the plugin analyzed: its envelope key, and its rewrite.
type projectFile struct {
	file    *ast.SourceFile
	key     string
	rewrite rewrittenFile
}

// isProjectFile returns file's envelope key and whether file lies under r.cwd, as the envelope's
// files do.
func (r pluginRun) isProjectFile(file *ast.SourceFile) (string, bool) {
	key := driver.TransformOutputKey(r.cwd, file.FileName())
	return key, !filepath.IsAbs(filepath.FromSlash(key))
}

// analyzeProject rewrites every non-declaration file of prog under r.cwd, each through an emit
// context of its own, and returns the files with the plugin's diagnostics for them.
//
// Without strict, each INTERNAL bail writes one line to stderr instead of becoming a diagnostic;
// the error wraps errIO when that write fails.
func (r pluginRun) analyzeProject(prog *driver.Program, stderr io.Writer) ([]projectFile, []diagnostic, error) {
	w := r.newRewriter(prog)
	var files []projectFile
	var bails []plan.Bail
	for _, file := range prog.SourceFiles() {
		key, ok := r.isProjectFile(file)
		if !ok {
			continue
		}
		rewrite := w.rewrite(printer.NewEmitContext(), file)
		bails = append(bails, rewrite.bails...)
		files = append(files, projectFile{file: file, key: key, rewrite: rewrite})
	}
	diagnostics, err := bailDiagnostics(bails, r.opts, stderr)
	if err != nil {
		return nil, nil, err
	}
	return files, diagnostics, nil
}

// rewriteTransform is the plugin's transform in tsgo's emit chain over prog: it rewrites each
// project file through the emit context tsgo prints it with, and returns every other file
// unchanged. Its bails are not reported again: build reports those of the same rewrite before it
// emits.
func (r pluginRun) rewriteTransform(prog *driver.Program) driver.PluginTransform {
	w := r.newRewriter(prog)
	return func(ctx *printer.EmitContext, file *ast.SourceFile) *ast.SourceFile {
		if _, ok := r.isProjectFile(file); !ok {
			return file
		}
		if output := w.rewrite(ctx, file).output; output != nil {
			return output.SourceFile()
		}
		return file
	}
}

// transform writes the project envelope of prog to out.stdout. A file with no rewrite is its
// original text; a rewritten file is its original text with each inlined loop and the preamble
// spliced in, printed with the emit context that built them, with an inline-sources source map,
// and depends on the src/debug.ts its DEBUG copy came from, which is also a host input.
//
// The error wraps errIO when a write fails, and is errReported when a diagnostic is an error. A
// failure to encode the envelope is returned wrapping neither.
func (r pluginRun) transform(prog *driver.Program, out streams) error {
	env := envelope{
		Graph:             driver.NewTransformGraph(prog, r.cwd),
		Dependencies:      map[string][]string{},
		HostInputHashes:   map[string]*string{},
		HostInputPhysical: map[string]*string{},
		SourceMaps:        map[string]json.RawMessage{},
		TypeScript:        map[string]string{},
	}
	files, diagnostics, err := r.analyzeProject(prog, out.stderr)
	if err != nil {
		return err
	}
	for _, f := range files {
		env.add(r.cwd, f)
	}
	env.HostInputs = slices.Sorted(maps.Keys(env.HostInputHashes))
	env.Diagnostics = diagnostics
	encoded, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("encode the transform envelope: %w", err)
	}
	if err := write(out.stdout, "stdout", string(encoded)+"\n"); err != nil {
		return err
	}
	if slices.ContainsFunc(diagnostics, isError) {
		return errReported
	}
	return nil
}

// add records f in env, with its dependencies keyed relative to cwd.
func (env *envelope) add(cwd string, f projectFile) {
	if len(f.rewrite.consulted) > 0 {
		env.Dependencies[f.key] = outputKeys(cwd, f.rewrite.consulted)
	}
	if f.rewrite.output == nil {
		env.TypeScript[f.key] = f.file.Text()
		return
	}
	text, sourceMap := f.rewrite.output.Print()
	env.TypeScript[f.key] = text
	env.SourceMaps[f.key] = json.RawMessage(sourceMap)
	gate := f.rewrite.debug
	sum := sha256.Sum256(gate.debug.Source)
	env.HostInputHashes[gate.debug.Path] = new(hex.EncodeToString(sum[:]))
	env.HostInputPhysical[gate.debug.Path] = new(gate.physical)
}

// outputKeys is files keyed like the envelope, sorted and without duplicates.
func outputKeys(cwd string, files []string) []string {
	keys := make([]string, 0, len(files))
	for _, file := range files {
		keys = append(keys, driver.TransformOutputKey(cwd, file))
	}
	slices.Sort(keys)
	return slices.Compact(keys)
}

// ---------------------------------------------------------------------------
// Check and build
// ---------------------------------------------------------------------------

// output is one file the emit produced, held until the build knows it may write.
type output struct {
	name string
	text string
}

// check writes prog's TypeScript diagnostics to stderr, followed by the plugin's diagnostics for
// every project file, and writes no file.
//
// ttsc runs its own type check only after a sidecar exits non-zero, so on a zero exit these are the
// only TypeScript diagnostics the user sees: none may be dropped. Both are written as the
// diagnostic lines ttsc parses from stderr. The error is errReported when a diagnostic is an
// error, and wraps errIO when a write to stderr fails.
func (r pluginRun) check(prog *driver.Program, stderr io.Writer) error {
	typeScriptDiagnostics := prog.Diagnostics()
	_, pluginDiagnostics, err := r.analyzeProject(prog, stderr)
	if err != nil {
		return err
	}
	var report strings.Builder
	report.WriteString(renderDiagnostics(typeScriptDiagnostics, r.cwd))
	for _, d := range pluginDiagnostics {
		report.WriteString(d.line())
	}
	if err := write(stderr, "stderr", report.String()); err != nil {
		return err
	}
	if driver.CountErrors(typeScriptDiagnostics) > 0 || slices.ContainsFunc(pluginDiagnostics, isError) {
		return errReported
	}
	return nil
}

// build reports prog's diagnostics as check does, then emits the project through tsgo with the
// plugin's transform first in its transform chain, into args.OutDir when it is set.
//
// When args.Emit is set, the project is reloaded with emit forced, as ttsc's own --emit does: that
// clears both noEmit and emitDeclarationOnly, so the build writes JavaScript whatever the tsconfig
// says. A tsconfig that sets noEmit is reloaded the same way without the flag, since ttsc runs
// build only to emit. Nothing is written unless no TypeScript, plugin, or emit diagnostic is an
// error: every output is held until the emit finishes, so a failing build leaves no partial output
// behind. The error is errReported when a diagnostic is an error, and wraps errIO when the emit or
// a write fails. When the forced reload fails, the error is its load error, which wraps errLoad:
// a *loadDiagnosticsError, or another load failure. A failure to close the reloaded Program is
// joined to the error.
func (r pluginRun) build(prog *driver.Program, args sidecarArgs, out streams) (err error) {
	if err = r.check(prog, out.stderr); err != nil {
		return err
	}
	if !args.Emit && !prog.ParsedConfig.ParsedConfig.CompilerOptions.NoEmit.IsTrue() {
		return r.emit(prog, out)
	}
	emitting, err := loadProgram(args, true)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := emitting.Close(); closeErr != nil {
			err = errors.Join(err, fmt.Errorf("close the program reloaded to emit %s: %w", args.Tsconfig, closeErr))
		}
	}()
	return r.emit(emitting, out)
}

// emit emits prog with the plugin's rewrite (see rewriteTransform), or r.emitTransform when set,
// first in tsgo's transform chain and, when no emit diagnostic is an error, writes every output.
// Emit diagnostics go to out.stderr.
//
// The driver reports an emit diagnostic that is an error, such as a declaration it cannot emit,
// both in the returned diagnostics and as a *driver.PluginEmitError; that error is a diagnostic
// failure, not an I/O one. The error is errReported when an emit diagnostic is an error, and
// wraps errIO when the emit otherwise fails or a write fails.
func (r pluginRun) emit(prog *driver.Program, out streams) error {
	var outputs []output
	hold := func(name, text string, _ *compiler.WriteFileData) error {
		outputs = append(outputs, output{name: name, text: text})
		return nil
	}
	transform := r.emitTransform
	if transform == nil {
		transform = r.rewriteTransform(prog)
	}
	diagnostics, err := prog.EmitWithPluginTransformers([]driver.PluginTransform{transform}, hold)
	if _, reported := errors.AsType[*driver.PluginEmitError](err); err != nil && !reported {
		return fmt.Errorf("%w: emit the project at %s: %w", errIO, r.cwd, err)
	}
	if err := write(out.stderr, "stderr", renderDiagnostics(diagnostics, r.cwd)); err != nil {
		return err
	}
	if driver.CountErrors(diagnostics) > 0 {
		return errReported
	}
	for _, o := range outputs {
		if err := driver.DefaultWriteFile(o.name, o.text); err != nil {
			return fmt.Errorf("%w: write output %s: %w", errIO, o.name, err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

// The diagnostic categories the plugin reports, from ttsc's ITtscCompilerDiagnostic.Category.
const (
	categoryError   = "error"
	categoryWarning = "warning"
)

// messagePrefix starts every message the plugin writes for the user.
const messagePrefix = "ecstatic: "

// diagnostic is one diagnostic in ttsc's public ITtscCompilerDiagnostic shape. A bail reports a
// point location, so the shape's optional length is never set.
type diagnostic struct {
	File        string `json:"file"`
	Category    string `json:"category"`
	MessageText string `json:"messageText"`
	// Code is the reason's numeric diagnostic code.
	Code int `json:"code"`
	// Start is the call's 0-based offset in the file text.
	Start int `json:"start"`
	// Line and Character are the call's 1-based line and column.
	Line      int `json:"line"`
	Character int `json:"character"`
}

func isError(d diagnostic) bool {
	return d.Category == categoryError
}

// line is d as one diagnostic line on stderr, in the "file:line:column - category code: message"
// form ttsc parses a sidecar's check and build diagnostics from.
func (d diagnostic) line() string {
	return fmt.Sprintf("%s:%d:%d - %s %d: %s\n", d.File, d.Line, d.Character, d.Category, d.Code, d.MessageText)
}

// renderDiagnostics is diagnostics as ttsc's own commands write them to stderr, relative to cwd.
func renderDiagnostics(diagnostics []driver.Diagnostic, cwd string) string {
	var b strings.Builder
	driver.WritePrettyDiagnostics(&b, diagnostics, cwd)
	return b.String()
}

// bailDiagnostics turns the bails that opts reports into diagnostics, ordered by file name and
// then source offset.
//
// Under strict, every strict and warning bail, INTERNAL included, is an error. Without strict,
// only warning bails are reported, as warnings; an INTERNAL bail instead writes one line to
// stderr, so an internal failure never fails a non-strict build. That line starts with the call's
// position, or names the file for a bail that covers a whole file. The error wraps errIO when
// that write fails.
func bailDiagnostics(bails []plan.Bail, opts pluginOptions, stderr io.Writer) ([]diagnostic, error) {
	sorted := slices.SortedStableFunc(slices.Values(bails), func(a, b plan.Bail) int {
		return cmp.Or(cmp.Compare(a.Pos.File, b.Pos.File), cmp.Compare(a.Pos.Offset, b.Pos.Offset))
	})
	var diagnostics []diagnostic
	for _, bail := range sorted {
		switch {
		case bail.Reported(opts.Strict):
			diagnostics = append(diagnostics, bailDiagnostic(bail, opts.Strict))
		case bail.Reason == facts.ReasonInternal:
			if err := write(stderr, "stderr", internalLine(bail)); err != nil {
				return nil, fmt.Errorf("write internal error for %s: %w", bail.Pos.File, err)
			}
		}
	}
	return diagnostics, nil
}

// internalLine is the stderr line of an INTERNAL bail without strict. A file bail's message
// already names the file, and its position is only the file's start, so it carries no prefix.
func internalLine(bail plan.Bail) string {
	if isFileBail(bail) {
		return bailMessage(bail, false) + "\n"
	}
	return fmt.Sprintf("%s:%d:%d: %s\n", bail.Pos.File, bail.Pos.Line, bail.Pos.Column, bailMessage(bail, false))
}

// isFileBail reports whether bail covers a whole file rather than one call: OpNone names no call,
// as analyzeFile reports a panic while analyzing the file.
func isFileBail(bail plan.Bail) bool {
	return bail.Op == facts.OpNone
}

func bailDiagnostic(bail plan.Bail, strict bool) diagnostic {
	category := categoryWarning
	if strict {
		category = categoryError
	}
	return diagnostic{
		File:        bail.Pos.File,
		Category:    category,
		Code:        bail.Reason.Info().Code,
		Start:       bail.Pos.Offset,
		Line:        bail.Pos.Line,
		Character:   bail.Pos.Column,
		MessageText: bailMessage(bail, strict),
	}
}

func bailMessage(bail plan.Bail, strict bool) string {
	info := bail.Reason.Info()
	reason := strings.Replace(info.Text, facts.DetailPlaceholder, bail.Detail, 1)
	var message strings.Builder
	if isFileBail(bail) {
		fmt.Fprintf(&message, messagePrefix+"%s could not be analyzed (%s). Its calls compile to the runtime calls",
			bail.Pos.File, reason)
	} else {
		fmt.Fprintf(&message, messagePrefix+"The %s() call cannot be optimized (%s). It compiles to the runtime call",
			bail.Op.Name(), reason)
	}
	if strict {
		message.WriteString(" (strict mode)")
	}
	message.WriteString(".")
	if info.Hint != "" {
		message.WriteString(" ")
		message.WriteString(info.Hint)
	}
	return message.String()
}
