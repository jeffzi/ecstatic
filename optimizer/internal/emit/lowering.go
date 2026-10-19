package emit

import (
	"fmt"
	"strconv"

	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/printer"

	"github.com/jeffzi/ecstatic/optimizer/internal/facts"
	"github.com/jeffzi/ecstatic/optimizer/internal/plan"
	"github.com/jeffzi/ecstatic/optimizer/internal/syntax"
)

// noteUse records the rules of the view lowering table, and the alias rule, that lowering node, the node of
// use, applies. Comparisons, updates, and destructuring record theirs where they lower.
func (l *loop) noteUse(node *ast.Node, use facts.ViewUse) {
	switch use.Kind {
	case facts.UseID:
		l.applied.add(ruleEntityID)
	case facts.UseFieldRead:
		l.noteField(use, node.Expression(), ruleReadRequiredField, ruleReadOptionalField)
		if l.field(use).Kind == facts.FieldBoolean {
			l.applied.add(ruleReadBooleanField)
		}
	case facts.UseOptionalRead:
		if _, optional := l.slot(use.Comp); optional {
			l.applied.add(ruleOptionalChainRead)
		}
	case facts.UseFieldAssign:
		l.noteAssign(node, use)
	case facts.UsePresence:
		l.noteSlot(use, rulePresenceRequired, rulePresenceOptional)
	case facts.UseCoalesce:
		l.noteSlot(use, ruleCoalesceRequired, ruleCoalesceOptional)
	case facts.UseTag:
		l.noteSlot(use, ruleRequiredTag, ruleOptionalTag)
	case facts.UseAlias:
		if node.Kind == ast.KindVariableDeclaration {
			l.applied.add(ruleAlias)
			l.noteNonNull(node.Initializer())
		}
	}
}

// noteSlot records required when the slot of use is a required component's, and optional otherwise.
func (l *loop) noteSlot(use facts.ViewUse, required, optional Rule) {
	if _, isOptional := l.slot(use.Comp); isOptional {
		l.applied.add(optional)
	} else {
		l.applied.add(required)
	}
}

// noteField records the rule, required or optional, of a use of a field reached through slot, its slot expression,
// and the non-null-asserted slot rule when slot asserts the slot non-null.
func (l *loop) noteField(use facts.ViewUse, slot *ast.Node, required, optional Rule) {
	l.noteSlot(use, required, optional)
	l.noteNonNull(slot)
}

// noteNonNull records the non-null-asserted slot rule when slot, the slot expression of a field use or an alias, is
// `e.C!`.
func (l *loop) noteNonNull(slot *ast.Node) {
	if skipParens(slot).Kind == ast.KindNonNullExpression {
		l.applied.add(ruleNonNullSlot)
	}
}

// noteAssign records the rules of node, an assignment to the field of use: the write, its boolean encoding, and the
// decoded value a boolean assignment yields when its value is used.
func (l *loop) noteAssign(node *ast.Node, use facts.ViewUse) {
	l.noteField(use, skipParens(node.AsBinaryExpression().Left).Expression(), ruleWriteRequiredField, ruleWriteOptionalField)
	if l.field(use).Kind != facts.FieldBoolean {
		return
	}
	l.applied.add(ruleWriteBooleanField)
	if isValueUsed(node) {
		l.applied.add(ruleBooleanAssignmentValue)
	}
}

// patternSite is where a pattern destructuring the view stands: a body declaration or the callback's parameter.
type patternSite uint8

const (
	inDeclaration patternSite = iota
	inParameter
)

// aliasRule is the rule of a slot alias bound in a pattern of the view at s.
func (s patternSite) aliasRule() Rule {
	if s == inParameter {
		return ruleDestructureParameter
	}
	return ruleDestructureView
}

// nestedRule is the rule of a slot pattern nested in a pattern of the view at s.
func (s patternSite) nestedRule() Rule {
	if s == inParameter {
		return ruleDestructureParameterNested
	}
	return ruleDestructureViewNested
}

// slotGuard declares an empty pattern of `(present ? 0 : undefined)` for the optional slot of use, which throws a
// TypeError while the slot is disabled, as destructuring the getter's `undefined` does, even when the pattern binds
// nothing.
func (l *loop) slotGuard(use facts.ViewUse) *ast.Node {
	factory := l.ctx.Factory
	empty := factory.NewBindingPattern(ast.KindObjectBindingPattern, factory.NewNodeList(nil))
	return declaration(l.ctx, empty, orUndefined(l.ctx, l.present(use, nil), number(l.ctx, "0")))
}

