package facts_test

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
	"github.com/jeffzi/ecstatic/optimizer/internal/project"
)

func TestSite_AddDeclarationFile(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		files []string
		want  []string
	}{
		{
			name:  "out of order kept sorted",
			files: []string{"/p/c.ts", "/p/a.ts", "/p/b.ts"},
			want:  []string{"/p/a.ts", "/p/b.ts", "/p/c.ts"},
		},
		{
			name:  "duplicate dropped",
			files: []string{"/p/b.ts", "/p/a.ts", "/p/b.ts"},
			want:  []string{"/p/a.ts", "/p/b.ts"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			var site facts.Site

			for _, file := range tt.files {
				site.AddDeclarationFile(file)
			}

			if diff := cmp.Diff(tt.want, site.DeclarationFiles); diff != "" {
				t.Errorf("DeclarationFiles after adding %q mismatch (-want +got):\n%s", tt.files, diff)
			}
		})
	}
}

// tag returns a non-relation component with no fields.
func tag(name string) facts.Component {
	return facts.Component{Name: name}
}

func numberField(name string) facts.Field {
	return facts.Field{Name: name, Kind: facts.FieldNumber}
}

// requiredOnly returns a shape whose required components are comps and that has no optionals.
func requiredOnly(comps ...facts.Component) facts.ArchShape {
	return facts.ArchShape{Required: comps}
}

// shipShape is `class Ship extends Archetype([Position], [Shield, Stunned, Boost])`.
func shipShape() facts.ArchShape {
	return facts.ArchShape{
		Required: []facts.Component{{Name: "Position", Fields: []facts.Field{numberField("x"), numberField("y")}}},
		Optional: []facts.Component{
			{Name: "Shield", Fields: []facts.Field{numberField("hp")}},
			tag("Stunned"),
			tag("Boost"),
		},
	}
}

type keyCase struct {
	name  string
	want  string
	shape facts.ArchShape
}

// keyCases pairs representative shapes with the exact key the runtime guard
// must compute for them.
func keyCases() []keyCase {
	return append(fieldKeyCases(), nameKeyCases()...)
}

// fieldKeyCases covers how fields, their kinds, and the relation flag enter the key.
func fieldKeyCases() []keyCase {
	return []keyCase{
		{
			name:  "required then optional, each name length-prefixed",
			shape: shipShape(),
			want:  "c8:Position{1:x=n,1:y=n}|c6:Shield{2:hp=n}c7:Stunned{}c5:Boost{}",
		},
		{
			name: "fields sorted by name with their column kinds",
			shape: requiredOnly(facts.Component{
				Name: "Body",
				Fields: []facts.Field{
					{Name: "z", Kind: facts.FieldBoolean},
					{Name: "a", Kind: facts.FieldPlain},
					{Name: "m", Kind: facts.FieldNumber},
				},
			}),
			want: "c4:Body{1:a=p,1:m=n,1:z=b}|",
		},
		{
			name: "relation flag",
			shape: requiredOnly(facts.Component{
				Name:     "ChildOf",
				Fields:   []facts.Field{numberField("order")},
				Relation: true,
			}),
			want: "r7:ChildOf{5:order=n}|",
		},
		{
			name: "field names sorted by UTF-16 code unit, astral before high BMP",
			shape: requiredOnly(facts.Component{
				Name: "Glyph",
				Fields: []facts.Field{
					numberField("Ａ"),
					numberField("\U0001D400"),
				},
			}),
			want: "c5:Glyph{2:\U0001D400=n,1:Ａ=n}|",
		},
	}
}

