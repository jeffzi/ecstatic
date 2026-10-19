package ttscadapter_test

import (
	compare "cmp"
	"fmt"
	"io/fs"
	"maps"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/google/go-cmp/cmp"
	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/jeffzi/ecstatic/optimizer/internal/analysis"
	"github.com/jeffzi/ecstatic/optimizer/internal/emit"
	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/golden"
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
	"github.com/jeffzi/ecstatic/optimizer/internal/ttscadapter"
)

// fixtureRoot is the fixture corpus, relative to this package.
const fixtureRoot = "../../../tests/optimizer/fixtures"

const (
	fixtureInput  = "input.ts"
	fixtureGolden = "expected.ts.golden"
	bailCorpus    = "bail"
)

// sampleFixture is the name of the sample bail fixture the harness tests feed their inputs.
const sampleFixture = "bail/sample"

// expectPrefix starts an expected-diagnostic comment, which marks the line below it.
const expectPrefix = "// expect-diagnostic:"

// expectMarker matches a comment that reads as an expected-diagnostic comment, near misses included, so that a
// misspelled one fails its fixture instead of going unchecked.
var expectMarker = regexp.MustCompile(`(?i)^//\s*expect[-_ ]?diagnostics?\b`)

// expectComment is the grammar of an expected-diagnostic comment: "warning" for a reason reported in every build,
// then the reason's code and its ID.
var expectComment = regexp.MustCompile(`^// expect-diagnostic: (warning )?(\d+) ([A-Z_]+)$`)

// expectGrammar spells expectComment for an error message.
const expectGrammar = expectPrefix + " [warning ]<code> <ID>"

// expected is one diagnostic a fixture's expect-diagnostic comment calls for.
type expected struct {
	file    string
	id      string
	line    int
	code    int
	warning bool
}

// found is one diagnostic as the harness compares it: where, which reason, and in which category.
type found struct {
	file     string
	id       string
	category string
	line     int
	code     int
}

// corpusRun is what one transform over the whole corpus reported.
type corpusRun struct {
	env    envelope
	status int
}

// corpusRoot is the absolute, slash-separated path of the fixture corpus, as the compiler spells file names.
func corpusRoot(t *testing.T) string {
	t.Helper()
	return resolvedDir(t, fixtureRoot)
}