// bindElement returns the declarations binding element, a property of a pattern at site that destructures the view
// or a slot: those of the slot's own pattern, or one declaration of what element binds, a plain binding or a pattern
// on a plain value.
//
// It panics when element has no view use.
func (l *loop) bindElement(visitor *ast.NodeVisitor, element *ast.Node, site patternSite) []*ast.Node {
	name := element.Name()
	if use, ok := l.lowering[name]; ok {
		l.applied.add(site.nestedRule())
		return l.destructure(visitor, name, use, site)
	}
	use, ok := l.lowering[element]
	switch {
	case !ok:
		panic("emit: a property of a lowered pattern has no view use")
	case use.Kind == facts.UseAlias:
		l.applied.add(site.aliasRule())
		return []*ast.Node{l.lower(visitor, element, use)}
	case use.Kind == facts.UseFieldRead:
		return []*ast.Node{declaration(l.ctx, visitor.VisitNode(name), l.fieldValue(visitor, element, use))}
	}
	if use.Kind == facts.UseID {
		l.applied.add(ruleDestructureID)
	} else if _, optional := l.slot(use.Comp); optional && use.Kind == facts.UseTag {
		l.applied.add(ruleDestructureOptionalTag)
	}
	return []*ast.Node{declaration(l.ctx, visitor.VisitNode(name), l.lower(visitor, element, use))}
}

// fieldValue reads the field of use for element, a property of a slot pattern, applying the property's default as
// destructuring the record does: never on a typed-array column, which never holds undefined, and on undefined in a
// plain-array one, through `(t = column[i]) === undefined ? default : t`.
func (l *loop) fieldValue(visitor *ast.NodeVisitor, element *ast.Node, use facts.ViewUse) *ast.Node {
	read := l.read(use, l.columnArray(use))
	fallback := element.Initializer()
	if fallback == nil {
		return read
	}
	if l.field(use).Kind != facts.FieldPlain {
		l.applied.add(ruleDestructureDefaultTyped)
		return read
	}
	l.applied.add(ruleDestructureDefaultPlain)
	factory := l.ctx.Factory
	held := l.newTemp("value")
	unset := binary(l.ctx, paren(l.ctx, assignTo(l.ctx, held, read)), ast.KindEqualsEqualsEqualsToken, factory.NewVoidZeroExpression())
	return conditional(l.ctx, unset, visitor.VisitNode(fallback), factory.DeepCloneNode(held))
}

// assign lowers node, an assignment to the field of use, keeping the order the field setter sees: the slot, then
// the right-hand side, then the store. A boolean field stores its value encoded as 1/0 and the assignment yields
// what the setter was given, or the decoded current value when a logical form short-circuits. In realloc-safe mode
// the column is read only once the right-hand side has run, through assignInOrder.
func (l *loop) assign(visitor *ast.NodeVisitor, node *ast.Node, use facts.ViewUse) *ast.Node {
	if l.mode == plan.ModeReallocSafe {
		return l.assignInOrder(visitor, node, use)
	}
	factory := l.ctx.Factory
	assignment := node.AsBinaryExpression()
	operator := assignment.OperatorToken.Kind
	slot := skipParens(assignment.Left).Expression()
	target := func() *ast.Node { return l.atRow(l.guardedColumn(use, slot)) }
	value := visitor.VisitNode(assignment.Right)
	if l.field(use).Kind != facts.FieldBoolean {
		return binary(l.ctx, target(), operator, value)
	}
	current := l.decode(target())
	if operator == ast.KindQuestionQuestionEqualsToken {
		// A decoded boolean is never nullish, so the right-hand side never runs.
		return current
	}
	var store *ast.Node
	if isValueUsed(node) {
		held := l.newTemp("value")
		encoded := encode(l.ctx, paren(l.ctx, assignTo(l.ctx, held, value)))
		store = paren(l.ctx, factory.NewCommaExpression(binary(l.ctx, target(), ast.KindEqualsToken, encoded), factory.DeepCloneNode(held)))
	} else {
		store = binary(l.ctx, target(), ast.KindEqualsToken, encode(l.ctx, paren(l.ctx, value)))
	}
	switch operator {
	case ast.KindBarBarEqualsToken:
		return paren(l.ctx, factory.NewLogicalORExpression(current, paren(l.ctx, store)))
	case ast.KindAmpersandAmpersandEqualsToken:
		return paren(l.ctx, factory.NewLogicalANDExpression(current, paren(l.ctx, store)))
	default:
		return store
	}
}

