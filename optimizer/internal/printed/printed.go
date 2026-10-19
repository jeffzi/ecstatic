// Package printed recognizes what a rewrite adds to a file, in the file's printed text: the
// namespace import and the shape-key constants of the preamble, the shape guard and the row loop of
// an inlined each, and the names the file declares.
//
// Only test files import it, so it never links into the sidecar.
package printed

import (
	"regexp"
	"testing"
)

// NamespaceImport is the import of the internal entry a rewritten file's preamble opens with.
const NamespaceImport = `import * as ecstatic_internal from "ecstatic/internal";`

// RowLoop opens the row loop of an inlined each.
const RowLoop = "for (let "

var (
	// shapeKeyConstant is a shape-key constant of the preamble, capturing its name and the shape key it holds.
	shapeKeyConstant = regexp.MustCompile(`(?m)^const (shapeKey\w*) = "([^"]*\|[^"]*)";$`)
	// shapeGuard is the shape guard of a loop, capturing the name of the constant it checks the storage against.
	shapeGuard = regexp.MustCompile(`assertShape\(\w+, (\w+)\)`)
	// declaredName is a namespace import or a variable declaration, capturing the name it binds.
	declaredName = regexp.MustCompile(`(?:\bimport \* as |\b(?:const|let|var)\s+|,\s+)([A-Za-z_$][\w$]*)(?: =| from)`)
)

// ShapeKey is a shape-key constant of a rewritten file's preamble.
type ShapeKey struct {
	Name string
	// Key is the shape key the constant holds, as facts.ArchShape.Key spells it.
	Key string
}

// ShapeKeys returns the shape-key constants text declares, in order.
func ShapeKeys(text string) []ShapeKey {
	var keys []ShapeKey
	for _, m := range shapeKeyConstant.FindAllStringSubmatch(text, -1) {
		keys = append(keys, ShapeKey{Name: m[1], Key: m[2]})
	}
	return keys
}

// Guards returns, for each shape guard in text in order, the name of the constant it checks its storage against.
func Guards(text string) []string {
	var names []string
	for _, m := range shapeGuard.FindAllStringSubmatch(text, -1) {
		names = append(names, m[1])
	}
	return names
}

// AssertDeclaredOnce fails tb for each name text declares more than once, as a namespace import or a variable, and
// for each of userNames it does not declare.
func AssertDeclaredOnce(tb testing.TB, text string, userNames []string) {
	tb.Helper()
	counts := map[string]int{}
	for _, m := range declaredName.FindAllStringSubmatch(text, -1) {
		counts[m[1]]++
	}
	for name, count := range counts {
		if count != 1 {
			tb.Errorf("%q is declared %d times, want once:\n%s", name, count, text)
		}
	}
	for _, name := range userNames {
		if counts[name] == 0 {
			tb.Errorf("user binding %q is no longer declared under its own name:\n%s", name, text)
		}
	}
}
