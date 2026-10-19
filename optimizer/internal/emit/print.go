package emit

import (
	"cmp"
	"encoding/json"
	"fmt"
	"maps"
	"path"
	"slices"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/core"
	"github.com/microsoft/typescript-go/shim/parser"
	"github.com/microsoft/typescript-go/shim/printer"
	"github.com/microsoft/typescript-go/shim/scanner"
)

// Print returns the text of the rewritten file and a version 3 source map from it back to the source, which carries
// the source text inline. A file with no inlined call is its source text.
//
// Every byte outside the inlined calls and the preamble is the source's own. Each loop is printed through the emit
// context that built it and spliced over the statement it replaces, or over the call when the call is an arrow
// function's body, from the statement's first token, so the comments around it stay; its continuation lines take the
// indentation of the line the statement starts on, and every printed line ends with the line break that ends the
// source's first line. The preamble is spliced in after the directive prologue, or after the shebang when there is
// none. The map takes every untouched token to its own position and every line of a loop
// to the start of the statement it replaces; the preamble maps nowhere.
func (f *File) Print() (text, sourceMap string) {
	out := &splicedText{source: f.source.Text()}
	for _, s := range f.splices() {
		out.copySource(s.start)
		out.insert(s.text, s.mapped)
		out.skipSource(s.end)
	}
	out.copySource(len(out.source))
	return out.text.String(), out.sourceMap(path.Base(f.source.FileName()))
}

// splice is printed text that replaces the source bytes from start to end. Its lines map to the source position at
// start when mapped is true, and nowhere otherwise.
type splice struct {
	text       string
	start, end int
	mapped     bool
}

// splices are the preamble and the loops of the file, in source order. One printer prints them all through the
// file's emit context, in the order the whole file would print them, so every generated name prints as it would there.
func (f *File) splices() []splice {
	if f.preamble == nil {
		return nil
	}
	p := printer.NewPrinter(printer.PrinterOptions{}, printer.PrintHandlers{}, f.ctx)
	statements := f.preambleStatements()
	lines := make([]string, 0, len(statements))
	for _, statement := range statements {
		lines = append(lines, p.Emit(statement, f.source))
	}
	newline := sourceNewline(f.source.Text())
	at := f.preambleOffset()
	preambleText := newline + strings.Join(lines, newline)
	if at == 0 {
		preambleText = strings.Join(lines, newline) + newline
	}
	splices := []splice{{text: preambleText, start: at, end: at}}
	targets := slices.SortedFunc(maps.Keys(f.replaced), func(a, b *ast.Node) int { return cmp.Compare(a.Pos(), b.Pos()) })
	for _, target := range targets {
		start := scanner.GetTokenPosOfNode(target, f.source, false)
		if previous := splices[len(splices)-1]; start < previous.end {
			panic(fmt.Sprintf("emit: the loop at offset %d overlaps the splice ending at offset %d", start, previous.end))
		}
		text := withNewline(f.indent(p.Emit(f.replaced[target], f.source), lineIndentation(f.source.Text(), start)), newline)
		splices = append(splices, splice{text: text, start: start, end: target.End(), mapped: true})
	}
	return splices
}

// sourceNewline is the line break that ends the first line of source, or \n when source is one line.
func sourceNewline(source string) string {
	if i := strings.IndexByte(source, '\n'); i > 0 && source[i-1] == '\r' {
		return "\r\n"
	}
	return "\n"
}

// withNewline is printed, which the printer ends lines of with \n, with every line ending with newline instead. A
// \r\n already in printed, copied from a template literal, becomes newline too rather than \r followed by newline,
// an extra line break the literal's value would gain.
func withNewline(printed, newline string) string {
	if newline == "\n" {
		return printed
	}
	return strings.ReplaceAll(strings.ReplaceAll(printed, "\r\n", "\n"), "\n", newline)
}

// preambleOffset is where the preamble goes: after the directive prologue, or else after the shebang, or else at the
// start of the file.
func (f *File) preambleOffset() int {
	prologue, _ := f.ctx.Factory.SplitStandardPrologue(f.source.Statements.Nodes)
	if len(prologue) > 0 {
		return prologue[len(prologue)-1].End()
	}
	return len(scanner.GetShebang(f.source.Text()))
}

// lineIndentation is the run of spaces and tabs that opens the line of source holding offset.
func lineIndentation(source string, offset int) string {
	line := source[strings.LastIndexAny(source[:offset], "\n\r")+1 : offset]
	return line[:len(line)-len(strings.TrimLeft(line, " \t"))]
}

// indent prefixes every line of printed, a loop as the printer wrote it, with indentation, except the first and any
// line that continues a string literal, a template literal, or JSX text, whose value the prefix would change.
func (f *File) indent(printed, indentation string) string {
	if indentation == "" {
		return printed
	}
	parsed := parser.ParseSourceFile(ast.SourceFileParseOptions{FileName: f.source.FileName()}, printed, f.source.ScriptKind)
	var literals []core.TextRange
	collectLiterals(parsed.AsNode(), printed, &literals)
	var b strings.Builder
	at, next := 0, 0
	for line := range strings.SplitAfterSeq(printed, "\n") {
		for next < len(literals) && literals[next].End() < at {
			next++
		}
		continued := next < len(literals) && literals[next].Pos() < at && at <= literals[next].End()
		if at > 0 && line != "\n" && !continued {
			b.WriteString(indentation)
		}
		b.WriteString(line)
		at += len(line)
	}
	return b.String()
}

