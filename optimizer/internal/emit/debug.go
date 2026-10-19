package emit

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/core"
	"github.com/microsoft/typescript-go/shim/parser"
)

// ErrNoDebug reports a src/debug.ts that declares no top-level DEBUG with an initializer.
var ErrNoDebug = errors.New("no top-level DEBUG declaration with an initializer")

// Debug is the DEBUG initializer of one ecstatic package root, which every rewritten file copies.
type Debug struct {
	initializer *ast.Node
	// Path is the src/debug.ts the initializer was extracted from, under the root LoadDebug was given.
	Path string
	// Source is the text of Path as LoadDebug read it.
	Source []byte
}

// LoadDebug extracts the initializer of the top-level DEBUG declaration in root's src/debug.ts.
//
// It returns an error wrapping the read failure when that file cannot be read, and one wrapping ErrNoDebug when it
// declares no top-level DEBUG with an initializer.
func LoadDebug(root string) (*Debug, error) {
	path := filepath.Join(root, "src", "debug.ts")
	text, err := os.ReadFile(path) //nolint:gosec // the path is the ecstatic package root's own runtime source
	if err != nil {
		return nil, fmt.Errorf("read the DEBUG gate: %w", err)
	}
	// The parser requires an absolute file name; the read above already succeeded, so the working directory exists.
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve the DEBUG gate: %w", err)
	}
	file := parser.ParseSourceFile(ast.SourceFileParseOptions{FileName: filepath.ToSlash(abs)}, string(text), core.ScriptKindTS)
	for _, statement := range file.Statements.Nodes {
		if statement.Kind != ast.KindVariableStatement {
			continue
		}
		for _, variable := range statement.AsVariableStatement().DeclarationList.AsVariableDeclarationList().Declarations.Nodes {
			name := variable.Name()
			if name.Kind == ast.KindIdentifier && name.Text() == "DEBUG" && variable.Initializer() != nil {
				return &Debug{initializer: variable.Initializer(), Path: path, Source: text}, nil
			}
		}
	}
	return nil, fmt.Errorf("%s: %w", path, ErrNoDebug)
}
