package facts

import (
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
)

// NodeID names an AST node the analysis reported. IDs are dense from 0 and
// stable for one source file in one run; the node table maps them back to
// nodes.
type NodeID int32

// StmtContext says where a call sits relative to the statement holding it,
// which decides whether its value can be dropped.
type StmtContext uint8

// The statement contexts of a call site.
const (
	ContextExpressionStatement StmtContext = iota + 1
	ContextArrowBody
	// ContextOtherExpression is a call whose value is used.
	ContextOtherExpression
)

// Op identifies a public ecstatic function a call site invokes.
type Op uint8

// OpNone is the zero Op: it names no function.
const OpNone Op = 0

// The ops, one per function src/index.ts exports.
const (
	OpEach Op = iota + 1
	OpQuery
	OpQuerySources
	OpHas
	OpHasAny
	OpEnable
	OpDisable
	OpGet
	OpSet
	OpAlive
	OpEnableMany
	OpDisableMany
	OpSpawn
	OpSpawnMany
	OpDespawn
	OpDespawnMany
	OpGetTarget
	OpLink
	OpUnlink
	OpGetResource
	OpSetResource
	OpResetResource
	OpGetSources
	OpHasSources
	OpCountSources
	OpRegister
	OpCreateWorld
	OpDestroyWorld
	OpGetStorage
	// OpArchetype is `archetype`, the function form; OpArchetypeClass is
	// `Archetype`, the class-producing form.
	OpArchetype
	OpArchetypeClass
	OpComponent
	OpComponents
	OpRelation
	OpResource
	OpRef
	OpF32
	OpF64
	OpI8
	OpI16
	OpI32
	OpU8
	OpU16
	OpU32
)

type opInfo struct {
	name string
	// arities lists the argument counts of the declared overloads; nil for
	// an op without overload data.
	arities []int
}

// opTable is indexed by Op and never written.
var opTable = [...]opInfo{ //nolint:gochecknoglobals // read-only lookup table; Go has no constant arrays
	// each(storage, fn), each(storage, filter, fn), and the same two over a
	// storages array.
	OpEach: {name: "each", arities: []int{2, 3}},
	// query(world, comps, fn) and query(world, filter, fn).
	OpQuery:          {name: "query", arities: []int{3}},
	OpQuerySources:   {name: "querySources"},
	OpHas:            {name: "has"},
	OpHasAny:         {name: "hasAny"},
	OpEnable:         {name: "enable"},
	OpDisable:        {name: "disable"},
	OpGet:            {name: "get"},
	OpSet:            {name: "set"},
	OpAlive:          {name: "alive"},
	OpEnableMany:     {name: "enableMany"},
	OpDisableMany:    {name: "disableMany"},
	OpSpawn:          {name: "spawn"},
	OpSpawnMany:      {name: "spawnMany"},
	OpDespawn:        {name: "despawn"},
	OpDespawnMany:    {name: "despawnMany"},
	OpGetTarget:      {name: "getTarget"},
	OpLink:           {name: "link"},
	OpUnlink:         {name: "unlink"},
	OpGetResource:    {name: "getResource"},
	OpSetResource:    {name: "setResource"},
	OpResetResource:  {name: "resetResource"},
	OpGetSources:     {name: "getSources"},
	OpHasSources:     {name: "hasSources"},
	OpCountSources:   {name: "countSources"},
	OpRegister:       {name: "register"},
	OpCreateWorld:    {name: "createWorld"},
	OpDestroyWorld:   {name: "destroyWorld"},
	OpGetStorage:     {name: "getStorage"},
	OpArchetype:      {name: "archetype"},
	OpArchetypeClass: {name: "Archetype"},
	OpComponent:      {name: "component"},
	OpComponents:     {name: "components"},
	OpRelation:       {name: "relation"},
	OpResource:       {name: "resource"},
	OpRef:            {name: "ref"},
	OpF32:            {name: "f32"},
	OpF64:            {name: "f64"},
	OpI8:             {name: "i8"},
	OpI16:            {name: "i16"},
	OpI32:            {name: "i32"},
	OpU8:             {name: "u8"},
	OpU16:            {name: "u16"},
	OpU32:            {name: "u32"},
}