// nameKeyCases covers how component names and their lengths enter the key.
func nameKeyCases() []keyCase {
	return []keyCase{
		{
			name:  "comma inside a name stays one component",
			shape: requiredOnly(tag("A,B")),
			want:  "c3:A,B{}|",
		},
		{
			name:  "two components",
			shape: requiredOnly(tag("A"), tag("B")),
			want:  "c1:A{}c1:B{}|",
		},
		{
			name:  "optional-only shape",
			shape: facts.ArchShape{Optional: []facts.Component{tag("A")}},
			want:  "|c1:A{}",
		},
		{
			name:  "non-ASCII name length counts UTF-16 code units",
			shape: requiredOnly(tag("Δ")),
			want:  "c1:Δ{}|",
		},
		{
			name:  "astral-plane name length counts a surrogate pair as two",
			shape: requiredOnly(tag("Rocket\U0001F680")),
			want:  "c8:Rocket\U0001F680{}|",
		},
	}
}

func TestArchShape_Key(t *testing.T) {
	t.Parallel()
	for _, tt := range keyCases() {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := tt.shape.Key()

			if got != tt.want {
				t.Errorf("Key() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestArchShape_Key_WhenFieldsUnsorted_LeavesShapeFieldsInDeclarationOrder(t *testing.T) {
	t.Parallel()
	shape := requiredOnly(facts.Component{
		Name:   "Body",
		Fields: []facts.Field{numberField("z"), numberField("a")},
	})
	want := slices.Clone(shape.Required[0].Fields)

	_ = shape.Key()

	if diff := cmp.Diff(want, shape.Required[0].Fields); diff != "" {
		t.Errorf("Fields after Key() mismatch, want declaration order (-want +got):\n%s", diff)
	}
}

// reasonRows is the expected reason catalog, in catalog order.
var reasonRows = []struct { //nolint:gochecknoglobals // read-only table shared by the catalog tests
	want   facts.ReasonInfo
	reason facts.Reason
}{
	{
		reason: facts.ReasonShapeUnresolved,
		want: facts.ReasonInfo{
			Code:     99910,
			ID:       "SHAPE_UNRESOLVED",
			Category: facts.CategoryStrict,
			Text:     "the storage's archetype shape is not known statically",
			Hint:     "Type the storage as `Storage<typeof X>` or `Storage<X>`.",
		},
	},
	{
		reason: facts.ReasonStoragesDynamic,
		want: facts.ReasonInfo{
			Code:     99912,
			ID:       "STORAGES_DYNAMIC",
			Category: facts.CategoryStrict,
			Text:     "the storages argument is not an array literal of typed storages",
		},
	},
	{
		reason: facts.ReasonCallbackNotInline,
		want: facts.ReasonInfo{
			Code:     99913,
			ID:       "CALLBACK_NOT_INLINE",
			Category: facts.CategoryStrict,
			Text:     "the callback is not written inline",
			Hint:     "Write `(e) => { ... }` at the call site.",
		},
	},
	{
		reason: facts.ReasonCallbackParams,
		want: facts.ReasonInfo{
			Code:     99914,
			ID:       "CALLBACK_PARAMS",
			Category: facts.CategoryStrict,
			Text: "the callback has a defaulted, rest, or array-pattern parameter, more than one parameter, " +
				"or a `var` redeclaring a destructured parameter",
			Hint: "Use `(e)` or an object pattern.",
		},
	},
	{
		reason: facts.ReasonCallbackAsync,
		want: facts.ReasonInfo{
			Code:     99915,
			ID:       "CALLBACK_ASYNC",
			Category: facts.CategoryWarning,
			Text:     "the callback is async",
			Hint:     "Views are valid only until the callback returns; collect ids and await between passes.",
		},
	},
	{
		reason: facts.ReasonCallbackGenerator,
		want: facts.ReasonInfo{
			Code:     99916,
			ID:       "CALLBACK_GENERATOR",
			Category: facts.CategoryStrict,
			Text:     "the callback is a generator function",
		},
	},
	{
		reason: facts.ReasonCallbackFunctionBindings,
		want: facts.ReasonInfo{
			Code:     99917,
			ID:       "CALLBACK_FUNCTION_BINDINGS",
			Category: facts.CategoryStrict,
			Text:     "the callback uses `this`, `arguments`, `new.target`, or its own name",
			Hint:     "Use an arrow function.",
		},
	},
	{
		reason: facts.ReasonInternal,
		want: facts.ReasonInfo{
			Code:     99920,
			ID:       "INTERNAL",
			Category: facts.CategoryStrict,
			Text:     "internal error (`<detail>`); please report it",
		},
	},
	{
		reason: facts.ReasonArgCount,
		want: facts.ReasonInfo{
			ID:       "ARG_COUNT",
			Category: facts.CategorySilent,
			Text:     "argument count matches no rewritable overload",
		},
	},
	{
		reason: facts.ReasonNotStatement,
		want: facts.ReasonInfo{
			ID:       "NOT_STATEMENT",
			Category: facts.CategorySilent,
			Text:     "the call's value is used",
		},
	},
	{
		reason: facts.ReasonOpNotRewritten,
		want: facts.ReasonInfo{
			ID:       "OP_NOT_REWRITTEN",
			Category: facts.CategorySilent,
			Text:     "the op has no rewrite in this version",
		},
	},
}

func TestReason_Info(t *testing.T) {
	t.Parallel()
	for _, row := range reasonRows {
		t.Run(row.want.ID, func(t *testing.T) {
			t.Parallel()

			got := row.reason.Info()

			if diff := cmp.Diff(row.want, got); diff != "" {
				t.Errorf("Reason(%d).Info() mismatch (-want +got):\n%s", row.reason, diff)
			}
		})
	}
}

func TestReasons_WhenComparedWithTheReasonTable_ListsEveryReasonInOrder(t *testing.T) {
	t.Parallel()
	want := make([]facts.Reason, 0, len(reasonRows))
	for _, row := range reasonRows {
		want = append(want, row.reason)
	}

	got := facts.Reasons()

	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Reasons() mismatch (-want +got):\n%s", diff)
	}
}

func TestReasons_WhenReasonsCarryACode_NoTwoShareIt(t *testing.T) {
	t.Parallel()
	seen := map[int]string{}

	for _, r := range facts.Reasons() {
		info := r.Info()
		if info.Code == 0 {
			continue
		}
		if prev, dup := seen[info.Code]; dup {
			t.Errorf("%s and %s share code %d", prev, info.ID, info.Code)
		}
		seen[info.Code] = info.ID
	}
}

// The public API is read from the TypeScript source with two line-shaped
// patterns rather than a parser:
//
//   - src/index.ts re-exports values with `export { a, b as c } from "./m.js"`;
//     `type` entries and `export type { ... }` blocks are skipped.
//   - Each re-exported name is then classified in its module by its declaring
//     line: `export function name` is a function, `export const|let|var|class|enum
//     name` is not.
//
// Any other export shape (`export *`, `export default`, a name the module
// declares some other way) fails the test instead of being guessed, so a new
// shape is noticed rather than silently dropped.
const (
	indexFile = "index.ts"

	exportDeclare    = `(?m)^export\s+(?:declare\s+)?`
	exportFunction   = exportDeclare + `(?:async\s+)?function`
	nonFunctionKinds = `const|let|var|class|enum`
)

var (
	reExportPattern   = regexp.MustCompile(`export\s*\{([^}]*)\}\s*from\s*"([^"]+)"`)
	unsupportedExport = regexp.MustCompile(`(?m)^export\s+(?:\*|default\b)`)
	directExport      = regexp.MustCompile(exportDeclare + `(?:async\s+)?(?:function|` + nonFunctionKinds + `)\b`)
)

// exportedNameAndLocal splits a re-export entry `local` or `local as exported`.
func exportedNameAndLocal(entry string) (exported, local string) {
	local, exported, renamed := strings.Cut(entry, " as ")
	if !renamed {
		exported = local
	}
	return strings.TrimSpace(exported), strings.TrimSpace(local)
}

// isFunctionDeclaration reports whether module exports name as a function, failing the test when it declares name some other way.
func isFunctionDeclaration(t *testing.T, module, name string) bool {
	t.Helper()
	quoted := regexp.QuoteMeta(name)
	function := regexp.MustCompile(exportFunction + `\*?\s+` + quoted + `\b`)
	nonFunction := regexp.MustCompile(exportDeclare + `(?:` + nonFunctionKinds + `)\s+` + quoted + `\b`)
	switch {
	case function.MatchString(module):
		return true
	case nonFunction.MatchString(module):
		return false
	default:
		t.Fatalf("cannot tell whether %q is a function: no `export function` or `export %s` line declares it", name, nonFunctionKinds)
		return false
	}
}

// modulePath maps a `./m.js` import specifier to its `m.ts` source path.
func modulePath(specifier string) string {
	return strings.TrimSuffix(strings.TrimPrefix(specifier, "./"), ".js") + ".ts"
}

// indexFunctionExports lists the functions src/index.ts exports, sorted.
func indexFunctionExports(t *testing.T) []string {
	t.Helper()
	files := project.Runtime(t, nil)
	index, ok := files["src/"+indexFile]
	if !ok {
		t.Fatalf("src/%s is missing from the runtime sources", indexFile)
	}
	if unsupportedExport.MatchString(index) || directExport.MatchString(index) {
		t.Fatal("src/index.ts uses an export shape the scanner does not read; extend the scanner")
	}

	var names []string
	for _, match := range reExportPattern.FindAllStringSubmatch(index, -1) {
		entries, specifier := match[1], match[2]
		path := modulePath(specifier)
		module, ok := files["src/"+path]
		if !ok {
			t.Fatalf("src/%s is missing from the runtime sources", path)
		}
		for entry := range strings.SplitSeq(entries, ",") {
			entry = strings.TrimSpace(entry)
			if entry == "" || strings.HasPrefix(entry, "type ") {
				continue
			}
			exported, local := exportedNameAndLocal(entry)
			if isFunctionDeclaration(t, module, local) {
				names = append(names, exported)
			}
		}
	}
	slices.Sort(names)
	return names
}

func TestOps_WhenComparedWithIndexExports_NameEveryFunction(t *testing.T) {
	t.Parallel()
	want := indexFunctionExports(t)

	ops := facts.Ops()
	got := make([]string, 0, len(ops))
	for _, op := range ops {
		got = append(got, op.Name())
	}
	slices.Sort(got)

	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("Op names mismatch, want the function exports of src/index.ts (-want +got):\n%s", diff)
	}
}

func TestOpByName_FindsEveryOpByItsName(t *testing.T) {
	t.Parallel()
	for _, op := range facts.Ops() {
		t.Run(op.Name(), func(t *testing.T) {
			t.Parallel()

			got, ok := facts.OpByName(op.Name())

			if !ok || got != op {
				t.Errorf("OpByName(%q) = %v, %t, want %v, true", op.Name(), got, ok, op)
			}
		})
	}
}

func TestOpByName_ReportsUnknownNamesAsNotFound(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		in   string
	}{
		{name: "empty", in: ""},
		{name: "not an ecstatic function", in: "banana"},
		{name: "module export missing from index", in: "eachStorageMatched"},
		{name: "case differs from a declaration", in: "Each"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, ok := facts.OpByName(tt.in)

			if ok {
				t.Errorf("OpByName(%q) = %v, true, want not found", tt.in, got)
			}
		})
	}
}

