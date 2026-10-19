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

// valueDeclaration returns the declaration of the value symbol names, nil
// when it declares none.
func valueDeclaration(symbol *ast.Symbol) *ast.Node {
	return symbol.ValueDeclaration
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

func isAccessorProperty(c *checker.Checker, t *checker.Type, name string) bool {
	return isAccessorSymbol(propertyOfType(c, t, name))
}

// isAccessorSymbol reports whether symbol is a get or set accessor; false for
// a nil symbol.
func isAccessorSymbol(symbol *ast.Symbol) bool {
	return symbol != nil && symbol.Flags&ast.SymbolFlagsAccessor != 0
}

// isAnonymousObjectSymbol reports whether symbol, a type's symbol, names an
// object literal or a type literal, or no declaration at all: an object type
// with no class or interface behind it.
func isAnonymousObjectSymbol(symbol *ast.Symbol) bool {
	return symbol == nil || symbol.Flags&(ast.SymbolFlagsObjectLiteral|ast.SymbolFlagsTypeLiteral) != 0
}

// isGlobalValue reports whether expr is an identifier that refers to the
// global value named name, not to a local binding that shadows it.
func isGlobalValue(c *checker.Checker, expr *ast.Node, name string) bool {
	if expr.Kind != ast.KindIdentifier || expr.Text() != name {
		return false
	}
	global := c.GetGlobalSymbol(name, ast.SymbolFlagsValue, nil)
	return global != nil && resolveSymbol(c, expr) == global
}
