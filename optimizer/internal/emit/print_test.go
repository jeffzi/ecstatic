package emit_test

import (
	"regexp"
	"strings"
	"testing"

	"github.com/microsoft/typescript-go/shim/printer"

	"github.com/jeffzi/ecstatic/optimizer/internal/emit"
	"github.com/jeffzi/ecstatic/optimizer/internal/printed"
)

// keptSource holds, in a formatting the printer would change, calls the rewrite keeps beside two it compiles into
// loops: one at the top level and one in the callback of a kept filtered each.
const keptSource = `"use strict";
// Opens the file, after the directive prologue.
import {
  createWorld,
  each,
  query,
  register,
} from "../../src/index.js";
import { Mover, Position, Velocity } from "../schema.js";

const world = createWorld();
const movers = register(world, Mover);

each(
  movers,
  [Velocity], // filtered
  (e) => {
    e.Position.x += 1;
  },
);
// Before the inlined call.
each(movers, (e) => {
  e.Position.y += e.Velocity.dy;
}); // after it
each([movers, movers], /* array literal */ (e) => {
  e.Position.x  +=  2;
});
query(world, [Position], (e) => {
  e.Position.y = 0;
});
each(movers, [Position], () => {
  each(movers, (inner) => {
    inner.Velocity.dx = 3;
  });
});
`

// keptInlined is the statements of keptSource the rewrite compiles into loops, in source order.
func keptInlined() []string {
	return []string{
		"each(movers, (e) => {\n  e.Position.y += e.Velocity.dy;\n});",
		"each(movers, (inner) => {\n    inner.Velocity.dx = 3;\n  });",
	}
}

// preamblePart and loopPart match the parts a rewrite splices into its source: the preamble after the directive
// prologue, and an inlined loop.
var (
	preamblePart = regexp.MustCompile(`^\n` + regexp.QuoteMeta(printed.NamespaceImport) + `(?:\nconst (?:DEBUG|shapeKey)\w* = [^\n]+;)+$`)
	loopPart     = regexp.MustCompile(`(?s)^\{\n.*` + regexp.QuoteMeta(printed.RowLoop) + `\w+ = \w+ - 1;.*\}$`)
)

// cutAround is source cut around each of statements, in order: the text before the first, between each two, and
// after the last.
func cutAround(t *testing.T, source string, statements []string) []string {
	t.Helper()
	var segments []string
	for _, statement := range statements {
		before, after, found := strings.Cut(source, statement)
		if !found {
			t.Fatalf("source %q holds no statement %q", source, statement)
		}
		segments = append(segments, before)
		source = after
	}
	return append(segments, source)
}

// assertSpliced fails t unless text is segments, in order and byte for byte, with one part between each two of them
// that matches the pattern of parts at its index.
func assertSpliced(t *testing.T, text string, segments []string, parts []*regexp.Regexp) {
	t.Helper()
	rest, found := strings.CutPrefix(text, segments[0])
	if !found {
		t.Fatalf("text = %q, want it to open with the source's %q", text, segments[0])
	}
	for i, pattern := range parts {
		next := segments[i+1]
		end := strings.Index(rest, next)
		if i == len(parts)-1 && !strings.HasSuffix(rest, next) {
			end = -1
		} else if i == len(parts)-1 {
			end = len(rest) - len(next)
		}
		if end < 0 {
			t.Fatalf("text after spliced part %d = %q, want the source's %q next", i, rest, next)
		}
		if part := rest[:end]; !pattern.MatchString(part) {
			t.Errorf("spliced part %d = %q, want it to match /%s/", i, part, pattern)
		}
		rest = rest[end+len(next):]
	}
}

func TestFile_Print_KeepsEveryByteOutsideTheInlinedStatementsAndThePreamble(t *testing.T) {
	t.Parallel()
	p := loadProject(t, map[string]string{caseFile(0): keptSource})
	prologue, body, _ := strings.Cut(keptSource, "\n")
	segments := append([]string{prologue}, cutAround(t, "\n"+body, keptInlined())...)

	out := p.rewrite(t, caseFile(0), p.debugOf(t), 0)

	assertSpliced(t, out.text, segments, []*regexp.Regexp{preamblePart, loopPart, loopPart})
}

func TestFile_Print_SplicesThePreambleAfterTheShebangOrAtTheStart(t *testing.T) {
	t.Parallel()
	bare := strings.TrimPrefix(preambleSource, `"use strict";`+"\n")
	tests := []struct {
		name   string
		source string
		want   string
	}{
		{name: "a file with neither a prologue nor a shebang opens with it", source: bare, want: printed.NamespaceImport + "\n"},
		{name: "a shebang stays the first line", source: "#!/usr/bin/env node\n" + bare, want: "#!/usr/bin/env node\n" + printed.NamespaceImport + "\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			p := loadProject(t, map[string]string{caseFile(0): tt.source})

			out := p.rewrite(t, caseFile(0), p.debugOf(t), 0)

			if !strings.HasPrefix(out.text, tt.want) {
				t.Errorf("rewritten text opens %q, want %q:\n%s", out.text[:min(len(tt.want), len(out.text))], tt.want, out.text)
			}
		})
	}
}

func TestFile_Print_WhenTheSourceEndsLinesWithCRLF_EndsEveryLineWithCRLF(t *testing.T) {
	t.Parallel()
	// The template literal's line break reaches the printer as the source's \r\n.
	template := "const rows: string[] = [];\neach(movers, (e) => {\n  rows.push(`row\n${e.id}`);\n});\n"
	p := loadProject(t, map[string]string{caseFile(0): strings.ReplaceAll(keptSource+template, "\n", "\r\n")})

	out := p.rewrite(t, caseFile(0), p.debugOf(t), 0)

	if stray := strings.ReplaceAll(out.text, "\r\n", ""); strings.ContainsAny(stray, "\r\n") {
		t.Errorf("rewritten text ends a line with something other than \\r\\n, want \\r\\n throughout:\n%q", out.text)
	}
}

func TestFile_Print_WhenNothingIsInlined_ReturnsTheSource(t *testing.T) {
	t.Parallel()
	p := loadProject(t, map[string]string{caseFile(0): preambleSource})

	text, _ := emit.NewFile(printer.NewEmitContext(), p.file(t, caseFile(0)), nil, nil).Print()

	if text != preambleSource {
		t.Errorf("Print() of a file with no inlined call = %q, want its source %q", text, preambleSource)
	}
}