// Name returns the op's runtime function name, as declared in the runtime.
// The zero Op has the empty name; a value past the last declared Op panics.
func (o Op) Name() string {
	return opTable[o].name
}

// MatchesArgCount reports whether count arguments match one of the op's
// declared overloads. Only each and query carry overload data; every other
// op matches no count.
func (o Op) MatchesArgCount(count int) bool {
	return slices.Contains(opTable[o].arities, count)
}

// Iterates reports whether o is an iteration op the optimizer compiles into an
// inline loop: each and query. Only these ops carry overload arities and nest
// the sites of their callback. querySources also runs a callback once per
// entity, but it stays a runtime call, so it reports false.
func (o Op) Iterates() bool {
	return o == OpEach || o == OpQuery
}

// Ops returns every op in declaration order.
func Ops() []Op {
	return tableIndices[Op](len(opTable))
}

// OpByName returns the op whose runtime function is declared as name, and
// false when no op has that name. Names are case-sensitive: `archetype` and
// `Archetype` are distinct ops.
func OpByName(name string) (Op, bool) {
	for _, o := range Ops() {
		if o.Name() == name {
			return o, true
		}
	}
	return OpNone, false
}

// Position locates a call in its source file for diagnostics.
type Position struct {
	File string
	// Offset is the 0-based position of the call's first token in the file
	// text, in the compiler's own position unit.
	Offset int
	// Line and Column are 1-based.
	Line   int
	Column int
}

// Site is one recognized ecstatic call.
type Site struct {
	// Callback summarizes the inline function an each or query call passes
	// as its last argument; nil when that argument is not an arrow function
	// or function expression, and for every other op.
	Callback *Callback
	// Reasons lists why the call keeps its runtime call, in the order they
	// were recorded; empty while the site is still a rewrite candidate.
	Reasons []Reason
	// Nested holds the ecstatic sites inside this call's callback, in source
	// order.
	Nested []Site
	// Shapes holds the site's resolved archetype shapes: one for a single
	// storage, one per element for an array literal of storages.
	Shapes []ArchShape
	// DeclarationFiles lists, sorted and without duplicates, the declaration
	// files shape resolution consulted; the build reports them as
	// dependencies. Add to it with AddDeclarationFile.
	DeclarationFiles []string
	Pos              Position
	Call             NodeID
	Op               Op
	Context          StmtContext
}

// AddDeclarationFile adds file to DeclarationFiles, keeping the list sorted
// and free of duplicates.
func (s *Site) AddDeclarationFile(file string) {
	i, found := slices.BinarySearch(s.DeclarationFiles, file)
	if !found {
		s.DeclarationFiles = slices.Insert(s.DeclarationFiles, i, file)
	}
}

// ParamForm is the syntactic form of a callback's first parameter.
type ParamForm uint8

// The forms of a callback's first parameter.
const (
	// ParamNone is the zero ParamForm on purpose, unlike the zero value of
	// the package's other enums, which names nothing: a callback that
	// declares no parameter has Params 0 and FirstParam ParamNone.
	ParamNone ParamForm = iota
	// ParamIdentifier is a plain identifier without a default.
	ParamIdentifier
	// ParamObjectPattern is an object destructuring pattern without a
	// default.
	ParamObjectPattern
	// ParamOther is every other form: an identifier or pattern with a
	// default, a rest parameter, or an array pattern.
	ParamOther
)

// Callback is the syntactic summary of the inline function an iteration
// call passes as its last argument.
type Callback struct {
	// FunctionLocal lists, in source order, every use of a binding the
	// function expression itself provides: `this`, `arguments`,
	// `new.target`, and each reference to its own name. Always empty for an
	// arrow function, whose `this` and `arguments` belong to the enclosing
	// scope.
	FunctionLocal []NodeID
	// Params counts the declared parameters; a TypeScript `this` parameter
	// is a type annotation, not a parameter, and is not counted.
	Params     int
	FirstParam ParamForm
	Arrow      bool
	Async      bool
	Generator  bool
	// ExprBody is set only for an arrow function; a function expression's
	// body is always a block.
	ExprBody bool
}

// FieldKind is the column kind a component field is stored in.
type FieldKind uint8

