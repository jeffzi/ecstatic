package emit

import "slices"

// Rule is one rule of the rewrite catalog that the fixture corpus must cover: a mode of the emitted loop, a row of
// the view lowering table, a destructuring form, or a callback transplant case. A loop applies a rule when building
// it takes the code path the rule names, and File.Applied reports the rules a file's loops applied.
type Rule uint8

// The rules of the rewrite catalog, in catalog order.
const (
	ruleModeHoisted Rule = iota
	ruleModeReallocSafe

	ruleEntityID
	ruleReadRequiredField
	ruleReadOptionalField
	// ruleReadBooleanField decodes a boolean column's 1/0 as true/false.
	ruleReadBooleanField
	ruleWriteRequiredField
	ruleWriteOptionalField
	// ruleWriteBooleanField encodes the value a boolean field is assigned as 1/0.
	ruleWriteBooleanField
	// ruleBooleanAssignmentValue yields what a boolean field assignment was given, not the encoded number.
	ruleBooleanAssignmentValue
	ruleUpdateField
	// ruleRelationDataField reads or writes a data field of a relation slot, whose column holds the relation's data
	// beside its target.
	ruleRelationDataField
	// ruleNonNullSlot reaches a field through a non-null-asserted slot, `e.C!.f` or an alias `const p = e.C!`.
	ruleNonNullSlot
	ruleOptionalChainRead
	// rulePresenceOptional tests an optional slot's bit, in a test position or compared with undefined or `== null`.
	rulePresenceOptional
	// rulePresenceRequired lowers the same tests of a required slot to a constant.
	rulePresenceRequired
	ruleCompareNullStrictEqual
	ruleCompareNullStrictNotEqual
	ruleCoalesceOptional
	ruleCoalesceRequired
	ruleRequiredTag
	ruleOptionalTag
	// ruleAlias declares `const p = e.C` or `const p = e.C!`, testing presence once.
	ruleAlias

	// ruleDestructureSlot declares `const { x, y: py } = e.C` or its `let` form.
	ruleDestructureSlot
	// ruleDestructureParameter binds slot aliases in the callback's parameter pattern.
	ruleDestructureParameter
	// ruleDestructureParameterNested reads a slot's fields through a pattern nested in the parameter pattern.
	ruleDestructureParameterNested
	ruleDestructureID
	// ruleDestructureView binds slot aliases in a declaration destructuring the view.
	ruleDestructureView
	// ruleDestructureViewNested reads a slot's fields through a pattern nested in a declaration of the view.
	ruleDestructureViewNested
	// ruleDestructureOptionalSlot tests an optional slot once and guards before reading its fields.
	ruleDestructureOptionalSlot
	ruleDestructureOptionalTag
	// ruleDestructureDefaultTyped drops a field default on a typed-array column, which never holds undefined.
	ruleDestructureDefaultTyped
	// ruleDestructureDefaultPlain applies a field default to undefined on a plain-array column.
	ruleDestructureDefaultPlain

	ruleCallbackArrow
	ruleCallbackFunction
	ruleCallbackWithoutParameter
	// ruleCallbackTypedParameter ignores the type annotation of the callback's parameter.
	ruleCallbackTypedParameter
	ruleReturnVoid
	// ruleReturnValue runs a returned expression as a statement before continuing.
	ruleReturnValue
	// ruleReturnObjectLiteral runs a returned expression that starts with an object literal as a statement, which the
	// printer parenthesizes so it does not read as a block.
	ruleReturnObjectLiteral
	// ruleReturnFunctionExpression runs a returned expression that starts with a function expression as a statement,
	// which the printer parenthesizes so it does not read as a function declaration.
	ruleReturnFunctionExpression
	// ruleReturnLabeled continues the labeled row loop from a return under an inner loop or switch.
	ruleReturnLabeled
	ruleReturnInFinally
	// ruleReturnInNestedFunction leaves the returns of a function nested in the body as they are.
	ruleReturnInNestedFunction
	ruleExpressionBody
	// ruleOuterBinding keeps a reference to a binding outside the callback pointing at it when a name the loop adds
	// has the same base, which then takes a fresh name instead.
	ruleOuterBinding
	// ruleBlockScopedDeclaration keeps a body let, const, class, or function declaration fresh on every row.
	ruleBlockScopedDeclaration
	// ruleClosure keeps a function created in the body capturing that row's bindings.
	ruleClosure
	// ruleOuterLetDeadZone keeps in place a read of an outer let, const, or class declared after the call, which
	// throws at the same point as in the callback.
	ruleOuterLetDeadZone
	ruleThis
	ruleArguments
	// ruleNewTarget keeps an arrow callback's new.target, the enclosing function's.
	ruleNewTarget
	ruleSuper
	// ruleVarToLet declares the body's var bindings with let at the top of the row block.
	ruleVarToLet
	// ruleUserLabel keeps the body's labeled statements, break, and continue as written.
	ruleUserLabel
	// ruleUserLabelRenamed gives a body label that a statement enclosing the call also declares a fresh name, in its
	// labeled statement and in the break and continue that name it.
	ruleUserLabelRenamed
	ruleThrow
)

