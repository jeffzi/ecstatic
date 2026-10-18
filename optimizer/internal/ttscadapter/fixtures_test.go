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
	"testing"
	"testing/fstest"

	"github.com/google/go-cmp/cmp"
	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/samchon/ttsc/packages/ttsc/driver"

	"github.com/jeffzi/ecstatic/optimizer/internal/analysis"
	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/golden"
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
	"github.com/jeffzi/ecstatic/optimizer/internal/ttscadapter"
)

// fixtureRoot is the fixture corpus, relative to this package.
const fixtureRoot = "../../../tests/optimizer/fixtures"

const (
	fixtureInput   = "input.ts"
	fixtureGolden  = "expected.ts.golden"
	bailCorpus     = "bail"
	eligibleCorpus = "eligible"
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
	abs, err := filepath.Abs(fixtureRoot)
	if err != nil {
		t.Fatalf("filepath.Abs(%q) error = %v, want nil", fixtureRoot, err)
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		t.Fatalf("filepath.EvalSymlinks(%q) error = %v, want nil", abs, err)
	}
	return filepath.ToSlash(resolved)
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

// assertCorpusRan fails the test now unless the corpus transform exited OK or with diagnostics.
func assertCorpusRan(t *testing.T, got result) {
	t.Helper()
	if got.status != statusOK && got.status != statusDiagnostics {
		t.Fatalf("Run(transform) over the fixture corpus = %d, want %d or %d; stderr = %q",
			got.status, statusOK, statusDiagnostics, got.stderr)
	}
}

// transformCorpus runs the transform subcommand once over the corpus at root with pluginsJSON, analyzing each file
// with analyze.
func transformCorpus(t *testing.T, root, pluginsJSON string, analyze analyzer) corpusRun {
	t.Helper()
	got := runArgv(sidecarArgv("transform", root, pluginsJSON), analyze)
	assertCorpusRan(t, got)
	return corpusRun{env: decodeEnvelope(t, got.stdout), status: got.status}
}

// planRecorder analyzes as Run does and records the plan of each file it analyzes in planned, keyed by file name.
func planRecorder(planned map[string][]plan.Bail) analyzer {
	return func(prog *driver.Program, file *ast.SourceFile, roots *analysis.PackageRoots) []facts.Site {
		sites := analyzeProgram(prog, file, roots)
		planned[file.FileName()] = plan.Plan(sites)
		return sites
	}
}

func plansNotRewrittenEach(b plan.Bail) bool {
	return b.Op == facts.OpEach && b.Reason == facts.ReasonOpNotRewritten
}

// assertAnalyzed fails t unless fixture's input was analyzed as a project file of the corpus at root.
func assertAnalyzed(t *testing.T, planned map[string][]plan.Bail, root, fixture string) {
	t.Helper()
	if _, analyzed := planned[path.Join(root, fixture, fixtureInput)]; !analyzed {
		t.Fatalf("fixture %s: %s was not analyzed as a project file; the corpus tsconfig.json leaves it out",
			fixture, fixtureInput)
	}
}

// assertPlansNotRewritten fails t unless some each site of fixture's input in the corpus at root plans
// OP_NOT_REWRITTEN.
func assertPlansNotRewritten(t *testing.T, planned map[string][]plan.Bail, root, fixture string) {
	t.Helper()
	if !slices.ContainsFunc(planned[path.Join(root, fixture, fixtureInput)], plansNotRewrittenEach) {
		t.Errorf("fixture %s: no each site of %s plans %s",
			fixture, fixtureInput, facts.ReasonOpNotRewritten.Info().ID)
	}
}

// runPlanChecks registers the plan checks for one fixture as separate t.Run cases: its input was analyzed as a project
// file and, for an eligible fixture, some each site of it plans not rewritten.
func runPlanChecks(t *testing.T, planned map[string][]plan.Bail, root, fixture string) {
	t.Helper()
	t.Run("input is analyzed as a project file", func(t *testing.T) {
		t.Parallel()
		assertAnalyzed(t, planned, root, fixture)
	})
	if strings.HasPrefix(fixture, eligibleCorpus+"/") {
		t.Run("eligible each site plans not rewritten", func(t *testing.T) {
			t.Parallel()
			assertPlansNotRewritten(t, planned, root, fixture)
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

	planned := map[string][]plan.Bail{}

	strict := transformCorpus(t, root, strictPlugins, planRecorder(planned))
	lenient := transformCorpus(t, root, lenientPlugins, analyzeProgram)

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
			runPlanChecks(t, planned, root, fixture)
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
