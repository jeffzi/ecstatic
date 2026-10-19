package syntax_test

import (
	"testing"

	"github.com/google/go-cmp/cmp"
	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/core"
	"github.com/microsoft/typescript-go/shim/parser"

	_ "github.com/jeffzi/ecstatic/optimizer/internal/golden" // registers -update, which go test ./... -update passes to every test binary
	"github.com/jeffzi/ecstatic/optimizer/internal/syntax"
)

// firstStatement parses source as a TypeScript file and returns its first statement.
func firstStatement(t *testing.T, source string) *ast.Node {
	t.Helper()
	file := parser.ParseSourceFile(ast.SourceFileParseOptions{FileName: "/main.ts"}, source, core.ScriptKindTS)
	statements := file.Statements.Nodes
	if len(statements) == 0 {
		t.Fatalf("source %q has no statement", source)
	}
	return statements[0]
}

// expression parses source, an expression statement, and returns its expression.
func expression(t *testing.T, source string) *ast.Node {
	t.Helper()
	return firstStatement(t, source).Expression()
}

func TestSkipWrappers(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		source string
		want   ast.Kind
	}{
		{name: "bare expression stays", source: "x;", want: ast.KindIdentifier},
		{name: "parentheses and non-null assertions stripped", source: "((x)!)!;", want: ast.KindIdentifier},
		{name: "type assertion kept", source: "(x as T);", want: ast.KindAsExpression},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			expr := expression(t, tt.source)

			got := syntax.SkipWrappers(expr)

			if got.Kind != tt.want {
				t.Errorf("SkipWrappers(%q).Kind = %v, want %v", tt.source, got.Kind, tt.want)
			}
		})
	}
}

func TestOutermostParens(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		source string
		// from and want count the expressions to descend through from the statement's expression to the node
		// passed and to the node expected.
		from int
		want int
	}{
		{name: "nested parentheses return the outermost", source: "((x));", from: 2, want: 0},
		{name: "non-null assertion stops the walk", source: "(x!);", from: 2, want: 2},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			expr := expression(t, tt.source)
			from, want := descend(expr, tt.from), descend(expr, tt.want)

			got := syntax.OutermostParens(from)

			if got != want {
				t.Errorf("OutermostParens in %q = %v at %d, want %v at %d", tt.source, got.Kind, got.Pos(), want.Kind, want.Pos())
			}
		})
	}
}

// descend returns the expression depth levels inside expr.
func descend(expr *ast.Node, depth int) *ast.Node {
	for range depth {
		expr = expr.Expression()
	}
	return expr
}

func TestForEachBoundName(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		source string
		want   []string
	}{
		{name: "nested patterns", source: "const {a, b: [c, d = 1], ...e} = v;", want: []string{"a", "c", "d", "e"}},
		{name: "array elision declares nothing", source: "const [a, , b] = v;", want: []string{"a", "b"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			list := firstStatement(t, tt.source).AsVariableStatement().DeclarationList
			name := list.AsVariableDeclarationList().Declarations.Nodes[0].Name()
			var got []string

			syntax.ForEachBoundName(name, func(bound string) { got = append(got, bound) })

			if diff := cmp.Diff(tt.want, got); diff != "" {
				t.Errorf("ForEachBoundName(%q) mismatch (-want +got):\n%s", tt.source, diff)
			}
		})
	}
}

// assignmentOperator is an assignment operator with the binary operator ArithmeticOperator and LogicalOperator should
// map it to, zero where the function should report false.
type assignmentOperator struct {
	operator   ast.Kind
	arithmetic ast.Kind
	logical    ast.Kind
}

// assignmentOperators lists every assignment operator.
func assignmentOperators() []assignmentOperator {
	return []assignmentOperator{
		{operator: ast.KindEqualsToken},
		{operator: ast.KindPlusEqualsToken, arithmetic: ast.KindPlusToken},
		{operator: ast.KindMinusEqualsToken, arithmetic: ast.KindMinusToken},
		{operator: ast.KindAsteriskEqualsToken, arithmetic: ast.KindAsteriskToken},
		{operator: ast.KindAsteriskAsteriskEqualsToken, arithmetic: ast.KindAsteriskAsteriskToken},
		{operator: ast.KindSlashEqualsToken, arithmetic: ast.KindSlashToken},
		{operator: ast.KindPercentEqualsToken, arithmetic: ast.KindPercentToken},
		{operator: ast.KindLessThanLessThanEqualsToken, arithmetic: ast.KindLessThanLessThanToken},
		{operator: ast.KindGreaterThanGreaterThanEqualsToken, arithmetic: ast.KindGreaterThanGreaterThanToken},
		{
			operator:   ast.KindGreaterThanGreaterThanGreaterThanEqualsToken,
			arithmetic: ast.KindGreaterThanGreaterThanGreaterThanToken,
		},
		{operator: ast.KindAmpersandEqualsToken, arithmetic: ast.KindAmpersandToken},
		{operator: ast.KindBarEqualsToken, arithmetic: ast.KindBarToken},
		{operator: ast.KindCaretEqualsToken, arithmetic: ast.KindCaretToken},
		{operator: ast.KindBarBarEqualsToken, logical: ast.KindBarBarToken},
		{operator: ast.KindAmpersandAmpersandEqualsToken, logical: ast.KindAmpersandAmpersandToken},
		{operator: ast.KindQuestionQuestionEqualsToken, logical: ast.KindQuestionQuestionToken},
	}
}

func TestArithmeticOperator(t *testing.T) {
	t.Parallel()
	for _, tt := range assignmentOperators() {
		t.Run(tt.operator.String(), func(t *testing.T) {
			t.Parallel()

			got, ok := syntax.ArithmeticOperator(tt.operator)

			if got != tt.arithmetic || ok != (tt.arithmetic != 0) {
				t.Errorf("ArithmeticOperator(%v) = %v, %t, want %v", tt.operator, got, ok, tt.arithmetic)
			}
		})
	}
}

func TestLogicalOperator(t *testing.T) {
	t.Parallel()
	for _, tt := range assignmentOperators() {
		t.Run(tt.operator.String(), func(t *testing.T) {
			t.Parallel()

			got, ok := syntax.LogicalOperator(tt.operator)

			if got != tt.logical || ok != (tt.logical != 0) {
				t.Errorf("LogicalOperator(%v) = %v, %t, want %v", tt.operator, got, ok, tt.logical)
			}
		})
	}
}