// fixtureDirs is every directory of the corpus that holds an input.ts, slash-separated relative to root, sorted.
func fixtureDirs(t *testing.T, root string) []string {
	t.Helper()
	var dirs []string
	err := fs.WalkDir(os.DirFS(root), ".", func(rel string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && entry.Name() == fixtureInput {
			dirs = append(dirs, path.Dir(rel))
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk the fixture corpus at %s: %v", root, err)
	}
	if len(dirs) == 0 {
		t.Fatalf("fixture corpus at %s holds no %s", root, fixtureInput)
	}
	slices.Sort(dirs)
	return dirs
}

// corpusOf is what got, one transform over a corpus, reported, failing the test now unless it exited OK or with
// diagnostics.
func corpusOf(t *testing.T, got result) corpusRun {
	t.Helper()
	if got.status != statusOK && got.status != statusDiagnostics {
		t.Fatalf("Run(transform) over the fixture corpus = %d, want %d or %d; stderr = %q",
			got.status, statusOK, statusDiagnostics, got.stderr)
	}
	return corpusRun{env: decodeEnvelope(t, got.stdout), status: got.status}
}

// transformCorpus runs the transform subcommand once over the corpus at root with pluginsJSON, analyzing each file
// with analyze.
func transformCorpus(t *testing.T, root, pluginsJSON string, analyze analyzer) corpusRun {
	t.Helper()
	return corpusOf(t, runArgv(sidecarArgv("transform", root, pluginsJSON), analyze))
}

// planRecorder analyzes as Run does and records the plan of each file it analyzes in planned, keyed by file name.
func planRecorder(planned map[string]plan.Result) analyzer {
	return func(prog *driver.Program, file *ast.SourceFile, roots *analysis.PackageRoots) []facts.Site {
		sites := analyzeProgram(prog, file, roots)
		planned[file.FileName()] = plan.Plan(sites)
		return sites
	}
}

// assertAnalyzed fails t unless fixture's input was analyzed as a project file of the corpus at root.
func assertAnalyzed(t *testing.T, planned map[string]plan.Result, root, fixture string) {
	t.Helper()
	if _, analyzed := planned[path.Join(root, fixture, fixtureInput)]; !analyzed {
		t.Fatalf("fixture %s: %s was not analyzed as a project file; the corpus tsconfig.json leaves it out",
			fixture, fixtureInput)
	}
}

// assertPlansRewrite fails t unless some each site of fixture's input in the corpus at root plans an inlining.
func assertPlansRewrite(t *testing.T, planned map[string]plan.Result, root, fixture string) {
	t.Helper()
	if len(planned[path.Join(root, fixture, fixtureInput)].Rewrites) == 0 {
		t.Errorf("fixture %s: no each site of %s plans a rewrite, yet the fixture expects no diagnostic, so its sites "+
			"keep their runtime call silently", fixture, fixtureInput)
	}
}

// plannedRun is a transform over the corpus at root, with the plan of each file it analyzed and the output it printed.
type plannedRun struct {
	planned    map[string]plan.Result
	typescript map[string]string
	root       string
}

// assertRewrittenAsPlanned fails t unless the output of fixture differs from its input exactly when some each site of
// the input plans a rewrite, so that a file with no rewrite is printed byte-identical.
func assertRewrittenAsPlanned(t *testing.T, run plannedRun, fixture string) {
	t.Helper()
	input := path.Join(run.root, fixture, fixtureInput)
	rewrites := len(run.planned[input].Rewrites)
	rewritten := run.typescript[outputKey(fixture)] != fileText(t, filepath.FromSlash(input))
	if rewritten != (rewrites > 0) {
		t.Errorf("fixture %s: output differs from %s = %t with %d rewrites planned, want it to differ exactly when a "+
			"rewrite is planned", fixture, fixtureInput, rewritten, rewrites)
	}
}

// runPlanChecks registers the plan checks for one fixture, whose expect-diagnostic comments are all, as separate t.Run
// cases: its input was analyzed as a project file, its output is rewritten exactly when a site plans a rewrite, and,
// when it expects no diagnostic, some each site of it plans a rewrite. A fixture whose sites all bail therefore names
// a diagnostic, so a site that starts bailing silently fails its fixture even after its golden is regenerated.
func runPlanChecks(t *testing.T, run plannedRun, fixture string, all []expected) {
	t.Helper()
	t.Run("input is analyzed as a project file", func(t *testing.T) {
		t.Parallel()
		assertAnalyzed(t, run.planned, run.root, fixture)
	})
	t.Run("output is rewritten exactly when a site plans a rewrite", func(t *testing.T) {
		t.Parallel()
		assertRewrittenAsPlanned(t, run, fixture)
	})
	if len(all) == 0 {
		t.Run("fixture with no expected diagnostic plans a rewrite", func(t *testing.T) {
			t.Parallel()
			assertPlansRewrite(t, run.planned, run.root, fixture)
		})
	}
}

// reasonsByCode is the catalog's reason for each reported code.
func reasonsByCode() map[int]facts.ReasonInfo {
	byCode := map[int]facts.ReasonInfo{}
	for _, r := range facts.Reasons() {
		if info := r.Info(); info.Code != 0 {
			byCode[info.Code] = info
		}
	}
	return byCode
}

// parseExpectation is the diagnostic that comment, on line (1-based) of file in fixture, calls for. It errors,
// naming fixture, file, and line, when the comment is malformed or disagrees with the reason catalog.
func parseExpectation(fixture, file, comment string, line int) (expected, error) {
	at := fmt.Sprintf("fixture %s: %s:%d", fixture, file, line)
	match := expectComment.FindStringSubmatch(comment)
	if match == nil {
		return expected{}, fmt.Errorf("%s: %q does not read %q", at, comment, expectGrammar)
	}
	warning, id := match[1] != "", match[3]
	code, err := strconv.Atoi(match[2])
	if err != nil {
		return expected{}, fmt.Errorf("%s: code %q: %w", at, match[2], err)
	}
	info, known := reasonsByCode()[code]
	if !known || info.ID != id {
		return expected{}, fmt.Errorf("%s: %d %s names no reported reason of the catalog", at, code, id)
	}
	if isWarning := info.Category == facts.CategoryWarning; warning != isWarning {
		return expected{}, fmt.Errorf("%s: %s is marked warning = %t, want %t", at, info.ID, warning, isWarning)
	}
	return expected{file: file, id: info.ID, line: line + 1, code: code, warning: warning}, nil
}

// fileExpectations is every diagnostic the comments in content, the text of file name of fixture, call for, in line
// order. It errors, naming fixture, name, and line, when a comment that reads as an expect-diagnostic comment is
// malformed.
func fileExpectations(fixture, name, content string) ([]expected, error) {
	var all []expected
	for i, text := range strings.Split(content, "\n") {
		comment := strings.TrimSpace(text)
		if !expectMarker.MatchString(comment) {
			continue
		}
		e, err := parseExpectation(fixture, name, comment, i+1)
		if err != nil {
			return nil, err
		}
		all = append(all, e)
	}
	return all, nil
}

// readExpectations is every diagnostic the .ts files of fixture in corpus call for, in file then line order. It
// errors, naming fixture, when a file cannot be read or a comment that reads as an expect-diagnostic comment is
// malformed.
func readExpectations(corpus fs.FS, fixture string) ([]expected, error) {
	entries, err := fs.ReadDir(corpus, fixture)
	if err != nil {
		return nil, fmt.Errorf("read fixture %s: %w", fixture, err)
	}
	var all []expected
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".ts") {
			continue
		}
		content, err := fs.ReadFile(corpus, path.Join(fixture, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read fixture %s: %w", fixture, err)
		}
		inFile, err := fileExpectations(fixture, entry.Name(), string(content))
		if err != nil {
			return nil, err
		}
		all = append(all, inFile...)
	}
	return all, nil
}

// expectations is readExpectations of fixture in the corpus at root, failing t on its error.
func expectations(t *testing.T, root, fixture string) []expected {
	t.Helper()
	all, err := readExpectations(os.DirFS(root), fixture)
	if err != nil {
		t.Fatal(err)
	}
	return all
}

// wanted is the diagnostics expectations call for: every one as an error under strict, only the warning ones as
// warnings otherwise.
func wanted(all []expected, strict bool) []found {
	var want []found
	for _, e := range all {
		var category string
		switch {
		case strict:
			category = categoryError
		case e.warning:
			category = categoryWarning
		default:
			continue
		}
		want = append(want, found{file: e.file, id: e.id, category: category, line: e.line, code: e.code})
	}
	return sortedFound(want)
}

// diagnosticsByFixture groups diagnostics by the fixture directory of their file; a diagnostic outside every
// fixture directory is grouped under its own directory, which names no fixture.
func diagnosticsByFixture(root string, diagnostics []ttscadapter.Diagnostic) map[string][]found {
	byCode := reasonsByCode()
	byFixture := map[string][]found{}
	for _, d := range diagnostics {
		rel := strings.TrimPrefix(d.File, root+"/")
		fixture := path.Dir(rel)
		byFixture[fixture] = append(byFixture[fixture], found{
			file: path.Base(rel), id: byCode[d.Code].ID, category: d.Category, line: d.Line, code: d.Code,
		})
	}
	for fixture, list := range byFixture {
		byFixture[fixture] = sortedFound(list)
	}
	return byFixture
}

// sortedFound is list sorted by file, line, code, then category.
func sortedFound(list []found) []found {
	return slices.SortedFunc(slices.Values(list), func(a, b found) int {
		return compare.Or(
			strings.Compare(a.file, b.file), compare.Compare(a.line, b.line), compare.Compare(a.code, b.code),
			strings.Compare(a.category, b.category),
		)
	})
}

// missingFrom is every diagnostic of want that got lacks, counting duplicates.
func missingFrom(got, want []found) []found {
	left := map[found]int{}
	for _, f := range got {
		left[f]++
	}
	var missing []found
	for _, f := range want {
		if left[f] > 0 {
			left[f]--
			continue
		}
		missing = append(missing, f)
	}
	return missing
}

// assertDiagnostics fails t, naming fixture and each missing or extra diagnostic, unless got equals want.
func assertDiagnostics(t *testing.T, fixture string, got, want []found) {
	t.Helper()
	for _, f := range missingFrom(got, want) {
		t.Errorf("fixture %s: missing %s %s %d at %s:%d", fixture, f.category, f.id, f.code, f.file, f.line)
	}
	for _, f := range missingFrom(want, got) {
		t.Errorf("fixture %s: extra %s %s %d at %s:%d", fixture, f.category, f.id, f.code, f.file, f.line)
	}
}

// outputKey is the key of fixture's printed output in the envelope's TypeScript map.
func outputKey(fixture string) string {
	return fixture + "/" + fixtureInput
}

// matchGolden compares got to the golden at the slash-separated name under root or, when update is true, rewrites
// that golden to got. It errors naming the golden with a diff of the two, or naming the -update command when the
// golden is missing.
func matchGolden(root, name, got string, update bool) error {
	if update {
		file := filepath.Join(filepath.FromSlash(root), filepath.FromSlash(name))
		if err := os.WriteFile(file, []byte(got), 0o600); err != nil {
			return fmt.Errorf("write %s: %w", file, err)
		}
		return nil
	}
	want, err := fs.ReadFile(os.DirFS(root), name)
	if err != nil {
		return fmt.Errorf("read %s: %w; run go test ./internal/ttscadapter -update to write it", name, err)
	}
	if diff := cmp.Diff(string(want), got); diff != "" {
		return fmt.Errorf("output differs from %s (-want +got):\n%s", name, diff)
	}
	return nil
}

// assertGolden compares the printed output of fixture to its golden, or rewrites the golden under -update.
func assertGolden(t *testing.T, root, fixture string, typescript map[string]string) {
	t.Helper()
	key := outputKey(fixture)
	got, printed := typescript[key]
	if !printed {
		t.Fatalf("fixture %s: the optimizer printed no output for %s", fixture, key)
	}
	if err := matchGolden(root, path.Join(fixture, fixtureGolden), got, golden.Update()); err != nil {
		t.Errorf("fixture %s: %v", fixture, err)
	}
}

// stray is a directory, outside every fixture, in which one run over the corpus reported diagnostics.
type stray struct {
	run string
	dir string
}

// strayDiagnostics is every directory of the strict run's and then the lenient run's diagnostics, each run sorted,
// that is none of fixtures. Both runs are parameters so that neither can go unchecked.
func strayDiagnostics(fixtures []string, strict, lenient map[string][]found) []stray {
	runs := []struct {
		byFixture map[string][]found
		name      string
	}{{byFixture: strict, name: "strict"}, {byFixture: lenient, name: "lenient"}}
	var strays []stray
	for _, r := range runs {
		for _, dir := range slices.Sorted(maps.Keys(r.byFixture)) {
			if !slices.Contains(fixtures, dir) {
				strays = append(strays, stray{run: r.name, dir: dir})
			}
		}
	}
	return strays
}

func TestRun_WhenTransformingTheFixtureCorpus_MatchesTheFixtureExpectations(t *testing.T) {
	t.Parallel()
	root := corpusRoot(t)
	fixtures := fixtureDirs(t, root)

	planned := map[string]plan.Result{}
	recorder := &appliedRules{byFile: map[string]map[emit.Rule]bool{}}

	strict := transformCorpus(t, root, strictPlugins, planRecorder(planned))
	lenient := corpusOf(t, runInlining(sidecarArgv("transform", root, lenientPlugins), recorder.inliner()))

	strictFound := diagnosticsByFixture(root, strict.env.Diagnostics)
	lenientFound := diagnosticsByFixture(root, lenient.env.Diagnostics)

	for _, fixture := range fixtures {
		t.Run(fixture, func(t *testing.T) {
			t.Parallel()
			all := expectations(t, root, fixture)

			t.Run("output equals the golden", func(t *testing.T) {
				t.Parallel()
				assertGolden(t, root, fixture, strict.env.TypeScript)
			})
			t.Run("strict diagnostics equal the comments as errors", func(t *testing.T) {
				t.Parallel()
				assertDiagnostics(t, fixture, strictFound[fixture], wanted(all, true))
			})
			t.Run("lenient output equals the strict output", func(t *testing.T) {
				t.Parallel()
				key := outputKey(fixture)
				if diff := cmp.Diff(strict.env.TypeScript[key], lenient.env.TypeScript[key]); diff != "" {
					t.Errorf("fixture %s: output without strict mismatch with the output with it (-strict +lenient):\n%s", fixture, diff)
				}
			})
			t.Run("lenient diagnostics equal the warning comments", func(t *testing.T) {
				t.Parallel()
				assertDiagnostics(t, fixture, lenientFound[fixture], wanted(all, false))
			})
			runPlanChecks(t, plannedRun{planned: planned, typescript: strict.env.TypeScript, root: root}, fixture, all)
		})
	}
	t.Run("no diagnostic outside a fixture directory", func(t *testing.T) {
		t.Parallel()
		for _, s := range strayDiagnostics(fixtures, strictFound, lenientFound) {
			t.Errorf("%s run: diagnostics in %s, which is no fixture", s.run, s.dir)
		}
	})
	t.Run("lenient run succeeds", func(t *testing.T) {
		t.Parallel()
		if lenient.status != statusOK {
			t.Errorf("Run(transform) without strict = %d, want %d", lenient.status, statusOK)
		}
	})
	t.Run("every rule of the catalog has a fixture whose rewrite applies it", func(t *testing.T) {
		t.Parallel()
		claimed, applied := corpusRules(t, root, fixtures, recorder)

		assertCatalogCovered(t, claimed, applied)
	})
}

// benchmarkRoot is the benchmark suite, relative to this package.
const benchmarkRoot = "../../../benchmarks"

// helperCall matches the call of the opaque helper in the body of the iteration/helper_call benchmark.
var helperCall = regexp.MustCompile(`=\s*advance\(`)

// helperCallLine is the line on which the each call of the iteration/helper_call benchmark starts in text.
func helperCallLine(t *testing.T, text string) int {
	t.Helper()
	call := helperCall.FindStringIndex(text)
	if call == nil {
		t.Fatalf("iteration-bench.ts holds no match for %s", helperCall)
	}
	each := strings.LastIndex(text[:call[0]], "each(")
	if each < 0 {
		t.Fatalf("iteration-bench.ts has no each call ahead of its helper call at line %d", lineOf(text, call[0]))
	}
	return lineOf(text, each)
}

func TestRun_WhenTransformingTheBenchmarks_PlansTheModesTheExitCriterionTimes(t *testing.T) {
	t.Parallel()
	root := resolvedDir(t, benchmarkRoot)
	planned := map[string]plan.Result{}

	transformCorpus(t, root, lenientPlugins, planRecorder(planned))

	t.Run("every each call of the systems compiles hoisted", func(t *testing.T) {
		t.Parallel()
		systems := planned[path.Join(root, "systems.ts")]
		if len(systems.Bails) > 0 || len(systems.Rewrites) == 0 {
			t.Fatalf("Plan(systems.ts) bails = %+v, rewrites = %d, want no bail and a rewrite", systems.Bails, len(systems.Rewrites))
		}
		for _, r := range systems.Rewrites {
			if r.Mode != plan.ModeHoisted {
				t.Errorf("Plan(systems.ts) mode of the each call at line %d = %d, want ModeHoisted (%d)", r.Pos.Line, r.Mode, plan.ModeHoisted)
			}
		}
	})
	t.Run("the helper_call each call compiles realloc-safe", func(t *testing.T) {
		t.Parallel()
		file := path.Join(root, "iteration-bench.ts")
		line := helperCallLine(t, fileText(t, file))
		modes := map[int]plan.Mode{}
		for _, r := range planned[file].Rewrites {
			modes[r.Pos.Line] = r.Mode
		}
		if got, ok := modes[line]; !ok || got != plan.ModeReallocSafe {
			t.Errorf("Plan(iteration-bench.ts) mode of the each call at line %d = %d (planned %t), want ModeReallocSafe (%d)",
				line, got, ok, plan.ModeReallocSafe)
		}
	})
}

func TestReasons_WhenReported_HaveABailFixture(t *testing.T) {
	t.Parallel()
	root := corpusRoot(t)
	named := map[string]bool{}
	for _, fixture := range fixtureDirs(t, root) {
		if !strings.HasPrefix(fixture, bailCorpus+"/") {
			continue
		}
		for _, e := range expectations(t, root, fixture) {
			named[e.id] = true
		}
	}

	for _, r := range facts.Reasons() {
		info := r.Info()
		reported := info.Category == facts.CategoryStrict || info.Category == facts.CategoryWarning
		if reported && r != facts.ReasonInternal && !named[info.ID] {
			t.Errorf("reason %s (%d) has no %s fixture whose expect-diagnostic comment names it",
				info.ID, info.Code, bailCorpus)
		}
	}
}

func TestShapeRows_WhenListed_HaveAFixtureThatExpectsTheirOutcome(t *testing.T) {
	t.Parallel()
	rows := []struct {
		row      string
		fixture  string
		resolves bool
	}{
		{row: "local storage", fixture: "eligible/local-storage", resolves: true},
		{row: "class-form archetype", fixture: "eligible/class-archetype", resolves: true},
		{row: "parameter typed Storage<typeof X>", fixture: "eligible/typed-parameter", resolves: true},
		{row: "parameter typed Storage<X>", fixture: "shape/class-storage-parameter", resolves: true},
		{row: "storage imported from another module", fixture: "eligible/imported-storage", resolves: true},
		{row: "class field", fixture: "shape/class-field", resolves: true},
		{row: "property chain", fixture: "shape/property-chain", resolves: true},
		{row: "call result", fixture: "shape/call-result", resolves: true},
		{row: "getStorage", fixture: "shape/get-storage", resolves: true},
		{row: "generic constrained to a storage type", fixture: "shape/constrained-generic", resolves: true},
		{row: "as cast", fixture: "shape/as-cast", resolves: true},
		{row: "wide Storage", fixture: "shape/wide-storage"},
		{row: "union of storages of different shapes", fixture: "shape/union-of-shapes"},
		{row: "any", fixture: "shape/any-storage"},
		{row: "unknown", fixture: "shape/unknown-storage"},
		{row: "unconstrained type parameter", fixture: "shape/unconstrained-type-parameter"},
		{row: "component tuple built by a conditional type", fixture: "shape/conditional-components"},
		{row: "component tuple built by a mapped type", fixture: "shape/mapped-components"},
		{row: "optional tuple element", fixture: "shape/optional-element"},
		{row: "rest tuple element", fixture: "shape/rest-element"},
		{row: "variadic tuple element", fixture: "shape/variadic-element"},
		{row: "union-typed tuple element", fixture: "shape/union-component-element"},
	}
	root := corpusRoot(t)
	fixtures := fixtureDirs(t, root)

	for _, tt := range rows {
		t.Run(tt.row, func(t *testing.T) {
			t.Parallel()
			if !slices.Contains(fixtures, tt.fixture) {
				t.Fatalf("shape row %q has no fixture %s", tt.row, tt.fixture)
			}

			var got []string
			for _, e := range expectations(t, root, tt.fixture) {
				got = append(got, e.id)
			}

			var want []string
			if !tt.resolves {
				want = []string{facts.ReasonShapeUnresolved.Info().ID}
			}
			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("shape row %q: fixture %s expect-diagnostic IDs mismatch (-want +got):\n%s", tt.row, tt.fixture, diff)
			}
		})
	}
}

