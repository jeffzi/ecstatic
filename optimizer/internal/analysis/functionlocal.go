package analysis

import (
	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/checker"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/nodes"
)

const argumentsName = "arguments"

// functionLocalWalker collects the uses of a function expression's own
// bindings in its parameters and body.
//
// The walk covers all code nested in the function, at any depth, because a
// reference to the function's name resolves to the function wherever it
// sits. Whether `this`, `arguments`, and `new.target` belong to the function
// depends on where they sit:
//
//   - Nested arrow functions are looked through: they see the function's
//     `this`, `arguments`, and `new.target`.
//   - Nested non-arrow functions, methods, accessors, constructors, and
//     instance field initializers bind their own `this`, `arguments`, and
//     `new.target`, so inside their parameters and bodies only references
//     to the function's name are recorded.
//   - A class is entered: its decorators, computed member names, `extends`
//     clause, static blocks, and static field initializers run when the
//     class is evaluated, inside the function. Decorators and computed
//     names see the function's bindings. Static blocks and static field
//     initializers see the class as `this`, have no `arguments`, and see
//     `new.target` as undefined, so inside them only references to the
//     function's name are recorded.
//
// A nested binding that shadows the function's name resolves to its own
// symbol, so references to it are never recorded.
//
// Type positions are skipped: types are erased, so a reference inside one,
// such as `typeof visit`, never touches the binding at runtime. A class's
// `extends` expression is a value and is still walked.
type functionLocalWalker struct {
	checker  *checker.Checker
	table    *nodes.Table
	self     *ast.Symbol
	selfName string
	uses     []facts.NodeID
}

// walk records the uses in node's subtree. ownThis is false inside code that
// binds its own `this`, `arguments`, and `new.target`: the parameters and
// body of a nested non-arrow function or member, or a class's static block
// or field initializer.
func (w *functionLocalWalker) walk(node *ast.Node, ownThis bool) {
	if ast.IsPartOfTypeNode(node) {
		return
	}
	switch node.Kind {
	case ast.KindFunctionExpression, ast.KindFunctionDeclaration:
		w.walkFunctionRun(node, false)
		return
	case ast.KindMethodDeclaration, ast.KindGetAccessor, ast.KindSetAccessor, ast.KindConstructor:
		w.walkMemberHead(node, ownThis)
		w.walkFunctionRun(node, ownThis)
		return
	case ast.KindPropertyDeclaration:
		w.walkMemberHead(node, ownThis)
		if init := node.Initializer(); init != nil {
			w.walk(init, false)
		}
		return
	case ast.KindClassStaticBlockDeclaration:
		w.walk(node.AsClassStaticBlockDeclaration().Body, false)
		return
	case ast.KindThisKeyword:
		w.recordIf(node, ownThis)
		return
	case ast.KindMetaProperty:
		w.recordIf(node, ownThis && node.AsMetaProperty().KeywordToken == ast.KindNewKeyword)
		return
	case ast.KindIdentifier:
		w.recordIf(node, w.isFunctionLocal(node, ownThis))
		return
	}
	node.ForEachChild(func(child *ast.Node) bool {
		w.walk(child, ownThis)
		return false
	})
}

// walkMemberHead walks the parts of a class or object-literal member that
// run when the class or object is evaluated: its decorators and its
// computed name.
func (w *functionLocalWalker) walkMemberHead(member *ast.Node, ownThis bool) {
	visitMemberHead(member, func(node *ast.Node) { w.walk(node, ownThis) })
}

// walkFunctionRun walks the parameters and body of fn, a nested non-arrow
// function or a class or object-literal member. Each binds its own `this`,
// `arguments`, and `new.target`.
//
// A parameter's decorators are the exception: they resolve at class level, so
// they see the enclosing bindings and are walked with ownThis. Only members
// carry parameter decorators; a function passes false.
func (w *functionLocalWalker) walkFunctionRun(fn *ast.Node, ownThis bool) {
	for _, param := range fn.Parameters() {
		param.ForEachChild(func(child *ast.Node) bool {
			w.walk(child, ownThis && runsWithClass(child))
			return false
		})
	}
	if body := fn.Body(); body != nil {
		w.walk(body, false)
	}
}

// isFunctionLocal reports whether the identifier id refers to the
// function's `arguments` object or to the function itself.
func (w *functionLocalWalker) isFunctionLocal(id *ast.Node, ownThis bool) bool {
	switch id.Text() {
	case argumentsName:
		return ownThis && refersToArguments(w.checker, id)
	case w.selfName:
		return w.self != nil && resolveSymbol(w.checker, id) == w.self
	default:
		return false
	}
}

func (w *functionLocalWalker) recordIf(node *ast.Node, record bool) {
	if record {
		w.uses = append(w.uses, w.table.Register(node))
	}
}