// The field kinds. The zero FieldKind names no kind.
const (
	// FieldBoolean is a boolean field, stored as 1/0 in a numeric column.
	FieldBoolean FieldKind = iota + 1
	// FieldNumber is a number field, stored in a numeric column.
	FieldNumber
	// FieldPlain is a field of any other type, stored in a plain array.
	FieldPlain
)

// Field is one data field of a component.
type Field struct {
	Name string
	Kind FieldKind
}

// Component is one component of an archetype shape.
type Component struct {
	Name string
	// Fields are in declaration order. The runtime sorts its own copy by
	// code unit, so code that walks columns by position must sort first.
	Fields []Field
	// Relation marks a relation component; its Fields exclude `target`.
	Relation bool
}

// ArchShape mirrors an archetype descriptor's component lists, each in
// declaration order.
type ArchShape struct {
	Required []Component
	// Optional[k] has presence bit 1 << k.
	Optional []Component
}

// Key returns the shape-guard key the DEBUG shape guard compares a storage's
// archetype against. The TypeScript guard computes the same string, so the
// format is a contract between the two:
//
//	key       = components(Required) "|" components(Optional)
//	component = ("c" | "r") len ":" name "{" [field ("," field)*] "}"
//	field     = len ":" name "=" ("b" | "n" | "p")
//
// "r" marks a relation. Fields are sorted by name in UTF-16 code unit order,
// as JavaScript's default sort orders them, and each len is the name's
// length in UTF-16 code units, as JavaScript's `.length` counts it. The
// length prefix keeps a name holding a separator (`component("A,B")`) from
// reading as two components.
func (s ArchShape) Key() string {
	var b strings.Builder
	for _, c := range s.Required {
		writeComponentKey(&b, c)
	}
	b.WriteByte('|')
	for _, c := range s.Optional {
		writeComponentKey(&b, c)
	}
	return b.String()
}

func writeComponentKey(b *strings.Builder, c Component) {
	if c.Relation {
		b.WriteByte('r')
	} else {
		b.WriteByte('c')
	}
	writeLengthPrefixed(b, c.Name)
	b.WriteByte('{')
	fields := slices.Clone(c.Fields)
	slices.SortFunc(fields, func(x, y Field) int {
		return slices.Compare(utf16.Encode([]rune(x.Name)), utf16.Encode([]rune(y.Name)))
	})
	for i, f := range fields {
		if i > 0 {
			b.WriteByte(',')
		}
		writeLengthPrefixed(b, f.Name)
		b.WriteByte('=')
		b.WriteByte(fieldKindCode(f.Kind))
	}
	b.WriteByte('}')
}

// writeLengthPrefixed writes `${name.length}:${name}`, the length counted in
// UTF-16 code units so it matches the runtime's __ecstatic_component_key.
func writeLengthPrefixed(b *strings.Builder, name string) {
	units := 0
	for _, r := range name {
		units += utf16.RuneLen(r)
	}
	b.WriteString(strconv.Itoa(units))
	b.WriteByte(':')
	b.WriteString(name)
}

func fieldKindCode(k FieldKind) byte {
	switch k {
	case FieldBoolean:
		return 'b'
	case FieldNumber:
		return 'n'
	case FieldPlain:
		return 'p'
	default:
		panic("facts: field kind " + strconv.Itoa(int(k)) + " has no shape-key code")
	}
}

// Category decides when a reason is reported.
type Category uint8

// The reporting categories of the reason catalog.
const (
	// CategorySilent marks a call the optimizer leaves alone by design;
	// it is never reported.
	CategorySilent Category = iota + 1
	// CategoryStrict marks an eligible call that could not be proven; it is
	// reported as an error under strict and not at all otherwise.
	CategoryStrict
	// CategoryWarning marks a contract violation reported in every build:
	// an error under strict, a warning otherwise.
	CategoryWarning
)

// Reason identifies why a call site keeps its runtime call.
type Reason uint8

// ReasonNone is the zero Reason: no reason applies, so the call is still a
// rewrite candidate.
const ReasonNone Reason = 0

// The reasons a call site is not rewritten. Codes are never reused, so a
// reason that leaves the catalog leaves its code retired.
const (
	ReasonShapeUnresolved Reason = iota + 1
	ReasonStoragesDynamic
	ReasonCallbackNotInline
	ReasonCallbackParams
	ReasonCallbackAsync
	ReasonCallbackGenerator
	ReasonCallbackFunctionBindings
	ReasonInternal
	ReasonArgCount
	ReasonNotStatement
	ReasonOpNotRewritten
)