func TestOp_Iterates_AgreesWithTheOverloadData(t *testing.T) {
	t.Parallel()
	for _, op := range facts.Ops() {
		t.Run(op.Name(), func(t *testing.T) {
			t.Parallel()
			want := len(acceptedArgCounts(op)) > 0

			got := op.Iterates()

			if got != want {
				t.Errorf("%s.Iterates() = %t, want %t", op.Name(), got, want)
			}
		})
	}
}

// The accepted argument counts of an iteration op are read from the overload
// signatures of its declaration, with a bracket-balancing scan rather than a
// parser:
//
//   - Every `export function name` (optionally `declare`, `async`) in the
//     module starts a signature. An optional `<...>` type-parameter list is
//     skipped, then the `(...)` parameter list is split on its top-level
//     commas. Nesting counts `()`, `[]`, `{}`, and `<>` (the `>` of `=>` is
//     not a bracket). Comments and the contents of string and template
//     literals are dropped from each parameter before it is classified, so a
//     `:`, `?`, or `=` inside one never counts.
//   - After the parameter list, `: ReturnType` ends in `;` for an overload or
//     `{` for the implementation, whose parameters are not classified.
//   - An overload accepts every count from its required parameters (no `?`) to
//     all of them. A `this` parameter is never passed, so it is not counted.
//
// A rest parameter or an initializer in an overload (TypeScript forbids
// initializers there, so one can only be a misread), a missing parameter list
// or return type, an unbalanced bracket, a module with no overloads, or more
// than one signature with a body (an overload returning an object type would
// read as one) fails the test instead of being guessed, so a new shape is
// noticed rather than silently miscounted.