// ruleNames is the name of each rule, indexed by the rule.
var ruleNames = [...]string{ //nolint:gochecknoglobals // read-only lookup table; Go has no constant arrays
	ruleModeHoisted:                "mode-hoisted",
	ruleModeReallocSafe:            "mode-realloc-safe",
	ruleEntityID:                   "entity-id",
	ruleReadRequiredField:          "read-required-field",
	ruleReadOptionalField:          "read-optional-field",
	ruleReadBooleanField:           "read-boolean-field",
	ruleWriteRequiredField:         "write-required-field",
	ruleWriteOptionalField:         "write-optional-field",
	ruleWriteBooleanField:          "write-boolean-field",
	ruleBooleanAssignmentValue:     "boolean-assignment-value",
	ruleUpdateField:                "update-field",
	ruleRelationDataField:          "relation-data-field",
	ruleNonNullSlot:                "non-null-slot",
	ruleOptionalChainRead:          "optional-chain-read",
	rulePresenceOptional:           "presence-optional",
	rulePresenceRequired:           "presence-required",
	ruleCompareNullStrictEqual:     "compare-null-strict-equal",
	ruleCompareNullStrictNotEqual:  "compare-null-strict-not-equal",
	ruleCoalesceOptional:           "coalesce-optional",
	ruleCoalesceRequired:           "coalesce-required",
	ruleRequiredTag:                "required-tag",
	ruleOptionalTag:                "optional-tag",
	ruleAlias:                      "alias",
	ruleDestructureSlot:            "destructure-slot",
	ruleDestructureParameter:       "destructure-parameter",
	ruleDestructureParameterNested: "destructure-parameter-nested",
	ruleDestructureID:              "destructure-id",
	ruleDestructureView:            "destructure-view",
	ruleDestructureViewNested:      "destructure-view-nested",
	ruleDestructureOptionalSlot:    "destructure-optional-slot",
	ruleDestructureOptionalTag:     "destructure-optional-tag",
	ruleDestructureDefaultTyped:    "destructure-default-typed",
	ruleDestructureDefaultPlain:    "destructure-default-plain",
	ruleCallbackArrow:              "callback-arrow",
	ruleCallbackFunction:           "callback-function",
	ruleCallbackWithoutParameter:   "callback-without-parameter",
	ruleCallbackTypedParameter:     "callback-typed-parameter",
	ruleReturnVoid:                 "return-void",
	ruleReturnValue:                "return-value",
	ruleReturnObjectLiteral:        "return-object-literal",
	ruleReturnFunctionExpression:   "return-function-expression",
	ruleReturnLabeled:              "return-labeled",
	ruleReturnInFinally:            "return-in-finally",
	ruleReturnInNestedFunction:     "return-in-nested-function",
	ruleExpressionBody:             "expression-body",
	ruleOuterBinding:               "outer-binding",
	ruleBlockScopedDeclaration:     "block-scoped-declaration",
	ruleClosure:                    "closure",
	ruleOuterLetDeadZone:           "outer-let-dead-zone",
	ruleThis:                       "this",
	ruleArguments:                  "arguments",
	ruleNewTarget:                  "new-target",
	ruleSuper:                      "super",
	ruleVarToLet:                   "var-to-let",
	ruleUserLabel:                  "user-label",
	ruleUserLabelRenamed:           "user-label-renamed",
	ruleThrow:                      "throw",
}

// Rules returns every rule of the rewrite catalog, in catalog order.
func Rules() []Rule {
	rules := make([]Rule, 0, len(ruleNames))
	for r := range Rule(len(ruleNames)) {
		rules = append(rules, r)
	}
	return rules
}

// Name is the rule's name, as a fixture's rewrite claim spells it.
func (r Rule) Name() string {
	return ruleNames[r]
}

type ruleSet map[Rule]bool

func (s ruleSet) add(r Rule) {
	s[r] = true
}

// sorted is the rules of s, in catalog order.
func (s ruleSet) sorted() []Rule {
	return slices.DeleteFunc(Rules(), func(r Rule) bool { return !s[r] })
}