// assignInOrder lowers node, an assignment to the field of use, in realloc-safe mode, in the order the field
// accessors of fieldAccessorsFor (src/entity/each.ts) see it: the slot's presence, tested once; the
// current value, for a compound or logical form; the right-hand side; and then the store, which reads the column
// from the record only when it runs, as the setter reads the column holder's current array. A right-hand side that
// grows the storage past its capacity therefore stores into the column growth put in place. The read and the store
// share the one presence the slot had when the assignment began, as the runtime evaluates `e.C` once, so a
// right-hand side that disables the component does not make the store throw.
//
// It panics on an operator that is no assignment.
func (l *loop) assignInOrder(visitor *ast.NodeVisitor, node *ast.Node, use facts.ViewUse) *ast.Node {
	assignment := node.AsBinaryExpression()
	operator := assignment.OperatorToken.Kind
	boolean := l.field(use).Kind == facts.FieldBoolean
	steps, columnOf := l.heldColumn(use, skipParens(assignment.Left).Expression())
	field := func() *ast.Node { return l.atRow(columnOf()) }
	if boolean && operator == ast.KindQuestionQuestionEqualsToken {
		// A decoded boolean is never nullish, so the right-hand side never runs.
		return commaList(l.ctx, append(steps, l.decode(field()))...)
	}
	held := l.newTemp("value")
	value := visitor.VisitNode(assignment.Right)
	if apply, ok := syntax.ArithmeticOperator(operator); ok {
		combined := binary(l.ctx, l.ctx.Factory.DeepCloneNode(held), apply, paren(l.ctx, value))
		steps = append(steps, assignTo(l.ctx, held, field()), assignTo(l.ctx, l.ctx.Factory.DeepCloneNode(held), combined),
			assignTo(l.ctx, field(), l.ctx.Factory.DeepCloneNode(held)))
		return commaList(l.ctx, steps...)
	}
	stored := l.ctx.Factory.DeepCloneNode(held)
	if boolean {
		stored = encode(l.ctx, stored)
	}
	store := []*ast.Node{assignTo(l.ctx, held, value), assignTo(l.ctx, field(), stored)}
	if boolean && isValueUsed(node) {
		store = append(store, l.ctx.Factory.DeepCloneNode(held))
	}
	if operator == ast.KindEqualsToken {
		return commaList(l.ctx, append(steps, store...)...)
	}
	short, ok := syntax.LogicalOperator(operator)
	if !ok {
		panic(fmt.Sprintf("emit: the field assignment of %s.%s has no lowering for operator kind %d", use.Comp, use.Field, operator))
	}
	current := paren(l.ctx, assignTo(l.ctx, l.ctx.Factory.DeepCloneNode(held), field()))
	if boolean {
		current = l.decode(field())
	}
	return commaList(l.ctx, append(steps, binary(l.ctx, current, short, commaList(l.ctx, store...)))...)
}

// heldColumn returns the steps that test the presence of the slot of use, reached through slot, once into a temp,
// and a builder of the field's column guarded by that presence: `(present ? column : undefined)`, which throws a
// TypeError when indexed while the slot was disabled. A required component and an alias, whose declaration holds
// the presence it tested, need no step.
func (l *loop) heldColumn(use facts.ViewUse, slot *ast.Node) ([]*ast.Node, func() *ast.Node) {
	if _, optional := l.slot(use.Comp); !optional || use.Alias {
		return nil, func() *ast.Node { return l.guardedColumn(use, slot) }
	}
	present := l.newTemp("present")
	steps := []*ast.Node{assignTo(l.ctx, present, l.present(use, slot))}
	return steps, func() *ast.Node {
		return orUndefined(l.ctx, l.ctx.Factory.DeepCloneNode(present), l.columnArray(use))
	}
}

