// Package position locates text in a TypeScript source and gives its position as the analysis
// reports it, so tests can state where a call is by quoting it.
//
// Only test files import it, so it never links into the sidecar.
package position

import (
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
)

// Of returns the position of offset, a byte offset into source, in the file named file.
//
// Lines count from 1, and columns count UTF-16 code units from 1, as TypeScript's own diagnostics
// do.
func Of(file, source string, offset int) facts.Position {
	before := source[:offset]
	lineStart := strings.LastIndex(before, "\n") + 1
	return facts.Position{
		File:   file,
		Offset: offset,
		Line:   strings.Count(before, "\n") + 1,
		Column: len(utf16.Encode([]rune(before[lineStart:]))) + 1,
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