// maxProbedArgCount is the highest argument count the overload tests probe.
// It must be at least the largest parameter count of any each or query
// overload: overloadArgCounts fails when an overload exceeds it.
const maxProbedArgCount = 6

// errOverloadInitializer marks an overload parameter read with an initializer,
// which TypeScript forbids in overload signatures, so it can only be a misread.
var errOverloadInitializer = errors.New("overload parameter has an initializer")

// signatureScanner walks TypeScript source one byte at a time, skipping
// comments and string literals. The first failure is kept in err and ends the
// scan by moving pos to the end of text.
type signatureScanner struct {
	err  error
	text string
	pos  int
}

// fail records err unless an earlier failure is already recorded, and ends the scan.
func (s *signatureScanner) fail(err error) {
	if s.err == nil {
		s.err = err
	}
	s.pos = len(s.text)
}

// skipTrivia advances past whitespace and comments.
func (s *signatureScanner) skipTrivia() {
	for s.pos < len(s.text) {
		rest := s.text[s.pos:]
		switch {
		case strings.HasPrefix(rest, "//"):
			end := strings.IndexByte(rest, '\n')
			if end < 0 {
				end = len(rest)
			}
			s.pos += end
		case strings.HasPrefix(rest, "/*"):
			end := strings.Index(rest, "*/")
			if end < 0 {
				s.fail(errors.New("unterminated block comment"))
				return
			}
			s.pos += end + len("*/")
		case strings.ContainsRune(" \t\r\n", rune(rest[0])):
			s.pos++
		default:
			return
		}
	}
}