// claimPrefix starts a rewrite claim: a comment saying the fixture's rewrite applies the rule it names.
const claimPrefix = "// rewrite-applies:"

// claimMarker matches a comment that reads as a rewrite claim, near misses included, so that a misspelled one fails
// its fixture instead of going uncounted.
var claimMarker = regexp.MustCompile(`(?i)^//\s*rewrite[-_ ]?(apply|applies)\b`)

// claimComment is the grammar of a rewrite claim: the name of one rule of the rewrite catalog.
var claimComment = regexp.MustCompile(`^// rewrite-applies: ([a-z-]+)$`)

// claim is one rule a fixture's rewrite claim says its rewrite applies, with the file and line of the claim.
type claim struct {
	file string
	line int
	rule emit.Rule
}

// rulesByName is the rewrite catalog's rule for each name.
func rulesByName() map[string]emit.Rule {
	byName := map[string]emit.Rule{}
	for _, r := range emit.Rules() {
		byName[r.Name()] = r
	}
	return byName
}

// readClaims is every rule the rewrite claims in the input.ts of fixture in corpus name, in line order. It errors,
// naming fixture and line, when the file cannot be read, or a comment that reads as a claim is malformed or names no
// rule of the catalog.
func readClaims(corpus fs.FS, fixture string) ([]claim, error) {
	content, err := fs.ReadFile(corpus, path.Join(fixture, fixtureInput))
	if err != nil {
		return nil, fmt.Errorf("read fixture %s: %w", fixture, err)
	}
	byName := rulesByName()
	var all []claim
	for i, text := range strings.Split(string(content), "\n") {
		comment := strings.TrimSpace(text)
		if !claimMarker.MatchString(comment) {
			continue
		}
		at := fmt.Sprintf("fixture %s: %s:%d", fixture, fixtureInput, i+1)
		match := claimComment.FindStringSubmatch(comment)
		if match == nil {
			return nil, fmt.Errorf("%s: %q does not read %q", at, comment, claimPrefix+" <rule>")
		}
		rule, known := byName[match[1]]
		if !known {
			return nil, fmt.Errorf("%s: %s names no rule of the rewrite catalog", at, match[1])
		}
		all = append(all, claim{file: fixtureInput, line: i + 1, rule: rule})
	}
	return all, nil
}