// newTemp is a fresh local named after base that a lowering holds a value in, declared once per call.
func (l *loop) newTemp(base string) *ast.Node {
	temp := l.ctx.Factory.NewUniqueNameEx(base, optimistic())
	l.temps = append(l.temps, temp)
	return temp
}

// decode is `element !== 0`, the boolean field getter's decoding of a stored element.
func (l *loop) decode(element *ast.Node) *ast.Node {
	return paren(l.ctx, binary(l.ctx, element, ast.KindExclamationEqualsEqualsToken, number(l.ctx, "0")))
}

func assignTo(ctx *printer.EmitContext, target, value *ast.Node) *ast.Node {
	return ctx.Factory.NewAssignmentExpression(target, value)
}

// commaList is `(first, ..., last)`, or the one expression given when there is one.
func commaList(ctx *printer.EmitContext, expressions ...*ast.Node) *ast.Node {
	list := expressions[0]
	if len(expressions) == 1 {
		return list
	}
	for _, next := range expressions[1:] {
		list = ctx.Factory.NewCommaExpression(list, next)
	}
	return paren(ctx, list)
}

// update lowers node, a prefix or postfix update of the field of use; analysis never reports one on a boolean field.
func (l *loop) update(node *ast.Node, use facts.ViewUse) *ast.Node {
	factory := l.ctx.Factory
	l.applied.add(ruleUpdateField)
	if node.Kind == ast.KindPrefixUnaryExpression {
		prefix := node.AsPrefixUnaryExpression()
		slot := skipParens(prefix.Operand).Expression()
		l.noteNonNull(slot)
		return factory.NewPrefixUnaryExpression(prefix.Operator, l.atRow(l.guardedColumn(use, slot)))
	}
	postfix := node.AsPostfixUnaryExpression()
	slot := skipParens(postfix.Operand).Expression()
	l.noteNonNull(slot)
	return factory.NewPostfixUnaryExpression(l.atRow(l.guardedColumn(use, slot)), postfix.Operator)
}

// compare lowers node, a comparison of the slot of use with null or undefined: the slot is the field record or
// `undefined`, never `null`.
func (l *loop) compare(node *ast.Node, use facts.ViewUse) *ast.Node {
	factory := l.ctx.Factory
	comparison := node.AsBinaryExpression()
	slot, other := comparison.Left, comparison.Right
	if isNullishLiteral(slot) {
		slot, other = other, slot
	}
	operator := comparison.OperatorToken.Kind
	strictNull := syntax.SkipWrappers(other).Kind == ast.KindNullKeyword &&
		(operator == ast.KindEqualsEqualsEqualsToken || operator == ast.KindExclamationEqualsEqualsToken)
	switch {
	case strictNull && operator == ast.KindEqualsEqualsEqualsToken:
		l.applied.add(ruleCompareNullStrictEqual)
		return factory.NewFalseExpression()
	case strictNull:
		l.applied.add(ruleCompareNullStrictNotEqual)
		return factory.NewTrueExpression()
	}
	l.noteSlot(use, rulePresenceRequired, rulePresenceOptional)
	switch operator {
	case ast.KindEqualsEqualsEqualsToken, ast.KindEqualsEqualsToken:
		return paren(l.ctx, factory.NewPrefixUnaryExpression(ast.KindExclamationToken, l.present(use, slot)))
	default:
		return l.present(use, slot)
	}
}

// present is whether the slot of use is enabled at the row: `true` for a required component, the alias for a use
// through one, whose declaration holds the presence it tested, and otherwise the optional's bit in the mask, as the
// optional slot getter of buildView (src/entity/each.ts) tests it. slot is the slot expression of the use.
func (l *loop) present(use facts.ViewUse, slot *ast.Node) *ast.Node {
	factory := l.ctx.Factory
	bit, optional := l.slot(use.Comp)
	switch {
	case use.Alias:
		return factory.DeepCloneNode(syntax.SkipWrappers(slot))
	case !optional:
		return factory.NewTrueExpression()
	}
	maskArray := l.mask
	if maskArray == nil {
		maskArray = l.storageArray("mask")
	}
	masked := paren(l.ctx, binary(l.ctx, l.atRow(maskArray), ast.KindAmpersandToken, number(l.ctx, strconv.FormatUint(uint64(bit), 10))))
	return l.decode(masked)
}