// skipString advances past the string literal opening at the current byte.
func (s *signatureScanner) skipString() {
	quote := s.text[s.pos]
	for s.pos++; s.pos < len(s.text); s.pos++ {
		switch s.text[s.pos] {
		case '\\':
			s.pos++
		case quote:
			s.pos++
			return
		}
	}
	s.fail(errors.New("unterminated string literal"))
}

// skipOpaque advances past the whitespace, comments, string literal, or `=>`
// at the current byte, whose bytes are never brackets or commas, writing their
// code view to item, and reports whether it advanced.
func (s *signatureScanner) skipOpaque(item *strings.Builder) bool {
	before := s.pos
	s.skipTrivia()
	if s.pos > before {
		item.WriteByte(' ')
		return true
	}
	switch rest := s.text[s.pos:]; {
	case rest[0] == '"' || rest[0] == '\'' || rest[0] == '`':
		s.skipString()
		item.WriteString(`""`)
	case strings.HasPrefix(rest, "=>"):
		s.pos += len("=>")
		item.WriteString("=>")
	default:
		return false
	}
	return true
}

// balanced scans the bracketed list opening at the current byte and returns
// each top-level, comma-separated item, leaving pos after the closing bracket.
// An item is a code view of its text: each run of whitespace and comments
// reads as one space and each string or template literal as `""`, so
// classifying an item never sees a colon, `?`, or `=` written inside one.
func (s *signatureScanner) balanced() []string {
	depth := 0
	var items []string
	var item strings.Builder
	for s.pos < len(s.text) {
		if s.skipOpaque(&item) {
			continue
		}
		c := s.text[s.pos]
		switch {
		case strings.IndexByte("([{<", c) >= 0:
			depth++
			if depth == 1 {
				s.pos++
				continue
			}
		case strings.IndexByte(")]}>", c) >= 0:
			depth--
			if depth == 0 {
				s.pos++
				return append(items, item.String())
			}
		case c == ',' && depth == 1:
			items = append(items, item.String())
			item.Reset()
			s.pos++
			continue
		}
		item.WriteByte(c)
		s.pos++
	}
	s.fail(errors.New("unbalanced brackets in a signature"))
	return nil
}

