package position_test

import (
	"strings"
	"testing"

	"github.com/google/go-cmp/cmp"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/fatal"
	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
	"github.com/jeffzi/ecstatic/optimizer/internal/position"
)

func TestOf(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		source string
		want   facts.Position
		offset int
	}{
		{name: "start of the first line", source: "has(s, s);\n", offset: 0, want: facts.Position{File: "main.ts", Offset: 0, Line: 1, Column: 1}},
		{name: "after a line break", source: "declare const s: any;\n\thas(s, s);\n", offset: 23, want: facts.Position{File: "main.ts", Offset: 23, Line: 2, Column: 2}},
		{name: "after a lone carriage return", source: "a\rb", offset: 2, want: facts.Position{File: "main.ts", Offset: 2, Line: 2, Column: 1}},
		{name: "after a line separator", source: "a b", offset: len("a "), want: facts.Position{File: "main.ts", Offset: len("a "), Line: 2, Column: 1}},
		{
			name:   "after text longer in UTF-8 bytes than in UTF-16 code units",
			source: "const label = \"é🚀\"; has(s, s);\n",
			offset: len("const label = \"é🚀\"; "),
			want:   facts.Position{File: "main.ts", Offset: len("const label = \"é🚀\"; "), Line: 1, Column: 22},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := position.Of("main.ts", tt.source, tt.offset)

			if diff := cmp.Diff(tt.want, got); diff != "" {
				t.Errorf("Of(%q, %d) mismatch (-want +got):\n%s", tt.source, tt.offset, diff)
			}
		})
	}
}

func TestOccurrence(t *testing.T) {
	t.Parallel()
	const source = "has(e, s);\nhas(e, s);\n"
	tests := []struct {
		name string
		nth  int
		want int
	}{
		{name: "first", nth: 0, want: 0},
		{name: "second", nth: 1, want: 11},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := position.Occurrence(t, source, "has(e, s)", tt.nth)

			if got != tt.want {
				t.Errorf("Occurrence(%q, %d) = %d, want %d", source, tt.nth, got, tt.want)
			}
		})
	}
}

func TestOccurrence_WhenTooFewOccurrences_FailsNamingTheText(t *testing.T) {
	t.Parallel()
	recorder := &fatal.Recorder{TB: t}

	got := recorder.Run(func(tb testing.TB) { position.Occurrence(tb, "has(e, s);\n", "has(e, s)", 1) })

	if !strings.Contains(got, `"has(e, s)"`) {
		t.Errorf("Occurrence() fatal = %q, want it to name %q", got, "has(e, s)")
	}
}