// appliedRules records, for each file the transform rewrites, every rule its inlined loops apply.
type appliedRules struct {
	byFile map[string]map[emit.Rule]bool
	mu     sync.Mutex
}

// inliner emits each planned rewrite as Run does, then records the rules the rewritten file's loops apply.
func (a *appliedRules) inliner() ttscadapter.Inliner {
	return func(file *emit.File, rewrite plan.EachInlining, uses []facts.ViewUse) {
		file.Inline(rewrite, uses)
		a.mu.Lock()
		defer a.mu.Unlock()
		rules := a.byFile[rewrite.Pos.File]
		if rules == nil {
			rules = map[emit.Rule]bool{}
			a.byFile[rewrite.Pos.File] = rules
		}
		for _, r := range file.Applied() {
			rules[r] = true
		}
	}
}

// claimGap is a claim of fixture whose rewrite does not apply the rule the claim names.
type claimGap struct {
	fixture string
	claim   claim
}

// catalogGaps is every claim of claimed whose fixture's rewrite does not apply its rule by applied, both keyed by
// fixture, in fixture then claim order; then every rule of the catalog that no claim the rewrite bears out names.
func catalogGaps(claimed map[string][]claim, applied map[string]map[emit.Rule]bool) ([]claimGap, []emit.Rule) {
	covered := map[emit.Rule]bool{}
	var gaps []claimGap
	for _, fixture := range slices.Sorted(maps.Keys(claimed)) {
		for _, c := range claimed[fixture] {
			if !applied[fixture][c.rule] {
				gaps = append(gaps, claimGap{fixture: fixture, claim: c})
				continue
			}
			covered[c.rule] = true
		}
	}
	var uncovered []emit.Rule
	for _, r := range emit.Rules() {
		if !covered[r] {
			uncovered = append(uncovered, r)
		}
	}
	return gaps, uncovered
}

