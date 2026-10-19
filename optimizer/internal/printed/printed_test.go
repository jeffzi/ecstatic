package printed_test

import (
	"fmt"
	"slices"
	"testing"

	"github.com/google/go-cmp/cmp"

	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
	"github.com/jeffzi/ecstatic/optimizer/internal/printed"
)

// rewrittenText is a printed rewrite with two shape-key constants, a decoy constant that holds no shape key, and two
// guarded loops.
const rewrittenText = printed.NamespaceImport + `
const DEBUG = typeof NDEBUG === "undefined" || !NDEBUG;
const shapeKey = "c8:Position{1:x=n,1:y=n}|";
const shapeKey_1 = "r6:Tether{5:slack=n}|c3:A,B{1:n=n}";
const shapeKeyNote = "banana";
{
    DEBUG && ecstatic_internal.assertShape(storage, shapeKey_1);
    for (let i = storage.n - 1; i >= 0; i--) {}
}
{
    DEBUG && ecstatic_internal.assertShape(storage, shapeKey);
}
`

func TestShapeKeys(t *testing.T) {
	t.Parallel()
	want := []printed.ShapeKey{
		{Name: "shapeKey", Key: "c8:Position{1:x=n,1:y=n}|"},
		{Name: "shapeKey_1", Key: "r6:Tether{5:slack=n}|c3:A,B{1:n=n}"},
	}

	got := printed.ShapeKeys(rewrittenText)

	if diff := cmp.Diff(want, got); diff != "" {
		t.Errorf("ShapeKeys() mismatch (-want +got):\n%s", diff)
	}
}

func TestGuards(t *testing.T) {
	t.Parallel()
	want := []string{"shapeKey_1", "shapeKey"}

	got := printed.Guards(rewrittenText)

	if !slices.Equal(got, want) {
		t.Errorf("Guards() = %q, want %q", got, want)
	}
}

// errorRecorder is a testing.TB that records each Errorf message in place of failing the test.
type errorRecorder struct {
	testing.TB

	messages []string
}

func (r *errorRecorder) Errorf(format string, args ...any) {
	r.messages = append(r.messages, fmt.Sprintf(format, args...))
}

func TestAssertDeclaredOnce(t *testing.T) {
	t.Parallel()
	const text = printed.NamespaceImport + "\nconst storage = 1, n = 2;\nlet i = 0;\nvar storage_1 = 3;\n"
	tests := []struct {
		name      string
		text      string
		userNames []string
		want      []string
	}{
		{
			name:      "every name declared once, the user names among them",
			text:      text,
			userNames: []string{"storage", "n", "i"},
		},
		{
			name: "a name declared twice",
			text: text + "const n = 4;\n",
			want: []string{`"n" is declared 2 times, want once:` + "\n" + text + "const n = 4;\n"},
		},
		{
			name: "the namespace import declared twice",
			text: text + printed.NamespaceImport + "\n",
			want: []string{`"ecstatic_internal" is declared 2 times, want once:` + "\n" + text + printed.NamespaceImport + "\n"},
		},
		{
			name:      "a user name no longer declared",
			text:      text,
			userNames: []string{"entities"},
			want:      []string{`user binding "entities" is no longer declared under its own name:` + "\n" + text},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			recorder := &errorRecorder{TB: t}

			printed.AssertDeclaredOnce(recorder, tt.text, tt.userNames)

			if diff := cmp.Diff(tt.want, recorder.messages); diff != "" {
				t.Errorf("AssertDeclaredOnce() failures mismatch (-want +got):\n%s", diff)
			}
		})
	}
}