// expect records a failure unless the next non-trivia byte is c.
func (s *signatureScanner) expect(c byte, what string) {
	s.skipTrivia()
	if s.pos >= len(s.text) || s.text[s.pos] != c {
		s.fail(fmt.Errorf("want %s at offset %d, found %.20q", what, s.pos, s.text[s.pos:]))
	}
}

// overloadArity returns the required and total parameter counts of the
// signature starting at pos, and whether it is an overload rather than the
// implementation, whose parameters are not classified.
func (s *signatureScanner) overloadArity() (required, total int, overload bool) {
	s.skipTrivia()
	if s.pos < len(s.text) && s.text[s.pos] == '<' {
		s.balanced()
	}
	s.expect('(', "a parameter list")
	params := s.balanced()
	s.expect(':', "a return type")
	end := strings.IndexAny(s.text[s.pos:], ";{")
	if end < 0 {
		s.fail(errors.New("signature has no `;` or body after its return type"))
		return 0, 0, false
	}
	s.pos += end
	if s.text[s.pos] == '{' {
		return 0, 0, false
	}
	required, total, err := parameterArity(params)
	if err != nil {
		s.fail(err)
	}
	return required, total, true
}

// parameterArity counts the required and total arguments of an overload's
// parameters, given as the code view balanced returns.
//
// A `this` parameter only types the receiver and is never passed, so it is not
// counted. A parameter is optional when its name ends in `?`; an overload
// cannot declare a default.
//
// It returns an error wrapping errOverloadInitializer for a parameter with an
// initializer, and an error for a rest parameter, whose arity is not fixed.
func parameterArity(params []string) (required, total int, err error) {
	for _, param := range params {
		param = strings.TrimSpace(param)
		head, _, _ := strings.Cut(param, ":")
		head = strings.TrimSpace(head)
		switch {
		case param == "" || head == "this":
			continue
		case strings.HasPrefix(param, "..."):
			return 0, 0, fmt.Errorf("rest parameter %q has no fixed arity; extend the scanner", param)
		case strings.Contains(strings.ReplaceAll(param, "=>", ""), "="):
			return 0, 0, fmt.Errorf("%w: %q", errOverloadInitializer, param)
		}
		total++
		if !strings.HasSuffix(head, "?") {
			required++
		}
	}
	return required, total, nil
}

// overloadArgCounts returns the argument counts the overloads of the function
// name in the TypeScript source text accept, sorted, or an error when a
// signature has a shape the scanner does not read.
func overloadArgCounts(text, name string) ([]int, error) {
	start := regexp.MustCompile(exportFunction + `\s+` + regexp.QuoteMeta(name) + `\b`)
	var counts []int
	implementations := 0
	for _, match := range start.FindAllStringIndex(text, -1) {
		s := &signatureScanner{text: text, pos: match[1]}
		required, total, overload := s.overloadArity()
		if s.err != nil {
			return nil, fmt.Errorf("signature of %s at offset %d: %w", name, match[0], s.err)
		}
		if !overload {
			implementations++
			continue
		}
		if total > maxProbedArgCount {
			return nil, fmt.Errorf("an overload of %s takes %d parameters, more than the %d probed; raise maxProbedArgCount", name, total, maxProbedArgCount)
		}
		for count := required; count <= total; count++ {
			counts = append(counts, count)
		}
	}
	slices.Sort(counts)
	counts = slices.Compact(counts)
	if len(counts) == 0 || implementations > 1 {
		return nil, fmt.Errorf("found %d overload counts and %d bodies for %s, want overloads and at most one body; extend the scanner", len(counts), implementations, name)
	}
	return counts, nil
}