// assertCatalogCovered fails t for each claim of claimed whose fixture's rewrite does not apply its rule by applied,
// and for each rule of the catalog that no claim the rewrite bears out names.
func assertCatalogCovered(t *testing.T, claimed map[string][]claim, applied map[string]map[emit.Rule]bool) {
	t.Helper()
	gaps, uncovered := catalogGaps(claimed, applied)
	for _, g := range gaps {
		t.Errorf("fixture %s: %s:%d claims rule %s, which its rewrite does not apply",
			g.fixture, g.claim.file, g.claim.line, g.claim.rule.Name())
	}
	for _, r := range uncovered {
		t.Errorf("rule %s has no fixture whose rewrite applies it; add one whose input.ts reads %s %s",
			r.Name(), claimPrefix, r.Name())
	}
}

// corpusRules is the claims of each of fixtures, in the corpus at root, and the rules recorder saw each one's rewrite
// apply, both keyed by fixture.
func corpusRules(t *testing.T, root string, fixtures []string, recorder *appliedRules) (map[string][]claim, map[string]map[emit.Rule]bool) {
	t.Helper()
	claimed := map[string][]claim{}
	applied := map[string]map[emit.Rule]bool{}
	for _, fixture := range fixtures {
		claims, err := readClaims(os.DirFS(root), fixture)
		if err != nil {
			t.Fatal(err)
		}
		claimed[fixture] = claims
		applied[fixture] = recorder.byFile[path.Join(root, fixture, fixtureInput)]
	}
	return claimed, applied
}