// DetailPlaceholder marks where the diagnostic writer substitutes a bail's
// detail in ReasonInternal's text.
const DetailPlaceholder = "<detail>"

// ReasonInfo is a reason's row in the catalog.
type ReasonInfo struct {
	ID string
	// Text fills the parenthesis of the diagnostic message.
	Text string
	// Hint follows the message; empty when the reason has none.
	Hint string
	// Code is the diagnostic code; 0 for a silent reason, which is never
	// reported.
	Code     int
	Category Category
}

// reasonTable is indexed by Reason and never written.
var reasonTable = [...]ReasonInfo{ //nolint:gochecknoglobals // read-only lookup table; Go has no constant arrays
	ReasonShapeUnresolved: {
		Code:     99910,
		ID:       "SHAPE_UNRESOLVED",
		Category: CategoryStrict,
		Text:     "the storage's archetype shape is not known statically",
		Hint:     "Type the storage as `Storage<typeof X>` or `Storage<X>`.",
	},
	ReasonStoragesDynamic: {
		Code:     99912,
		ID:       "STORAGES_DYNAMIC",
		Category: CategoryStrict,
		Text:     "the storages argument is not an array literal of typed storages",
	},
	ReasonCallbackNotInline: {
		Code:     99913,
		ID:       "CALLBACK_NOT_INLINE",
		Category: CategoryStrict,
		Text:     "the callback is not written inline",
		Hint:     "Write `(e) => { ... }` at the call site.",
	},
	ReasonCallbackParams: {
		Code:     99914,
		ID:       "CALLBACK_PARAMS",
		Category: CategoryStrict,
		Text: "the callback has a defaulted, rest, or array-pattern parameter, more than one parameter, " +
			"or a `var` redeclaring a destructured parameter",
		Hint: "Use `(e)` or an object pattern.",
	},
	ReasonCallbackAsync: {
		Code:     99915,
		ID:       "CALLBACK_ASYNC",
		Category: CategoryWarning,
		Text:     "the callback is async",
		Hint:     "Views are valid only until the callback returns; collect ids and await between passes.",
	},
	ReasonCallbackGenerator: {
		Code:     99916,
		ID:       "CALLBACK_GENERATOR",
		Category: CategoryStrict,
		Text:     "the callback is a generator function",
	},
	ReasonCallbackFunctionBindings: {
		Code:     99917,
		ID:       "CALLBACK_FUNCTION_BINDINGS",
		Category: CategoryStrict,
		Text:     "the callback uses `this`, `arguments`, `new.target`, or its own name",
		Hint:     "Use an arrow function.",
	},
	ReasonInternal: {
		Code:     99920,
		ID:       "INTERNAL",
		Category: CategoryStrict,
		Text:     "internal error (`" + DetailPlaceholder + "`); please report it",
	},
	ReasonArgCount: {
		ID:       "ARG_COUNT",
		Category: CategorySilent,
		Text:     "argument count matches no rewritable overload",
	},
	ReasonNotStatement: {
		ID:       "NOT_STATEMENT",
		Category: CategorySilent,
		Text:     "the call's value is used",
	},
	ReasonOpNotRewritten: {
		ID:       "OP_NOT_REWRITTEN",
		Category: CategorySilent,
		Text:     "the op has no rewrite in this version",
	},
}

// Info returns the reason's catalog row. The zero Reason has the zero
// ReasonInfo; a value past the last declared Reason panics.
func (r Reason) Info() ReasonInfo {
	return reasonTable[r]
}

// Reasons returns every reason in catalog order: each one the reason table
// describes, so a reason appended to the table is listed without editing here.
func Reasons() []Reason {
	return tableIndices[Reason](len(reasonTable))
}

// tableIndices returns T(1) through T(n-1): every entry of a lookup table of length n whose index 0
// is reserved for the zero value.
func tableIndices[T ~uint8](n int) []T {
	indices := make([]T, 0, n-1)
	for i := 1; i < n; i++ {
		indices = append(indices, T(i))
	}
	return indices
}