// collectLiterals appends to literals the range, from its first token to its end, of every string literal, template
// literal part, and JSX text in node, whose text is text, in source order.
func collectLiterals(node *ast.Node, text string, literals *[]core.TextRange) {
	switch node.Kind {
	case ast.KindStringLiteral, ast.KindNoSubstitutionTemplateLiteral, ast.KindTemplateHead, ast.KindTemplateMiddle,
		ast.KindTemplateTail, ast.KindJsxText:
		*literals = append(*literals, core.NewTextRange(scanner.SkipTrivia(text, node.Pos()), node.End()))
	}
	node.ForEachChild(func(child *ast.Node) bool {
		collectLiterals(child, text, literals)
		return false
	})
}

// splicedText accumulates the text of a rewritten file and the mappings of its source map, as the source is copied,
// skipped, and spliced into in order.
type splicedText struct {
	source   string
	text     strings.Builder
	mappings strings.Builder
	// generated is where text ends, and original where the source is read up to: at, in bytes.
	generated, original textPosition
	at                  int
	// segment holds the fields of the last segment written, which the next one encodes relative to; segmentLine is
	// the generated line the mappings have reached, and segmentOnLine whether a segment is written on it.
	segment       [4]int
	segmentLine   int
	segmentOnLine bool
}

// textPosition is a 0-based line and a 0-based column in UTF-16 code units, the units of a source map.
type textPosition struct {
	line, column int
}

// advance moves p past r, followed in its text by rest. A line ends at \n, \r not followed by \n, U+2028, or U+2029,
// as tsgo's line map ends one.
func (p *textPosition) advance(r rune, rest string) {
	if r == '\n' || r == '\u2028' || r == '\u2029' || (r == '\r' && !strings.HasPrefix(rest, "\n")) {
		p.line++
		p.column = 0
		return
	}
	p.column += utf16.RuneLen(r)
}

// copySource copies the source up to the byte offset to, mapping each token it starts to its own position.
func (s *splicedText) copySource(to int) {
	previous := ' '
	for i, r := range s.source[s.at:to] {
		if !unicode.IsSpace(r) && (unicode.IsSpace(previous) || isWordRune(previous) != isWordRune(r)) {
			s.addSegment()
		}
		rest := s.source[s.at+i+utf8.RuneLen(r):]
		s.generated.advance(r, rest)
		s.original.advance(r, rest)
		previous = r
	}
	s.text.WriteString(s.source[s.at:to])
	s.at = to
}

// skipSource moves past the source up to the byte offset to without copying it.
func (s *splicedText) skipSource(to int) {
	for i, r := range s.source[s.at:to] {
		s.original.advance(r, s.source[s.at+i+utf8.RuneLen(r):])
	}
	s.at = to
}

// insert appends text, mapping the first token of each of its lines to the source position read up to when mapped is
// true.
func (s *splicedText) insert(text string, mapped bool) {
	pending := mapped
	for i, r := range text {
		if pending && !unicode.IsSpace(r) {
			s.addSegment()
			pending = false
		}
		line := s.generated.line
		s.generated.advance(r, text[i+utf8.RuneLen(r):])
		pending = pending || (mapped && s.generated.line != line)
	}
	s.text.WriteString(text)
}

// addSegment maps the generated position to the original one, unless a segment already starts there.
func (s *splicedText) addSegment() {
	if s.segmentOnLine && s.generated.line == s.segmentLine && s.generated.column == s.segment[0] {
		return
	}
	for s.segmentLine < s.generated.line {
		s.mappings.WriteByte(';')
		s.segmentLine++
		s.segment[0], s.segmentOnLine = 0, false
	}
	if s.segmentOnLine {
		s.mappings.WriteByte(',')
	}
	fields := [4]int{s.generated.column, 0, s.original.line, s.original.column}
	for i, field := range fields {
		writeVLQ(&s.mappings, field-s.segment[i])
	}
	s.segment, s.segmentOnLine = fields, true
}

// sourceMap is the version 3 source map of the text, generated into file from the source file of the same name.
func (s *splicedText) sourceMap(file string) string {
	encoded, err := json.Marshal(struct {
		File           string   `json:"file"`
		SourceRoot     string   `json:"sourceRoot"`
		Mappings       string   `json:"mappings"`
		Sources        []string `json:"sources"`
		Names          []string `json:"names"`
		SourcesContent []string `json:"sourcesContent"`
		Version        int      `json:"version"`
	}{
		File: file, Mappings: s.mappings.String(), Sources: []string{file}, Names: []string{},
		SourcesContent: []string{s.source}, Version: 3,
	})
	if err != nil {
		panic(fmt.Sprintf("emit: encode the source map of %s: %v", file, err))
	}
	return string(encoded)
}

// isWordRune reports whether r can be part of an identifier, a keyword, or a number.
func isWordRune(r rune) bool {
	return r == '_' || r == '$' || unicode.IsLetter(r) || unicode.IsDigit(r)
}

// base64Digits are the digits of a base64 VLQ, by value.
const base64Digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

// writeVLQ appends value to b as a base64 VLQ: the sign in the lowest bit, then five bits per digit, lowest first.
func writeVLQ(b *strings.Builder, value int) {
	vlq := value << 1
	if value < 0 {
		vlq = -value<<1 | 1
	}
	for {
		digit := vlq & 31
		vlq >>= 5
		if vlq > 0 {
			digit |= 32
		}
		b.WriteByte(base64Digits[digit])
		if vlq == 0 {
			return
		}
	}
}