func TestCatalogGaps(t *testing.T) {
	t.Parallel()
	rules := emit.Rules()
	if len(rules) < 2 {
		t.Fatalf("emit.Rules() = %d rules, want at least 2", len(rules))
	}
	all := map[emit.Rule]bool{}
	var everyClaim []claim
	for i, r := range rules {
		all[r] = true
		everyClaim = append(everyClaim, claim{file: fixtureInput, line: i + 1, rule: r})
	}
	first := claim{file: fixtureInput, line: 1, rule: rules[0]}
	tests := []struct {
		claimed       map[string][]claim
		applied       map[string]map[emit.Rule]bool
		name          string
		wantGaps      []claimGap
		wantUncovered []emit.Rule
	}{
		{
			name:          "a claim its fixture's rewrite does not apply is a gap and covers nothing",
			claimed:       map[string][]claim{sampleFixture: {first}},
			applied:       map[string]map[emit.Rule]bool{sampleFixture: {rules[1]: true}},
			wantGaps:      []claimGap{{fixture: sampleFixture, claim: first}},
			wantUncovered: rules,
		},
		{
			name:          "a rule applied only by another fixture's rewrite does not bear the claim out",
			claimed:       map[string][]claim{sampleFixture: {first}, "each/banana": nil},
			applied:       map[string]map[emit.Rule]bool{"each/banana": {rules[0]: true}},
			wantGaps:      []claimGap{{fixture: sampleFixture, claim: first}},
			wantUncovered: rules,
		},
		{
			name:          "a rule no fixture claims is uncovered even when a rewrite applies it",
			claimed:       map[string][]claim{sampleFixture: everyClaim[1:]},
			applied:       map[string]map[emit.Rule]bool{sampleFixture: all},
			wantUncovered: rules[:1],
		},
		{
			name:    "every rule claimed and applied leaves no gap",
			claimed: map[string][]claim{sampleFixture: everyClaim},
			applied: map[string]map[emit.Rule]bool{sampleFixture: all},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			gaps, uncovered := catalogGaps(tt.claimed, tt.applied)

			if diff := cmp.Diff(tt.wantGaps, gaps, cmp.AllowUnexported(claimGap{}, claim{})); diff != "" {
				t.Errorf("catalogGaps() gaps mismatch (-want +got):\n%s", diff)
			}
			if diff := cmp.Diff(tt.wantUncovered, uncovered); diff != "" {
				t.Errorf("catalogGaps() uncovered mismatch (-want +got):\n%s", diff)
			}
		})
	}
}

