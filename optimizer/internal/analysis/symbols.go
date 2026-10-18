package analysis

import (
	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/checker"
)

// Every checker symbol and file-name accessor the package calls lives in
// this file, so a compiler upgrade that renames them edits it alone.

// resolveSymbol returns the symbol name refers to, following import and
// export aliases to the declaring symbol; nil when name refers to none.
func resolveSymbol(c *checker.Checker, name *ast.Node) *ast.Symbol {
	symbol := valueSymbolAt(c, name)
	if symbol == nil || symbol.Flags&ast.SymbolFlagsAlias == 0 {
		return symbol
	}
	return c.GetAliasedSymbol(symbol)
}

// valueSymbolAt returns the symbol name reads. The name of a shorthand
// property (`{ visit }`) both declares a property and reads a variable;
// the checker's symbol at that location is the property, so the variable is
// asked for separately.
func valueSymbolAt(c *checker.Checker, name *ast.Node) *ast.Symbol {
	if parent := name.Parent; parent != nil && parent.Kind == ast.KindShorthandPropertyAssignment && parent.Name() == name {
		return c.GetShorthandAssignmentValueSymbol(parent)
	}
	return c.GetSymbolAtLocation(name)
}

// foreignValueFileName returns the name of the file declaring the value expr
// refers to, following import aliases, and false when expr names no value or
// names one declared in expr's own file.
func foreignValueFileName(c *checker.Checker, expr *ast.Node) (string, bool) {
	symbol := resolveSymbol(c, expr)
	if symbol == nil || symbol.ValueDeclaration == nil {
		return "", false
	}
	file := nodeFileName(symbol.ValueDeclaration)
	if file == nodeFileName(expr) {
		return "", false
	}
	return file, true
}

// refersToArguments reports whether name reads a function's implicit
// `arguments` object, not a property or binding named arguments.
func refersToArguments(c *checker.Checker, name *ast.Node) bool {
	return c.IsArgumentsSymbol(valueSymbolAt(c, name))
}

func symbolName(symbol *ast.Symbol) string {
	return symbol.Name
}

func sourceFileName(file *ast.SourceFile) string {
	return file.FileName()
}

func nodeFileName(node *ast.Node) string {
	return sourceFileName(ast.GetSourceFileOfNode(node))
}

// propertyOfType returns t's property named name, nil when t has none.
func propertyOfType(c *checker.Checker, t *checker.Type, name string) *ast.Symbol {
	return c.GetPropertyOfType(t, name)
}

// propertiesOfType returns t's properties in declaration order.
func propertiesOfType(c *checker.Checker, t *checker.Type) []*ast.Symbol {
	return c.GetPropertiesOfType(t)
}

func typeOfSymbol(c *checker.Checker, symbol *ast.Symbol) *checker.Type {
	return c.GetTypeOfSymbol(symbol)
}

// typeSymbol returns the symbol naming t, nil for an anonymous type.
func typeSymbol(t *checker.Type) *ast.Symbol {
	return t.Symbol()
}

// declarationFileNames returns the names of the files declaring symbol, one
// per declaration; nil for a nil symbol.
func declarationFileNames(symbol *ast.Symbol) []string {
	if symbol == nil {
		return nil
	}
	names := make([]string, 0, len(symbol.Declarations))
	for _, declaration := range symbol.Declarations {
		names = append(names, nodeFileName(declaration))
	}
	return names
}
