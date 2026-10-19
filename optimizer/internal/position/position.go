// Package position locates text in a TypeScript source and gives its position as the analysis
// reports it, so tests can state where a call is by quoting it.
//
// Only test files import it, so it never links into the sidecar.
package position

import (
	"cmp"
	"slices"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/microsoft/typescript-go/shim/core"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
)

// Of returns the position of offset, a byte offset into source, in the file named file.
//
// Lines count from 1, and columns count UTF-16 code units from 1, as TypeScript's own diagnostics
// do. Lines end where tsgo's line map ends them (LF, CRLF, CR, LS and PS), so Of agrees with the
// positions the analysis reports.
func Of(file, source string, offset int) facts.Position {
	starts := core.ComputeECMALineStarts(source)
	line, found := slices.BinarySearchFunc(starts, offset, func(start core.TextPos, offset int) int {
		return cmp.Compare(int(start), offset)
	})
	if !found {
		line--
	}
	lineStart := int(starts[line])
	return facts.Position{
		File:   file,
		Offset: offset,
		Line:   line + 1,
		Column: len(utf16.Encode([]rune(source[lineStart:offset]))) + 1,
	}
}

// Occurrence returns the byte offset of the nth (from 0) occurrence of text in source, failing tb
// when there are fewer.
func Occurrence(tb testing.TB, source, text string, nth int) int {
	tb.Helper()
	var offset int
	start := 0
	for range nth + 1 {
		i := strings.Index(source[start:], text)
		if i < 0 {
			tb.Fatalf("source has fewer than %d occurrences of %q", nth+1, text)
		}
		offset = start + i
		start = offset + len(text)
	}
	return offset
}