func TestReadClaims_WhenEachCommentNamesOneRule_ReadsThemInLineOrder(t *testing.T) {
	t.Parallel()
	rules := emit.Rules()
	source := "export const banana = 1;\n" + claimPrefix + " " + rules[0].Name() + "\n  " + claimPrefix + " " +
		rules[1].Name() + "\n"
	corpus := fstest.MapFS{sampleFixture + "/" + fixtureInput: {Data: []byte(source)}}
	want := []claim{{file: fixtureInput, line: 2, rule: rules[0]}, {file: fixtureInput, line: 3, rule: rules[1]}}

	got, err := readClaims(corpus, sampleFixture)
	if err != nil {
		t.Fatalf("readClaims() error = %v, want nil", err)
	}

	if diff := cmp.Diff(want, got, cmp.AllowUnexported(claim{})); diff != "" {
		t.Errorf("readClaims() mismatch (-want +got):\n%s", diff)
	}
}

func TestReadClaims_RejectsNamingTheFixtureLine(t *testing.T) {
	t.Parallel()
	rules := emit.Rules()
	tests := []struct {
		name    string
		comment string
	}{
		{name: "a name outside the catalog", comment: claimPrefix + " banana"},
		{name: "two rules on one line", comment: claimPrefix + " " + rules[0].Name() + ", " + rules[1].Name()},
		{name: "no colon", comment: "// rewrite-applies " + rules[0].Name()},
		{name: "singular keyword", comment: "// rewrite-apply: " + rules[0].Name()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			source := "export const banana = 1;\n" + tt.comment + "\n"
			corpus := fstest.MapFS{sampleFixture + "/" + fixtureInput: {Data: []byte(source)}}

			_, err := readClaims(corpus, sampleFixture)

			if err == nil || !strings.Contains(err.Error(), "fixture bail/sample: input.ts:2:") {
				t.Errorf("readClaims(%q) error = %v, want one naming fixture bail/sample: input.ts:2", tt.comment, err)
			}
		})
	}
}

func TestParseExpectation(t *testing.T) {
	t.Parallel()
	shape := facts.ReasonShapeUnresolved.Info()
	async := facts.ReasonCallbackAsync.Info()
	tests := []struct {
		name    string
		comment string
		want    expected
	}{
		{
			name:    "strict reason is code then ID",
			comment: fmt.Sprintf("// expect-diagnostic: %d %s", shape.Code, shape.ID),
			want:    expected{file: fixtureInput, id: shape.ID, line: 8, code: shape.Code},
		},
		{
			name:    "warning reason leads with the warning mark",
			comment: fmt.Sprintf("// expect-diagnostic: warning %d %s", async.Code, async.ID),
			want:    expected{file: fixtureInput, id: async.ID, line: 8, code: async.Code, warning: true},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := parseExpectation(sampleFixture, fixtureInput, tt.comment, 7)
			if err != nil {
				t.Fatalf("parseExpectation(%q) error = %v, want nil", tt.comment, err)
			}

			if got != tt.want {
				t.Errorf("parseExpectation(%q) = %+v, want %+v", tt.comment, got, tt.want)
			}
		})
	}
}