// declaredArgCounts returns the argument counts the overloads of the function
// name in src/module accept, sorted, failing the test when they cannot be read.
func declaredArgCounts(t *testing.T, module, name string) []int {
	t.Helper()
	source, ok := project.Runtime(t, nil)["src/"+module]
	if !ok {
		t.Fatalf("src/%s is missing from the runtime sources", module)
	}
	counts, err := overloadArgCounts(source, name)
	if err != nil {
		t.Fatalf("src/%s: %v", module, err)
	}
	return counts
}

// acceptedArgCounts lists the counts up to maxProbedArgCount that op accepts.
func acceptedArgCounts(op facts.Op) []int {
	var counts []int
	for count := range maxProbedArgCount + 1 {
		if op.MatchesArgCount(count) {
			counts = append(counts, count)
		}
	}
	return counts
}

func TestOp_MatchesArgCount_AgreesWithTheDeclaredOverloads(t *testing.T) {
	t.Parallel()
	tests := []struct {
		module string
		op     facts.Op
	}{
		{module: "entity/each.ts", op: facts.OpEach},
		{module: "query.ts", op: facts.OpQuery},
	}
	for _, tt := range tests {
		t.Run(tt.op.Name(), func(t *testing.T) {
			t.Parallel()
			want := declaredArgCounts(t, tt.module, tt.op.Name())

			got := acceptedArgCounts(tt.op)

			if diff := cmp.Diff(want, got); diff != "" {
				t.Errorf("%s.MatchesArgCount mismatch, want the counts its overloads in src/%s declare (-want +got):\n%s", tt.op.Name(), tt.module, diff)
			}
		})
	}
}

func TestOverloadArgCounts(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		source string
		want   []int
	}{
		{
			name:   "line comment with a colon before an optional parameter",
			source: "export function f(a: A, // note: x\n\tfn?: F): void;",
			want:   []int{1, 2},
		},
		{
			name:   "block comment with a colon before an optional parameter",
			source: "export function f(a: A, /* see: b */ b?: B): void;",
			want:   []int{1, 2},
		},
		{name: "string literal type containing an equals sign", source: `export function f(mode: "a=b"): void;`, want: []int{1}},
		{name: "single-quoted literal type containing a colon and an equals sign", source: `export function f(mode: 'k:v=1'): void;`, want: []int{1}},
		{name: "template literal type containing an equals sign", source: "export function f(key: `x=${string}`): void;", want: []int{1}},
		{name: "this parameter is not an argument", source: "export function f(this: World, a: A): void;", want: []int{1}},
		{name: "arrow function type is not an initializer", source: "export function f(fn: (x: X) => void): void;", want: []int{1}},
		{
			name:   "default in the implementation signature is ignored",
			source: "export function f(a: A): void;\nexport function f(a: A, b = 1): void {}",
			want:   []int{1},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got, err := overloadArgCounts(tt.source, "f")
			if err != nil {
				t.Fatalf("overloadArgCounts(%q) error = %v, want nil", tt.source, err)
			}

			if diff := cmp.Diff(tt.want, got); diff != "" {
				t.Errorf("overloadArgCounts(%q) mismatch (-want +got):\n%s", tt.source, diff)
			}
		})
	}
}

func TestOverloadArgCounts_WhenAnOverloadParameterHasAnInitializer_Fails(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		source string
	}{
		{name: "untyped default", source: "export function f(a = 1): void;"},
		{name: "default after a string literal type", source: `export function f(mode: "a" = "a"): void;`},
		{name: "default after an arrow function type", source: "export function f(fn: () => void = done): void;"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			_, err := overloadArgCounts(tt.source, "f")

			if !errors.Is(err, errOverloadInitializer) {
				t.Errorf("overloadArgCounts(%q) error = %v, want %v", tt.source, err, errOverloadInitializer)
			}
		})
	}
}
