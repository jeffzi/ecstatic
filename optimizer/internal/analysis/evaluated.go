package analysis

import "github.com/microsoft/typescript-go/shim/ast"

// forEachEvaluated calls visit on each child of node that runs when node
// runs. A nested function runs only when called, so none of it does, except
// the parts of a class or object-literal member evaluated with the class or
// object: its decorators, its computed name, its parameters' decorators, and
// a static field's initializer. A class's own children (its decorators,
// `extends` clause, and members) and a static block's body run with it. Type
// positions never run.
func forEachEvaluated(node *ast.Node, visit func(*ast.Node)) {
	switch node.Kind {
	case ast.KindArrowFunction, ast.KindFunctionExpression, ast.KindFunctionDeclaration,
		ast.KindInterfaceDeclaration, ast.KindTypeAliasDeclaration:
		return
	case ast.KindMethodDeclaration, ast.KindGetAccessor, ast.KindSetAccessor, ast.KindConstructor:
		visitMemberHead(node, visit)
		for _, param := range node.Parameters() {
			param.ForEachChild(func(child *ast.Node) bool {
				if runsWithClass(child) {
					visit(child)
				}
				return false
			})
		}
		return
	case ast.KindPropertyDeclaration:
		visitMemberHead(node, visit)
		if init := node.Initializer(); init != nil && !isInstanceInitializer(node, init) {
			visit(init)
		}
		return
	}
	node.ForEachChild(func(child *ast.Node) bool {
		if !ast.IsPartOfTypeNode(child) {
			visit(child)
		}
		return false
	})
}

// visitMemberHead calls visit on member's modifiers, decorators among them,
// and on its name when the name is computed.
func visitMemberHead(member *ast.Node, visit func(*ast.Node)) {
	for _, modifier := range member.ModifierNodes() {
		visit(modifier)
	}
	if name := member.Name(); name != nil && name.Kind == ast.KindComputedPropertyName {
		visit(name)
	}
}

// forEachDeferred calls visit on each part of node, a class or object-literal
// member, that runs only when the member is called or, for an instance
// field's initializer, when an instance is built: the parts of a member that
// forEachEvaluated leaves out. A parameter's decorators run with the class,
// so they are not among them.
func forEachDeferred(node *ast.Node, visit func(*ast.Node)) {
	switch node.Kind {
	case ast.KindMethodDeclaration, ast.KindGetAccessor, ast.KindSetAccessor, ast.KindConstructor:
		for _, param := range node.Parameters() {
			param.ForEachChild(func(child *ast.Node) bool {
				if !runsWithClass(child) {
					visit(child)
				}
				return false
			})
		}
		if body := node.Body(); body != nil {
			visit(body)
		}
	case ast.KindPropertyDeclaration:
		if init := node.Initializer(); init != nil && isInstanceInitializer(node, init) {
			visit(init)
		}
	}
}

// runsWithClass reports whether child, a child of a member's parameter, runs
// when the class is evaluated rather than when the member is called: it is
// one of the parameter's decorators.
func runsWithClass(child *ast.Node) bool {
	return child.Kind == ast.KindDecorator
}

// isInstanceInitializer reports whether node is the initializer of member, an
// instance field, which runs each time an instance is built rather than when
// the class is evaluated.
func isInstanceInitializer(member, node *ast.Node) bool {
	return member.Kind == ast.KindPropertyDeclaration && member.Initializer() == node &&
		member.ModifierFlags()&ast.ModifierFlagsStatic == 0
}