func TestParseExpectation_RejectsNamingTheFixtureLine(t *testing.T) {
	t.Parallel()
	shape := facts.ReasonShapeUnresolved.Info()
	async := facts.ReasonCallbackAsync.Info()
	tests := []struct {
		name    string
		comment string
	}{
		{name: "ID before code", comment: fmt.Sprintf("// expect-diagnostic: %s %d", shape.ID, shape.Code)},
		{name: "trailing warning mark", comment: fmt.Sprintf("// expect-diagnostic: %d %s warning", async.Code, async.ID)},
		{name: "missing ID", comment: fmt.Sprintf("// expect-diagnostic: %d", shape.Code)},
		{name: "ID and code of different reasons", comment: fmt.Sprintf("// expect-diagnostic: %d %s", shape.Code, async.ID)},
		{name: "code outside the catalog", comment: "// expect-diagnostic: 12345 " + shape.ID},
		{name: "warning mark on a strict reason", comment: fmt.Sprintf("// expect-diagnostic: warning %d %s", shape.Code, shape.ID)},
		{name: "warning reason without the mark", comment: fmt.Sprintf("// expect-diagnostic: %d %s", async.Code, async.ID)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			_, err := parseExpectation(sampleFixture, fixtureInput, tt.comment, 7)

			if err == nil || !strings.Contains(err.Error(), "fixture bail/sample: input.ts:7:") {
				t.Errorf("parseExpectation(%q) error = %v, want one naming fixture bail/sample: input.ts:7", tt.comment, err)
			}
		})
	}
}

func TestReadExpectations_RejectsANearMissNamingTheFixtureLine(t *testing.T) {
	t.Parallel()
	shape := facts.ReasonShapeUnresolved.Info()
	tests := []struct {
		name    string
		comment string
	}{
		{name: "plural keyword", comment: fmt.Sprintf("// expect-diagnostics: %d %s", shape.Code, shape.ID)},
		{name: "no space after the slashes", comment: fmt.Sprintf("//expect-diagnostic: %d %s", shape.Code, shape.ID)},
		{name: "no colon", comment: fmt.Sprintf("// expect-diagnostic %d %s", shape.Code, shape.ID)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			source := "export const banana = 1;\n  " + tt.comment + "\nconsole.log(banana);\n"
			corpus := fstest.MapFS{sampleFixture + "/" + fixtureInput: {Data: []byte(source)}}

			_, err := readExpectations(corpus, sampleFixture)

			if err == nil || !strings.Contains(err.Error(), "fixture bail/sample: input.ts:2:") {
				t.Errorf("readExpectations(%q) error = %v, want one naming fixture bail/sample: input.ts:2", tt.comment, err)
			}
		})
	}
}

func TestMatchGolden_WhenUpdating_WritesGotExactly(t *testing.T) {
	t.Parallel()
	dir := project.Write(t, map[string]string{fixtureGolden: "export const banana = 1;\n"})
	got := "export const banana = 2;\nexport const split = banana;"

	err := matchGolden(dir, fixtureGolden, got, true)
	if err != nil {
		t.Fatalf("matchGolden(update = true) error = %v, want nil", err)
	}

	written := fileText(t, filepath.Join(dir, fixtureGolden))
	if written != got {
		t.Errorf("golden after matchGolden(update = true) = %q, want %q", written, got)
	}
}

func TestMatchGolden_WhenComparing_RejectsNamingTheFix(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{
			name:  "differing golden names the golden",
			files: map[string]string{fixtureGolden: "export const banana = 1;\nexport const split = 2;\n"},
			want:  "output differs from " + fixtureGolden,
		},
		{
			name:  "missing golden names the update command",
			files: map[string]string{},
			want:  "go test ./internal/ttscadapter -update",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			dir := project.Write(t, tt.files)

			err := matchGolden(dir, fixtureGolden, "export const banana = 1;\nexport const split = 3;\n", false)

			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Errorf("matchGolden(update = false) error = %v, want one containing %q", err, tt.want)
			}
		})
	}
}

func TestStrayDiagnostics(t *testing.T) {
	t.Parallel()
	fixtures := []string{sampleFixture}
	shape := facts.ReasonShapeUnresolved.Info()
	diagnostic := []found{{file: "schema.ts", id: shape.ID, category: categoryError, line: 3, code: shape.Code}}
	tests := []struct {
		name    string
		strict  map[string][]found
		lenient map[string][]found
		want    []stray
	}{
		{
			name:    "strict run outside a fixture",
			strict:  map[string][]found{".": diagnostic},
			lenient: map[string][]found{},
			want:    []stray{{run: "strict", dir: "."}},
		},
		{
			name:    "lenient run outside a fixture",
			strict:  map[string][]found{},
			lenient: map[string][]found{".": diagnostic},
			want:    []stray{{run: "lenient", dir: "."}},
		},
		{
			name:    "both runs inside a fixture",
			strict:  map[string][]found{sampleFixture: diagnostic},
			lenient: map[string][]found{sampleFixture: diagnostic},
			want:    nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := strayDiagnostics(fixtures, tt.strict, tt.lenient)

			if !slices.Equal(got, tt.want) {
				t.Errorf("strayDiagnostics() = %+v, want %+v", got, tt.want)
			}
		})
	}
}