// guardedColumn is the column of use's field, reached through slot, its slot expression: for an optional component
// `(present ? column : undefined)`, which throws a TypeError when indexed while the slot is disabled, as reading a
// field of the getter's `undefined` does.
func (l *loop) guardedColumn(use facts.ViewUse, slot *ast.Node) *ast.Node {
	if _, optional := l.slot(use.Comp); !optional {
		return l.columnArray(use)
	}
	return orUndefined(l.ctx, l.present(use, slot), l.columnArray(use))
}

// paren parenthesizes expression, so the printer keeps the lowering's grouping wherever it lands.
func paren(ctx *printer.EmitContext, expression *ast.Node) *ast.Node {
	return ctx.Factory.NewParenthesizedExpression(expression)
}

// conditional is `(condition ? whenTrue : whenFalse)`.
func conditional(ctx *printer.EmitContext, condition, whenTrue, whenFalse *ast.Node) *ast.Node {
	factory := ctx.Factory
	return paren(ctx, factory.NewConditionalExpression(condition, factory.NewToken(ast.KindQuestionToken), whenTrue,
		factory.NewToken(ast.KindColonToken), whenFalse))
}

// orUndefined is `(condition ? whenTrue : undefined)`.
func orUndefined(ctx *printer.EmitContext, condition, whenTrue *ast.Node) *ast.Node {
	return conditional(ctx, condition, whenTrue, ctx.Factory.NewVoidZeroExpression())
}

// read reads the field of use from array at the row, decoding a boolean.
func (l *loop) read(use facts.ViewUse, array *ast.Node) *ast.Node {
	element := l.atRow(array)
	if l.field(use).Kind == facts.FieldBoolean {
		return l.decode(element)
	}
	return element
}

func (l *loop) atRow(array *ast.Node) *ast.Node {
	return l.ctx.Factory.NewElementAccessExpression(array, nil, l.i, ast.NodeFlagsNone)
}

// entityArray is the hoisted entity array, or in realloc-safe mode the storage's current one.
func (l *loop) entityArray() *ast.Node {
	if l.entities != nil {
		return l.entities
	}
	return l.storageArray("entities")
}

// columnArray is the hoisted column of use's field, or in realloc-safe mode the record's current one. Reaching the
// column of a relation's data field records that rule.
func (l *loop) columnArray(use facts.ViewUse) *ast.Node {
	if l.isRelation(use.Comp) {
		l.applied.add(ruleRelationDataField)
	}
	col := column{comp: use.Comp, field: use.Field}
	if local, ok := l.columns[col]; ok {
		return local
	}
	return l.recordColumn(col)
}

func (l *loop) isRelation(comp string) bool {
	c, ok := l.shape.Component(comp)
	return ok && c.Relation
}

// field returns the field use reads or writes in the loop's shape.
//
// It panics when the shape has no such field.
func (l *loop) field(use facts.ViewUse) facts.Field {
	if c, ok := l.shape.Component(use.Comp); ok {
		if field, ok := c.Field(use.Field); ok {
			return field
		}
	}
	panic(fmt.Sprintf("emit: the shape has no field %s.%s", use.Comp, use.Field))
}

// encode is `value === true ? 1 : 0`, the encoding of the boolean field setter that fieldAccessorsFor
// (src/entity/each.ts) builds.
func encode(ctx *printer.EmitContext, value *ast.Node) *ast.Node {
	isTrue := binary(ctx, value, ast.KindEqualsEqualsEqualsToken, ctx.Factory.NewTrueExpression())
	return conditional(ctx, isTrue, number(ctx, "1"), number(ctx, "0"))
}

// isValueUsed reports whether the value of node, an expression, may be read: it is not the whole of an expression
// statement.
func isValueUsed(node *ast.Node) bool {
	return syntax.OutermostParens(node).Parent.Kind != ast.KindExpressionStatement
}

// isNullishLiteral reports whether expr spells `null` or `undefined`.
func isNullishLiteral(expr *ast.Node) bool {
	expr = syntax.SkipWrappers(expr)
	return expr.Kind == ast.KindNullKeyword || (expr.Kind == ast.KindIdentifier && expr.Text() == "undefined")
}

func skipParens(node *ast.Node) *ast.Node {
	for node.Kind == ast.KindParenthesizedExpression {
		node = node.Expression()
	}
	return node
}
